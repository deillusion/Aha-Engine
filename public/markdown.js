/**
 * Lightweight, zero-dependency Markdown parser and renderer.
 * Designed for AI streaming and conversation outputs.
 */

function escapeHtml(str = '') {
  return String(str).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function sanitizeUrl(url = '') {
  const trimmed = String(url).trim();
  if (/^(https?:\/\/|\/|#|\.\/)/i.test(trimmed)) {
    return trimmed;
  }
  return '#';
}

/**
 * Global copy handler for markdown code blocks
 */
if (typeof window !== 'undefined') {
  window.__copyCode = function(button) {
    if (!button) return;
    const wrapper = button.closest('.code-block-wrapper');
    const codeEl = wrapper ? wrapper.querySelector('pre code') : null;
    const text = codeEl ? codeEl.innerText : '';
    if (!text) return;

    const originalHtml = button.innerHTML;
    const setSuccess = () => {
      button.classList.add('copied');
      button.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>已复制</span>
      `;
      clearTimeout(button._timer);
      button._timer = setTimeout(() => {
        button.innerHTML = originalHtml;
        button.classList.remove('copied');
      }, 2000);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(setSuccess).catch(() => {
        fallbackCopy(text);
        setSuccess();
      });
    } else {
      fallbackCopy(text);
      setSuccess();
    }
  };

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
}

export function renderMarkdown(markdown = '') {
  if (!markdown) return '';
  const text = String(markdown);

  // 1. Extract fenced code blocks
  const codeBlocks = [];
  let processed = text.replace(/(?:^|\n)```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)(?:```(?:\r?\n|$)|$)/g, (match, lang, code) => {
    const idx = codeBlocks.length;
    const cleanLang = (lang || '').trim() || 'text';
    const safeLang = escapeHtml(cleanLang);
    const safeCode = escapeHtml(code.replace(/\r?\n$/, ''));
    codeBlocks.push(`
      <div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-block-lang">${safeLang}</span>
          <button class="code-copy-btn" type="button" title="复制代码" onclick="window.__copyCode?.(this)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span>复制</span>
          </button>
        </div>
        <pre><code class="language-${safeLang}">${safeCode}</code></pre>
      </div>
    `);
    return `\n\x00CODE_BLOCK_${idx}\x00\n`;
  });

  // 2. Extract inline code blocks
  const inlineCodes = [];
  processed = processed.replace(/`([^`\r\n]+)`/g, (match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code class="inline-code">${escapeHtml(code)}</code>`);
    return `\x00INLINE_CODE_${idx}\x00`;
  });

  function inlineFormat(str) {
    let res = escapeHtml(str);

    // Images: ![alt](url)
    res = res.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
      return `<img src="${escapeHtml(sanitizeUrl(url))}" alt="${alt}" loading="lazy" class="markdown-img" />`;
    });

    // Links: [text](url)
    res = res.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, url) => {
      return `<a href="${escapeHtml(sanitizeUrl(url))}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
    });

    // Task list items
    res = res.replace(/^\[ \]\s*/, '<input type="checkbox" disabled class="task-checkbox"> ');
    res = res.replace(/^\[[xX]\]\s*/, '<input type="checkbox" checked disabled class="task-checkbox"> ');

    // Bold + Italic: ***text***
    res = res.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>');

    // Bold: **text**
    res = res.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Bold: __text__ (word boundaries)
    res = res.replace(/(^|[^\w])__(.+?)__([^\w]|$)/g, '$1<strong>$2</strong>$3');

    // Italic: *text*
    res = res.replace(/\*([^*\r\n]+)\*/g, '<em>$1</em>');

    // Italic: _text_ (word boundaries)
    res = res.replace(/(^|[^\w])_([^_\r\n]+)_([^\w]|$)/g, '$1<em>$2</em>$3');

    // Strikethrough: ~~text~~
    res = res.replace(/~~(.*?)~~/g, '<del>$1</del>');

    // Restore inline codes
    res = res.replace(/\x00INLINE_CODE_(\d+)\x00/g, (m, idx) => inlineCodes[Number(idx)] || '');

    return res;
  }

  const lines = processed.split(/\r?\n/);
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Check for code block placeholder
    const codeMatch = line.match(/^\x00CODE_BLOCK_(\d+)\x00$/);
    if (codeMatch) {
      output.push(codeBlocks[Number(codeMatch[1])]);
      i++;
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Horizontal rule: ---, ***, ___ (alone on a line)
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
      output.push('<hr>');
      i++;
      continue;
    }

    // Headings: # to ######
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      output.push(`<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote: > ...
    if (line.startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && (lines[i].startsWith('>') || (lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('- ') && !lines[i].startsWith('* ') && !lines[i].startsWith('\x00CODE_BLOCK_')))) {
        const raw = lines[i].startsWith('>') ? lines[i].replace(/^>\s?/, '') : lines[i];
        quoteLines.push(raw);
        i++;
      }
      output.push(`<blockquote><p>${quoteLines.map(l => inlineFormat(l)).join('<br>')}</p></blockquote>`);
      continue;
    }

    // Tables: | header | header |
    if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[-: ]+\|/.test(lines[i + 1])) {
      const headerRow = line.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
      const alignRow = lines[i + 1].trim().replace(/^\||\|$/g, '').split('|').map(s => {
        const t = s.trim();
        if (t.startsWith(':') && t.endsWith(':')) return 'center';
        if (t.endsWith(':')) return 'right';
        return 'left';
      });
      i += 2;
      const bodyRows = [];
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
        bodyRows.push(cells);
        i++;
      }

      let tbl = '<div class="table-wrapper"><table><thead><tr>';
      headerRow.forEach((h, idx) => {
        const align = alignRow[idx] || 'left';
        tbl += `<th style="text-align:${align}">${inlineFormat(h)}</th>`;
      });
      tbl += '</tr></thead><tbody>';
      bodyRows.forEach(row => {
        tbl += '<tr>';
        row.forEach((cell, idx) => {
          const align = alignRow[idx] || 'left';
          tbl += `<td style="text-align:${align}">${inlineFormat(cell)}</td>`;
        });
        tbl += '</tr>';
      });
      tbl += '</tbody></table></div>';
      output.push(tbl);
      continue;
    }

    // Lists (unordered and ordered)
    const isUnordered = /^(\s*)([-*+])\s+(.+)$/.test(line);
    const isOrdered = /^(\s*)(\d+)\.\s+(.+)$/.test(line);
    if (isUnordered || isOrdered) {
      const listType = isOrdered ? 'ol' : 'ul';
      const items = [];

      while (i < lines.length) {
        const curr = lines[i];
        const uMatch = curr.match(/^(\s*)([-*+])\s+(.+)$/);
        const oMatch = curr.match(/^(\s*)(\d+)\.\s+(.+)$/);

        if (listType === 'ul' && uMatch) {
          items.push(inlineFormat(uMatch[3]));
          i++;
        } else if (listType === 'ol' && oMatch) {
          items.push(inlineFormat(oMatch[3]));
          i++;
        } else if (curr.startsWith('  ') || curr.startsWith('\t')) {
          if (items.length > 0) {
            items[items.length - 1] += '<br>' + inlineFormat(curr.trim());
          }
          i++;
        } else {
          break;
        }
      }

      output.push(`<${listType}>${items.map(it => `<li>${it}</li>`).join('')}</${listType}>`);
      continue;
    }

    // Paragraph
    const pLines = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (!cur.trim()) break;
      if (cur.startsWith('\x00CODE_BLOCK_')) break;
      if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(cur.trim())) break;
      if (/^(#{1,6})\s+/.test(cur)) break;
      if (cur.startsWith('>')) break;
      if (/^\s*\|.+\|\s*$/.test(cur) && i + 1 < lines.length && /^\s*\|[-: ]+\|/.test(lines[i + 1])) break;
      if (/^(\s*)([-*+]|\d+\.)\s+/.test(cur)) break;

      pLines.push(inlineFormat(cur));
      i++;
    }

    if (pLines.length) {
      output.push(`<p>${pLines.join('<br>')}</p>`);
    }
  }

  return output.join('\n');
}
