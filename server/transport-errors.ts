/** Fetch and Node HTTP clients expose the same transient failure differently. */
export function isTransientTransportError(error: unknown) {
  const details: string[] = []
  let current = error
  const seen = new Set<unknown>()
  while (current && !seen.has(current) && seen.size < 6) {
    seen.add(current)
    if (typeof current !== 'object') { details.push(String(current)); break }
    const value = current as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown }
    details.push(String(value.message ?? ''), String(value.code ?? ''), String(value.name ?? ''))
    current = value.cause
  }
  return /fetch failed|network|socket hang up|premature close|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|ERR_STREAM_PREMATURE_CLOSE|timeout|timed out|AbortError|aborted|terminated|超过 .*秒/i.test(details.join(' '))
}
