/** Collect independent report errors so one same-material correction receives
 * every actionable diagnosis. Execution and infrastructure errors stay intact. */
export function validateReviewParts<T extends Record<string, () => unknown>>(checks: T): { [K in keyof T]: ReturnType<T[K]> } {
  const results: Record<string, unknown> = {}, errors: string[] = []
  for (const [name, check] of Object.entries(checks)) {
    try { results[name] = check() } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('REVIEW_RESULT_INVALID:')) throw error
      errors.push(name + ': ' + error.message.slice('REVIEW_RESULT_INVALID:'.length).trim())
    }
  }
  if (errors.length) throw new Error('REVIEW_RESULT_INVALID: ' + errors.map((error, index) => '[' + (index + 1) + '] ' + error).join('\n'))
  return results as { [K in keyof T]: ReturnType<T[K]> }
}
