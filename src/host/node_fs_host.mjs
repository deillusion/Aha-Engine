import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  access, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile
} from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'dist', 'build']);
const BINARY_BYTES = new Set([0]);
// 单条命中行的宽度上限，对标 Claude Code 的 ripgrep 参数 --max-columns 500
// （src/tools/GrepTool/GrepTool.ts:338）。工作区里存在「整个文件就是一行」的数据文件，
// 不限宽的话一条命中就能把 1.8MB 原文塞进对话。
const DEFAULT_MAX_MATCH_LINE_CHARS = 500;
// 超限工具结果的落盘目录。放在工作区根的 .aha 下，listFiles 默认会跳过它，
// 所以落盘内容不会再被 Grep/Glob 检索到，但模型仍可用 Read 按路径取回。
const DEFAULT_RESULT_ROOT = '.aha/tool-results';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function slash(value) {
  return value.split(path.sep).join('/');
}

function detectEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (!crlf && !lf) return 'none';
  if (crlf && lf) return 'mixed';
  return crlf ? 'crlf' : 'lf';
}

function looksBinary(bytes) {
  const limit = Math.min(bytes.length, 8192);
  for (let index = 0; index < limit; index++) if (BINARY_BYTES.has(bytes[index])) return true;
  return false;
}

function decodeUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('拒绝读取非 UTF-8 或二进制文件'); }
}

function safeRegexSource(source) {
  if (source.length > 200) return false;
  if (/\\[1-9]/.test(source)) return false;
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(source)) return false;
  if (/\.[*+]\s*\.[*+]/.test(source)) return false;
  return true;
}

function globRegex(pattern = '**/*') {
  const normalized = slash(pattern).replace(/^\.\//, '');
  let output = '^';
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') { index += 1; output += '(?:.*/)?'; }
        else output += '.*';
      } else output += '[^/]*';
    } else if (char === '?') output += '[^/]';
    else output += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${output}$`, 'i');
}

async function exists(filePath) {
  try { await access(filePath); return true; }
  catch { return false; }
}

async function renameWithRetry(source, target) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await rename(source, target); return; }
    catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await delay(10 + attempt * 5);
    }
  }
  throw lastError;
}

export class WorkspaceBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceBoundaryError';
    this.code = 'WORKSPACE_BOUNDARY';
  }
}

export class StaleFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StaleFileError';
    this.code = 'STALE_FILE';
  }
}

export class NodeFsHost {
  constructor(workspaceRoot, {
    maxFileBytes = 2 * 1024 * 1024,
    backupRoot = '.aha/backups',
    resultRoot = DEFAULT_RESULT_ROOT
  } = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.maxFileBytes = maxFileBytes;
    this.backupRoot = backupRoot;
    this.resultRoot = resultRoot;
    this.rootRealPath = null;
  }

  async init() {
    this.rootRealPath = await realpath(this.workspaceRoot);
    return this;
  }

  normalizePath(filePath) {
    const absolute = path.resolve(this.workspaceRoot, filePath || '.');
    const relative = path.relative(this.workspaceRoot, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new WorkspaceBoundaryError('路径越出工作区');
    }
    return { absolute, relative: slash(relative || '.') };
  }

  async assertContained(filePath, { allowMissing = false } = {}) {
    if (!this.rootRealPath) await this.init();
    const target = this.normalizePath(filePath);
    let probe = target.absolute;
    if (allowMissing) {
      while (!await exists(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) throw new WorkspaceBoundaryError('无法解析目标父目录');
        probe = parent;
      }
    }
    const resolved = await realpath(probe);
    const relativeReal = path.relative(this.rootRealPath, resolved);
    if (relativeReal === '..' || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) {
      throw new WorkspaceBoundaryError('符号链接或 junction 越出工作区');
    }
    return target;
  }

  async listFiles(pattern = '**/*', { maxResults = 500, includeHidden = false, signal } = {}) {
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 5000) throw new Error('maxResults 须为 1–5000');
    const matcher = globRegex(pattern);
    const results = [];
    const visit = async directory => {
      signal?.throwIfAborted();
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (results.length >= maxResults) return;
        if (DEFAULT_IGNORES.has(entry.name)) continue;
        if (entry.name === '.aha' && path.resolve(directory) === this.workspaceRoot) continue;
        if (!includeHidden && entry.name.startsWith('.')) continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          try { await this.assertContained(slash(path.relative(this.workspaceRoot, absolute))); }
          catch { continue; }
        }
        if (entry.isDirectory()) {
          try { await this.assertContained(slash(path.relative(this.workspaceRoot, absolute))); }
          catch { continue; }
          await visit(absolute);
        }
        else if (entry.isFile()) {
          const relative = slash(path.relative(this.workspaceRoot, absolute));
          if (matcher.test(relative)) results.push(relative);
        }
      }
    };
    await visit(this.workspaceRoot);
    return results.sort((a, b) => a.localeCompare(b)).slice(0, maxResults);
  }

  async grep(query, {
    isRegex = false,
    pathFilter = '**/*',
    maxResults = 200,
    maxFileBytes = this.maxFileBytes,
    maxLineChars = DEFAULT_MAX_MATCH_LINE_CHARS,
    signal
  } = {}) {
    if (typeof query !== 'string' || !query || query.length > 500) throw new Error('检索词长度须为 1–500');
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 2000) throw new Error('maxResults 须为 1–2000');
    if (!Number.isInteger(maxLineChars) || maxLineChars < 40 || maxLineChars > 10000) throw new Error('maxLineChars 须为 40–10000');
    let matcher;
    if (isRegex && !safeRegexSource(query)) throw new Error('正则表达式过于复杂或可能导致超时');
    try { matcher = isRegex ? new RegExp(query, 'iu') : null; }
    catch { throw new Error('非法正则表达式'); }
    const files = await this.listFiles(pathFilter, { maxResults: 5000, signal });
    const matches = [];
    for (const file of files) {
      signal?.throwIfAborted();
      const target = await this.assertContained(file);
      const info = await stat(target.absolute);
      if (info.size > maxFileBytes) continue;
      const bytes = await readFile(target.absolute);
      if (looksBinary(bytes)) continue;
      const text = decodeUtf8(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      for (const [index, line] of text.split('\n').entries()) {
        matcher?.lastIndex && (matcher.lastIndex = 0);
        if (matcher ? matcher.test(line) : line.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
          matches.push(line.length > maxLineChars
            ? { file, line: index + 1, content: line.slice(0, maxLineChars), line_chars: line.length, truncated: true }
            : { file, line: index + 1, content: line });
          if (matches.length >= maxResults) return matches;
        }
      }
    }
    return matches;
  }

  async readFile(filePath, { startLine = 1, endLine = null, maxBytes = this.maxFileBytes, signal } = {}) {
    signal?.throwIfAborted();
    const target = await this.assertContained(filePath);
    const info = await stat(target.absolute);
    if (!info.isFile()) throw new Error('目标不是文件');
    if (info.size > maxBytes) throw new Error(`文件超过读取上限 ${maxBytes} bytes`);
    const bytes = await readFile(target.absolute);
    if (looksBinary(bytes)) throw new Error('拒绝读取二进制文件');
    const hadUtf8Bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const rawText = decodeUtf8(bytes).replace(/^\uFEFF/, '');
    const originalEol = detectEol(rawText);
    const normalized = rawText.replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n');
    const first = Math.max(1, Number(startLine) || 1);
    const last = Math.min(lines.length, endLine == null ? lines.length : Math.max(first, Number(endLine) || first));
    const selected = lines.slice(first - 1, last);
    return {
      filePath: target.relative,
      content: selected.join('\n'),
      renderedContent: selected.map((line, index) => `${first + index}→${line}`).join('\n'),
      contentHash: sha256(bytes),
      originalEol,
      hadUtf8Bom,
      lineRange: [first, last]
    };
  }

  async writeFile(filePath, content, { expectedHash = null, createBackup = true } = {}) {
    if (createBackup !== true) throw new Error('写入必须启用自动备份');
    const target = await this.assertContained(filePath, { allowMissing: true });
    const present = await exists(target.absolute);
    let backup;
    if (present) {
      const current = await readFile(target.absolute);
      const currentHash = sha256(current);
      if (expectedHash === null || currentHash !== expectedHash) throw new StaleFileError('文件已在读取后发生变化，拒绝覆盖');
      backup = await this.createBackup(target.relative, current, currentHash, 'write');
    } else if (expectedHash !== null) throw new StaleFileError('目标文件不存在，但传入了旧版本 Hash');
    await mkdir(path.dirname(target.absolute), { recursive: true });
    const receipt = await this.atomicReplace(target.absolute, Buffer.from(String(content), 'utf8'));
    return { file_path: target.relative, new_hash: receipt, backup };
  }

  async editFile(filePath, oldString, newString, { expectedHash, createBackup = true } = {}) {
    if (createBackup !== true) throw new Error('编辑必须启用自动备份');
    const full = await this.readFile(filePath);
    if (full.contentHash !== expectedHash) throw new StaleFileError('文件已在读取后发生变化，拒绝编辑');
    const occurrences = full.content.split(oldString).length - 1;
    if (occurrences !== 1) throw new Error(`oldString 必须恰好匹配一次，实际 ${occurrences} 次`);
    let next = full.content.replace(oldString, newString);
    if (full.originalEol === 'crlf') next = next.replace(/\n/g, '\r\n');
    if (full.hadUtf8Bom) next = `\uFEFF${next}`;
    const target = await this.assertContained(filePath);
    const current = await readFile(target.absolute);
    if (sha256(current) !== expectedHash) throw new StaleFileError('文件已在编辑提交前发生变化，拒绝覆盖');
    const backup = await this.createBackup(target.relative, current, expectedHash, 'edit');
    const newHash = await this.atomicReplace(target.absolute, Buffer.from(next, 'utf8'));
    return { file_path: target.relative, new_hash: newHash, backup };
  }

  async createBackup(relativePath, bytes, originalHash, operation) {
    const backupId = `backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const backupPath = slash(path.posix.join(this.backupRoot, backupId, relativePath));
    const target = await this.assertContained(backupPath, { allowMissing: true });
    await mkdir(path.dirname(target.absolute), { recursive: true });
    await writeFile(target.absolute, bytes, { flag: 'wx' });
    const record = {
      backup_id: backupId,
      original_path: relativePath,
      backup_path: backupPath,
      original_hash: originalHash,
      created_at: new Date().toISOString(),
      operation
    };
    const indexPath = slash(path.posix.join(this.backupRoot, 'index.json'));
    let records = [];
    try { records = JSON.parse((await readFile(this.normalizePath(indexPath).absolute, 'utf8')) || '[]'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    records.push(record);
    const indexTarget = await this.assertContained(indexPath, { allowMissing: true });
    await mkdir(path.dirname(indexTarget.absolute), { recursive: true });
    await this.atomicReplace(indexTarget.absolute, Buffer.from(`${JSON.stringify(records, null, 2)}\n`, 'utf8'));
    return record;
  }

  async listBackups(filePath = null) {
    const indexPath = this.normalizePath(path.posix.join(this.backupRoot, 'index.json')).absolute;
    try {
      const records = JSON.parse(await readFile(indexPath, 'utf8'));
      return filePath ? records.filter(record => record.original_path === this.normalizePath(filePath).relative) : records;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  // 超限工具结果的落盘出口。写入 this.resultRoot（默认 .aha/tool-results/），
  // 该目录位于工作区内，模型可用 Read 按返回的 filePath 取回；因为 listFiles 会跳过
  // 工作区根的 .aha，它自己不会再被检索到。返回的是工作区相对路径。
  async persistToolResult(label, text) {
    const safe = String(label ?? 'result').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'result';
    const target = await this.assertContained(slash(path.posix.join(this.resultRoot, `${safe}.json`)), { allowMissing: true });
    const bytes = Buffer.from(String(text), 'utf8');
    await mkdir(path.dirname(target.absolute), { recursive: true });
    await this.atomicReplace(target.absolute, bytes);
    return { filePath: target.relative, bytes: bytes.length };
  }

  async restoreBackup(backupId) {
    const record = (await this.listBackups()).find(item => item.backup_id === backupId);
    if (!record) throw new Error('找不到该备份编号');
    const backupTarget = await this.assertContained(record.backup_path);
    const bytes = await readFile(backupTarget.absolute);
    if (sha256(bytes) !== record.original_hash) throw new Error('备份内容 Hash 校验失败，拒绝恢复');
    const originalTarget = await this.assertContained(record.original_path, { allowMissing: true });
    let recoveryBackup;
    if (await exists(originalTarget.absolute)) {
      const current = await readFile(originalTarget.absolute);
      recoveryBackup = await this.createBackup(record.original_path, current, sha256(current), 'write');
    }
    const newHash = await this.atomicReplace(originalTarget.absolute, bytes);
    return { file_path: record.original_path, new_hash: newHash, backup: recoveryBackup, restored_from: backupId };
  }

  async atomicReplace(targetPath, bytes) {
    const tempPath = `${targetPath}.aha-tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    await mkdir(path.dirname(targetPath), { recursive: true });
    const handle = await open(tempPath, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    try { await renameWithRetry(tempPath, targetPath); }
    catch (error) { await unlink(tempPath).catch(() => {}); throw error; }
    return sha256(bytes);
  }
}

export class MemoryHost {
  constructor(files = {}) {
    this.files = new Map(Object.entries(files).map(([name, content]) => [slash(name), Buffer.from(content)]));
    this.backups = [];
  }

  async init() { return this; }
  async listFiles(pattern = '**/*') { const matcher = globRegex(pattern); return [...this.files.keys()].filter(name => matcher.test(name)).sort(); }
  async grep(query, { isRegex = false, pathFilter = '**/*', maxResults = 200, maxLineChars = DEFAULT_MAX_MATCH_LINE_CHARS } = {}) {
    const matcher = isRegex ? new RegExp(query, 'iu') : null;
    const matches = [];
    for (const file of await this.listFiles(pathFilter)) {
      for (const [index, line] of this.files.get(file).toString('utf8').replace(/\r\n?/g, '\n').split('\n').entries()) {
        const hit = matcher ? matcher.test(line) : line.toLowerCase().includes(query.toLowerCase());
        if (hit) matches.push(line.length > maxLineChars
          ? { file, line: index + 1, content: line.slice(0, maxLineChars), line_chars: line.length, truncated: true }
          : { file, line: index + 1, content: line });
        if (matches.length >= maxResults) return matches;
      }
    }
    return matches;
  }
  async persistToolResult(label, text) {
    const safe = String(label ?? 'result').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120) || 'result';
    const name = slash(`${DEFAULT_RESULT_ROOT}/${safe}.json`);
    const bytes = Buffer.from(String(text), 'utf8');
    this.files.set(name, bytes);
    return { filePath: name, bytes: bytes.length };
  }
  async readFile(filePath, { startLine = 1, endLine = null } = {}) {
    const bytes = this.files.get(slash(filePath));
    if (!bytes) { const error = new Error('文件不存在'); error.code = 'ENOENT'; throw error; }
    const raw = bytes.toString('utf8').replace(/^\uFEFF/, '');
    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    const last = endLine == null ? lines.length : endLine;
    const selected = lines.slice(startLine - 1, last);
    return { filePath: slash(filePath), content: selected.join('\n'), renderedContent: selected.map((line, index) => `${startLine + index}→${line}`).join('\n'), contentHash: sha256(bytes), originalEol: detectEol(raw), hadUtf8Bom: false, lineRange: [startLine, Math.min(last, lines.length)] };
  }
  async writeFile(filePath, content, { expectedHash = null, createBackup = true } = {}) {
    if (!createBackup) throw new Error('写入必须启用备份');
    const name = slash(filePath), current = this.files.get(name);
    if (current && sha256(current) !== expectedHash) throw new StaleFileError('文件已变化');
    if (!current && expectedHash !== null) throw new StaleFileError('文件不存在');
    let backup;
    if (current) { backup = { backup_id: `backup-${this.backups.length + 1}`, original_path: name, bytes: Buffer.from(current), original_hash: sha256(current), operation: 'write', created_at: new Date().toISOString() }; this.backups.push(backup); }
    const bytes = Buffer.from(String(content)); this.files.set(name, bytes);
    return { file_path: name, new_hash: sha256(bytes), backup };
  }
  async editFile(filePath, oldString, newString, options) {
    const read = await this.readFile(filePath);
    const count = read.content.split(oldString).length - 1;
    if (count !== 1) throw new Error(`oldString 必须恰好匹配一次，实际 ${count} 次`);
    return this.writeFile(filePath, read.content.replace(oldString, newString), options);
  }
  async listBackups(filePath = null) { return this.backups.filter(item => !filePath || item.original_path === slash(filePath)).map(({ bytes, ...item }) => item); }
  async restoreBackup(backupId) {
    const record = this.backups.find(item => item.backup_id === backupId);
    if (!record) throw new Error('找不到备份');
    const current = this.files.get(record.original_path);
    if (current) this.backups.push({ backup_id: `backup-${this.backups.length + 1}`, original_path: record.original_path, bytes: Buffer.from(current), original_hash: sha256(current), operation: 'write', created_at: new Date().toISOString() });
    this.files.set(record.original_path, Buffer.from(record.bytes));
    return { file_path: record.original_path, new_hash: sha256(record.bytes), restored_from: backupId };
  }
}
