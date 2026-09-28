export type ModelFailureKind = 'content_rejected' | 'channel_unavailable' | 'access_denied' | 'quota_exhausted' | 'invalid_request' | 'transient' | 'other'

/** Inspect error envelopes only; successful generated content is never a routing signal. */
export function classifyModelFailure(status: number, body: unknown): ModelFailureKind {
  if (status < 400) return 'other'
  const parts: string[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number) => {
    if (depth > 6 || value == null || seen.has(value)) return
    seen.add(value)
    if (typeof value === 'string') { parts.push(value); return }
    if (typeof value !== 'object') return
    const row = value as Record<string, unknown>
    // Async providers put the rejection in data.task_status_msg. Keep visiting
    // error envelopes only: prompts and generated task_result/content are not
    // evidence of a provider stop decision.
    for (const key of ['code', 'type', 'message', 'task_status_msg', 'error', 'data', 'upstream', 'provider_response', 'cause']) visit(row[key], depth + 1)
  }
  visit(body, 0)
  const text = parts.join(' ')
  if (/MODEL_CONTENT_REJECTED|content_(?:policy_violation|rejected|filter(?:ed)?)|safety_(?:rejected|violation)|moderation_(?:blocked|rejected)|(?:failure|failed) to pass (?:the )?(?:risk control|content moderation|safety) (?:system|check)|(?:content|prompt|image|video) (?:was |is )?(?:rejected|blocked|flagged) (?:by|due to|for) (?:the )?(?:safety|moderation|content policy)|(?:内容|安全|风控)审核(?:不通过|未通过|失败|拒绝)/i.test(text)) return 'content_rejected'
  if (/insufficient_quota|quota_exceeded|credit_balance_too_low|insufficient (?:credits|balance)|余额不足/i.test(text)) return 'quota_exhausted'
  if (status === 401 || status === 403 || /authentication_error|permission_error|invalid_api_key|requires a .*subscription|credentials are FREE tier/i.test(text)) return 'access_denied'
  // Gateways can restore a route later; this is a short probe budget, not a
  // declaration that the model does not exist or a permission to switch models.
  if (/model_not_found|No available channel|no available (?:provider|route)|无可用渠道|无可用通道/i.test(text)) return 'channel_unavailable'
  if (status === 400 || status === 404 || /invalid_request_error|context_length_exceeded/i.test(text)) return 'invalid_request'
  return [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 529].includes(status) ? 'transient' : 'other'
}

/** Explicit upstream stop decisions override workflow retry patterns. */
export function modelRetryStopped(message: string): boolean {
  return /VOICE_(?:BINDING_MISSING|BINDING_INVALID|IDENTITY_AMBIGUOUS|PROVIDER_UNSUPPORTED|ELEMENT_MISSING|ASSET_UNAVAILABLE|REVIEW_REQUIRED|REVIEW_INVALID)|MODEL_(?:CONTENT_REJECTED|TRANSPORT_EXHAUSTED|TRANSPORT_DEADLINE|CHANNEL_UNAVAILABLE|ACCESS_DENIED|QUOTA_EXHAUSTED|REQUEST_INVALID)|"retryable"\s*:\s*false|"retryExhausted"\s*:\s*true/.test(message)
}
