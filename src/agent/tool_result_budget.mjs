// 单次工具结果的体积闸门。
//
// 设计照抄 Claude Code 的两个文件：
//   src/constants/toolLimits.ts        —— 系统级/单条/单轮 三层阈值
//   src/utils/toolResultStorage.ts     —— 超限「落盘 + 预览」，而不是截断丢信息
//
// 一处刻意的差异：Claude Code 的预算单位是「字符」，并把 token 换算硬编码成
// BYTES_PER_TOKEN = 4（对中文密集内容会低估约一倍）。这里的阈值全部直接按字符计，
// 不做 bytes→token 换算，避免同样的中文大结果从缝里漏过去。

export const PERSISTED_OUTPUT_TAG = '<persisted-output>';

/** 系统级上限：任何单条工具结果都不允许超过这个字符数（工具只能声明更低的）。 */
export const DEFAULT_MAX_RESULT_CHARS = 50_000;

/** 工具可以声明更低的上限。Grep 对标 Claude Code 的 maxResultSizeChars: 20_000。 */
export const MAX_RESULT_CHARS_BY_TOOL = { Grep: 20_000 };

/** 单条 user 消息内所有工具结果之和的上限（一轮里 N 个工具同时命中时兜底）。 */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

/** 落盘后回给模型的预览长度，对标 Claude Code 的 PREVIEW_SIZE_BYTES = 2000。 */
export const PREVIEW_CHARS = 2_000;

export function resultMaxChars(name) {
  return MAX_RESULT_CHARS_BY_TOOL[name] ?? DEFAULT_MAX_RESULT_CHARS;
}

function measure(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text?.length ?? 0;
}

function previewOf(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length <= PREVIEW_CHARS ? text : text.slice(0, PREVIEW_CHARS);
}

export function renderToolResults(results) {
  return `Tool results (trusted execution data; matched 1:1 by id):\n${JSON.stringify(results)}`;
}

/**
 * 把过大的工具结果换成「落盘 + 预览」。
 *
 * 两趟：
 *   1. 单条超过该工具上限 → 落盘（Grep 20K，其余 50K）；
 *   2. 剩下的合计仍超过单轮预算 → 从最大的开始继续落盘，直到回到预算内。
 *
 * 返回值里的 results 与入参一一对应（id/name/ok 保序保号），模型仍能 1:1 匹配调用。
 * 被落盘的那条会带上 persisted_path，模型需要细节时用 Read 去读，而不是重新检索。
 *
 * @param {Array<{id?: string, name?: string, ok?: boolean}>} results 原始工具结果
 * @param {{persist: (label: string, text: string) => Promise<{filePath: string, bytes: number}>,
 *          budget?: number, label?: string}} options persist 由调用方注入（写盘或内存）
 */
export async function applyToolResultBudget(results, { persist, budget = MAX_TOOL_RESULTS_PER_MESSAGE_CHARS, label = 'result' } = {}) {
  if (typeof persist !== 'function') throw new Error('工具结果预算需要一个 persist 落盘函数');
  const sizes = results.map(measure);
  const overLimit = new Set();
  results.forEach((item, index) => {
    if (sizes[index] > resultMaxChars(item.name)) overLimit.add(index);
  });
  let total = sizes.reduce((sum, size, index) => (overLimit.has(index) ? sum : sum + size), 0);
  if (total > budget) {
    const order = results.map((_, index) => index)
      .filter(index => !overLimit.has(index))
      .sort((a, b) => sizes[b] - sizes[a]);
    for (const index of order) {
      if (total <= budget) break;
      overLimit.add(index);
      total -= sizes[index];
    }
  }

  const kept = [];
  const persisted = [];
  for (const [index, item] of results.entries()) {
    if (!overLimit.has(index)) { kept.push(item); continue; }
    const text = JSON.stringify(item);
    const stored = await persist(`${label}-${item.id ?? index}`, text);
    persisted.push({ id: item.id ?? null, name: item.name ?? null, path: stored.filePath, bytes: stored.bytes, chars: text.length });
    kept.push({
      id: item.id,
      name: item.name,
      ok: item.ok,
      persisted: true,
      persisted_path: stored.filePath,
      persisted_chars: text.length,
      note: `${PERSISTED_OUTPUT_TAG} 结果过大（${text.length} 字符），完整内容已写入 persisted_path。需要细节时用 Read 读取该文件，不要重跑同一个检索。`,
      preview: previewOf(text)
    });
  }
  return { results: kept, persisted, chars: measure(kept) };
}
