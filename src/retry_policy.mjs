// 重试分级。
//
// 对标 Claude Code 的 src/services/api/withRetry.ts:760-786（shouldRetry 白名单）：
// 只有 408 / 409 / 429 / 401 / 5xx 和连接层错误会重试，其余状态码一律不重试。
// 尤其是 400 —— 上下文超限、参数非法都属于「重发同样的包只会再错一次」，
// 之前的实现把 400 也重试了 3 次，等于把几十 MB 的请求体重复上传。
//
// 这里额外区分两类错误：
//   • 带 HTTP status 的（模型服务返回的）→ 走状态码白名单；
//   • 不带 status 的（本地 JSON 解析 / schema 校验失败）→ 仍然重试，
//     而且允许追加「只修复格式」的提示，这是唯一能让重试有意义的场景。

export function isRetryableProviderError(error) {
  const status = error?.status;
  if (status == null) return true;
  if (status === 408 || status === 409 || status === 429) return true;
  return status >= 500;
}

/** 只有本地校验类失败才值得给模型追加「修复 JSON」的提示；HTTP 错误追加它毫无意义。 */
export function shouldAppendRepairFeedback(error) {
  return error?.status == null;
}
