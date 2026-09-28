type JsonAtom = string | number | boolean | null
type GraphValue = JsonAtom | { ref: number }
type GraphNode = { kind: 'array'; values: GraphValue[] } | { kind: 'object'; entries: Array<[string, GraphValue]> }
export type ExecutionGraph = { format: 'execution-graph-v1'; root: GraphValue; nodes: GraphNode[] }

/** Lossless JSON-value storage with both identity and structural deduplication.
 * Branch snapshots cloned by JSON/structuredClone must share identical subtrees
 * again at the storage boundary, without dropping any saved evidence. */
export function encodeExecutionGraph(value: unknown): ExecutionGraph {
  const nodes: GraphNode[] = []
  const identities = new WeakMap<object, number>()
  const visiting = new WeakSet<object>()
  const structures = new Map<string, number>()
  const encode = (current: unknown, inArray = false): GraphValue | undefined => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number') return Number.isFinite(current) ? current : null
    if (typeof current === 'bigint') throw new Error('EXECUTION_SERIALIZATION_INVALID: 执行状态包含无法保存的 BigInt')
    if (typeof current !== 'object') return inArray ? null : undefined
    if (current instanceof Date) return current.toJSON()
    const known = identities.get(current)
    if (known !== undefined) return { ref: known }
    if (visiting.has(current)) throw new Error('EXECUTION_SERIALIZATION_INVALID: 执行状态存在循环引用，保留当前结果并停止后续节点')
    visiting.add(current)
    const node: GraphNode = Array.isArray(current)
      ? { kind: 'array', values: Array.from(current, item => encode(item, true) ?? null) }
      : { kind: 'object', entries: Object.entries(current).flatMap(([key, item]) => {
          const encoded = encode(item)
          return encoded === undefined ? [] : [[key, encoded] as [string, GraphValue]]
        }) }
    const signature = JSON.stringify(node)
    let id = structures.get(signature)
    if (id === undefined) { id = nodes.length; nodes.push(node); structures.set(signature, id) }
    identities.set(current, id)
    visiting.delete(current)
    return { ref: id }
  }
  return { format: 'execution-graph-v1', root: encode(value) ?? null, nodes }
}

const ROOT_FIELDS = ['context', 'branchHistory'] as const
const STORYBOARD_PLAN_FIELDS = ['storyboardSplitPlan', 'storyboardSplitCandidate'] as const
const RUN_FIELDS = ['context', 'inputs', 'inputContext', 'routeInputContext', 'routeInputOverrides', 'attempts', 'retryFeedback', 'loopPrevious', 'loopItem', 'branchState', 'branchCarry', ...STORYBOARD_PLAN_FIELDS] as const
type StoredExecution = Record<string, unknown>
type StorageEnvelope = { format: 'execution-state-v1'; graph: ExecutionGraph }

/** Keep the public run/output index available to SQL and compact polling clients.
 * Only snapshot fields use references; all evidence is retained in one graph. */
export function encodeExecutionState(state: StoredExecution): StoredExecution {
  if (state._executionStorage !== undefined) {
    decodeExecutionState(state)
    return state
  }
  const values: unknown[] = []
  const extract = (source: StoredExecution, fields: readonly string[]) => {
    const result = { ...source }
    for (const field of fields) if (source[field] !== undefined) {
      result[field] = { slot: values.length }
      values.push(source[field])
    }
    return result
  }
  const stored = extract(state, ROOT_FIELDS)
  if (Array.isArray(state.nodeRuns)) stored.nodeRuns = state.nodeRuns.map(run =>
    run && typeof run === 'object' && !Array.isArray(run) ? extract(run as StoredExecution, RUN_FIELDS) : run)
  stored._executionStorage = { format: 'execution-state-v1', graph: encodeExecutionGraph(values) } satisfies StorageEnvelope
  return stored
}

export function decodeExecutionState<T = StoredExecution>(stored: StoredExecution): T {
  if (stored._executionStorage === undefined) return stored as T
  const envelope = stored._executionStorage as StorageEnvelope
  if (envelope?.format !== 'execution-state-v1') throw new Error('EXECUTION_STORAGE_INVALID: 不支持的执行记录格式')
  const values = decodeExecutionGraph<unknown[]>(envelope.graph)
  if (!Array.isArray(values)) throw new Error('EXECUTION_STORAGE_INVALID: 执行记录快照无效')
  const restore = (source: StoredExecution, fields: readonly string[], legacyInlineFields: readonly string[] = []) => {
    const result = { ...source }
    for (const field of fields) if (source[field] !== undefined) {
      const reference = source[field] as { slot: number }
      // Older execution-state-v1 writers left then-unknown metadata inline.
      // Only the codec's exact one-key slot marker denotes a stored reference;
      // an inline plan or future metadata value remains lossless JSON.
      if (legacyInlineFields.includes(field) && (!reference || typeof reference !== 'object'
        || Array.isArray(reference) || Object.keys(reference).length !== 1 || !Object.hasOwn(reference, 'slot'))) continue
      if (!reference || typeof reference !== 'object' || !Number.isInteger(reference.slot) || reference.slot < 0 || reference.slot >= values.length) {
        throw new Error('EXECUTION_STORAGE_INVALID: 执行记录快照引用无效')
      }
      result[field] = values[reference.slot]
    }
    return result
  }
  const state = restore(stored, ROOT_FIELDS)
  delete state._executionStorage
  if (Array.isArray(stored.nodeRuns)) state.nodeRuns = stored.nodeRuns.map(run =>
    run && typeof run === 'object' && !Array.isArray(run) ? restore(run as StoredExecution, RUN_FIELDS, STORYBOARD_PLAN_FIELDS) : run)
  return state as T
}

export function decodeExecutionGraph<T = unknown>(graph: ExecutionGraph): T {
  if (graph?.format !== 'execution-graph-v1' || !Array.isArray(graph.nodes)) throw new Error('EXECUTION_STORAGE_INVALID: 执行记录格式无效')
  const decoded: unknown[] = []
  const decode = (value: GraphValue): unknown => {
    if (!value || typeof value !== 'object') return value
    if (!Number.isInteger(value.ref) || value.ref < 0 || value.ref >= decoded.length) throw new Error('EXECUTION_STORAGE_INVALID: 执行记录引用无效')
    return decoded[value.ref]
  }
  for (const node of graph.nodes) {
    if (node.kind === 'array' && Array.isArray(node.values)) decoded.push(node.values.map(decode))
    else if (node.kind === 'object' && Array.isArray(node.entries)) {
      const object: Record<string, unknown> = {}
      for (const [key, value] of node.entries) Object.defineProperty(object, key, { value: decode(value), enumerable: true, writable: true, configurable: true })
      decoded.push(object)
    } else throw new Error('EXECUTION_STORAGE_INVALID: 执行记录节点无效')
  }
  return decode(graph.root) as T
}
