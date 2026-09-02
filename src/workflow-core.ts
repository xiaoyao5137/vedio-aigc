export type GraphNode = {
  id: string
  kind: string
  childIds?: string[]
  parentId?: string
}

export type GraphWorkflow<Node extends GraphNode = GraphNode> = {
  nodes: Node[]
  edges: Array<{ from: string; to: string }>
}

export type VariableProducer = {
  nodeId: string
  nodeTitle: string
}

export type VariableMetadata = VariableProducer & {
  chineseName?: string
}

type VariableNode = GraphNode & {
  title: string
  resultVar: string
  params?: Array<{ name: string; englishName?: string; value?: string }>
  loop?: { itemVar?: string }
}

export type StepRunStatus = 'idle' | 'running' | 'success' | 'failed' | 'skipped'

export type NodeRunCondition = {
  path: string
  equals: unknown
}

export type LoopRunSnapshot = {
  node: { id: string }
  loopGroupId?: string
  loopIndex?: number
  status?: StepRunStatus
}

/** Detects content migrations even when the number of stored records is unchanged. */
export function serializedValuesDiffer(current: unknown, next: unknown) {
  return JSON.stringify(current) !== JSON.stringify(next)
}

/** Identifies live runner snapshots that still contain nodes removed from the workflow definition. */
export function hasRemovedExecutionNodes<Node extends GraphNode>(workflow: GraphWorkflow<Node>, runs: Array<{ node: { id: string } }>) {
  const currentNodeIds = new Set(workflow.nodes.map((node) => node.id))
  return runs.some((run) => !currentNodeIds.has(run.node.id))
}

function executionNodeContract(node: { id: string } & Record<string, unknown>) {
  return {
    id: node.id,
    kind: node.kind,
    modelId: node.modelId,
    operation: node.operation,
    resultVar: node.resultVar,
    prompt: node.prompt,
    code: node.code,
    params: node.params,
    parentId: node.parentId,
    childIds: node.childIds,
    runIf: node.runIf,
  }
}

/** Invalidates live snapshots after nodes, parameters, prompts, or loop topology change. */
export function hasExecutionPlanMismatch<Node extends GraphNode>(workflow: GraphWorkflow<Node>, runs: Array<{ node: Node }>) {
  const currentById = new Map(workflow.nodes.map((node) => [node.id, node]))
  const runNodeIds = new Set(runs.map((run) => run.node.id))
  if (runNodeIds.size !== currentById.size || [...currentById.keys()].some((id) => !runNodeIds.has(id))) return true
  return runs.some((run) => {
    const current = currentById.get(run.node.id)
    return !current || JSON.stringify(executionNodeContract(current as Node & Record<string, unknown>))
      !== JSON.stringify(executionNodeContract(run.node as Node & Record<string, unknown>))
  })
}

/** Prevents a direct retry from jumping over an idle or failed prerequisite. */
export function firstBlockingRunIndex(
  runs: Array<{ status?: StepRunStatus }>,
  requestedIndex: number,
) {
  const boundedIndex = Math.max(0, Math.min(requestedIndex, runs.length - 1))
  const blocker = runs.findIndex((run, index) => index <= boundedIndex && run.status !== 'success' && run.status !== 'skipped')
  return blocker >= 0 ? blocker : boundedIndex
}

export function missingRequiredParamNames(
  params: Array<{ name: string; englishName?: string; required: boolean }>,
  values: Record<string, unknown>,
) {
  const missing = (value: unknown) => value === undefined
    || value === null
    || (typeof value === 'string' && !value.trim())
    || (Array.isArray(value) && value.length === 0)
  return params
    .filter((param) => param.required && missing(values[param.englishName?.trim() || param.name]))
    .map((param) => param.name)
}

/** Returns only loop rounds that have started, in display order. */
export function availableLoopIterations(runs: LoopRunSnapshot[], loopGroupId: string) {
  return [...new Set(runs
    .filter((run) => run.loopGroupId === loopGroupId && run.loopIndex !== undefined && run.status !== 'idle')
    .map((run) => run.loopIndex as number))]
    .sort((a, b) => a - b)
}

/** Keeps the same node selected when possible while moving to another loop snapshot. */
export function findLoopSnapshotRunIndex(runs: LoopRunSnapshot[], loopGroupId: string, loopIndex: number, preferredNodeId?: string) {
  const candidates = runs
    .map((run, index) => ({ run, index }))
    .filter(({ run }) => run.loopGroupId === loopGroupId && run.loopIndex === loopIndex && run.status !== 'idle')
  return candidates.find(({ run }) => run.node.id === preferredNodeId)?.index ?? candidates.at(-1)?.index ?? -1
}

/** Resolves the concrete run behind a DAG node click without leaking a loop snapshot to nodes outside that loop. */
export function findInspectableNodeRunIndex(
  runs: LoopRunSnapshot[],
  nodeId: string,
  fallbackRunIndex: number,
  loopGroupId?: string,
  loopIndex?: number,
) {
  if (loopGroupId && loopIndex !== undefined) {
    const snapshotIndex = runs.findIndex((run) =>
      run.node.id === nodeId && run.loopGroupId === loopGroupId && run.loopIndex === loopIndex)
    if (snapshotIndex >= 0) return snapshotIndex
  }
  if (fallbackRunIndex >= 0 && runs[fallbackRunIndex]?.node.id === nodeId) return fallbackRunIndex
  const matchingRuns = runs
    .map((run, index) => ({ run, index }))
    .filter(({ run }) => run.node.id === nodeId)
  return matchingRuns.find(({ run }) => run.status === 'running')?.index
    ?? matchingRuns.filter(({ run }) => run.status !== 'idle').at(-1)?.index
    ?? matchingRuns[0]?.index
    ?? -1
}

/** Detects text that has already been irreversibly replaced by a failed character decode. */
export function containsUnicodeReplacementCharacter(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\uFFFD')
  if (Array.isArray(value)) return value.some(containsUnicodeReplacementCharacter)
  if (!value || typeof value !== 'object') return false
  return Object.values(value as Record<string, unknown>).some(containsUnicodeReplacementCharacter)
}

export function shouldRunNode(condition: NodeRunCondition | undefined, context: Record<string, unknown>) {
  if (!condition) return true
  const value = condition.path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    return (current as Record<string, unknown>)[key]
  }, context)
  return value === condition.equals
}

export function canAdvanceStep(status: StepRunStatus | undefined, stepIndex: number, stepCount: number) {
  return (status === 'success' || status === 'skipped') && stepIndex >= 0 && stepIndex < stepCount - 1
}

/** Finds the next concrete run whose workflow node has a breakpoint. */
export function findNextBreakpointIndex(
  runs: Array<{ node: { id: string } }>,
  breakpointNodeIds: ReadonlySet<string>,
  afterIndex: number,
) {
  return runs.findIndex((run, index) => index > afterIndex && breakpointNodeIds.has(run.node.id))
}

export function shouldSkipStep(status: StepRunStatus | undefined, condition: NodeRunCondition | undefined, context: Record<string, unknown>) {
  return status === 'idle' && Boolean(condition) && !shouldRunNode(condition, context)
}

type VariableRun = {
  node: VariableNode
  output?: unknown
  status?: string
}

function visitRecordPaths(value: unknown, path: string[], visitor: (path: string[]) => void) {
  visitor(path)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => visitRecordPaths(child, [...path, key], visitor))
}

/** Builds display metadata without changing the runtime context payload. Later successful runs win for patched paths. */
export function buildVariableMetadata(nodes: VariableNode[], runs: VariableRun[] = []) {
  const metadata: Record<string, VariableMetadata> = {}
  const assign = (path: string[], producer: VariableProducer, chineseName?: string, overwrite = true) => {
    const key = path.join('.')
    if (!key || (!overwrite && metadata[key])) return
    metadata[key] = { ...producer, ...(chineseName && chineseName !== path.at(-1) ? { chineseName } : {}) }
  }

  nodes.forEach((node) => {
    const producer = { nodeId: node.id, nodeTitle: node.title }
    assign([node.resultVar], producer, node.title, false)
    if (node.loop?.itemVar) assign([node.loop.itemVar], producer, `${node.title}单项`, false)
    ;(node.params ?? []).forEach((param) => {
      const englishName = param.englishName?.trim() || param.name
      if (node.kind === 'input') assign([node.resultVar, englishName], producer, param.name, false)
      const reference = param.value?.trim().match(/^\$\{([^}]+)\}$/)
      if (reference) assign(reference[1].trim().split('.'), metadata[reference[1].trim()] ?? producer, param.name, false)
    })
  })

  runs.forEach((run) => {
    if (run.status === 'idle' || run.status === 'running' || run.output === undefined) return
    const producer = { nodeId: run.node.id, nodeTitle: run.node.title }
    visitRecordPaths(run.output, [run.node.resultVar], (path) => assign(path, producer, path.length === 1 ? run.node.title : metadata[path.join('.')]?.chineseName))
    if (run.output && typeof run.output === 'object' && !Array.isArray(run.output)) {
      const patch = (run.output as Record<string, unknown>).contextPatch
      if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
        visitRecordPaths(patch, [], (path) => assign(path, producer, metadata[path.join('.')]?.chineseName))
      }
    }
  })

  return metadata
}

export function resolveVariableMetadata(metadata: Record<string, VariableMetadata>, path: string[]) {
  for (let length = path.length; length > 0; length -= 1) {
    const matched = metadata[path.slice(0, length).join('.')]
    if (matched) return length === path.length ? matched : { nodeId: matched.nodeId, nodeTitle: matched.nodeTitle }
  }
  return undefined
}

export function downstreamNodeIds<Node extends GraphNode>(workflow: GraphWorkflow<Node>, nodeId: string, visited = new Set<string>()): string[] {
  if (visited.has(nodeId)) return []
  visited.add(nodeId)
  const direct = workflow.edges.filter((edge) => edge.from === nodeId).map((edge) => edge.to)
  return direct.concat(...direct.map((childId) => downstreamNodeIds(workflow, childId, visited)))
}

export function scopedLoopNodes<Node extends GraphNode>(workflow: GraphWorkflow<Node>, loopNodeId: string, ordered: Node[]) {
  const loopNode = workflow.nodes.find((node) => node.id === loopNodeId)
  if (!loopNode) return []
  const explicitIds = loopNode.childIds?.length
    ? new Set(loopNode.childIds)
    : new Set(workflow.nodes.filter((node) => node.parentId === loopNodeId).map((node) => node.id))
  if (explicitIds.size) return ordered.filter((node) => explicitIds.has(node.id))
  const legacyIds = new Set(downstreamNodeIds(workflow, loopNodeId))
  return ordered.filter((node) => legacyIds.has(node.id) && node.id !== loopNodeId)
}

function extractBalancedJson(text: string) {
  for (let start = 0; start < text.length; start += 1) {
    const opener = text[start]
    if (opener !== '[' && opener !== '{') continue
    const closer = opener === '[' ? ']' : '}'
    const stack = [closer]
    let inString = false
    let escaped = false
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') {
        inString = true
        continue
      }
      if (character === '[') stack.push(']')
      else if (character === '{') stack.push('}')
      else if (character === ']' || character === '}') {
        if (stack.at(-1) !== character) break
        stack.pop()
        if (!stack.length) return text.slice(start, index + 1)
      }
    }
  }
  return undefined
}

/**
 * Repairs the common model-output mistake of putting literal ASCII quotes inside
 * a JSON string. A quote is only escaped when the following token cannot legally
 * terminate a JSON key or string value, so valid JSON is left untouched.
 */
function repairUnescapedJsonStringQuotes(candidate: string) {
  let repaired = ''
  let inString = false
  let escaped = false

  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index]
    if (!inString) {
      repaired += character
      if (character === '"') inString = true
      continue
    }
    if (escaped) {
      repaired += character
      escaped = false
      continue
    }
    if (character === '\\') {
      repaired += character
      escaped = true
      continue
    }
    if (character !== '"') {
      repaired += character
      continue
    }

    let nextIndex = index + 1
    while (/\s/.test(candidate[nextIndex] ?? '')) nextIndex += 1
    const nextToken = candidate[nextIndex]
    let terminatesString = nextToken === ':' || nextToken === '}' || nextToken === ']' || nextToken === undefined
    if (nextToken === ',') {
      // A comma can be either JSON punctuation or ordinary prose inside a model
      // generated string. Treat it as JSON punctuation only when the token after
      // it can actually begin the next object property/array value. This avoids
      // corrupting text such as: 高呼"党人何罪",县令面对……
      let followingIndex = nextIndex + 1
      while (/\s/.test(candidate[followingIndex] ?? '')) followingIndex += 1
      const followingToken = candidate[followingIndex]
      terminatesString = followingToken === '"'
        || followingToken === '{'
        || followingToken === '['
        || followingToken === '}'
        || followingToken === ']'
        || followingToken === '-'
        || followingToken === 't'
        || followingToken === 'f'
        || followingToken === 'n'
        || /\d/.test(followingToken ?? '')
    }
    if (terminatesString) {
      repaired += character
      inString = false
    } else {
      repaired += '\\"'
    }
  }
  return repaired
}

export function parseStructuredJson(value: unknown) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return value as Record<string, unknown>
  const raw = String(value ?? '').trim()
  if (!raw) return undefined
  const candidates = [raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''), extractBalancedJson(raw)].filter(Boolean) as string[]
  for (const candidate of candidates) {
    for (const json of [candidate, repairUnescapedJsonStringQuotes(candidate)]) {
      try {
        const parsed = JSON.parse(json)
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown> | unknown[]
      } catch {
        continue
      }
    }
  }
  return undefined
}

export function deriveSceneOutlineMetrics(output: Record<string, unknown>) {
  const sourceScenes = output.scenes
  if (!Array.isArray(sourceScenes)) return output
  const scenes = sourceScenes.map((scene) => scene && typeof scene === 'object' && !Array.isArray(scene)
    ? { ...(scene as Record<string, unknown>), targetDuration: 15 }
    : scene)
  const totalDuration = scenes.reduce((total, scene) => {
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return total
    const duration = Number((scene as Record<string, unknown>).targetDuration)
    return total + (Number.isFinite(duration) ? duration : 0)
  }, 0)
  return {
    ...output,
    scenes,
    count: scenes.length,
    totalDuration,
  }
}

function responseRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function collectTextResponseCandidates(value: unknown, candidates: string[], visited: Set<object>) {
  if (typeof value === 'string') {
    if (value.trim()) candidates.push(value)
    return
  }
  if (!value || typeof value !== 'object' || visited.has(value)) return
  visited.add(value)
  if (Array.isArray(value)) {
    value.forEach((item) => collectTextResponseCandidates(item, candidates, visited))
    return
  }
  const record = value as Record<string, unknown>
  for (const key of ['text', 'output_text', 'content']) {
    const child = record[key]
    if (typeof child === 'string' || Array.isArray(child) || (child && typeof child === 'object')) {
      collectTextResponseCandidates(child, candidates, visited)
    }
  }
  for (const key of ['choices', 'output']) {
    const child = record[key]
    if (Array.isArray(child)) collectTextResponseCandidates(child, candidates, visited)
  }
  const message = record.message
  if (message && typeof message === 'object') collectTextResponseCandidates(message, candidates, visited)
}

function textResponseCandidates(body: unknown) {
  if (typeof body === 'string') return body.trim() ? [body] : []
  const candidates: string[] = []
  collectTextResponseCandidates(body, candidates, new Set())
  return [...new Set(candidates)]
}

function isProviderResponseEnvelope(body: unknown) {
  const record = responseRecord(body)
  if (!record) return false
  const keys = new Set(Object.keys(record))
  if (keys.has('choices') || keys.has('output')) return true
  if (!keys.has('content')) return false
  return ['id', 'model', 'object', 'role', 'stop_reason', 'stop_sequence', 'type', 'usage'].some((key) => keys.has(key))
}

function responseTerminationReason(body: unknown) {
  const record = responseRecord(body)
  if (!record) return ''
  if (typeof record.stop_reason === 'string') return record.stop_reason
  if (Array.isArray(record.choices)) {
    const choice = responseRecord(record.choices[0])
    if (typeof choice?.finish_reason === 'string') return choice.finish_reason
  }
  return ''
}

export function extractTextResponse(body: unknown) {
  if (typeof body === 'string') return body
  const candidates = textResponseCandidates(body)
  if (candidates.length) return candidates.join('\n')
  if (body === undefined || body === null) return String(body ?? '')
  return JSON.stringify(body)
}

export function normalizeStructuredTextOutput(body: unknown, text: string, outputMode: 'legacy-shots' | 'array' | 'json' | 'text' = 'legacy-shots') {
  if (outputMode === 'text') return { text, raw: body }
  const candidateTexts = [...new Set([text, ...textResponseCandidates(body)].filter((candidate) => candidate.trim()))]
  const parsed = candidateTexts.map((candidate) => parseStructuredJson(candidate)).find(Boolean)
    ?? (isProviderResponseEnvelope(body) ? undefined : parseStructuredJson(body))
  if (!parsed) {
    const reason = responseTerminationReason(body)
    if (reason === 'max_tokens' || reason === 'length') throw new Error(`文本模型输出因 ${reason} 被截断，未形成有效 JSON`)
    throw new Error('文本模型正文未返回有效 JSON')
  }
  if (Array.isArray(parsed)) {
    if (outputMode === 'json') return { items: parsed, text, raw: body }
    return { items: parsed, shots: parsed, text, raw: body }
  }
  if (outputMode === 'array' || outputMode === 'legacy-shots') {
    const items = Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed.shots) ? parsed.shots : Array.isArray(parsed.scenes) ? parsed.scenes : undefined
    if (!items) throw new Error('文本模型返回的 JSON 对象中没有 items、shots 或 scenes 数组')
    const normalized = { ...parsed, items, shots: items, text, raw: body }
    return Array.isArray(parsed.scenes) ? deriveSceneOutlineMetrics(normalized) : normalized
  }
  const normalized = { ...parsed, text, raw: body }
  return Array.isArray(parsed.scenes) ? deriveSceneOutlineMetrics(normalized) : normalized
}

function structuredRecord(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是 JSON 对象`)
  return value as Record<string, unknown>
}

function requiredString(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}.${key} 必须是非空字符串`)
  return value
}

function rejectUnexpectedKeys(record: Record<string, unknown>, allowed: string[], label: string) {
  const allowedKeys = new Set([...allowed, 'text', 'raw'])
  const unexpected = Object.keys(record).filter((key) => !allowedKeys.has(key))
  if (unexpected.length) throw new Error(`${label} 包含未声明字段：${unexpected.join(', ')}`)
}

/**
 * `audioType` classifies the primary spoken track, while ambient/action sounds
 * belong in `audioText` and `videoPrompt`. Text models commonly append those
 * sound-design labels to an otherwise unambiguous spoken type; normalize that
 * harmless variation without accepting a genuinely mixed narration/dialogue
 * contract.
 */
function normalizeStoryboardAudioType(value: unknown) {
  if (typeof value !== 'string') return value
  const normalized = value.trim()
  if (normalized === '旁白' || normalized === '对白') return normalized
  const compact = normalized.replace(/\s+/g, '')
  const primaryTypes = ['旁白', '对白'].filter((type) => compact.includes(type))
  if (primaryTypes.length !== 1) return value
  const remainder = compact
    .replace(primaryTypes[0], '')
    .replace(/[+＋、,，/／|&和与及:：()（）[\]【】-]/g, '')
  if (!remainder || /^(?:(?:环境|动作|自然)(?:音|声)|音效|音乐|配乐|同期声)+$/.test(remainder)) return primaryTypes[0]
  return value
}

const chineseDigitValues: Record<string, number> = {
  '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
}

function spokenText(audioText: string) {
  return audioText
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[^\uff1a:，,。！？!?]{1,12}[\uff1a:]\s*/, '').trim())
    .filter(Boolean)
}

function durationWordSeconds(value: string) {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if (value === '十') return 10
  if (value.startsWith('十')) return 10 + (chineseDigitValues[value[1]] ?? 0)
  if (value.endsWith('十')) return (chineseDigitValues[value[0]] ?? 0) * 10
  if (value.includes('十')) {
    const [tens, units] = value.split('十')
    return (chineseDigitValues[tens] ?? 0) * 10 + (chineseDigitValues[units] ?? 0)
  }
  return [...value].reduce((total, digit) => total * 10 + (chineseDigitValues[digit] ?? 0), 0)
}

export function estimateStoryboardTiming(audioValue: unknown, videoPromptValue: unknown) {
  const audioText = String(audioValue ?? '')
  const videoPrompt = String(videoPromptValue ?? '')
  const lines = spokenText(audioText)
  const dialogue = lines.join('\n')
  const speechCharacterCount = [...dialogue].filter((character) => /\p{Script=Han}/u.test(character)).length
  const speechSeconds = speechCharacterCount / 4
  const punctuationPauseSeconds = (dialogue.match(/[，,；;]/g) ?? []).length * 0.2
    + (dialogue.match(/[。！？!?]/g) ?? []).length * 0.4
  const speakerTurnPauseSeconds = Math.max(0, lines.length - 1) * 0.3
  const explicitPauseSeconds = [...videoPrompt.matchAll(/(?:沉默|停顿|静默|凝视|停留)(\d+(?:\.\d+)?|[零一二两三四五六七八九十]+)秒/g)]
    .reduce((total, match) => total + durationWordSeconds(match[1]), 0)
  // Reserve non-overlapping time for the reaction after the final line and a
  // stable ending composition. Establishing movement may overlap dialogue.
  const actionAndEndHoldSeconds = 2.5
  const rawRequiredSeconds = speechSeconds + punctuationPauseSeconds + speakerTurnPauseSeconds + explicitPauseSeconds + actionAndEndHoldSeconds
  return {
    speechCharacterCount,
    speechSeconds: Number(speechSeconds.toFixed(2)),
    punctuationPauseSeconds: Number(punctuationPauseSeconds.toFixed(2)),
    speakerTurnPauseSeconds: Number(speakerTurnPauseSeconds.toFixed(2)),
    explicitPauseSeconds: Number(explicitPauseSeconds.toFixed(2)),
    actionAndEndHoldSeconds,
    rawRequiredSeconds: Number(rawRequiredSeconds.toFixed(2)),
    requiredDuration: Math.max(8, Math.ceil(rawRequiredSeconds)),
  }
}

export function validateHistoricalStructuredOutput(operation: string | undefined, output: unknown, expected: Record<string, unknown> = {}) {
  if (operation !== 'history.scene-outline' && operation !== 'history.storyboard') return output
  const sourceRecord = structuredRecord(output, operation)

  if (operation === 'history.scene-outline') {
    const record = deriveSceneOutlineMetrics(sourceRecord)
    rejectUnexpectedKeys(record, ['episodeTitle', 'count', 'totalDuration', 'scenes', 'text', 'raw', 'model'], 'history.scene-outline')
    requiredString(record, 'episodeTitle', 'history.scene-outline')
    const scenes = record.scenes
    if (!Array.isArray(scenes)) throw new Error('history.scene-outline.scenes 必须是数组')
    if (!scenes.length) throw new Error('history.scene-outline.scenes 至少需要一个场景')
    const derived = record
    if (Number(derived.count) !== scenes.length) throw new Error('场景大纲 count 必须等于 scenes 数量')
    const ids = new Set<string>()
    let totalDuration = 0
    scenes.forEach((sceneValue, index) => {
      const scene = structuredRecord(sceneValue, `scenes[${index}]`)
      rejectUnexpectedKeys(scene, ['id', 'sequence', 'title', 'purpose', 'historicalBasis', 'adaptationBoundary', 'targetDuration', 'continuityFromPrevious'], `scenes[${index}]`)
      const id = requiredString(scene, 'id', `scenes[${index}]`)
      if (ids.has(id)) throw new Error(`场景大纲存在重复 id：${id}`)
      ids.add(id)
      if (Number(scene.sequence) !== index + 1) throw new Error(`scenes[${index}].sequence 必须等于 ${index + 1}`)
      requiredString(scene, 'title', `scenes[${index}]`)
      requiredString(scene, 'purpose', `scenes[${index}]`)
      const historicalBasis = requiredString(scene, 'historicalBasis', `scenes[${index}]`)
      if (!/\[史料\d+\]/.test(historicalBasis)) throw new Error(`scenes[${index}].historicalBasis 必须包含 [史料N] 引用`)
      requiredString(scene, 'adaptationBoundary', `scenes[${index}]`)
      const duration = Number(scene.targetDuration)
      if (duration !== 15) throw new Error(`scenes[${index}].targetDuration 必须固定为 15 秒`)
      if (typeof scene.continuityFromPrevious !== 'boolean') throw new Error(`scenes[${index}].continuityFromPrevious 必须是布尔值`)
      if (index === 0 && scene.continuityFromPrevious) throw new Error('第一镜 continuityFromPrevious 必须为 false')
      totalDuration += duration
    })
    if (Number(derived.totalDuration) !== totalDuration) throw new Error('场景大纲 totalDuration 必须等于所有 targetDuration 之和')
    return derived
  }

  const scene = expected.scene && typeof expected.scene === 'object' && !Array.isArray(expected.scene)
    ? expected.scene as Record<string, unknown>
    : {}
  const record: Record<string, unknown> = {
    ...sourceRecord,
    audioType: normalizeStoryboardAudioType(sourceRecord.audioType),
    historicalBasis: typeof sourceRecord.historicalBasis === 'string' && sourceRecord.historicalBasis.trim()
      ? sourceRecord.historicalBasis
      : scene.historicalBasis,
    adaptationBoundary: typeof sourceRecord.adaptationBoundary === 'string' && sourceRecord.adaptationBoundary.trim()
      ? sourceRecord.adaptationBoundary
      : scene.adaptationBoundary,
  }
  rejectUnexpectedKeys(record, ['id', 'title', 'duration', 'characters', 'visualPrompt', 'camera', 'mood', 'firstFrameMode', 'lastFramePrompt', 'videoPrompt', 'audioType', 'audioText', 'historicalBasis', 'adaptationBoundary'], 'history.storyboard')
  requiredString(record, 'id', 'history.storyboard')
  requiredString(record, 'title', 'history.storyboard')
  const duration = Number(record.duration)
  if (!Number.isInteger(duration) || duration < 8 || duration > 15) throw new Error('history.storyboard.duration 必须是 8 到 15 之间的整数')
  if (!Array.isArray(record.characters) || record.characters.some((name) => typeof name !== 'string' || !name.trim())) throw new Error('history.storyboard.characters 必须是人物姓名字符串数组')
  requiredString(record, 'visualPrompt', 'history.storyboard')
  requiredString(record, 'camera', 'history.storyboard')
  requiredString(record, 'mood', 'history.storyboard')
  const firstFrameMode = requiredString(record, 'firstFrameMode', 'history.storyboard')
  if (firstFrameMode !== 'reference' && firstFrameMode !== 'reuse_previous_tail') throw new Error('history.storyboard.firstFrameMode 只能是 reference 或 reuse_previous_tail')
  if (firstFrameMode === 'reuse_previous_tail' && scene.continuityFromPrevious !== true) throw new Error('非连续镜头不得使用 reuse_previous_tail')
  const lastFramePrompt = requiredString(record, 'lastFramePrompt', 'history.storyboard')
  const stillFrameConstraint = '【静态尾帧】只呈现动作完成后的单一时间点与最终状态；单幅全画幅画面，禁止分镜、拼贴、分栏、上下三段、连环画、重复人物；画面内禁止字幕、水印、标题、标签及任何可读文字，榜文、竹简、牌匾等文字载体只能虚焦、背向镜头或呈现不可辨纹理。'
  record.lastFramePrompt = lastFramePrompt.includes('【静态尾帧】')
    ? lastFramePrompt
    : `${lastFramePrompt}\n${stillFrameConstraint}`
  const videoPrompt = requiredString(record, 'videoPrompt', 'history.storyboard')
  const audioType = requiredString(record, 'audioType', 'history.storyboard')
  if (audioType !== '旁白' && audioType !== '对白') throw new Error('history.storyboard.audioType 只能是旁白或对白')
  const audioText = requiredString(record, 'audioText', 'history.storyboard')
  const historicalBasis = requiredString(record, 'historicalBasis', 'history.storyboard')
  if (!/\[史料\d+\]/.test(historicalBasis)) throw new Error('history.storyboard.historicalBasis 必须包含 [史料N] 引用')
  requiredString(record, 'adaptationBoundary', 'history.storyboard')
  const timingEstimate = estimateStoryboardTiming(audioText, videoPrompt)
  if (timingEstimate.requiredDuration > 15) {
    throw new Error(`STORYBOARD_TIMING_OVERFLOW: 当前对白、明示停顿与尾帧预留预计至少需要 ${timingEstimate.requiredDuration} 秒，超过 15 秒上限；请压缩台词/停顿或拆分镜头`)
  }
  const plannedDuration = Number(scene.targetDuration)
  const selectedDuration = 15
  record.duration = selectedDuration
  record.timingEstimate = {
    ...timingEstimate,
    plannedDuration: Number.isFinite(plannedDuration) ? plannedDuration : undefined,
    modelDuration: duration,
    selectedDuration,
  }
  return record
}

export function aggregateLoopOutputs(iterations: Array<Record<string, unknown>>) {
  const collected: Record<string, unknown[]> = {}
  for (const iteration of iterations) {
    for (const [key, value] of Object.entries(iteration)) collected[key] = [...(collected[key] ?? []), value]
  }
  return Object.fromEntries(Object.entries(collected).map(([key, items]) => [key, { items, count: items.length }]))
}

const unsafeContextKeys = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function mergeContextPatch(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (unsafeContextKeys.has(key)) continue
    const existing = merged[key]
    merged[key] = isPlainRecord(existing) && isPlainRecord(value)
      ? mergeContextPatch(existing, value)
      : value
  }
  return merged
}

export function applyNodeOutputToContext(context: Record<string, unknown>, resultVar: string, output: unknown) {
  const patch = isPlainRecord(output) && isPlainRecord(output.contextPatch) ? output.contextPatch : undefined
  const patchedContext = patch ? mergeContextPatch(context, patch) : context
  return { ...patchedContext, [resultVar]: output }
}
