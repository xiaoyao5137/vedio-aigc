/** Read-only ledger selectors. Prefix equality treats %, _ and quotes literally;
 * it must never widen a source execution into unrelated successful responses. */
export function modelExecutionBindingFilters(query: URLSearchParams, offset = 0) {
  const clauses: string[] = [], values: string[] = []
  const workflowId = query.get('workflowId'), nodeId = query.get('nodeId'), operation = query.get('operation'), prefix = query.get('requestKeyPrefix')
  const add = (expression: string, value: string | null) => {
    if (!value) return
    values.push(value)
    clauses.push(expression.replaceAll('?', `$${offset + values.length}`))
  }
  if (prefix) {
    const parts = prefix.split(':')
    if (!workflowId?.trim() || !nodeId?.trim() || !['history.scene-outline', 'history.storyboard'].includes(operation ?? '') || parts.length !== 7
      || !parts[0]?.trim() || !/^attempt-[1-9]\d*$/.test(parts[1]) || !/^revision-\d+$/.test(parts[2])
      || parts[3] !== nodeId || !/^\d+$/.test(parts[4]) || operation === 'history.storyboard' && !parts[5]?.trim()
      || parts[6] !== 'generation-' || parts.some(part => part !== part.trim())) {
      throw Error('MODEL_LEDGER_FILTER_INVALID: requestKeyPrefix requires the complete source namespace/attempt/revision/node/loop/scene identity and workflow/node/operation filters')
    }
  }
  add('workflow_id = ?', workflowId)
  add('node_id = ?', nodeId)
  add("request_data->>'operation' = ?", operation)
  add("left(request_data->>'requestKey', length(?)) = ?", prefix)
  return { clauses, values }
}
