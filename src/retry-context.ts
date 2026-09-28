/** Resolve explicit retry context sources without inheriting absent values from
 * a rewind snapshot. Arrays replace as JSON values; false, zero and empty text
 * are valid selections. Self-contained for persisted editable branch code. */
export function resolveRetryContextPatch(context: Record<string, unknown>, sources?: Record<string, string[]>): Record<string, unknown> {
  const invalid = (reason: string): never => { throw Error('RETRY_CONTEXT_INVALID: ' + reason) }
  const unsafe = new Set(['__proto__', 'prototype', 'constructor'])
  const plain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  if (sources === undefined) return {}
  if (!plain(sources)) invalid('retryContextSources 必须是目标根字段到来源路径数组的对象')
  if (!plain(context)) invalid('context 必须是对象')
  const patch: Record<string, unknown> = {}
  for (const [target, paths] of Object.entries(sources)) {
    if (!target.trim() || target !== target.trim() || target.includes('.') || unsafe.has(target)) invalid('目标必须是合法根字段，禁止 prototype 路径：' + target)
    if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string' || !path.trim()
      || path.split('.').some(key => !key || key !== key.trim() || unsafe.has(key)))) invalid('来源必须是非空安全路径数组：' + target)
    let selected: unknown = null
    for (const path of paths) {
      let current: unknown = context
      for (const key of path.split('.')) {
        if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) { current = undefined; break }
        current = (current as Record<string, unknown>)[key]
      }
      if (current !== null && current !== undefined) { selected = current; break }
    }
    try {
      const json = JSON.stringify(selected)
      if (json === undefined) invalid('来源值不能序列化为 JSON：' + target)
      patch[target] = JSON.parse(json)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('RETRY_CONTEXT_INVALID:')) throw error
      invalid('来源值不能序列化为 JSON：' + target)
    }
  }
  return patch
}
