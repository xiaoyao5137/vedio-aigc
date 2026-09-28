/** Resolve a reviewer's declared policy from the effective gate configuration.
 * Explicit field selection avoids copying unrelated configuration into a model
 * prompt. The caller supplies nodes from the current execution/loop, including
 * any run-time parameter overrides, and the normal parameter resolver. */
export function resolveNodePolicy<N extends { id: string }>(source: unknown, nodes: N[], resolve: (node: N) => Record<string, unknown>) {
  if (source === undefined || source === null || source === '') return undefined
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('REVIEW_POLICY_INVALID: reviewPolicySource 必须指定 nodeId 与 fields')
  const { nodeId, fields } = source as Record<string, unknown>
  if (typeof nodeId !== 'string' || !nodeId.trim() || !Array.isArray(fields) || !fields.length
    || fields.some(field => typeof field !== 'string' || !field.trim() || ['__proto__', 'constructor', 'prototype'].includes(field))
    || new Set(fields).size !== fields.length) throw new Error('REVIEW_POLICY_INVALID: reviewPolicySource 的节点或字段列表无效')
  const matches = nodes.filter(node => node.id === nodeId)
  if (matches.length !== 1) throw new Error('REVIEW_POLICY_INVALID: 当前执行范围内必须唯一找到策略节点 ' + nodeId)
  const values = resolve(matches[0])
  const policy: Record<string, unknown> = {}
  for (const field of fields as string[]) {
    if (!Object.hasOwn(values, field) || values[field] === undefined || values[field] === null
      || (typeof values[field] === 'number' && !Number.isFinite(values[field]))
      || (typeof values[field] === 'string' && values[field].includes('${'))) throw new Error('REVIEW_POLICY_INVALID: 策略字段未解析 ' + field)
    policy[field] = values[field]
  }
  return policy
}
