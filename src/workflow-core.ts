import { storyboardTimelineMatches } from './storyboard-timeline.ts'
import { dynamicStoryboardTiming, HISTORY_PACING_VERSION, HISTORY_SPEECH_RATE, HISTORY_TAIL_SECONDS, historyTailSeconds, performanceStoryboardTiming, speechBudgetSeconds, unionSeconds, validateNarrativeOutline, validateNarrativeShot } from './history-pacing.ts'
import { allowsEmptyEditorialCast, DramaOutlineIssuesError, expectedSourceRefs, validateDramaOutline, validateDramaStoryboard, validateDramaStoryboardAllocation, partitionDramaBeat, projectedDramaBeatDescription } from './history-drama.ts'
import { isCinematicShot, validateCinematicShot, validateCinematicWorldState } from './history-cinema.ts'
import { DURATION_PACING_VERSION, resolveDurationPolicy } from './duration-policy.ts'
import { collectDurationCoverageDiagnostics, collectDurationSpeechBudgetDiagnostics, collectDurationVoiceLayoutDiagnostics, compileDurationSchedule } from './duration-schedule.ts'
import { inheritShotCharacterVisuals } from './character-visual-workflow.ts'
import type { DurationBeat } from './duration-schedule.ts'
import { matchingEntranceActions, normalizeStoryboardAnonymousEntranceIdentities, projectStoryboardEntrances } from './storyboard-entrance.ts'
import { outlineKnowledgeRepairInstruction } from './outline-repair-diagnostics.ts'
import { isStaticIllustrationStyle } from './animation-shot.ts'
import { normalizePronunciationHints } from './pronunciation-hints.ts'
import { normalizeSandTableAesthetic } from './sand-table-contract.ts'
import { validateEpisodeNarrativeBoundary } from './episode-boundary.ts'

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
    acceptance: node.acceptance,
    errorRetry: node.errorRetry,
    mapInput: node.mapInput,
    request: node.request,
    captureTail: node.captureTail,
    outputMode: node.outputMode,
    loopResultMode: node.loopResultMode,
  }
}

/** Invalidates live snapshots after nodes, parameters, prompts, or loop topology change. */
export function hasExecutionPlanMismatch<Node extends GraphNode>(workflow: GraphWorkflow<Node>, runs: Array<{ node: Node }>) {
  if (isDurationPolicyTransition(workflow, runs)) return true
  const currentById = new Map(workflow.nodes.map((node) => [node.id, node]))
  const runNodeIds = new Set(runs.map((run) => run.node.id))
  if (runNodeIds.size !== currentById.size || [...currentById.keys()].some((id) => !runNodeIds.has(id))) return true
  const sanguoMap = (workflow as GraphWorkflow<Node> & { id?: string }).id === 'wf-sanguo-history-drama'
  const paidGroups = new Set(runs.filter(run => run.node.id === 'sanguo-video'
    && (run as { status?: string }).status === 'success')
    .map(run => (run as { loopGroupId?: string }).loopGroupId).filter((id): id is string => Boolean(id)))
  const preservedPaidMapGate = (run: { node: Node }, current: Node) => {
    const snapshot = run as { node: Node & { code?: string }; status?: string; loopGroupId?: string }
    const managed = current as Node & { request?: { url?: string } }
    return sanguoMap && ['sanguo-map-first-accept', 'sanguo-map-end-accept'].includes(run.node.id)
      && Boolean(snapshot.loopGroupId && paidGroups.has(snapshot.loopGroupId))
      && ['success', 'skipped'].includes(String(snapshot.status)) && snapshot.node.kind === 'code'
      && typeof snapshot.node.code === 'string' && snapshot.node.code.includes('HISTORICAL_MAP_FRAME_REJECTED')
      && managed.kind === 'http' && managed.request?.url === '/api/historical-map-frame-approval'
  }
  return runs.some((run) => {
    const current = currentById.get(run.node.id)
    return !current || JSON.stringify(executionNodeContract(current as Node & Record<string, unknown>))
      !== JSON.stringify(executionNodeContract(run.node as Node & Record<string, unknown>))
      && !preservedPaidMapGate(run, current)
  })
}

/** A new timing policy requires a new plan. Never splice v2 writer/gates into
 * already captured v1 execution evidence, even if all pending IDs still match. */
export function isDurationPolicyTransition<Node extends GraphNode>(workflow: GraphWorkflow<Node>, runs: Array<{node:Node}>) {
  const writerVersion = (nodes: Node[]) => {
    const writer = nodes.find(node => node.id === 'sanguo-shot-script' || (node as Node & Record<string,unknown>).operation === 'history.storyboard') as (Node & Record<string,unknown>) | undefined
    if (!writer) return undefined
    const params = Array.isArray(writer.params) ? writer.params as Record<string,unknown>[] : []
    const version = params.find(param => (param.englishName ?? param.name) === 'pacingVersion')?.value
    return version === DURATION_PACING_VERSION || typeof writer.prompt === 'string' && writer.prompt.includes('duration-v2') ? DURATION_PACING_VERSION : HISTORY_PACING_VERSION
  }
  const current = writerVersion(workflow.nodes), captured = writerVersion(runs.map(run=>run.node))
  return current !== undefined && captured !== undefined && current !== captured
}

/** Keep completed evidence immutable while applying compatible definition fixes
 * to unstarted or failed nodes. A migration must never erase a paid execution checkpoint. */
export function refreshPendingExecutionNodes<Node extends GraphNode, Run extends { node: Node; status: string }>(workflow: GraphWorkflow<Node>, runs: Run[]): Run[] {
  if (isDurationPolicyTransition(workflow,runs)) return runs
  const current = new Map(workflow.nodes.map(node => [node.id, node]))
  const ids = new Set(runs.map(run => run.node.id))
  if (ids.size !== current.size || [...current.keys()].some(id => !ids.has(id))) return runs
  let changed = false
  const updated = runs.map(run => {
    const node = current.get(run.node.id)!
    if (!['idle', 'failed'].includes(run.status) || JSON.stringify(executionNodeContract(node as Node & Record<string, unknown>)) === JSON.stringify(executionNodeContract(run.node as Node & Record<string, unknown>))) return run
    changed = true
    return { ...run, node }
  })
  return changed ? updated : runs
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

/** Turns a browser-interrupted running step back into a safe, explicitly retryable step. */
export function recoverInterruptedNodeRuns<Run extends { status?: StepRunStatus; startedAt?: number; durationMs?: number }>(runs: Run[]) {
  let interrupted = false
  const nodeRuns = runs.map((run): Run => {
    if (run.status !== 'running') return run
    interrupted = true
    return { ...run, status: 'idle', startedAt: undefined, durationMs: 0 } as Run
  })
  const firstPendingIndex = nodeRuns.findIndex((run) => run.status !== 'success' && run.status !== 'skipped')
  return {
    interrupted,
    nodeRuns,
    resumeIndex: firstPendingIndex >= 0 ? firstPendingIndex : Math.max(0, nodeRuns.length - 1),
  }
}

export function missingRequiredParamNames(
  params: Array<{ name: string; englishName?: string; required: boolean; type?: string }>,
  values: Record<string, unknown>,
) {
  const missing = (value: unknown, type?: string) => value === undefined
    || value === null
    || (typeof value === 'string' && !value.trim())
    // Required JSON denotes a supplied value, not a minimum item count. []
    // explicitly represents no initial actors/no findings; semantic node
    // contracts validate any required members. Empty media lists still fail.
    || (Array.isArray(value) && value.length === 0 && type !== 'json')
  return params
    .filter((param) => param.required && missing(values[param.englishName?.trim() || param.name], param.type))
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

/**
 * A DAG node can represent several concrete runs inside a loop. Completion must
 * belong to the run currently displayed on the canvas, rather than any earlier
 * run that happens to share the same workflow node id.
 */
export function isDisplayedRunCompletedBeforeStep(
  runs: LoopRunSnapshot[],
  displayedRunIndex: number,
  stepIndex: number,
) {
  return displayedRunIndex >= 0
    && displayedRunIndex < stepIndex
    && runs[displayedRunIndex]?.status === 'success'
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
  const explicitIds = loopNode.childIds !== undefined
    ? new Set(loopNode.childIds)
    : new Set(workflow.nodes.filter((node) => node.parentId === loopNodeId).map((node) => node.id))
  if (loopNode.childIds !== undefined || explicitIds.size) return ordered.filter((node) => explicitIds.has(node.id))
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
    ? { ...(scene as Record<string, unknown>) }
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
  if (normalized === '旁白' || normalized === '对白' || normalized === '环境声') return normalized
  if (/^(?:无|无声|无对白|无台词|纯环境声|环境音|纯环境音|none)$/i.test(normalized)) return '环境声'
  const compact = normalized.replace(/\s+/g, '')
  const primaryTypes = ['旁白', '对白'].filter((type) => compact.includes(type))
  if (primaryTypes.length !== 1) return value
  const remainder = compact
    .replace(primaryTypes[0], '')
    .replace(/[+＋、,，/／|&和与及:：()（）[\]【】-]/g, '')
  if (!remainder || /^(?:(?:环境|动作|自然)(?:音|声)|音效|音乐|配乐|同期声)+$/.test(remainder)) return primaryTypes[0]
  return value
}

/** A short identity such as “病患” is not independently present when its only
 * occurrence belongs to another declared identity such as “病患家属”. */
export function missingIndependentOpeningIdentities(openingPrompt: string, identities: string[]) {
  const hasIndependentIdentity = (name: string) => {
    for (let index = openingPrompt.indexOf(name); index >= 0; index = openingPrompt.indexOf(name, index + 1)) {
      const embedded = identities.some((other) => {
        if (other === name || !other.includes(name)) return false
        for (let otherIndex = openingPrompt.indexOf(other); otherIndex >= 0; otherIndex = openingPrompt.indexOf(other, otherIndex + 1)) {
          if (otherIndex <= index && otherIndex + other.length >= index + name.length) return true
        }
        return false
      })
      if (!embedded) return true
    }
    return false
  }
  return identities.filter((name) => !hasIndependentIdentity(name))
}

/** Narration labels classify the track; they must never be spoken aloud. */
export function normalizeStoryboardSpokenText(audioType: unknown, value: unknown) {
  if (normalizeStoryboardAudioType(audioType) !== '旁白' || typeof value !== 'string') return value
  return value.replace(/^\s*(?:旁白|画外音|解说|叙述者)\s*[:：]\s*/, '').trim()
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

function dialogueIdentity(label: string) {
  return label.replace(/(?:（[^）]*）|\([^)]*\)|【[^】]*】)/g, '').trim()
}

function dialogueSpeakers(audioText: string) {
  return [...new Set(audioText
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([^：:\n]{1,24})[：:]/)?.[1]
      ?.replace(/(?:（[^）]*）|\([^)]*\)|【[^】]*】)/g, '')
      .trim())
    .filter((speaker): speaker is string => Boolean(speaker)))]
}

function dialogueLines(audioText: string) {
  return audioText.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([^\uff1a:\n]{1,24})[\uff1a:]\s*(.+?)\s*$/)
    if (!match) return undefined
    return {
      speaker: match[1].replace(/(?:（[^）]*）|\([^)]*\)|【[^】]*】)/g, '').trim(),
      text: match[2].trim(),
    }
  }).filter((line): line is { speaker: string; text: string } => Boolean(line?.speaker && line.text))
}

// Native video speech tends to accumulate visible lip drift on a single long
// utterance. Short semantic cues give the model fresh timing anchors while
// keeping one complete audioText line bound to one executable beat.
const MAX_DIALOGUE_CUE_SECONDS = 6

function dialogueCueSeconds(value: string, speechRate = 4) {
  const speechCharacterCount = [...value].filter((character) => /\p{Script=Han}/u.test(character)).length
  const punctuationPauseSeconds = (value.match(/[，,；;]/g) ?? []).length * (speechRate >= 4.5 ? 0.15 : 0.2)
    + (value.match(/[。！？!?]/g) ?? []).length * (speechRate >= 4.5 ? 0.25 : 0.4)
  return Number((speechCharacterCount / speechRate + punctuationPauseSeconds).toFixed(2))
}

function dialogueCueLengthIssue(line: { speaker: string; text: string }, speechRate: number) {
  const seconds = dialogueCueSeconds(line.text, speechRate)
  return seconds > MAX_DIALOGUE_CUE_SECONDS
    ? `对白“${line.speaker}：${line.text}”预计连续发声 ${seconds} 秒，超过单条口型锚点 ${MAX_DIALOGUE_CUE_SECONDS} 秒上限；请在语义停顿处把 audioText 拆成两条较短的“${line.speaker}：台词”，并把每条完整台词分别绑定到相邻时间段`
    : undefined
}

/** Concrete dialogue-only schedule for repair prompts; no plot text is deleted
 * or silently rewritten. The model must still preserve actions and pass review. */
export function storyboardDialogueScheduleHint(output: unknown, speechRate = 4.5, validationMessage = '') {
  const splitHint = storyboardDialogueSplitHint(output)
  const clockHint = splitHint ? '' : storyboardDialogueClockHint(output, validationMessage)
  // A new line boundary adds a pause. Do not also prescribe the rejected
  // candidate's old speech total or old windows after proposing that split.
  if (splitHint || clockHint) {
    const rejectedHold = /STORYBOARD_PACING_INVALID:[^\n]*(?:空等|静止保持)/.test(validationMessage)
    return (rejectedHold ? storyboardCurrentDialogueScheduleHint(output, speechRate, validationMessage) : '') + (splitHint || clockHint)
  }
  return storyboardCurrentDialogueScheduleHint(output, speechRate, validationMessage)
}

/** A rejected simple dialogue schedule gets the exact continuous speech clock.
 * This is advice, not a local rewrite: authored actions and the full validator
 * still decide whether the writer's replacement schedule can be accepted. */
export function storyboardDialogueClockHint(output: unknown, validationMessage = '') {
  if (!output || typeof output !== 'object' || Array.isArray(output)
    || !/STORYBOARD_PACING_INVALID:/.test(validationMessage)) return ''
  const value = output as Record<string, unknown>
  const pacing = value.pacing as Record<string, unknown> | undefined
  if (Array.isArray(value.segments) || normalizeStoryboardAudioType(value.audioType) !== '对白'
    || pacing?.version !== HISTORY_PACING_VERSION || typeof value.audioText !== 'string'
    || typeof value.videoPrompt !== 'string'
    || (Array.isArray(pacing.performanceBeats) && pacing.performanceBeats.length)
    || (Array.isArray(value.enteringCharacters) && value.enteringCharacters.length)) return ''
  const lines = dialogueLines(value.audioText)
  if (lines.length < 2 || lines.length !== value.audioText.split(/\r?\n/).filter(line => line.trim()).length
    || new Set(lines.map(line => line.speaker)).size !== 1
    || lines.some(line => dialogueCueSeconds(line.text, HISTORY_SPEECH_RATE) > MAX_DIALOGUE_CUE_SECONDS)) return ''
  const matches = storyboardTimelineMatches(value.videoPrompt)
  const bodies = timedBeatBodies(value.videoPrompt, matches)
  const bound = lines.map(line => bodies.flatMap((body, index) => dialogueIsBoundToTimedBeat(line, body) ? [index] : []))
  if (bound.some(indices => indices.length !== 1) || bound.some((indices, index) => index > 0 && indices[0] <= bound[index - 1][0])) return ''
  const firstSecond = Number(matches[bound[0][0]][1])
  if (!Number.isFinite(firstSecond) || firstSecond < 0) return ''
  const at = (second: number) => Number(second.toFixed(2))
  const rawLines = value.audioText.split(/\r?\n/).filter(line => line.trim())
  let previousEnd = firstSecond
  const clock = rawLines.map((line, index) => {
    // Prefix budgets retain exact character arithmetic; round only displayed
    // boundaries so per-line rounding never accumulates in the final total.
    const end = firstSecond + speechBudgetSeconds(rawLines.slice(0, index + 1).join('\n')) + (index < rawLines.length - 1 ? 0.2 : 0)
    const row = { kind: 'speech', startSecond: at(previousEnd), endSecond: at(end), audioText: line,
      followingLinePauseSeconds: index < rawLines.length - 1 ? 0.2 : 0 }
    previousEnd = end
    return row
  })
  const reaction = Number(pacing.reactionSeconds)
  const serialReaction = Number.isFinite(reaction) && reaction >= 0.3 && reaction <= 1.2
    ? { kind: 'reaction', startSecond: at(previousEnd), endSecond: at(previousEnd + reaction) } : undefined
  const serialDuration = serialReaction ? Math.max(3, Math.ceil(Number((previousEnd + reaction + HISTORY_TAIL_SECONDS).toFixed(2)))) : undefined
  return `\n【含行间停顿的连续对白时钟】保留本候选第一句原起点${firstSecond}秒，按当前完整audioText精确计算：${JSON.stringify(clock)}；speech窗口并集=${Number(speechBudgetSeconds(value.audioText).toFixed(2))}秒。前面每条时间段的末尾已经包含0.2秒自然行间停顿，后一条从前一条结束时刻开始；不把这0.2秒漏到时间轴空档，也不另加纯换气时间段。停顿是该说话段中的自然间隔，不代表持续发音，不新增台词或语言口型。videoPrompt中对应的逐字说话段与speech窗口同步使用这些边界，不能只改pacing而保留旧起止；保留原说话正文、说话归属与原动作。${serialReaction ? `若原反应安排在说完后，串行参考reaction窗口=${JSON.stringify(serialReaction)}，按最晚结束加0.3秒取整的duration=${serialDuration}；${serialDuration! > 15 ? '超过15秒，必须保留完整剧情拆镜' : 'videoPrompt须连续覆盖0到该duration，不得只改数字而留断档'}。` : ''}reactionSeconds非零时必须有等量reaction窗口，actionSeconds同理。上述时钟只供修复当前简单对白排程；若原已批准动作、反应或其他活动需要并行、穿插或更晚结束，必须保留那些动作及先后关系并统一重排，不能为了采用参考时钟删改剧情；完整校验通过后才可生成。`
}

/** Propose punctuation-only line splits without changing the candidate or
 * choosing when its actions occur. Works with explicit, absent or invalid
 * activity windows; all three still go through the complete validator. */
export function storyboardDialogueSplitHint(output: unknown) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return ''
  const value = output as Record<string, unknown>
  if (Array.isArray(value.segments) || typeof value.audioText !== 'string'
    || (value.pacing as Record<string, unknown>)?.version !== HISTORY_PACING_VERSION
    || (value.audioType !== undefined && normalizeStoryboardAudioType(value.audioType) !== '对白')) return ''
  const speechRate = HISTORY_SPEECH_RATE
  const rawLines = value.audioText.split(/\r?\n/).filter(line => line.trim())
  const matches = rawLines.map(line => line.match(/^\s*([^：:\n]{1,24})[：:]\s*(.+?)\s*$/))
  if (matches.some(match => !match || !dialogueIdentity(match[1]))) return ''
  // Preserve delivery annotations such as （画外）; identity normalization is
  // useful for matching actors but must not rewrite the writer's voice labels.
  const lines = matches.map(match => ({ speaker: match![1], text: match![2] }))
  if (!lines.length
    || !lines.some(line => dialogueCueSeconds(line.text, speechRate) > MAX_DIALOGUE_CUE_SECONDS)) return ''
  const chunks: Array<{ speaker: string; text: string }> = []
  for (const line of lines) {
    if (dialogueCueSeconds(line.text, speechRate) <= MAX_DIALOGUE_CUE_SECONDS) { chunks.push(line); continue }
    const clauses = line.text.match(/[^，,。！？!?；;、]+[，,。！？!?；;、]*/g) ?? []
    if (clauses.join('') !== line.text || clauses.some(clause => dialogueCueSeconds(clause, speechRate) > MAX_DIALOGUE_CUE_SECONDS)) return ''
    let text = ''
    for (const clause of clauses) {
      if (text && dialogueCueSeconds(text + clause, speechRate) > MAX_DIALOGUE_CUE_SECONDS) {
        chunks.push({ speaker: line.speaker, text }); text = ''
      }
      text += clause
      if (/[。！？!?]$/.test(clause)) {
        chunks.push({ speaker: line.speaker, text }); text = ''
      }
    }
    if (text) chunks.push({ speaker: line.speaker, text })
  }
  const proposedAudio = chunks.map(line => `${line.speaker}：${line.text}`).join('\n')
  const seconds = speechBudgetSeconds(proposedAudio)
  const cues = chunks.map((line, index) => ({ ...line,
    speechSeconds: dialogueCueSeconds(line.text, speechRate),
    followingLinePauseSeconds: index < chunks.length - 1 ? 0.2 : 0,
  }))
  return `\n【程序计算的无损拆行建议】audioText=${JSON.stringify(proposedAudio)}。仅沿原标点拆开超过6秒的行，原已短行、说话人、全部文字、标点和顺序保持；逐行预算=${JSON.stringify(cues)}。按拆行后的正文重新计算 speechSeconds=${Number(seconds.toFixed(2))}（4.5字/秒，包含行间0.2秒停顿，逐行显示值的舍入不用于合计）。此数对应上述新分行，不能继续沿用旧audioText的总秒数或旧活动窗；若再改分行须再次核算。beatDramaturgy.audio是剧情义务声明，每条批准的完整原锚点仍在声明数组的一项中保留；audioText是实际发声排程，同一角色可在自然停顿处分成相邻短行，按顺序连接说话正文仍是完整原台词，不需要为维持声明的一项而合并实际台词行。每条新短行在videoPrompt自己的时间段逐字绑定，不能重复追加整段原长句。这只是对白预算，不指定开场、动作或反应起点；保留原剧情动作及先后依赖，重排speech/action/reaction窗口并覆盖实际说话段，按最晚活动结束加0.3秒取整算duration；超过15秒或需要超过6个时间段时保留完整剧情拆镜。`
}

function storyboardCurrentDialogueScheduleHint(output: unknown, speechRate = 4.5, validationMessage = '') {
  if (!output || typeof output !== 'object') return ''
  const value = output as Record<string, unknown>
  if ((value.pacing as Record<string,unknown>)?.version === DURATION_PACING_VERSION) {
    // Clock repair cannot solve a shot-boundary or evidence problem. Sending
    // "only change beats/duration" here prevented correcting continuity.mode.
    if (validationMessage && !/PACING|TIMING|DURATION|排程|时间窗|时长|预算|声部/.test(validationMessage)) {
      return `\n【分镜字段修复】${validationMessage}。按点名字段与本次权威契约修复当前候选；这不是单纯时长问题，不要只修改pacing或编造时长来消除错误。`
    }
    let detail: string
    // Use the actual scoped validator's diagnosis. Compiling an incomplete
    // candidate here without its source scene silently narrowed the scope to
    // its own coveredBeatIds and gave a different repair instruction.
    if (validationMessage) detail = validationMessage
    else try { detail = JSON.stringify(compileDurationSchedule(normalizeDurationStoryboardDraft(value)).timingEstimate) } catch (error) { detail = error instanceof Error ? error.message : String(error) }
    return `\n【duration-v2 结构化重排】${detail}。保留原 sourceBeatId 的全部动作和台词、动作主体和先后依赖；逐声部使用 timingPolicy 与 deliveryStyle 的 lower/expected/upper 保守估计，非词汇哼唱仍需要正数预算和可听完成证据。只修改真实缺陷对应的 beats 或请求整数 duration，起止窗口、采样时刻和哈希由程序统一编译；不要另写 activityWindows、不要套用旧4.5字/秒或0.3秒唯一最短公式。超过15秒沿完整原节拍拆段，不删词、不钳短。`
  }
  if (Array.isArray(value.segments) || (Array.isArray(value.enteringCharacters) && value.enteringCharacters.length)) return ''
  const lines = dialogueLines(String(value.audioText ?? ''))
  if (value.pacing) {
    // A rejected pacing budget is not a valid scheduling anchor. Repeating its
    // actionSeconds here used to reinstate the very opening hold being repaired.
    if (/STORYBOARD_PACING_INVALID:[^\n]*(?:空等|静止保持)/.test(validationMessage)) return '\n【重新预算】旧 pacing 与时间窗已被拒绝，不可沿用。先缩短空等或让姿态保持与必要动作、对白并行，再按实际非并行动作重新计算 actionSeconds、reactionSeconds、duration 和全部连续时间窗；保留原剧情与完整台词。'
    const pacing = value.pacing as Record<string, unknown>
    let budget: ReturnType<typeof dynamicStoryboardTiming>
    try { budget = dynamicStoryboardTiming(String(value.audioText ?? ''), pacing, value) } catch (error) {
      // The window bookkeeping can be rejected while the audio budget stays exactly derivable from
      // audioText alone. record-yi9rq0’s beat-carrying rounds were only told to “重新预算” with no
      // number to aim at, so hand over the arithmetic together with the demand to fix the windows.
      const rejection = error instanceof Error ? error.message : String(error)
      const speechSeconds = speechBudgetSeconds(String(value.audioText ?? ''))
      return `\n【重新预算】本候选的pacing或表演时间窗无效（${rejection}）。按 audioText 实际汉字数与 4.5 字/秒，speechSeconds=${Number(speechSeconds.toFixed(2))}。speech/action/reaction 三类窗口各自合计须分别等于 speechSeconds、actionSeconds、reactionSeconds，同类窗口之间不得重叠；跨类并行只计一次。修复后的合法 activityWindows 与 performanceBeats 最晚结束时刻为 plannedEndSecond，duration=max(3,ceil(plannedEndSecond+0.3))，上限15秒；超限须保留剧情拆段，不能裁成15秒。活动结束时刻不等于整数片长，videoPrompt 时间轴须连续覆盖0到duration，不能把活动窗强行延长到duration。额外的无声表演只有可观察行动才能用 performanceBeats 表达，心理标签或保持静帧不算。保留完整剧情、台词与已要求动作，按其先后关系重排合法窗口，不能继续沿用被拒绝的预算，也不能仅凭时间预算认定动作完成。`
    }
    if (Array.isArray(pacing.activityWindows)) {
      const activityEnd = Math.max(0, ...pacing.activityWindows.map(window => Number((window as Record<string, unknown>).endSecond)))
      const durationInstruction = budget.requiredDuration > 15
        ? `当前需要${budget.requiredDuration}秒，超过15秒上限，须保留完整剧情和台词拆段后重新预算，不能裁成15秒`
        : `duration须为${budget.requiredDuration}秒，videoPrompt 时间轴连续覆盖0到${budget.requiredDuration}秒`
      return `\n【已核验的活动时间预算】${JSON.stringify(budget)}。仅在本次audioText分行与活动排程保持不变时，保留已声明且通过时间核算的activityWindows=${JSON.stringify(pacing.activityWindows)}与performanceBeats=${JSON.stringify(pacing.performanceBeats ?? [])}；若其他校验要求拆行或调整说话/动作时间，须保留完整台词与原动作并重新核算，不能把旧窗口当作不可变约束。跨类重叠只计一次，不另排一套串行对白。activityWindows最晚结束于${activityEnd}秒，含performanceBeats的plannedEndSecond=${budget.plannedEndSecond}秒；加0.3秒剪辑余量后取整，${durationInstruction}。活动结束时刻与整数片长分别约束，不把活动窗拉长至duration；保留已声明动作的起止状态与先后关系，不改台词或裁剪动作。时间核算不证明动作已经发生。`
    }
    let second = Number(pacing.actionSeconds)
    const windows = lines.map((line, index) => {
      const start = second
      second = Math.ceil((second + dialogueCueSeconds(line.text, 4.5) + (index < lines.length - 1 ? 0.2 : 0)) * 10) / 10
      return {start,end:second,...line}
    })
    return `\n【程序计算的动态预算】${JSON.stringify(budget)}。duration须为${budget.requiredDuration}，时间轴结尾也必须${budget.requiredDuration}，不能只改duration。逐句自然语速的参考时间窗：${JSON.stringify(windows)}。0到${pacing.actionSeconds}秒只安排必要独立动作；其他动作可与对白同步，不重复计算。结尾完成${pacing.reactionSeconds}秒对手反应与0.3秒余量；不填静止摆拍。超过6秒的长句须在语义停顿处拆行并重新预算。`
  }
  if (!lines.length || new Set(lines.map(line => line.speaker)).size !== 1) return ''
  const chunks: Array<{ speaker: string; text: string }> = []
  for (const line of lines) {
    const clauses = line.text.match(/[^，,。！？!?；;、]+[，,。！？!?；;、]*/g) ?? []
    let text = ''
    for (const clause of clauses) {
      if (dialogueCueSeconds(clause, speechRate) > 6) return ''
      if (text && dialogueCueSeconds(text + clause, speechRate) > 5.8) { chunks.push({ speaker: line.speaker, text }); text = '' }
      text += clause
    }
    if (text) chunks.push({ speaker: line.speaker, text })
  }
  if (chunks.length > 3) return ''
  let second = 1
  const windows = chunks.map(chunk => {
    const start = second
    second = Math.round((second + dialogueCueSeconds(chunk.text, speechRate) + 0.2) * 10) / 10
    return { start, end: second, ...chunk }
  })
  if (second > 12.3) return ''
  return `\n【可直接采用的完整对白排程，不丢任何字】audioText写为${JSON.stringify(chunks.map(chunk => `${chunk.speaker}：${chunk.text}`).join('\n'))}。逐条把以下完整台词写入各自区间并标明说话人：${JSON.stringify(windows)}。0–1秒保留原开场动作，${second}–13.5秒保留原对手反应，13.5–15秒保持原静态尾帧；所有原剧情动作与锚点仍必须保留。每句必须成为独立audioText行，不得又合成长句。若原动作不能在这些区间执行，继续拆成相邻15秒段，禁止删剧情。`
}

function normalizedDialogueCue(value: string) {
  return value.normalize('NFKC').replace(/[\s，。！？；：、,.!?;:'"“”‘’…—\-（）()【】]/g, '')
}

function timedBeatBodies(videoPrompt: string, matches: RegExpMatchArray[]) {
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = matches[index + 1]?.index ?? videoPrompt.length
    // A trailing sound-design inventory is not an executable lip-sync cue. A
    // spoken line must be placed inside one of the actual timed beats.
    return videoPrompt.slice(start, end).split(/\s*(?:声音|音频|同期声)[：:]/, 1)[0]
  })
}

function dialogueIsBoundToTimedBeat(line: { speaker: string; text: string }, beat: string) {
  const normalizedLine = normalizedDialogueCue(line.text)
  const quotedFragments = quotedDialogueFragments(beat)
  const containsExactDialogue = quotedFragments.length
    ? quotedFragments.includes(normalizedLine)
    : normalizedDialogueCue(beat).includes(normalizedLine)
  return beat.includes(line.speaker)
    && containsExactDialogue
    && /(?:开口|说出|说道|说着|问出|问道|发问|答道|回答|回应|喊|喝道|念出|朗诵|对白)/.test(beat)
}

function quotedDialogueFragments(beat: string) {
  return [...beat.matchAll(/['"“‘]([^'"”’]+)['"”’]/g)]
    .map((match) => normalizedDialogueCue(match[1]))
    .filter(Boolean)
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const closedMouthCue = '(?:(?:嘴唇?|双唇|口型)(?:保持|始终|仍然|依旧|一直|全程|紧紧|微微)?(?:未动|不动|闭合|紧闭|闭|不张口)|(?:保持|始终|仍然|依旧|一直|全程)?(?:闭口|不张口))'

/** Only treats a closed-mouth cue as contradictory when it is attached to the
 * named speaker inside the same comma-delimited action. This avoids blaming
 * `other characters remain silent` on the speaker earlier in the same beat. */
function speakerHasClosedMouthCue(beat: string, speaker: string) {
  const name = escapeRegExp(speaker)
  const localText = `[^，,。；;！!?？\\n]{0,16}`
  // In the reverse form, only accept the direct Chinese attributive pattern
  // “嘴唇紧闭的张角”.  Allowing arbitrary text between the cue and the name
  // misreads “病人嘴唇紧闭目光转向张角” as a cue attached to 张角.
  return new RegExp(`${name}(?:的)?${localText}${closedMouthCue}|${closedMouthCue}(?:的)?${name}`).test(beat)
}

function characterHasUnsupportedMouthCue(clause: string, character: string) {
  const name = escapeRegExp(character)
  const localText = `[^，,。；;！!?？\\n]{0,16}`
  const openMouthCue = '(?:(?:嘴唇?|双唇|口型)[^，,。；;！!?？\\n]{0,8}(?:微动|微张|张开|颤动|张合|开合|翕动|无声)|开口|说话|咬牙|颔骨)'
  return new RegExp(`${name}(?:的)?${localText}${openMouthCue}|${openMouthCue}(?:的)?${name}`).test(clause)
}

function removeSpeakerClosedMouthCue(beat: string, speaker: string) {
  const name = escapeRegExp(speaker)
  const namedMouthCue = new RegExp(`(${name})(?:的)?(?:嘴唇?|双唇|口型)(?:保持|始终|仍然|依旧|一直|全程|紧紧|微微)?(?:未动|不动|闭合|紧闭|闭|不张口)(?:并|且|同时|却|但)?`, 'g')
  const namedSilenceCue = new RegExp(`(${name})(?:保持|始终|仍然|依旧|一直|全程)?(?:闭口|不张口)(?:不语|沉默)?(?:并|且|同时|却|但)?`, 'g')
  return beat.replace(namedMouthCue, '$1').replace(namedSilenceCue, '$1')
}

/**
 * Repairs the common model failure where a complete `audioText` line is only
 * repeated in an untimed sound inventory. This is intentionally conservative:
 * every missing line must already have exactly one empty, explicit speaker slot
 * with enough time. Partial dialogue, merged time ranges and guessed placement
 * are left to the writer. The regular validator remains the source of truth.
 */
export function repairStoryboardDialogueBindings(output: unknown): Record<string, unknown> | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined
  const record = output as Record<string, unknown>
  if ((record.pacing as Record<string,unknown>)?.version === DURATION_PACING_VERSION) return undefined
  if (Array.isArray(record.segments)) {
    let changed = false
    const segments: unknown[] = record.segments.map((segment): unknown => {
      const repaired = repairStoryboardDialogueBindings(segment)
      if (repaired && repaired !== segment) changed = true
      return repaired ?? segment
    })
    return changed ? { ...record, segments } : undefined
  }
  if (normalizeStoryboardAudioType(record.audioType) !== '对白'
    || typeof record.audioText !== 'string'
    || typeof record.videoPrompt !== 'string') return undefined

  const lines = dialogueLines(record.audioText)
  const timedBeats = storyboardTimelineMatches(record.videoPrompt)
  if (!lines.length || timedBeats.length < 3 || timedBeats.length > 6) return undefined
  const beatBodies = timedBeatBodies(record.videoPrompt, timedBeats)
  const speechRate = record.pacing ? HISTORY_SPEECH_RATE : 4
  if (lines.length !== record.audioText.split(/\r?\n/).filter(line => line.trim()).length
    || lines.some(line => dialogueCueSeconds(line.text, speechRate) > MAX_DIALOGUE_CUE_SECONDS)
    || new Set(lines.map(line => `${line.speaker}:${normalizedDialogueCue(line.text)}`)).size !== lines.length) return undefined
  const normalizedBodies = beatBodies.map(normalizedDialogueCue)
  const boundIndexes = lines.map(line => beatBodies.flatMap((beat, index) => dialogueIsBoundToTimedBeat(line, beat) ? [index] : []))
  if (boundIndexes.some(indexes => indexes.length > 1)
    || new Set(boundIndexes.flat()).size !== boundIndexes.flat().length
    || lines.some(line => normalizedBodies.reduce((count, body) => count + body.split(normalizedDialogueCue(line.text)).length - 1, 0) > 1)) return undefined
  let promptWithoutSpeakerConflicts = record.videoPrompt
  for (const line of lines) {
    const matchingIndex = beatBodies.findIndex((beat) => dialogueIsBoundToTimedBeat(line, beat))
    if (matchingIndex < 0 || !speakerHasClosedMouthCue(beatBodies[matchingIndex], line.speaker)) continue
    const repairedBody = removeSpeakerClosedMouthCue(beatBodies[matchingIndex], line.speaker)
    if (repairedBody === beatBodies[matchingIndex]) continue
    const bodyStart = (timedBeats[matchingIndex].index ?? 0) + timedBeats[matchingIndex][0].length
    const bodyEnd = timedBeats[matchingIndex + 1]?.index ?? promptWithoutSpeakerConflicts.length
    promptWithoutSpeakerConflicts = `${promptWithoutSpeakerConflicts.slice(0, bodyStart)}${repairedBody}${promptWithoutSpeakerConflicts.slice(bodyEnd)}`
    // Recompute offsets before attempting another line because prompt length may
    // have changed after removing the contradictory action.
    return repairStoryboardDialogueBindings({ ...record, videoPrompt: promptWithoutSpeakerConflicts })
  }
  const missingLines = lines.filter((line) => !beatBodies.some((beat) => dialogueIsBoundToTimedBeat(line, beat)))
  if (!missingLines.length) return record

  // Any existing piece may be a partially bound utterance. Without a full
  // one-to-one mapping, adding the whole line would repeat those spoken words.
  // Be conservative even for unquoted speech; the writer can resolve ambiguity.
  for (const line of missingLines) {
    const normalized = normalizedDialogueCue(line.text)
    const size = Math.min(2, normalized.length)
    if (!size || normalizedBodies.some(body => Array.from({ length: normalized.length - size + 1 }, (_, index) => normalized.slice(index, index + size))
      .some(fragment => body.includes(fragment)))) return undefined
  }

  const additions = new Map<number, string[]>()
  const occupied = new Set(boundIndexes.flat())
  const characters = Array.isArray(record.characters) ? record.characters.filter((name): name is string => typeof name === 'string') : lines.map(line => line.speaker)
  const speechCue = /(?:开口|说出|说道|说着|问出|问道|发问|答道|回答|回应|喊|喝道|念出|朗诵|对白|质问|询问)/
  for (const line of missingLines) {
    const candidates = beatBodies.flatMap((beat, index) => {
      if (occupied.has(index) || quotedDialogueFragments(beat).length) return []
      const duration = Number(timedBeats[index][2]) - Number(timedBeats[index][1])
      const namedSpeech = beat.split(/[，,。；;！!?？\n]/).some(clause => clause.includes(line.speaker) && speechCue.test(clause)
        && !characters.some(name => name !== line.speaker && clause.includes(name)))
      if (!namedSpeech || duration < dialogueCueSeconds(line.text, speechRate)) return []
      return [{ index }]
    })
    if (candidates.length !== 1) return undefined
    const target = candidates[0]
    occupied.add(target.index)

    const match = timedBeats[target.index]
    const bodyStart = (match.index ?? 0) + match[0].length
    const bodyEnd = timedBeats[target.index + 1]?.index ?? record.videoPrompt.length
    const body = record.videoPrompt.slice(bodyStart, bodyEnd)
    const soundOffset = body.search(/\s*(?:声音|音频|同期声)[：:]/)
    const insertionPoint = soundOffset >= 0 ? bodyStart + soundOffset : bodyEnd
    const existing = additions.get(insertionPoint) ?? []
    existing.push(`${line.speaker}开口说出“${line.text}”。`)
    additions.set(insertionPoint, existing)
  }

  let repairedPrompt = record.videoPrompt
  for (const [position, cues] of [...additions.entries()].sort((left, right) => right[0] - left[0])) {
    const separator = position > 0 && /[\s。；;]】?$/.test(repairedPrompt.slice(0, position)) ? '' : '。'
    repairedPrompt = `${repairedPrompt.slice(0, position)}${separator}${cues.join('')}${repairedPrompt.slice(position)}`
  }
  return { ...record, videoPrompt: repairedPrompt }
}

/** Normalizes the common narration-shot failure where several entrants are
 * emitted as overlapping micro-beats. This is safe only without dialogue: the
 * entrance beats can be collapsed without moving a spoken line or its lips. */
export function repairStoryboardNarrationEntrances(output: unknown): Record<string, unknown> | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined
  const record = output as Record<string, unknown>
  if ((record.pacing as Record<string,unknown>)?.version === DURATION_PACING_VERSION) return undefined
  if (Array.isArray(record.segments)) {
    let changed = false
    const segments = record.segments.map((segment) => {
      const repaired = repairStoryboardNarrationEntrances(segment)
      if (repaired) changed = true
      return repaired ?? segment
    })
    return changed ? { ...record, segments } : undefined
  }
  if (normalizeStoryboardAudioType(record.audioType) !== '旁白'
    || typeof record.videoPrompt !== 'string'
    || !Array.isArray(record.enteringCharacters)
    || !record.enteringCharacters.length) return undefined

  const entrants = record.enteringCharacters.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const item = value as Record<string, unknown>
    const name = String(item.name ?? '').trim()
    const path = String(item.path ?? '').split(/[,，；;]/, 1)[0].trim()
    const startSecond = Number(item.startSecond)
    const endSecond = Number(item.endSecond)
    return name && path && Number.isFinite(startSecond) && Number.isFinite(endSecond)
      ? { name, path, startSecond, endSecond }
      : undefined
  }).filter((value): value is StoryboardEntrant => Boolean(value))
  if (entrants.length !== record.enteringCharacters.length) return undefined

  const timedMatches = storyboardTimelineMatches(record.videoPrompt)
  if (timedMatches.length < 3) return undefined
  const bodies = timedBeatBodies(record.videoPrompt, timedMatches)
  let beats = timedMatches.map((match, index) => ({
    start: Number(match[1]),
    end: Number(match[2]),
    body: bodies[index].trim().replace(/[。；;]+$/, ''),
  }))
  const lastEntranceIndex = beats.reduce((last, beat, index) => (
    entrants.some((entrant) => beat.start < entrant.endSecond && beat.body.includes(entrant.name)) ? index : last
  ), -1)
  if (lastEntranceIndex < 0) return undefined
  const remainder = beats.slice(lastEntranceIndex + 1)
  const entranceEnd = remainder[0]?.start ?? Math.max(...entrants.map((entrant) => entrant.endSecond))
  if (!(entranceEnd > 0 && entranceEnd <= Number(record.duration) - historyTailSeconds(record))) return undefined
  const entranceBody = entrants.map((entrant) => (
    `${entrant.name}从${entrant.path}连续走入，先出现身体轮廓再完整入画，随后闭口停在场内`
  )).join('；')
  beats = [{ start: 0, end: entranceEnd, body: entranceBody }, ...remainder]

  // Keep the final 1.5-second hold intact. If the model over-segmented the
  // remaining silent action, merge the shortest adjacent middle beats.
  while (beats.length > 4) {
    let mergeIndex = 1
    let shortest = Number.POSITIVE_INFINITY
    for (let index = 1; index < beats.length - 1; index += 1) {
      const duration = beats[index + 1].end - beats[index].start
      if (duration < shortest) {
        shortest = duration
        mergeIndex = index
      }
    }
    const left = beats[mergeIndex]
    const right = beats[mergeIndex + 1]
    beats.splice(mergeIndex, 2, {
      start: left.start,
      end: right.end,
      body: `${left.body}；${right.body}`,
    })
  }
  if (beats[0].start !== 0 || beats.at(-1)?.end !== Number(record.duration)
    || beats.some((beat, index) => index > 0 && beat.start !== beats[index - 1].end)) return undefined

  const videoPrompt = beats.map((beat) => `${beat.start}-${beat.end}秒：${beat.body}。`).join('')
  return {
    ...record,
    enteringCharacters: entrants.map((entrant) => ({ ...entrant, startSecond: 0, endSecond: entranceEnd })),
    videoPrompt,
  }
}

const staticHoldCue = /(?:静止|保持.{0,15}(?:姿态|构图|不动)|站立不动|空等)/
const filmedMotionCue = /(?:走|递|接过|接稳|放下|转身|下跪|跪下|屈膝|叩首|叩拜|起身|站起|抬起|伸展|伸出|卷起|展开|收回|松开)/

/** A negated instruction (“禁止静止不动”) does not ask for a held frame. */
function affirmativeAction(text: string) {
  return text.replace(/(?:禁止|不得|不许|不要|避免|严禁|不能)[^，,。；;\n]*/g, '')
}

/**
 * A narration that takes 11.05 seconds to read at all cannot ship in a 9 second shot, yet that is what
 * the writer kept declaring: record-4li23v spent all five storyboard rounds on “本镜应为 14 秒，实际声明
 * 9 秒” because no text model divides 45 characters by 4.5 while it is also rewriting a scene, and every
 * round returned a new guess. The stretch is pure bookkeeping, so it is computed here instead of asked
 * for. Action and reaction seconds, every dialogue word, the whole timeline text and all story content
 * stay verbatim: only the clock grows to what the declared audio already requires, and the timeline and
 * entrance windows are scaled by the same factor so nothing moves into a different beat.
 *
 * Shrinking is never reconciled — a shot longer than its own content is the padding this budget exists
 * to reject — and a performanceBeat is only deleted when it sits entirely inside the declared activity
 * windows, because such a beat buys no screen time: it cannot make the shot longer or shorter, so
 * dropping it moves nothing that has to be filmed. Its proof stays in the videoPrompt body verbatim.
 */
export function reconcileStoryboardPacingBudget(output: unknown): Record<string, unknown> | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined
  const record = output as Record<string, unknown>
  if (Array.isArray(record.segments)) {
    let changed = false
    const segments = record.segments.map((segment) => {
      const repaired = reconcileStoryboardPacingBudget(segment)
      if (repaired) changed = true
      return repaired ?? segment
    })
    return changed ? { ...record, segments } : undefined
  }
  const pacing = record.pacing
  if (!pacing || typeof pacing !== 'object' || Array.isArray(pacing)) return undefined
  const budget = pacing as Record<string, unknown>
  const actionSeconds = Number(budget.actionSeconds)
  const reactionSeconds = Number(budget.reactionSeconds)
  const declaredDuration = Number(record.duration)
  if (budget.version !== HISTORY_PACING_VERSION
    || typeof record.audioText !== 'string' || typeof record.videoPrompt !== 'string'
    || !Number.isInteger(declaredDuration) || declaredDuration < 3 || declaredDuration > 15
    || !Number.isFinite(actionSeconds) || actionSeconds < 0 || actionSeconds > 10
    || !Number.isFinite(reactionSeconds) || reactionSeconds < 0.3 || reactionSeconds > 1.2) return undefined
  const beats = Array.isArray(budget.performanceBeats) ? budget.performanceBeats as Record<string, unknown>[] : []
  if (beats.length) {
    // The writer uses performanceBeats to buy silent screen time the speech/action/reaction windows do
    // not cover. When a beat overlaps the declared windows completely it adds zero seconds and only
    // tangles the arithmetic, which is how record-4li23v’s rounds 1-4 died on “speech activityWindows
    // 应覆盖 11.49 秒” while the same claim was already filmed in the timeline body.
    const activities = Array.isArray(budget.activityWindows) ? budget.activityWindows as Record<string, unknown>[] : []
    const seconds = (row: Record<string, unknown>) => ({ startSecond: Number(row?.startSecond), endSecond: Number(row?.endSecond) })
    const usable = (row: Record<string, unknown>) => Number.isFinite(Number(row?.startSecond)) && Number.isFinite(Number(row?.endSecond))
      && Number(row.endSecond) > Number(row.startSecond) && Number(row.startSecond) >= 0
    const knownKinds = ['speech', 'action', 'reaction']
    if (!activities.length || !activities.every(row => knownKinds.includes(String(row?.kind)) && usable(row))) return undefined
    if (beats.some(beat => !usable(beat))) return undefined
    if (unionSeconds([...activities, ...beats].map(seconds)) - unionSeconds(activities.map(seconds)) > 0.005) return undefined
  }
  const audioType = normalizeStoryboardAudioType(record.audioType)
  const ambientOnly = isCinematicShot(record) && audioType === '环境声'
  const spoken = ambientOnly ? '' : normalizeStoryboardSpokenText(audioType, record.audioText)
  const speechSeconds = speechBudgetSeconds(String(spoken))
  const at = (value: number) => Number(value.toFixed(2))
  const speechEnd = at(actionSeconds + speechSeconds)
  const plannedEnd = at(speechEnd + reactionSeconds)
  const requiredDuration = Math.max(3, Math.ceil(at(plannedEnd + HISTORY_TAIL_SECONDS)))
  if (requiredDuration <= declaredDuration || requiredDuration > 15) return undefined

  const timedBeats = storyboardTimelineMatches(record.videoPrompt)
  const bodies = timedBeatBodies(record.videoPrompt, timedBeats)
  const timelineEnd = Number(timedBeats.at(-1)?.[2] ?? Number.NaN)
  if (timedBeats.length < 3 || !Number.isFinite(timelineEnd) || timelineEnd >= requiredDuration) return undefined
  if (Number(timedBeats[0][1]) !== 0 || timedBeats.some((match, index) => Number(match[2]) <= Number(match[1])
    || (index > 0 && Number(match[1]) !== Number(timedBeats[index - 1][2])))) return undefined
  const factor = requiredDuration / timelineEnd
  const boundaries: number[] = [0]
  for (let index = 0; index < timedBeats.length; index += 1) {
    const next = index === timedBeats.length - 1 ? requiredDuration : Number((Number(timedBeats[index][2]) * factor).toFixed(1))
    if (next <= boundaries[index]) return undefined
    boundaries.push(next)
  }
  for (let index = 0; index < timedBeats.length; index += 1) {
    const grown = boundaries[index + 1] - boundaries[index]
    const previous = Number(timedBeats[index][2]) - Number(timedBeats[index][1])
    const action = affirmativeAction(bodies[index]).replace(/[「“"『][^」”"』]*[」”"』]/g, '')
    const spokenInBeat = audioType === '对白'
      && dialogueLines(String(spoken)).some(line => dialogueIsBoundToTimedBeat(line, affirmativeAction(bodies[index])))
    if (grown > 1.2 + 1e-9 && previous <= 1.2 + 1e-9 && !spokenInBeat
      && staticHoldCue.test(action) && !filmedMotionCue.test(action)) return undefined
  }

  let videoPrompt = record.videoPrompt
  for (let index = timedBeats.length - 1; index >= 0; index -= 1) {
    const match = timedBeats[index]
    const header = match[0]
    const startOffset = header.indexOf(match[1])
    const endOffset = header.lastIndexOf(match[2])
    const rebuilt = `${header.slice(0, startOffset)}${boundaries[index]}${header.slice(startOffset + match[1].length, endOffset)}${boundaries[index + 1]}${header.slice(endOffset + match[2].length)}`
    const position = match.index ?? 0
    videoPrompt = videoPrompt.slice(0, position) + rebuilt + videoPrompt.slice(position + header.length)
  }

  const entrants = Array.isArray(record.enteringCharacters) ? record.enteringCharacters as Record<string, unknown>[] : []
  const entranceLimit = at(requiredDuration - HISTORY_TAIL_SECONDS)
  const scaledEntrants = entrants.map((entrant) => {
    const startSecond = Number(entrant?.startSecond)
    const endSecond = Number(entrant?.endSecond)
    if (!Number.isFinite(startSecond) || !Number.isFinite(endSecond)) return undefined
    const scaledEnd = Math.min(at(endSecond * factor), entranceLimit)
    return scaledEnd > startSecond ? { ...entrant, startSecond, endSecond: scaledEnd } : undefined
  })
  if (scaledEntrants.some((entrant) => !entrant)) return undefined

  const activityWindows = [
    ...(actionSeconds > 0 ? [{ kind: 'action', startSecond: 0, endSecond: at(actionSeconds) }] : []),
    ...(speechSeconds > 0 ? [{ kind: 'speech', startSecond: at(actionSeconds), endSecond: speechEnd }] : []),
    ...(reactionSeconds > 0 ? [{ kind: 'reaction', startSecond: speechEnd, endSecond: plannedEnd }] : []),
  ]
  return {
    ...record,
    duration: requiredDuration,
    videoPrompt,
    ...(entrants.length ? { enteringCharacters: scaledEntrants } : {}),
    pacing: { ...budget, activityWindows, ...(beats.length ? { performanceBeats: [] } : {}) },
  }
}

function storyboardPromptIssue(
  videoPrompt: string,
  audioType: string,
  audioText: string,
  characters: string[],
  enteringCharacters: StoryboardEntrant[] = [],
  speechRate = 4,
  duration = 15,
) {
  if (/(?:^|[^\d.-])(?:第\s*)?0\s*秒\s*[:：]/.test(videoPrompt)) {
    return 'videoPrompt 不得把静态构图、动作或声音堆在“第0秒”；开场状态只写入 visualPrompt，videoPrompt 必须从“0-若干秒”的可执行时间段开始'
  }
  const timedBeats = storyboardTimelineMatches(videoPrompt)
  if (!timedBeats.length) {
    return 'videoPrompt 必须包含可执行时间区间，当前识别到 0 段；可使用“0-4秒：…”或“0秒-4秒：…”，不能只有单点秒数'
  }
  const ranges = timedBeats.map((match) => ({ start: Number(match[1]), end: Number(match[2]) }))
  if (ranges[0].start !== 0 || ranges.at(-1)?.end !== duration
    || ranges.some((range, index) => range.end <= range.start || (index > 0 && range.start !== ranges[index - 1].end))) {
    const details = ranges.flatMap((range, index) => {
      const previousEnd = index ? ranges[index - 1].end : 0
      return [
        ...(range.end <= range.start ? [`第 ${index + 1} 段 ${range.start}–${range.end}秒起止倒置或时长为零`] : []),
        ...(range.start > previousEnd ? [`${previousEnd}–${range.start}秒缺口（${Number((range.start - previousEnd).toFixed(3))}秒）`] : []),
        ...(range.start < previousEnd ? [`第 ${index + 1} 段起点 ${range.start}秒与前段结束 ${previousEnd}秒重叠`] : []),
      ]
    })
    if (ranges.at(-1)?.end !== duration) details.push(`末段止于 ${ranges.at(-1)?.end}秒，duration=${duration}秒`)
    return `videoPrompt 的时间段必须从 0 秒开始、连续无重叠地覆盖到 duration=${duration} 秒；${details.join('；')}`
  }
  const affirmative = affirmativeAction
  const unsafeMouth = /(?:嘴唇?|口型).{0,8}(?:微动|微张|张开|颤动|张合|开合|翕动|无声)|无声.{0,8}(?:张口|开口|嘴唇?|口型)|欲言又止/
  const hasUnvoicedMouth = timedBeatBodies(videoPrompt, timedBeats).some((body) => {
    const action = affirmative(body)
    if (!unsafeMouth.test(action)) return false
    if (/无声.{0,8}(?:张口|开口|嘴唇?|口型)|欲言又止/.test(action)) return true
    return audioType !== '对白' || !dialogueLines(audioText).some((line) => dialogueIsBoundToTimedBeat(line, body))
  })
  if (hasUnvoicedMouth) {
    return 'videoPrompt 包含无声口型或欲言又止；这会让人物动嘴却没有音轨，必须改为眼神、呼吸、手势或身体停顿'
  }

  if (audioType !== '对白') return undefined
  const speakers = dialogueSpeakers(audioText)
  if (!speakers.length) return 'audioText 是对白时，每行必须以“角色名：”开头，以便绑定说话人与口型'
  const identities = characters.map(dialogueIdentity)
  if (new Set(identities).size !== identities.length) return 'characters 去除括注后有重名角色；请使用甲、乙等不同角色名区分身份，不能仅依靠括注区分说话人'
  const unknownSpeakers = speakers.filter((speaker) => !identities.includes(speaker))
  if (unknownSpeakers.length) return `audioText 的说话人未列入 characters：${unknownSpeakers.join('、')}`
  const beatBodies = timedBeatBodies(videoPrompt, timedBeats)
  const speakerBeatIndexes: Array<{ speaker: string; beatIndex: number }> = []
  for (const line of dialogueLines(audioText)) {
    const normalizedLine = normalizedDialogueCue(line.text)
    if (!normalizedLine) return `audioText 中“${line.speaker}”的台词不能只有标点或停顿符号`
    const matchingBeatIndex = beatBodies.findIndex((beat) => dialogueIsBoundToTimedBeat(line, beat))
    if (matchingBeatIndex < 0) {
      return `对白“${line.speaker}：${line.text}”未逐字绑定到任何明确时间段；必须在某个“起止秒”段内写明${line.speaker}开口/问/答并说出完整台词，不能只把台词列在末尾声音清单中`
    }
    speakerBeatIndexes.push({ speaker: line.speaker, beatIndex: matchingBeatIndex })
    const matchingBeat = beatBodies[matchingBeatIndex]
    const entrant = enteringCharacters.find((item) => dialogueIdentity(item.name) === line.speaker)
    if (entrant && ranges[matchingBeatIndex].start < entrant.endSecond) {
      return `入场人物“${line.speaker}”在 ${entrant.endSecond} 秒完成入场前就开始说话；必须先完整入画，再从后续时间段开口`
    }
    const cueSeconds = dialogueCueSeconds(line.text, speechRate)
    const beatSeconds = ranges[matchingBeatIndex].end - ranges[matchingBeatIndex].start
    const lengthIssue = dialogueCueLengthIssue(line, speechRate)
    if (lengthIssue) return lengthIssue
    if (cueSeconds > beatSeconds + 0.05) {
      return `对白“${line.speaker}：${line.text}”预计需要 ${cueSeconds} 秒，但绑定时间段只有 ${beatSeconds} 秒；请扩大该时间段或缩短台词，不得加快语速`
    }
    if (speakerHasClosedMouthCue(matchingBeat, line.speaker)) {
      return `说话人“${line.speaker}”在台词时间段内同时被要求闭口；必须删除冲突动作，并明确其开口说出台词`
    }
  }
  for (const beatIndex of new Set(speakerBeatIndexes.map((item) => item.beatIndex))) {
    const beatSpeakers = [...new Set(speakerBeatIndexes.filter((item) => item.beatIndex === beatIndex).map((item) => item.speaker))]
    if (beatSpeakers.length > 1) {
      return `同一时间段绑定了多个不同说话人：${beatSpeakers.join('、')}；每个说话人必须使用各自独立且相邻的时间段，必要时可使用第 5 或第 6 个时间段，确保镜头逐段锁定对应说话人的完整脸部和嘴唇`
    }
  }
  const nonSpeakers = identities.filter((character) => !speakers.includes(character))
  for (const character of nonSpeakers) {
    const clauses = videoPrompt.split(/[，,；;。！？!?\n]/)
    if (clauses.some((clause) => characterHasUnsupportedMouthCue(clause, character))) {
      return `非说话人“${character}”被安排了口部动作，但 audioText 没有其台词；请让其闭口，以眼神、手势或身体反应表演`
    }
  }
  return undefined
}

/** A declared speech budget must lie in the authored, exactly bound speaking
 * intervals. This checks plans only; it cannot establish actual audio timing. */
export function validateStoryboardSpeechActivityCoverage(output: Record<string, unknown>) {
  const pacing = output.pacing && typeof output.pacing === 'object' && !Array.isArray(output.pacing) ? output.pacing as Record<string, unknown> : undefined
  if (pacing?.version === DURATION_PACING_VERSION) return // Compiled, actor-bound speech windows are checked by the v2 scheduler.
  if (normalizeStoryboardAudioType(output.audioType) !== '对白' || !Array.isArray(pacing?.activityWindows)
    || typeof output.audioText !== 'string' || typeof output.videoPrompt !== 'string') return
  const lines = dialogueLines(String(normalizeStoryboardSpokenText(output.audioType, output.audioText)))
  const source = output.videoPrompt.split(/【(?:同期对白硬约束|口型同步|旁白时间硬约束)】/)[0].trim()
  const matches = storyboardTimelineMatches(source)
  const ranges = matches.map(match => ({ start: Number(match[1]), end: Number(match[2]) }))
  if (!lines.length || !ranges.length || ranges.some((range, index) => !Number.isFinite(range.start) || !Number.isFinite(range.end)
    || range.start < 0 || range.end <= range.start || (index > 0 && range.start < ranges[index - 1].end))) return
  const bodies = timedBeatBodies(source, matches)
  const speakingIndexes = lines.map(line => bodies.findIndex(body => dialogueIsBoundToTimedBeat(line, body)))
  // Missing prerequisites remain the responsibility of the full
  // contract. Do not invent speaking intervals to continue this diagnostic.
  if (speakingIndexes.some(index => index < 0)) return
  const speakingRanges = [...new Set(speakingIndexes)].sort((left, right) => left - right).map(index => ranges[index])
  for (const [index, value] of pacing.activityWindows.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const window = value as Record<string, unknown>
    if (window.kind !== 'speech' || !Number.isFinite(window.startSecond) || !Number.isFinite(window.endSecond)
      || Number(window.startSecond) < 0 || Number(window.endSecond) <= Number(window.startSecond)) continue
    let end = Number(window.startSecond)
    const epsilon = Number.EPSILON * 8 * Math.max(1, Math.abs(end), Math.abs(Number(window.endSecond)))
    for (const range of speakingRanges) {
      if (range.end <= end) continue
      if (range.start > end + epsilon) break
      end = Math.max(end, range.end)
      if (end + epsilon >= Number(window.endSecond)) break
    }
    if (end + epsilon < Number(window.endSecond)) throw new Error(`STORYBOARD_PACING_INVALID: speech activityWindows[${index}] 的 ${window.startSecond}-${window.endSecond} 秒未被逐字绑定台词的时间段完整覆盖；合法说话时间段=${JSON.stringify(speakingRanges)}。预算不能把未说话的开场或动作区间计作对白；保留完整台词与原动作，统一活动窗和实际编写的说话时间段，不推断实片发声时刻`)
  }
}

type StoryboardEntrant = { name: string; startSecond: number; endSecond: number; path: string }

function storyboardEntranceIssue(
  videoPrompt: string,
  enteringCharacters: StoryboardEntrant[],
  durationV2 = false,
) {
  const timedBeats = storyboardTimelineMatches(videoPrompt)
  const beatBodies = timedBeatBodies(videoPrompt, timedBeats)
  for (const entrant of enteringCharacters) {
    const beatIndex = timedBeats.findIndex((match) => Number(match[1]) <= entrant.startSecond && Number(match[2]) >= entrant.endSecond)
    if (beatIndex < 0) return `入场人物“${entrant.name}”的 ${entrant.startSecond}-${entrant.endSecond} 秒没有落入一个完整时间段`
    const beat = beatBodies[beatIndex] ?? ''
    const explicitLongPath=durationV2&&beat.includes(entrant.name+entrant.path)
      && /^(?:从|沿)[^。；\n]{1,100}(?:走来|步来|走入|步入|进入|入画)/.test(entrant.path)
    if (!beat.includes(entrant.name) || !beat.includes(entrant.path)
      || (!explicitLongPath&&!/(?:走入|步入|进入|入画|推门而入|掀帘而入|从.{0,12}(?:走来|步来|现身))/.test(beat))) {
      return `入场人物“${entrant.name}”必须在 ${entrant.startSecond}-${entrant.endSecond} 秒时间段内写明从“${entrant.path}”连续走入画面；禁止首帧出现、闪现或切镜补人`
    }
  }
  return undefined
}

/** Builds a stateful retry suffix so the model can edit the exact rejected
 * storyboard instead of blindly regenerating another candidate from scratch. */
export function buildStoryboardRepairSuffix(
  validationMessage: string,
  rejectedCandidate: unknown,
  attemptLabel: string,
  expectedPacingVersion?: unknown,
) {
  const dialogueMatch = validationMessage.match(/对白“([^”]+)”未逐字绑定/)
  let targetedInstruction = '逐项修复上面的校验错误；不要改动已经合规的字段、史实依据、人物关系和前后帧状态。'
  if (validationMessage.includes('STORYBOARD_REFERENCE_OVERFLOW:')) {
    targetedInstruction = '先修复真实模型的身份参考容量：reference开镜本段至多2个人物；reuse_previous_tail本段至多2个新入场者，已有尾帧人物不占新参考名额。原始requiredBeats要求的人物和剧情必须保留，但候选自行添加的重复职能角色可以合并：例如原场景只要求冀州官吏传阅封侯诏书，就由冀州官吏持诏，不要额外增加传诏使者。确需更多人物则分段，首段只出现两人，其余后段入场；每段都有coveredBeatIds和实际承担的beatCoverage锚点，不能产生空剧情的凑数段。只完成当前已分配节拍，不抢演其他节拍。同时修复其余错误。'
  } else if (validationMessage.includes('STORYBOARD_CONTINUITY_INVALID:')) {
    targetedInstruction = '修复连续性字段：visualPrompt 和 lastFramePrompt 必须用中文，所有人物使用 characters 中的汉字全名，不能用英文音译或“官员/二人”等代称。endCharacters 每个名字必须在尾帧正文中逐字出现；不得为通过校验而删掉仍在画面的人物。续接首帧复制上段静态尾帧，人物、道具归属、站位与机位保持不变。同时修复下面其余错误。'
  } else if (validationMessage.includes('STORYBOARD_COVERAGE_INCOMPLETE:')) {
    targetedInstruction = '这是剧情实现缺失，先修复具体画面与台词，不要仅靠拆镜或在标题、引用、备注中堆关键词。逐字使用错误中列出的每个锚点：例如把道具明确称为“封侯诏书”，把功曹明确写为“冀州官吏（功曹）”；必须让角色在画面内持有或操作道具，动作锚点必须发生在时间段正文中。人物名称在 characters、画面和说话人标签保持一致。不可只写同义词、否定句或“必须呈现”清单来冒充已实现剧情。修改后同步检查对白时间窗和前后人物状态。'
  } else if (/入场人物|initialCharacters|enteringCharacters/.test(validationMessage)) {
    targetedInstruction = '这是首帧与人物入场的连续性错误。保留入场人物及其三视图身份，在 enteringCharacters 指定的时间段内写明其从 path 所述入口连续走入：先出现身体轮廓，再完整入画；入场完成前不得说话。首帧及 initialCharacters 不得包含该人物，禁止闪现、切镜补人或让其在 0 秒已经处于场内。'
  } else if (/仅声明完成|遗漏 (?:visual|audio) 声画义务/.test(validationMessage)) {
    targetedInstruction = '这是节拍义务没有实拍。错误已经点名每一条未落地的锚点短语：保留 beatDramaturgy 的声明、已批准 function/stateChange 与全部剧情不变，把每个被点名的锚点原样写进它所属节拍对应位置——visual 与 mustShow 写进 visualPrompt/videoPrompt 的“起止秒”段正文，audio 写进 audioText 对应台词，并在同一时间段内让该角色真正做出动作或说出话。锚点内的字必须连续出现，只允许在锚点前后补充细节，禁止在锚点中间插入修饰词、换成更具体的同义词或只写人物名。禁止用删除节拍、清空 beatDramaturgy 或改成笼统描述来消除错误。'
  } else if (/超过单条口型锚点/.test(validationMessage)) {
    targetedInstruction = '这是长句口型累计漂移风险。保留原意，在自然语义停顿处把该角色的一条 audioText 拆成两条更短的“角色名：台词”；每条都必须作为完整独立台词逐字写进各自相邻时间段，并明确同一角色开口说出。不得只拆 videoPrompt 而保留一条长 audioText。'
  } else if (/预计需要 .*但绑定时间段只有/.test(validationMessage)) {
    targetedInstruction = '这是对白与时间窗不匹配。按本次生产语速预算并计入标点停顿，扩大该句所在时间段或缩短台词；不得加快语速，最后仅留 0.3 秒剪辑余量。'
  } else if (dialogueMatch) {
    targetedInstruction = `这是对白时间段绑定错误，不是让你删改台词。必须保留 audioText 中的“${dialogueMatch[1]}”原文，并把冒号后的完整台词逐字写进同一个“起止秒”段；该段同时明确写出对应角色开口/问/答。台词必须位于时间段正文内、声音清单之前。严禁把同一行台词拆成前后半句分散到多个时间段。若原时间段容纳不下，就合并相邻时间段或调整分界，禁止缩写、同义改写、移到末尾声音清单或只写“继续说”。`
  } else if (/说话人“([^”]+)”在台词时间段内同时被要求闭口/.test(validationMessage)) {
    const speaker = validationMessage.match(/说话人“([^”]+)”/)?.[1] ?? '说话人'
    targetedInstruction = `这是同一角色的口型动作冲突。保留 ${speaker} 的 audioText 台词原文及其“开口说出完整台词”动作，只删除该台词时间段内附着在 ${speaker} 身上的“闭口、嘴唇紧闭、不张口”等冲突描述；其他未说话人物仍须闭口。不要删台词、换说话人或改动其他时间段。`
  } else if (/同一时间段绑定了多个不同说话人/.test(validationMessage)) {
    targetedInstruction = '这是多人对白镜头绑定错误。把不同说话人的台词拆到各自独立且首尾相接的时间段，每段只允许一个说话人，并让镜头在该段持续锁定此人的完整脸部和嘴唇；可使用第 5 或第 6 个时间段，最后仅留 0.3 秒自然结尾。不得让两名角色在同一时间段分别说话。'
  } else if (validationMessage.startsWith('STORYBOARD_TIMING_OVERFLOW:')) {
    targetedInstruction = '这是时长超限错误。保留必要台词和停顿，通过增加连续的 15 秒分段解决；不得加快语速或把多句台词挤入同一短时间段。'
  } else if (validationMessage.includes('STORYBOARD_PACING_INVALID:')) {
    targetedInstruction = '这是时间预算数据不一致。仅修复错误点名的预算、窗口和边界，同步重算pacing.actionSeconds、reactionSeconds、duration；保留完整台词、原动作及先后关系。预算算错不代表表演空等，不要求缩短姿态保持或新增动作。'
    if (/空等|静止保持/.test(validationMessage)) targetedInstruction += '若原诊断确实指出空等，旧 pacing 与时间窗已被拒绝，按具体区间重新预算，不靠改同义词或增加无依据动作补救。'
  } else if (/时间段|第0秒|650 字符|500 个中文字符/.test(validationMessage)) {
    targetedInstruction = '这是 videoPrompt 时间轴结构错误。按所列缺口、重叠或结束边界定点修复，使“起止秒”段从 0 秒连续覆盖到 duration；“0秒-4秒”和“0-4秒”均有效。保留原动作和完整台词，3–6段及650字符为编排建议，不为凑数重写。'
  }
  // Single failures retain their established recipe. Only a diagnostic list
  // with multiple reported classes gets parallel, short instructions; do not
  // add obligations that were absent from this candidate's actual failures.
  if (validationMessage.split('\n').filter(line => /(?:HISTORY_|STORYBOARD_)[A-Z_]+:/.test(line)).length > 1) {
    const instructions = [
      { test: /HISTORY_DRAMA_INVALID:|STORYBOARD_COVERAGE_INCOMPLETE:/, text: '声画锚点：保留批准的节拍、function/stateChange 与全部原始锚点；把缺失的 visual 锚点原文落在实际画面动作、audio 锚点落在完整台词，不以声明代替实现。' },
      { test: /STORYBOARD_WORLD_STATE_INVALID:/, text: '世界状态：按所报证据规则修复字段；未采证或未知事实保持 unknown 且不填事实 value，计划动作写在画面正文，已有实测事实保留原证据。' },
      { test: /STORYBOARD_NARRATIVE_INCOMPLETE:/, text: '剧情闭合：storyProgress 与当前单元、完成条件一致，保留实际动作结果、回应和仍待完成事项；不得把未完成动作写成完成。' },
      { test: /STORYBOARD_CONTINUITY_INVALID:/, text: '连续性：保留本场要求的承接模式、前镜 id、实际人物和首尾状态，逐项修复所报不一致，不能删除人物或承接义务。' },
      { test: /STORYBOARD_REFERENCE_OVERFLOW:/, text: '身份容量：保留所有剧情必需人物，按实际参考容量拆成有完整节拍分配的连续段，不删除人物或剧情。' },
      { test: /超过单条口型锚点/, text: '逐行语音：只在自然语义停顿处把过长 audioText 拆为较短的同角色台词行，原文与顺序不变；每行不超过 6 秒并完整绑定到相邻时间段，重新计入行间停顿。' },
      { test: /STORYBOARD_PACING_INVALID:|STORYBOARD_TIMING_OVERFLOW:/, text: '时间预算：按修复后的完整 audioText 同步重算 speech/action/reaction 窗口、表演交集、duration 与连续时间轴，不能沿用旧预算、加速、重复计时或添加无依据动作；超限保留剧情拆段。' },
      { test: /videoPrompt.*(?:时间段|时间区间)/, text: '时间轴：逐一闭合所列具体缺口、重叠及结束边界，正文和完整台词保留；两端带秒单位也是合法格式，预算正确并不等于时间轴已经连续。' },
      { test: /未逐字绑定|预计需要 .*但绑定时间段只有/, text: '对白绑定：让每条完整台词逐字落在其说话人的单一可执行时间段；语音过长先合法拆行并重算窗口，不能把整段长台词重复追加到已有片段上。' },
    ].filter(recipe => recipe.test.test(validationMessage)).map(recipe => recipe.text)
    if (instructions.length > 1) targetedInstruction = instructions.join('\n')
  }
  const repairAudioType = rejectedCandidate && typeof rejectedCandidate === 'object' ? (rejectedCandidate as Record<string, unknown>).audioType : undefined
  if (/遗漏 audio 声画义务|超过单条口型锚点/.test(validationMessage)
    && (repairAudioType === undefined || normalizeStoryboardAudioType(repairAudioType) === '对白')) {
    targetedInstruction += '\n区分音频声明与发声排程：beatDramaturgy.audio 的每条批准原锚点仍须在声明数组某一项中完整保留；audioText 可让同一说话人在自然停顿处连续分行，各行正文依序连接必须保留全部原台词。不要把“声明在某一项完整保留”误解成必须把实际发声合成超过6秒的一行，也不要为了拆分发声而拆碎或删去剧情义务声明。每条发声行分别逐字绑定到可执行时间段，并按新行数重算停顿与时间预算。'
  }
  const candidateRecord = rejectedCandidate && typeof rejectedCandidate === 'object' ? rejectedCandidate as Record<string, unknown> : {}
  const durationCandidates = Array.isArray(candidateRecord.segments) ? candidateRecord.segments : [candidateRecord]
  if (expectedPacingVersion === DURATION_PACING_VERSION || /当前工作流要求 duration-v2/.test(validationMessage)
    || durationCandidates.some(value => value && typeof value === 'object' && ((value as Record<string, unknown>).pacing as Record<string, unknown>)?.version === DURATION_PACING_VERSION)) {
    // v2 has one compiled clock. The old generic pacing recipe requested
    // actionSeconds/reactionSeconds, fields this same validator forbids.
    const instructions = ['按当前 duration-v2 契约逐项修复点名字段，保留已经合规的台词、动作、主体、史实与连续性；窗口和哈希由程序编译。']
    if (Array.isArray(candidateRecord.segments)) instructions.push('分段 JSON 顶层仅保留 segments 数组，不放总 duration、id 或内容契约字段；每个 segments 元素都是完整独立分镜，使用 id 而非 segmentId，逐段包含 contentContractVersion、dramaticSceneId 及原模板全部字段，不使用 segmentIndex 或省略继承字段。')
    if (/STORYBOARD_COVERAGE_INCOMPLETE:|遗漏 (?:visual|audio) 声画义务/.test(validationMessage)) instructions.push('这是源剧情覆盖缺失。以当前 scene.requiredBeats 为权威范围，在 pacing.beats 中真正编排每个缺失 sourceBeatId 的全部原动作和台词，并同步 coveredBeatIds、beatDramaturgy 与 audioText；不能只补 ID、写完成态或放入 pendingActions。若全部内容不能在15秒内完成，本次返回完整 {"segments":[...]}，各段只声明自己的节拍，全部分段合起来按原顺序覆盖当前场景所有节拍；同一复杂节拍跨段时用 beatCoverage 与 beatDramaturgy 明确分配其原声画义务，不能只返回第一段。')
    if (/可执行正文缺少原锚点/.test(validationMessage)) instructions.push('按诊断核对对应 sourceBeatId 下实际 pacing.beats 的 kind、actorIds 与动作正文；声明层保留已批准原锚点和本段声画义务，执行层把真实动作写入 textOrVocalization 或适用的 performanceInstruction。简单入场沿用同主体入场规则；共享校验器已识别的明确双主体互动只有在批准场景恰有两名角色、同一 kind=action 的 actorIds 恰为这两名角色时，才允许原代称或两人全名联合主语，以及批准场地或同节拍来源原文已有的地点/持物修饰；保留动作谓词原字、主体身份与对象，不换动作同义词。mustShow 与 observable.visual 对同一动作的简述和细述可由这一实际动作共同满足，无需再演一次或堆砌短句。未被上述有限规则识别的复合锚点仍须连续原文；否定、计划、回忆、旁观、命令和完成声明都不能代替当场动作。仅放在 completion.evidenceAnchor/finalState、标题、visualPrompt 或手写 videoPrompt 不会进入程序编译的动作正文。原环境锚点可随已有动作呈现在正文，无需新增剧情动作。保留台词原文，不把画面说明写入 speech.textOrVocalization。')
    if (/STORYBOARD_PACING_INVALID:|STORYBOARD_TIMING_OVERFLOW:/.test(validationMessage)) instructions.push('时长按共享 timingPolicy 和各声部 deliveryStyle 的自然语速下界及停顿估算，修复对应 beats 的 lower/expected/upper、真实依赖或请求整数 duration；超15秒保留全部剧情拆段。不要增加旧 actionSeconds、reactionSeconds、activityWindows 或另一套手写时间轴，不删动作、不加速、不伪造并行。可选 performanceInstruction 没有额外表演要求时省略，不填空字符串。')
    if (/actorGroups|actorIds|角色身份/.test(validationMessage)) instructions.push('人物与群体字段：保留 scene.cast 中已批准的人物原名，不把已有身份重命名或改成新 actorGroup。actorGroups 的 id 只用于 pacing.beats.actorIds 引用，不能放进 characters、presentCharacters、initialCharacters、endCharacters 或 worldState.characters.name；这些人物字段使用原人物全名，群体确需在场声明时使用其 label。group.id/label 各自唯一，不能冒用已有角色标识。先修正错误字段及所有引用，再核对首尾在场名单，不能通过删掉原人物绕过检查。')
    if (/原声部.*description 明示/.test(validationMessage)) instructions.push('原声部继承：按当前 requiredBeats.description 中绑定原台词的明确执行方式，保留原画外旁白 narration 或原传唱 chant/singing 及发声主体。原台词相同不代表可以换演员或改成普通对白；分段只执行本段分配的原音频片段。')
    if (/需要明确 对白\/旁白\/环境声 音轨类型/.test(validationMessage)) instructions.push('audioType 只允许 对白、旁白、环境声。吟唱或歌唱是 speech.deliveryStyle=chant/singing，其所在片段 audioType=对白；保留原吟唱/歌唱方式及原文，不改成普通说话。')
    if (/对白轨不能将声部伪装为画外旁白|旁白声部须逐字覆盖 audioText/.test(validationMessage)) instructions.push('音轨编排：每个分段仅有一个 audioType。原场景同时有画外 narration 和画内 dialogue/chant/singing 时，本次返回覆盖全部原节拍的完整 {"segments":[...]}，按原顺序把旁白与画内发声分在各自片段；旁白段 audioType=旁白，出镜说话或唱谣段 audioType=对白。保留原发声人、deliveryStyle、完整原文和对应画面，不能把唱谣改成旁白或让画内人物代说旁白来绕过约束。同一复杂节拍跨段时明确分配原声画义务，不能遗漏后段。若只是旁白文本缺失或重复，逐字对齐 audioText 与其声部即可。')
    const offscreenRevealConflict = /反打不等于离场[\s\S]*enteringCharacters/.test(validationMessage)
    if (/WORLD_STATE|CONTINUITY|initialCharacters|enteringCharacters/.test(validationMessage)) instructions.push('逐项保留和修复前镜人物、持物、站位及承接模式；未实拍状态保持 unknown，不把计划当 observed，不为消除错误删人物或重演已完成动作。')
    if (offscreenRevealConflict) instructions.push('同场分段的画外人物显露不是再次入场：若前段 presentCharacters 已包含本段人物，而前段 endCharacters 只表示尾帧可见者，则从本段 enteringCharacters 删除该人物，改用 continuity.mode=coverage_cut、firstFrameMode=reference、bridgeType=cut 和具体 bridgeAnchor；本段 initialCharacters、presentCharacters 与 worldState 保留该人物及其他仍在场者，characters 仍只列本段实际可见或行动者。该人物“走向”另一人的动作继续作为普通 kind=action 保留，但不再伪造 entering 声明；不得改写前段、删除人物或改成 tail_continuation。')
    if (!offscreenRevealConflict && /入场人物[^\n]*路径[^\n]*匹配/.test(validationMessage)) instructions.push('入场路径按诊断中的 enteringCharacters[index].path 原文核对：保留该声明的完整 path，在该人物唯一 kind=action 的 textOrVocalization 或适用的 performanceInstruction 中真实走完；actorIds 绑定该入场人物。只写近义的“走来”、只写在手工 videoPrompt 或完成声明均不足，不能缩短或改写 path 来迁就缺失动作。本项不要求复制尚未编译的时间窗口；先修复动作、完整路径和原有依赖，再由程序统一投影 startSecond/endSecond，入场前不得发声。')
    if (/HISTORY_DRAMA_INVALID:|STORYBOARD_NARRATIVE_INCOMPLETE:/.test(validationMessage)) instructions.push('按已批准的 function/stateChange 和本段分配的声画义务修复声明与执行正文；只有源完整戏 closesUnit=true 的最后片段可以闭合，当前拍摄段结束不等于整场戏结束。')
    targetedInstruction = instructions.join('\n')
  }
  let candidateText: string
  try {
    candidateText = JSON.stringify(rejectedCandidate)
  } catch {
    candidateText = String(rejectedCandidate ?? '')
  }
  return `\n\n【${attemptLabel}】\n${validationMessage}\n【定点修复要求】${targetedInstruction}\n【上一版未通过的 JSON；请在此基础上修正并返回完整结果】\n${candidateText}`
}

/** Outline correction needs the same per-class targeting the storyboard already uses. The shipped
 * text only listed recipes for abstract anchors, characterStates and continuityMode while loudly
 * forbidding any other edit, so a HISTORY_CONTENT_REJECTED subject violation had no legal way out:
 * record-qlxrj0 burned the whole writer budget on scene-09/scene-10 because restoring 宾客 as the
 * acting subject requires touching cast and beat text, which the prompt had just forbidden.
 * Recipes are appended only for the classes actually reported, so a simple structural fix still
 * gets a short instruction instead of an ever-longer prompt. */
export const SCENE_OUTLINE_REPAIR_RECIPES: readonly { test: RegExp; instruction: string }[] = [
  { test: /adaptationSpace\.(?:policy|sourceLevel)/, instruction: '若缺陷指 adaptationSpace.policy/sourceLevel，分别从报错中的权威 input.adaptation_policy/input.source_level 原文逐字恢复被点名字段；policy 是改编边界，sourceLevel 是来源层级，两项不能互换、概括或自行润色。不根据当前错误的 adaptationSpace 推断输入，不从其他字段复制近义文本。只修该字段及其他同时明确点名的缺陷，所有未被点名的 scene、完整戏、人物、节拍、历史锁和声画正文必须从上一版 JSON 原样保留，不能重新生成整集。' },
  { test: /scenes\[[^\]]+\]\.historicalBasis/, instruction: '若缺陷指 scenes[].historicalBasis，逐一核对被点名场景已有 requiredBeats、historicalLocks[].fact/sourceRefs 及提供的史料正文，只在来源确切支持该场已有史事时补上对应的 [史料N] 引用并说明支持哪项事实，不改声画、人物、因果或原来源内容。不能从编号存在推断事实受支持，不能复制其他场景引用来凑格式，也不能把拟制行走、调度细节谎称史载。只有原段确实不承载史实的纯转场 context_bridge 才可如实明确无具体史料；有实际史事却缺依据时保留缺陷，不能为绕过门禁改角色、剧情或声明无史料。' },
  { test: /contextPayload/, instruction: '若缺陷指 contextPayload，先逐条核对被点名镜头现有 requiredBeats.observable.audio。开场、历史地图信息镜头及带话语的 context_bridge 一次补齐 timePlace、非空 geographicFocus 字符串数组、historicalBackground、narration；live_action 有史实旁白的 context_bridge 同样需要，旁白原文不得遗漏。只有全部音频都是明确物理来源的音效、没有旁白或对白的 live_action 承接镜头，才可省略整个 contextPayload；若已有 contextPayload，可保留完整的时地、地理和背景字段，同时 narration 为空。不要因空 narration 就删掉其他已有效的背景字段；只依据该段已有地点、年代、史实和 requiredBeats.observable.audio，真实旁白沿用原文，不能将音效名称转为朗读台词；不新增史实、不改声画义务、不为绕过检查把 context_bridge 改成 story；未知声音不能默认为无话语。' },
  { test: /dramaticScenes[^\n]*\.function/, instruction: '若缺陷指 dramaticScenes[].function，只修改被点名完整戏的 function：实际人物互相影响的冲突用 conflict，开场建立处境用 setup，呈现已发生行动的后果用 consequence，承接时空或因果用 transition。此字段仅允许 conflict/setup/consequence/transition；payoff 仅属于 scenes[].editorialRole，不得将两套枚举混用。保持该完整戏的剧情、声画、人物和全部节拍原样。' },
  { test: /episodeDrama\.(?:openingPromise|payoff)\.beatIds/, instruction: '若缺陷指 episodeDrama 的节拍引用，先核对首场/末场的 scenes[].requiredBeats[].id 与所属 dramaticScenes.beatIds，以当前候选中双方一致的实际节拍为权威；依据原承诺/回应内容选择准确引用，仅修点名 beatIds，不改 description，不新增、删除、重编号或改写 requiredBeats 来迁就错误引用，也不从其他稿件复制编号。无法唯一对应时明确保留缺陷，不能编造覆盖。' },
  { test: /dramaticScenes[^\n]*\.beatIds/, instruction: '若缺陷指 dramaticScenes[].beatIds，按 scenes 的现有顺序找到 dramaticSceneId 与该戏 id 一致的短段，再依次收集其 requiredBeats[].id，将完整有序列表同步到被点名戏的 beatIds。scenes[].dramaticSceneId 与 requiredBeats[].id 是此修复的权威归属与标识；仅同步引用，不新增、删除、重编号或改写节拍内容，也不改变归属。若原节拍 ID 重复或归属本身无效，必须保留对应错误，不能猜测映射。' },
  { test: /(?:^|\n)(?:HISTORY_DRAMA_INVALID:\s*)?(?:scenes(?:\[[^\]]+\]|\.[^\s.]+)\.)?editorialRole\s*(?:无效|必须)/, instruction: '若缺陷指 editorialRole，只把点名 scene 的该字段改为合法枚举：首个建立镜头用 episode_opening，普通人物剧情或叙事推进用 story，跨完整戏的时空/因果承接镜头用 context_bridge，末尾实际回应开场承诺用 payoff。不得另造 main_action、story_action、narrative_action 等近义值；除非错误同时点名，不改画面、台词、节拍或场景归属。' },
  { test: /锚点|(?:observable|mustShow)[^\n]*(?:抽象|概括|必须有实际声画义务)/, instruction: '若缺陷指某锚点抽象，只把该锚点换成可直接拍出的具体可见短语并同步同一 beat 的 description 用词，其余不动。' },
  { test: /话语|对白|台词|声音|声部/, instruction: '若 mustShow 或 observable.visual 中的抽象项只是对同一 beat 音频义务的标签，删除这条视觉标签；完整原话只保留在 observable.audio，必要的开口、转头等真实可见动作另用具体视觉短语表达。不得把“恳求话语”“对白”“台词”等元标签塞进 action 正文，也不得重复或改写原台词。' },
  { test: /characterStates|characters 覆盖|cast/, instruction: '若缺陷指 characterStates、characters 或 cast，先核对该段是否真的有具名人物表演。纯环境镜头与匿名弟子、病患、百姓、军士等真人群演镜头可保留空 cast/characters/characterStates 与 live_action，不得为过校验虚构具名人物，也不得把真人群演改成 time_montage、historical_tableau 或 character_illustration。只有 episode_opening/context_bridge/payoff 的 historical_map 历史地理地图信息背景可走动画；地图若需叠加已有具名人物静态肖像，scene.cast 与分镜 characters、illustrationLayers 按姓名和资产一一对应，但肖像不是人物表演，不据此虚构真人入场、对白或 characterStates。确有具名人物真人出镜、行动或说话时，才把该人物同步列入 scene.cast、dramaticScenes.characters，并为其补齐 before/after；删除错误的多余具名人物时也要同步三处。' },
  { test: /continuityMode|continuityFromPrevious|scenes\[[^\]]+\][^\n]*\.setting|归属/, instruction: '若缺陷指 setting、continuityMode、continuityFromPrevious 或完整戏归属，先按原 requiredBeats.description 与实际声画核对空间及时间边界。“同一空地、傍晚”等文字不能仅机械替换为完整戏 setting；先确认仍是同一连续时空，还是已经换地点或发生显著时间重置。确属同一连续物理空间和时间时才对齐 setting 与承接模式；若原声画明确切到另一空间或重置时间，保留全部原动作、台词、地点及时间描述，拆分对应 dramaticSceneId/完整戏归属，同步 setting、beatIds、characterStates 与直接依赖，新时空首段保留 scene_cut。不得仅把 scene_cut 改成 tail_continuation，或改写原声画使异空间/时间跳跃伪装为连续镜头。' },
  { test: /HISTORY_CONTENT_REJECTED|行动主体|史料记载的人物/, instruction: '若缺陷是 HISTORY_CONTENT_REJECTED（史料行动主体、时代或因果被改写），必须把被点名 scene 内实际行动与反应的承担者改回史料记载的人物，并同步修改这些字段：该场 cast、requiredBeats 的 description/observable/mustShow/function/stateChange/purpose、所属 dramaticScenes 的 characters/tactics/turn/result/characterStates，以及对应 characterDramas 的 goal/tactic/leverage；让史料记载的人物（如两家宾客）当场完成接报、讥揣、结交等动作，历史本人只承担史料写到的言行。错误里“触发原文：”点名的字段（包括只写着“默许”“暗示”等幕后意图的 purpose/function/stateChange）属于必改范围，不算越界润色；把该句的行动承担者换成史料记载的人物重写这一句，不要只在原句上删字。未被点名的其余内容仍须逐字保留。只在 adaptationBoundary、purpose 或 historicalBasis 里声明“拟制”或“史料支持”而保留原来的本人动机，仍然违规。' },
]

export function buildSceneOutlineRepairSuffix(
  prompt: string,
  validationMessage: string,
  rejectedCandidate: unknown,
  repairAttempt = 1,
  previousAttemptUnchanged = false,
) {
  let candidateText: string
  try {
    // The normalizer appends duplicate provider text/raw after the authored fields.
    // record-vn75ae's 17k outline became 75k, then the 20k limit cut through its
    // escaped raw response. Keep the complete authoritative JSON, never a prefix
    // of a second, potentially stale draft. Nested authored fields stay intact.
    const candidate = rejectedCandidate && typeof rejectedCandidate === 'object' && !Array.isArray(rejectedCandidate)
      && Array.isArray((rejectedCandidate as Record<string, unknown>).scenes)
      ? Object.fromEntries(Object.entries(rejectedCandidate).filter(([key]) => !['text', 'raw', 'model'].includes(key)))
      : rejectedCandidate
    candidateText = JSON.stringify(candidate)
  } catch {
    candidateText = String(rejectedCandidate ?? '')
  }
  const recipes = SCENE_OUTLINE_REPAIR_RECIPES.filter(recipe => recipe.test.test(validationMessage)).map(recipe => recipe.instruction)
  recipes.push(outlineKnowledgeRepairInstruction(validationMessage, rejectedCandidate))
  const stalled = previousAttemptUnchanged
    ? '\n【上一轮未执行修复】上一次修正返回与基线逐字段完全相同，不能再次照抄。请先逐条定位错误中点名的字段，确认这些字段的值确实发生改变，再输出完整 JSON。'
    : ''
  return `${prompt}\n\n【场景大纲结构校验未通过，必须修正 · 第 ${repairAttempt} 轮】\n${validationMessage}${stalled}\n上面可能一次列出多项缺陷，分属不同 scene，必须在本次输出里全部修完，不要只修第一项。\n修正必须是最小局部改动：以下方【上一版未通过的 JSON】为唯一基线，逐字保留全部已通过的内容，只改动直接修复所列缺陷所必需的字段。未被点名的 scene、dramaticScenes、characterDramas、requiredBeats、historicalLocks、adaptationSpace、episodeDrama 及其子字段必须原样照抄；严禁增删或重排场景/完整戏/人物，严禁顺带润色、重组结构或“改进”未被点名的部分。只有报错明确要求拆段、调整完整戏归属或补齐人物时，才可同步修改其直接依赖。\n${recipes.join('')}\n逐条核对错误中点名的字段路径，确保全部修复；保留原 purpose 承诺的剧情和所有未被点名的具体声画内容。基线已省略重复的传输 text/raw/model，不要在输出中补回这些字段。只返回修正后的完整 JSON 对象。\n【上一版未通过的 JSON】\n${candidateText}`
}

export function appendLipSyncContract(videoPrompt: string, audioType: string, audioText: string, characters: string[], shot: Record<string, unknown> = {}) {
  videoPrompt = videoPrompt.split(/【(?:同期对白硬约束|口型同步|旁白时间硬约束|声部与收束)】/)[0].trim()
  if ((shot.pacing as Record<string,unknown>)?.version === DURATION_PACING_VERSION) {
    const pacing = shot.pacing as Record<string,unknown>, policy = resolveDurationPolicy(pacing.timingPolicy)
    const beats = pacing.beats as DurationBeat[]
    const voices = beats.filter(beat=>beat.kind==='speech'||beat.kind==='vocalization').map(beat=>({beatId:beat.id,actorIds:beat.actorIds,
      kind:beat.kind,deliveryStyle:beat.deliveryStyle,textOrVocalization:beat.textOrVocalization,...(beat.vocalization?{vocalization:beat.vocalization}:{})}))
    return `${videoPrompt}\n【声部与收束】按共享策略 ${policy.version} 和已编译节拍分别完成下列声部：${JSON.stringify(voices)}。对白按角色绑定嘴唇，画外旁白不绑定画内口型；歌谣、吟诵和歌唱遵循各自表演节奏，不强制改成每秒4.5字的对话。已声明的无词群体声部必须实际可听，不能因不在audioText中而静音；未声明声部不得新增可辨语言。完整保留每句台词及原动作先后关系，动作与必需回应完成后保留 ${policy.endingReadabilityReserve} 秒可读收尾，允许自然呼吸微动，不新增剧情动作或以静帧补齐缺失动作。导演参考窗口用于定位表演，硬边界和前置依赖必须遵守。`
  }
  if (isCinematicShot(shot) && audioType === '环境声') {
    return `${videoPrompt}\n【口型同步】本镜没有对白或旁白，只有真实环境声及已规划的非语言表演；人物不作语言口型，不新增可辨语言。保留具体动作与决定过程，完成后仅留0.3秒剪辑余量，不延长静帧。`
  }
  if ((shot.pacing as Record<string, unknown>)?.version === HISTORY_PACING_VERSION) {
    const speakers = dialogueSpeakers(audioText)
    return `${videoPrompt}\n【口型同步】${audioType === '旁白' ? '画外旁白不绑定人物口型' : `仅${speakers.join('、')}在逐句时间窗内自然开口发声，其他人物倾听并作真实反应`}。普通话自然对话约每秒4.5汉字，按句意停连，不逐字拖腔、不为凑片长拉长停顿；完整保留台词。对白与对手必要反应完成后立即结束镜头，仅留0.3秒剪辑余量；允许自然呼吸与微动，不要求全体静止、闭口摆拍或转向镜头。`
  }
  if (audioType === '旁白') {
    const end = Math.min(12, 0.5 + estimateStoryboardTiming(audioText, '').rawRequiredSeconds - 2.5)
    return `${videoPrompt}\n【旁白时间硬约束】画外旁白从0.5秒开始，在${end.toFixed(1)}秒前完整说完“${audioText}”，不得延后开口，13.5-15秒完全无人声，只保留环境底声。\n【口型同步】画外旁白，不绑定画面人物口型；所有出镜人物不得出现说话或无声语言口型；保留时间轴明确编排的自然表情与非语言反应，不新增对白，最后1.5秒保持静止闭口无人声。`
  }
  const speakers = dialogueSpeakers(audioText)
  const silentCharacters = characters.filter((character) => !speakers.includes(dialogueIdentity(character)))
  return `${videoPrompt}\n【同期对白硬约束】每句对白已逐字写入明确时间段；仅${speakers.join('、')}在各自台词所在时间段开口并同步发出清晰、完整、可听的普通话人声，不得只生成口型或只生成环境/动作声，不得增词、漏词、延后、串角；台词期间说话人的整张脸和嘴唇必须持续清晰入镜、无遮挡，不得被碗、手、衣袖或其他道具遮住，不得切到其他人物；${silentCharacters.length ? `${silentCharacters.join('、')}没有台词，不得抢说或做语言口型，但保留时间轴已明确编排的微笑、笑声及表情反应；` : ''}对白结束后停止语言口型，按时间轴继续动作和自然表情；最后 1.5 秒所有人物双唇完全贴合、无人声，禁止以嘴部或喉部特写作为无声尾帧；非台词时段不得新增可辨语言。`
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

function isImmediateNarrativeContinuation(previous: Record<string, unknown>, current: Record<string, unknown>) {
  const previousPurpose = String(previous.purpose ?? '').trim()
  const currentPurpose = String(current.purpose ?? '').trim()
  if (!previousPurpose || !currentPurpose) return false
  const previousLeavesQuestion = /(?:问|追问|质问|发问|逼问|反问|喝问|试探|要.*答|如何答|\?|？)/.test(previousPurpose)
  const currentStartsWithAnswer = /^(?:[^———：:]{0,12})?(?:答|回答|答道|回应|回道|坦言|承认|解释|反问|接话|续道|开口|沉默.{0,8}(?:后|，|,))/.test(currentPurpose)
  const explicitCarryOver = /^(?:[^———：:]{0,12})?(?:继续|接着|随即|仍然|仍|终于|紧接着|紧接(?:上|前)一镜|承接(?:上|前)一镜)/.test(currentPurpose)
  return (previousLeavesQuestion && currentStartsWithAnswer) || explicitCarryOver
}

function sceneSetting(scene: Record<string, unknown>) {
  const beats = Array.isArray(scene.requiredBeats) ? scene.requiredBeats : []
  const settings = beats
    .map((beat) => beat && typeof beat === 'object' && !Array.isArray(beat) ? String((beat as Record<string, unknown>).setting ?? '').trim() : '')
    .filter(Boolean)
  return settings.length && settings.every((setting) => normalizedCoverageText(setting) === normalizedCoverageText(settings[0]))
    ? normalizedCoverageText(settings[0])
    : ''
}

function hasExplicitTemporalBreak(scene: Record<string, unknown>) {
  const description = `${String(scene.title ?? '')} ${String(scene.purpose ?? '')}`
  return /(?:数日|数月|数年|多年|翌日|次日|次晨|当夜|翌晨|后来|此后|不久后|片刻后|半晌后|与此同时|同一时间|转眼|时隔|天后|月后|年后)/.test(description)
}

/** Repairs a conservative model flag when adjacent entries plainly form one
 * uninterrupted exchange or retain an identified character in the same
 * physical setting without a time jump. A shared location alone is insufficient. Ordinary scene changes retain the model flag. */
export function deriveSceneContinuity(scenes: Array<Record<string, unknown>>) {
  return scenes.map((scene, index) => {
    if (index === 0) return scene
    const previous = scenes[index - 1]
    if (scene.dramaticUnitId && previous.dramaticUnitId) {
      return previous.closesUnit === false && scene.dramaticUnitId === previous.dramaticUnitId
        ? { ...scene, continuityFromPrevious: true } : scene
    }
    const previousSetting = sceneSetting(previous)
    const previousCast = Array.isArray(previous.cast) ? previous.cast : []
    const currentCast = Array.isArray(scene.cast) ? scene.cast : []
    const continuingCharacter = previousCast.some(name => currentCast.includes(name))
    const sharedSetting = continuingCharacter && Boolean(previousSetting)
      && previousSetting === sceneSetting(scene)
      && !hasExplicitTemporalBreak(scene)
    const currentSetting = sceneSetting(scene)
    if (hasExplicitTemporalBreak(scene) || (previousSetting && currentSetting && previousSetting !== currentSetting)) {
      return { ...scene, continuityFromPrevious: false }
    }
    return isImmediateNarrativeContinuation(previous, scene) || sharedSetting
      ? { ...scene, continuityFromPrevious: true }
      : scene
  })
}

export function estimateStoryboardTiming(audioValue: unknown, videoPromptValue: unknown, speechRate = 4) {
  const audioText = String(audioValue ?? '')
  const videoPrompt = String(videoPromptValue ?? '')
  const lines = spokenText(audioText)
  const dialogue = lines.join('\n')
  const speechCharacterCount = [...dialogue].filter((character) => /\p{Script=Han}/u.test(character)).length
  const speechSeconds = speechCharacterCount / speechRate
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

type RequiredStoryBeat = Record<string, unknown> & {
  id: string
  description: string
  setting: string
  mustShow: string[]
}

function requiredStoryBeats(scene: Record<string, unknown>, context: string, required = false): RequiredStoryBeat[] {
  const rawBeats = scene.requiredBeats
  if (rawBeats === undefined && !required) return []
  if (!Array.isArray(rawBeats) || !rawBeats.length) {
    throw new Error(`${context}.requiredBeats 必须是非空数组`)
  }
  const ids = new Set<string>()
  const beats = rawBeats.map((value, index) => {
    const beat = structuredRecord(value, `${context}.requiredBeats[${index}]`)
    rejectUnexpectedKeys(beat, ['id', 'description', 'setting', 'mustShow', 'function', 'stateChange', 'observable'], `${context}.requiredBeats[${index}]`)
    const id = requiredString(beat, 'id', `${context}.requiredBeats[${index}]`)
    if (ids.has(id)) throw new Error(`${context}.requiredBeats 存在重复 id：${id}`)
    ids.add(id)
    const description = requiredString(beat, 'description', `${context}.requiredBeats[${index}]`)
    const setting = requiredString(beat, 'setting', `${context}.requiredBeats[${index}]`)
    const observable = isPlainRecord(beat.observable) ? beat.observable : {}
    const observableObligations = Array.isArray(observable.visual) && Array.isArray(observable.audio)
      ? [...observable.visual, ...observable.audio] : []
    // Only runtime partitions may allocate no mustShow: their separate visual
    // or audio obligation is still checked by the drama and executable gates.
    // Authored root scenes keep the original nonempty mustShow contract.
    const allowsEmptyMustShow = isCinematicShot(scene) && typeof scene.sourceSceneId === 'string' && Boolean(scene.sourceSceneId.trim())
      && observableObligations.length > 0 && observableObligations.every(anchor => typeof anchor === 'string' && Boolean(anchor.trim()))
    if (!Array.isArray(beat.mustShow) || (!beat.mustShow.length && !allowsEmptyMustShow)
      || beat.mustShow.some((anchor) => typeof anchor !== 'string' || !anchor.trim())) {
      throw new Error(`${context}.requiredBeats[${index}].mustShow 必须是非空字符串数组`)
    }
    const mustShow = [...new Set((beat.mustShow as string[]).map((anchor) => anchor.trim()))]
    return { ...beat, id, description, setting, mustShow }
  })
  const settings = [...new Set(beats.map((beat) => normalizedCoverageText(beat.setting)))]
  if (settings.length > 1) {
    throw new Error(`${context}.requiredBeats 跨越了多个物理空间；每个 scene 只能有一个连续场地，必须在大纲阶段拆成相邻 scenes`)
  }
  return beats
}

function normalizedCoverageText(value: unknown) {
  return String(value ?? '').replace(/[\s，,。；;：:'"“”‘’（）()【】\-—]/g, '')
}

function hasRaisedCupAction(record: Record<string, unknown>) {
  const video = String(record.videoPrompt ?? '').split(/【(?!\s*(?:第\s*)?\d)|备注[：:]|说明[：:]/)[0]
  const ranges = storyboardTimelineMatches(video)
  const actors = Array.isArray(record.characters) ? record.characters.map(String) : []
  const cup = '(?:(?:素陶|青铜|陶|酒)?(?:樽|觞|杯))'
  const raised = new RegExp(`举(?:起|着|了)?(?:手中(?:的)?)?(?:一[只个])?${cup}|${cup}[^，,。；;！!?？]{0,8}举(?:起|高|至|到)`)
  return timedBeatBodies(video, ranges).some((body) => body.replace(/[「“"『][^」”"』]*[」”"』]/g, '').split(/[，,。；;！!?？\n]/).some((clause) => {
    // Reported dialogue and instructions are not an enacted prop movement.
    const visible = clause
    return actors.some((actor) => visible.includes(actor))
      && !/(?:没有|未曾|未|不再|不|禁止|不得|避免|必须|需要|应当|想象|回忆|提到|谈及)/.test(visible)
      && raised.test(visible)
  }))
}

export function validateStoryboardBeatCoverage(record: Record<string, unknown>, scene: Record<string, unknown>) {
  const beats = requiredStoryBeats(scene, 'scene')
  if (!beats.length) return
  if (!Array.isArray(record.coveredBeatIds)
    || record.coveredBeatIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new Error('STORYBOARD_COVERAGE_INCOMPLETE: history.storyboard.coveredBeatIds 必须列出本段完整实现的剧情节拍')
  }
  const coveredIds = record.coveredBeatIds as string[]
  const expectedIds = beats.map((beat) => beat.id)
  if (new Set(coveredIds).size !== coveredIds.length
    || coveredIds.length !== expectedIds.length
    || coveredIds.some((id, index) => id !== expectedIds[index])) {
    throw new Error(`STORYBOARD_COVERAGE_INCOMPLETE: 本段必须按顺序完整覆盖剧情节拍 ${expectedIds.join('、')}，实际为 ${coveredIds.join('、') || '空'}；不得只拍前半段后丢弃余下剧情`)
  }
  if (isPlainRecord(record.pacing) && record.pacing.version === DURATION_PACING_VERSION) {
    // Use the same strict executable proof as the duration acceptance path.
    // Empty companion diagnostics can mean unknown shape, not valid coverage.
    // Static frames and a discarded hand-written timeline cannot prove actions.
    compileDurationSchedule(record, { scene })
    return
  }
  const implementation = normalizedCoverageText([
    record.visualPrompt,
    record.videoPrompt,
    record.audioText,
    record.lastFramePrompt,
  ].join('\n'))
  const missingAnchors = beats.flatMap((beat) => beat.mustShow
    .filter((anchor) => anchor === '举杯' ? !hasRaisedCupAction(record) : !implementation.includes(normalizedCoverageText(anchor)))
    .map((anchor) => `${beat.id}:${anchor}`))
  if (missingAnchors.length) {
    throw new Error(`STORYBOARD_COVERAGE_INCOMPLETE: 分镜未实际呈现大纲硬锚点 ${missingAnchors.join('、')}；若 15 秒无法容纳，必须拆成连续分段，不得省略剧情`)
  }
}

/** A later queue round may continue the same source beat, but it may only film
 * the obligations that remain in that round's approved scene partition. This
 * catches duplicated actions before provider generation, including anonymous
 * actor-group actions whose state is not represented in named worldState. */
export function validateNoCompletedActionReplay(record: Record<string, unknown>, scene: Record<string, unknown>, previous?: Record<string, unknown>) {
  if (!previous || !isPlainRecord(record.pacing) || !Array.isArray(record.pacing.beats)) return
  const previousIds = new Set(Array.isArray(previous.coveredBeatIds) ? previous.coveredBeatIds.map(String) : [])
  const currentIds = new Set(Array.isArray(record.coveredBeatIds) ? record.coveredBeatIds.map(String) : [])
  if (![...currentIds].some(id => previousIds.has(id))) return
  const approved = requiredStoryBeats(scene, 'scene').flatMap(beat => {
    const observable = isPlainRecord(beat.observable) ? beat.observable : {}
    return [...beat.mustShow, ...(Array.isArray(observable.visual) ? observable.visual.map(String) : []),
      ...(Array.isArray(observable.audio) ? observable.audio.map(String) : [])]
  })
  const pending = isPlainRecord(previous.storyProgress) && Array.isArray(previous.storyProgress.pendingActions)
    ? previous.storyProgress.pendingActions.map(String) : []
  const allowed = [...approved, ...pending].map(normalizedCoverageText).filter(Boolean)
  const replays = (record.pacing.beats as unknown[]).flatMap((value, index) => {
    if (!isPlainRecord(value) || value.kind !== 'action' || !previousIds.has(String(value.sourceBeatId ?? ''))) return []
    const performed = normalizedCoverageText(String(value.textOrVocalization ?? ''))
    if (!performed || allowed.some(item => item.includes(performed) || performed.includes(item))) return []
    return [`pacing.beats[${index}] “${String(value.textOrVocalization ?? '')}”`]
  })
  if (replays.length) throw new Error(`STORYBOARD_CONTINUITY_INVALID: 同一 sourceBeatId 的后续分镜重演了前镜已完成动作或加入未分配动作：${replays.join('、')}；当前镜只能执行 scene.requiredBeats 的剩余锚点和前镜 pendingActions`)
}

export function validateNoUnallocatedSplitActions(record: Record<string, unknown>, scene: Record<string, unknown>) {
  if (!String(scene.sourceSceneId ?? '') || !isPlainRecord(record.pacing) || !Array.isArray(record.pacing.beats)) return
  const criteria = Array.isArray(scene.completionCriteria) ? scene.completionCriteria.map(String) : []
  const beats = requiredStoryBeats(scene, 'scene')
  const restricted = new Map(beats.flatMap(beat => criteria.includes('原节拍表演：' + beat.description) ? [] : [[beat.id, beat]]))
  const extras = (record.pacing.beats as unknown[]).flatMap((value, index) => {
    if (!isPlainRecord(value) || value.kind !== 'action') return []
    const beat = restricted.get(String(value.sourceBeatId ?? ''))
    if (!beat) return []
    const observable = isPlainRecord(beat.observable) && Array.isArray(beat.observable.visual) ? beat.observable.visual.map(String) : []
    const allowed = [...beat.mustShow, ...observable].map(normalizedCoverageText).filter(Boolean)
    const performed = normalizedCoverageText(String(value.textOrVocalization ?? ''))
    return performed && !allowed.some(item => item.includes(performed) || performed.includes(item))
      ? [`pacing.beats[${index}] “${String(value.textOrVocalization ?? '')}”`] : []
  })
  if (extras.length) throw new Error(`STORYBOARD_COVERAGE_INVALID: 自动拆分后的本段加入了未分配动作：${extras.join('、')}；只允许当前 completionCriteria/observable.visual 的动作，其他动作留给后续分段`)
}

export function storyboardStatePrompt(value: unknown) {
  return String(value ?? '').split('【静态尾帧】')[0].trim()
}

function validateStoryboardContinuity(record: Record<string, unknown>, expected: Record<string, unknown>) {
  if (expected.requireContinuityContract === false || (!expected.requireContinuityContract && !record.continuity)) return
  const endCharacters = record.endCharacters
  if (!Array.isArray(endCharacters) || endCharacters.some((name) => typeof name !== 'string'
    || !(record.characters as string[]).includes(name) || !String(record.lastFramePrompt).includes(name))
    || new Set(endCharacters).size !== endCharacters.length) {
    throw new Error('STORYBOARD_CONTINUITY_INVALID: endCharacters 必须列出尾帧实际可见人物且姓名在 lastFramePrompt 中逐字出现')
  }
  const continuity = structuredRecord(record.continuity, 'STORYBOARD_CONTINUITY_INVALID: continuity')
  rejectUnexpectedKeys(continuity, ['previousShotId', 'bridgeType', 'bridgeAnchor', 'mode', 'exitingCharacters'], 'STORYBOARD_CONTINUITY_INVALID: continuity')
  const previous = expected.previousShot as Record<string, unknown> | undefined
  if (!previous) {
    if (continuity.previousShotId !== '' || continuity.bridgeType !== 'opening') throw new Error('STORYBOARD_CONTINUITY_INVALID: 第一镜 continuity 使用 previousShotId="" 和 bridgeType="opening"')
    return
  }
  if (continuity.previousShotId !== previous.id) throw new Error(`STORYBOARD_CONTINUITY_INVALID: previousShotId 必须为 ${String(previous.id)}，禁止引用旧轮次`)
  if (isCinematicShot(record) && continuity.mode === 'coverage_cut') {
    validateCinematicShot(record, expected.scene as Record<string, unknown> ?? {}, previous)
    return
  }
  if (record.firstFrameMode === 'reuse_previous_tail') {
    const previousCast = previous.endCharacters ?? previous.characters
    if (!Array.isArray(previousCast) || !Array.isArray(record.initialCharacters)
      || previousCast.length !== record.initialCharacters.length || previousCast.some((name) => !(record.initialCharacters as unknown[]).includes(name))) {
      throw new Error(`STORYBOARD_CONTINUITY_INVALID: initialCharacters 必须与前镜 endCharacters ${JSON.stringify(previousCast)} 完全一致，新增人物只能通过 enteringCharacters 入场`)
    }
    const evidence = previous.worldStateEvidence as Record<string, unknown> | undefined
    const principleActualTail = expected.qualityMode === 'principle-v1' && isCinematicShot(record) && isCinematicShot(previous)
      && continuity.mode === 'tail_continuation' && evidence?.method === 'actual-tail-image' && evidence.qualityPolicy === 'principle-v1'
      && typeof evidence.frame === 'string' && /^\/generated\/[\w./-]+\.(?:jpg|jpeg|png|webp)$/i.test(evidence.frame)
    if (principleActualTail && continuity.bridgeType === 'same_frame') {
      // The caller already bound this writer-only projection to accepted real
      // media. Preserve its state/cast contract without requiring two prose
      // descriptions of the same opening image to be byte-identical.
      validateCinematicShot(record, expected.scene as Record<string, unknown> ?? {}, previous)
      return
    }
    if (continuity.bridgeType !== 'same_frame' || storyboardStatePrompt(record.visualPrompt) !== storyboardStatePrompt(previous.lastFramePrompt)) {
      throw new Error('STORYBOARD_CONTINUITY_INVALID: 连续镜头 bridgeType 必须为 same_frame，visualPrompt 必须原样复制上一镜 lastFramePrompt 的静态正文（不含【静态尾帧】附加约束）；动作从该姿态继续')
    }
  } else {
    const anchor = String(continuity.bridgeAnchor ?? '').trim()
    if (continuity.bridgeType === 'cut' && anchor.length >= 4) return
    if (!['sound', 'action', 'prop', 'gaze'].includes(String(continuity.bridgeType)) || anchor.length < 2
      || ![previous.lastFramePrompt, previous.videoPrompt, previous.audioText].some((text) => String(text ?? '').includes(anchor))
      || ![record.visualPrompt, record.videoPrompt].some((text) => String(text ?? '').includes(anchor))) {
      throw new Error('STORYBOARD_CONTINUITY_INVALID: 正常换场使用cut并在bridgeAnchor说明剧情联系；只有声桥/动作/道具/视线匹配才使用sound/action/prop/gaze，且对应锚点须实际出现在两镜中')
    }
  }
}

export function normalizeStaticIllustrationCamera(camera: unknown, scene: Record<string, unknown>) {
  if (!isStaticIllustrationStyle(scene.visualTreatment, scene.animationStyle) || typeof camera !== 'string') return camera
  const value = camera.trim()
  if (value.startsWith('固定机位') || value.includes('无实拍机位')) return camera
  // This is a production-mode invariant, not a creative camera choice: static
  // illustration renderers cannot perform a live camera move. Preserve every
  // authored framing detail and state the required invariant in front of it.
  return value ? `固定机位，${value}` : '固定机位'
}

function normalizedStoryboardRecord(sourceRecord: Record<string, unknown>, scene: Record<string, unknown>, expected: Record<string, unknown> = {}, changes?: unknown[]): Record<string, unknown> {
  if (expected.requireCharacterEquipment === true && sourceRecord.characterEquipment === undefined) {
    throw new Error('history.storyboard.characterEquipment 必须显式写[]或本镜已批准装备；缺失不能视为空需求')
  }
  const record = {
    ...sourceRecord,
    videoPrompt: typeof sourceRecord.videoPrompt === 'string'
      ? sourceRecord.videoPrompt.split(/【(?:同期对白硬约束|口型同步|旁白时间硬约束|声部与收束)】/)[0].trim()
      : sourceRecord.videoPrompt,
    audioType: normalizeStoryboardAudioType(sourceRecord.audioType),
    audioText: normalizeStoryboardSpokenText(sourceRecord.audioType, sourceRecord.audioText),
    camera: normalizeStaticIllustrationCamera(sourceRecord.camera, scene),
    historicalBasis: typeof sourceRecord.historicalBasis === 'string' && sourceRecord.historicalBasis.trim()
      ? sourceRecord.historicalBasis
      : scene.historicalBasis,
    adaptationBoundary: typeof sourceRecord.adaptationBoundary === 'string' && sourceRecord.adaptationBoundary.trim()
      ? sourceRecord.adaptationBoundary
      : scene.adaptationBoundary,
  }
  const anonymousIdentityProjection = normalizeStoryboardAnonymousEntranceIdentities(record, { ...expected, scene })
  if (anonymousIdentityProjection) changes?.push(...anonymousIdentityProjection.changes)
  return normalizeSandTableAesthetic(inheritShotCharacterVisuals(anonymousIdentityProjection?.candidate ?? record, scene))
}

/** Lossless normalization of optional writer fields, shared with timing advice.
 * An empty optional instruction is absence, never a substitute for required
 * action text or a reason to rewrite the approved performance. */
export function normalizeDurationStoryboardDraft(record: Record<string, unknown>) {
  const pacing = record.pacing as Record<string, unknown> | undefined
  if (pacing?.version !== DURATION_PACING_VERSION || !Array.isArray(pacing.beats)) return record
  return { ...record, pacing: { ...pacing, beats: pacing.beats.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const beat = { ...value as Record<string, unknown> }
    if (['action', 'reaction'].includes(String(beat.kind)) && (beat.textOrVocalization === undefined || beat.textOrVocalization === '')
      && typeof beat.performanceInstruction === 'string' && beat.performanceInstruction.trim()) beat.textOrVocalization = beat.performanceInstruction
    if (typeof beat.performanceInstruction === 'string' && !beat.performanceInstruction.trim()) delete beat.performanceInstruction
    if (Array.isArray(beat.resources) && beat.resources.length === 0) beat.resources = beat.kind === 'action' ? ['body', 'hands']
      : beat.kind === 'reaction' ? ['attention', 'body'] : ['voice']
    return beat
  }) } }
}

export function validateHistoricalStructuredOutput(operation: string | undefined, output: unknown, expected: Record<string, unknown> = {}) {
  if (operation !== 'history.scene-outline' && operation !== 'history.storyboard') return output
  const sourceRecord = structuredRecord(output, operation)

  if (operation === 'history.scene-outline') {
    const issues: string[] = []
    let dramaOutline: Record<string, unknown>
    try {
      dramaOutline = validateDramaOutline(sourceRecord, expected)
    } catch (error) {
      // A completed safe traversal may report independent drama defects while
      // source/schema fields remain unchecked. Keep that normalized candidate
      // for diagnosis only; malformed shapes/identities cannot enter this path.
      if (!(error instanceof DramaOutlineIssuesError)) throw error
      dramaOutline = error.outline
      issues.push(error.message)
    }
    const capture = <T>(check: () => T): T | undefined => {
      try { return check() } catch (error) { issues.push(error instanceof Error ? error.message : String(error)) }
    }
    const record = deriveSceneOutlineMetrics(dramaOutline)
    rejectUnexpectedKeys(record, ['episodeTitle', 'count', 'totalDuration', 'scenes', 'text', 'raw', 'model', 'contentContractVersion', 'episodeDrama', 'historicalLocks', 'adaptationSpace', 'characterDramas', 'dramaticScenes'], 'history.scene-outline')
    capture(() => requiredString(record, 'episodeTitle', 'history.scene-outline'))
    const scenes = Array.isArray(record.scenes)
      ? deriveSceneContinuity(record.scenes.map((scene) => structuredRecord(scene, 'history.scene-outline.scenes')))
      : record.scenes
    record.scenes = scenes
    if (!Array.isArray(scenes)) throw new Error('history.scene-outline.scenes 必须是数组')
    if (!scenes.length) throw new Error('history.scene-outline.scenes 至少需要一个场景')
    const derived = record
    if (Number(derived.count) !== scenes.length) issues.push('场景大纲 count 必须等于 scenes 数量')
    const ids = new Set<string>()
    const sourceRefs = expectedSourceRefs(expected)
    let totalDuration = 0
    let previousSetting = ''
    scenes.forEach((sceneValue, index) => {
      const scene = structuredRecord(sceneValue, `scenes[${index}]`)
      rejectUnexpectedKeys(scene, ['id', 'sequence', 'title', 'editorialRole', 'visualTreatment', 'animationStyle', 'animationAesthetic', 'contextPayload', 'cast', 'characterVisuals', 'characterEquipment', 'purpose', 'requiredBeats', 'historicalBasis', 'adaptationBoundary', 'targetDuration', 'continuityFromPrevious', 'dramaticUnitId', 'completionCriteria', 'closesUnit', 'contentContractVersion', 'dramaticSceneId', 'settingId', 'continuityMode'], `scenes[${index}]`)
      const id = requiredString(scene, 'id', `scenes[${index}]`)
      if (ids.has(id)) throw new Error(`场景大纲存在重复 id：${id}`)
      ids.add(id)
      if (Number(scene.sequence) !== index + 1) issues.push(`scenes[${index}].sequence 必须等于 ${index + 1}`)
      capture(() => requiredString(scene, 'title', `scenes[${index}]`))
      capture(() => requiredString(scene, 'purpose', `scenes[${index}]`))
      const beats = requiredStoryBeats(scene, `scenes[${index}]`, expected.requireBeatCoverage === true)
      const historicalBasis = capture(() => requiredString(scene, 'historicalBasis', `scenes[${index}]`))
      if (historicalBasis !== undefined) {
        const sourceFreeBridge = scene.editorialRole === 'context_bridge' && allowsEmptyEditorialCast(scene)
          && /(?:无|不涉及|纯)(?:具体)?史料|(?:电影|剪辑|场景|时空)转(?:换|场)|电影语法/.test(historicalBasis)
        if (!/\[史料\d+\]/.test(historicalBasis) && !sourceFreeBridge) issues.push(`scenes[${index}].historicalBasis 必须包含 [史料N] 引用；只有明确声明不承载史实的纯转场 context_bridge 可如实标注无具体史料`)
        if (sourceRefs) for (const citation of new Set(historicalBasis.match(/\[史料\d+\]/g) ?? [])) {
          if (!sourceRefs.has(citation)) issues.push(`scenes[${index}].historicalBasis 引用不存在的 ${citation}；只能使用已提供的史料编号，不得编造来源`)
        }
      }
      capture(() => requiredString(scene, 'adaptationBoundary', `scenes[${index}]`))
      const duration = Number(scene.targetDuration)
      if (!Number.isInteger(duration) || duration < 3 || duration > 15) issues.push(`scenes[${index}].targetDuration 必须是 3–15 秒的动态预估整数`)
      if (typeof scene.continuityFromPrevious !== 'boolean') issues.push(`scenes[${index}].continuityFromPrevious 必须是布尔值`)
      if (index === 0 && scene.continuityFromPrevious) issues.push('第一镜 continuityFromPrevious 必须为 false')
      const setting = beats[0]?.setting ?? ''
      if (index > 0 && scene.continuityFromPrevious && previousSetting && setting
        && normalizedCoverageText(previousSetting) !== normalizedCoverageText(setting)) {
        issues.push(`scenes[${index}].continuityFromPrevious 为 true，但 setting 从“${previousSetting}”切换到“${setting}”；跨地点镜头不能复用上一镜尾帧`)
      }
      previousSetting = setting
      totalDuration += duration
    })
    if (Number.isFinite(totalDuration) && Number(derived.totalDuration) !== totalDuration) issues.push('场景大纲 totalDuration 必须等于所有 targetDuration 之和')
    if (expected.requireNarrativeClosure === true || scenes.some(item => (item as Record<string, unknown>).dramaticUnitId)) capture(() => validateNarrativeOutline(scenes as Record<string, unknown>[]))
    capture(() => validateEpisodeNarrativeBoundary(derived, expected.input, expected.requireEpisodeBoundary === true))
    if (issues.length) throw new Error([...new Set(issues)].join('\n'))
    return derived
  }

  const scene = expected.scene && typeof expected.scene === 'object' && !Array.isArray(expected.scene)
    ? expected.scene as Record<string, unknown>
    : {}
  const anonymousIdentityChanges: unknown[] = []
  const record = normalizedStoryboardRecord(sourceRecord, scene, expected, anonymousIdentityChanges)
  const manual = expected.qualityDisposition === 'manual-review-v1'
  const qualityWarnings: string[] = manual && Array.isArray(expected.storyboardQualityWarnings) ? expected.storyboardQualityWarnings.filter((warning): warning is string => typeof warning === 'string') : []
  const contentCheck = (check: () => unknown) => {
    if (!manual) { check(); return }
    try { check() } catch (error) { qualityWarnings.push(error instanceof Error ? error.message : String(error)) }
  }
  const pacingVersion = (record.pacing as Record<string,unknown>)?.version
  if (expected.pacingVersion !== undefined && pacingVersion !== expected.pacingVersion) throw new Error(`STORYBOARD_PACING_INVALID: 当前工作流要求 ${String(expected.pacingVersion)}，旧分镜须显式重新规划，禁止混用旧执行`)
  const durationV2 = pacingVersion === DURATION_PACING_VERSION
  if (durationV2) {
    record.pacing = normalizeDurationStoryboardDraft(record).pacing
  }
  const compiledDuration = durationV2 ? compileDurationSchedule({...record,videoPrompt:sourceRecord.videoPrompt},{scene,timingPolicy:expected.timingPolicy,qualityDisposition:expected.qualityDisposition,
    selectDuration:!record.scheduleHash&&!(record.pacing as Record<string,unknown>).scheduleHash}) : undefined
  if (compiledDuration) Object.assign(record,{duration:compiledDuration.duration,pacing:compiledDuration.pacing,videoPrompt:compiledDuration.videoPrompt,scheduleHash:compiledDuration.scheduleHash})
  qualityWarnings.push(...(compiledDuration?.qualityWarnings ?? []))
  rejectUnexpectedKeys(record, ['id', 'title', 'editorialRole', 'visualTreatment', 'animationStyle', 'animationAesthetic', 'illustrationLayers', 'duration', 'pacing', 'scheduleHash', 'storyProgress', 'completionCriteria', 'characters', 'characterVisuals', 'characterEquipment', 'initialCharacters', 'enteringCharacters', 'endCharacters', 'continuity', 'beatCoverage', 'coveredBeatIds', 'visualPrompt', 'camera', 'mood', 'firstFrameMode', 'lastFramePrompt', 'videoPrompt', 'audioType', 'audioText', 'pronunciationHints', 'historicalBasis', 'adaptationBoundary', 'contentContractVersion', 'dramaticSceneId', 'shotIntent', 'beatDramaturgy', 'presentCharacters', 'worldState'], 'history.storyboard')
  contentCheck(() => validateDramaStoryboard(record, scene))
  if (expected.requireDramaContract === true && !isCinematicShot(record)) throw new Error('HISTORY_DRAMA_INVALID: 当前分镜必须输出 cinematic-v1 内容契约')
  requiredString(record, 'id', 'history.storyboard')
  requiredString(record, 'title', 'history.storyboard')
  const duration = Number(record.duration)
  if (!Number.isInteger(duration) || duration < 3 || duration > 15) throw new Error('history.storyboard.duration 必须是 3 到 15 之间的整数')
  const dynamic = expected.requireDynamicPacing === true || Boolean(record.pacing)
  if (dynamic && !durationV2 && (record.pacing as Record<string, unknown>)?.version !== HISTORY_PACING_VERSION) throw new Error('STORYBOARD_PACING_INVALID: 缺少 dynamic-v1 pacing 预算，禁止沿用固定15秒旧分镜')
  if (expected.requireNarrativeClosure === true || scene.dramaticUnitId) {
    contentCheck(() => validateNarrativeShot(record, scene))
    record.completionCriteria = scene.completionCriteria
  }
  if (!Array.isArray(record.characters) || record.characters.some((name) => typeof name !== 'string' || !name.trim())) throw new Error('history.storyboard.characters 必须是人物姓名字符串数组')
  requiredString(record, 'visualPrompt', 'history.storyboard')
  requiredString(record, 'camera', 'history.storyboard')
  requiredString(record, 'mood', 'history.storyboard')
  const firstFrameMode = requiredString(record, 'firstFrameMode', 'history.storyboard')
  if (firstFrameMode !== 'reference' && firstFrameMode !== 'reuse_previous_tail') throw new Error('history.storyboard.firstFrameMode 只能是 reference 或 reuse_previous_tail')
  const coverageCut = isCinematicShot(record) && (record.continuity as Record<string, unknown>)?.mode === 'coverage_cut'
  const requiredFirstFrameMode = scene.continuityFromPrevious === true && !coverageCut ? 'reuse_previous_tail' : 'reference'
  if (firstFrameMode !== requiredFirstFrameMode) {
    throw new Error(scene.continuityFromPrevious === true
      ? '连续镜头必须使用 reuse_previous_tail，禁止重新自由构图'
      : '非连续镜头必须使用 reference')
  }
  const characters = record.characters as string[]
  const mapPortraitLayers = record.animationStyle === 'historical_map' && Array.isArray(record.illustrationLayers)
    && record.illustrationLayers.length > 0
  const defaultInitialCharacters = firstFrameMode === 'reference' ? mapPortraitLayers ? [] : [...characters] : undefined
  const initialCharacters = record.initialCharacters ?? defaultInitialCharacters
  if (!Array.isArray(initialCharacters) || initialCharacters.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new Error('STORYBOARD_PROMPT_OVERLOAD: history.storyboard.initialCharacters 必须是首帧已存在人物的姓名字符串数组；连续镜头不得省略')
  }
  const rawEntrants = record.enteringCharacters ?? (firstFrameMode === 'reference' ? [] : undefined)
  if (!Array.isArray(rawEntrants)) throw new Error('STORYBOARD_PROMPT_OVERLOAD: history.storyboard.enteringCharacters 必须是入场人物数组；连续镜头不得省略')
  const declaredEntrants = rawEntrants.map((value, index): StoryboardEntrant => {
    const entrant = structuredRecord(value, `enteringCharacters[${index}]`)
    rejectUnexpectedKeys(entrant, ['name', 'startSecond', 'endSecond', 'path'], `enteringCharacters[${index}]`)
    const name = requiredString(entrant, 'name', `enteringCharacters[${index}]`)
    const path = requiredString(entrant, 'path', `enteringCharacters[${index}]`)
    const startSecond = Number(entrant.startSecond)
    const endSecond = Number(entrant.endSecond)
    if (!Number.isFinite(startSecond) || !Number.isFinite(endSecond) || startSecond < 0 || endSecond <= startSecond || (!durationV2 && endSecond > duration - historyTailSeconds(record))) {
      throw new Error(`STORYBOARD_PROMPT_OVERLOAD: enteringCharacters[${index}] 入场时间必须位于 0 到 ${duration - historyTailSeconds(record)} 秒且 startSecond < endSecond`)
    }
    return { name, startSecond, endSecond, path }
  })
  const projectedEntrances = compiledDuration ? projectStoryboardEntrances(declaredEntrants, compiledDuration) : undefined
  const enteringCharacters = projectedEntrances?.enteringCharacters ?? declaredEntrants
  const initialNames = initialCharacters as string[]
  const enteringNames = enteringCharacters.map((entrant) => entrant.name)
  const missingOpeningIdentities = isCinematicShot(record)
    ? missingIndependentOpeningIdentities(String(record.visualPrompt), initialNames)
    : []
  if (missingOpeningIdentities.length) {
    contentCheck(() => { throw new Error(`STORYBOARD_PROMPT_OVERLOAD: visualPrompt 开场静态实景必须逐字声明 initialCharacters 的汉字全名；缺少：${missingOpeningIdentities.join('、')}；不得用“家属”“官员”等简称替代，否则人物身份参考无法与首帧安全绑定`) })
  }
  const newIdentityCount = firstFrameMode === 'reference' ? characters.length : enteringNames.length
  if (expected.requireContinuityContract === true && newIdentityCount > 2) {
    throw new Error(`STORYBOARD_REFERENCE_OVERFLOW: 本镜需要 ${newIdentityCount} 个新人物的完整三视图，模型每段最多接收 2 人；按节拍拆成连续分段，让剧情必需的其余人物在后段走入，不得删减必要角色或丢弃其身份参考`)
  }
  if (new Set(initialNames).size !== initialNames.length || new Set(enteringNames).size !== enteringNames.length) {
    throw new Error('STORYBOARD_PROMPT_OVERLOAD: initialCharacters 和 enteringCharacters 均不得包含重复人物')
  }
  const overlap = initialNames.filter((name) => enteringNames.includes(name))
  if (overlap.length) throw new Error(`STORYBOARD_PROMPT_OVERLOAD: 人物不能既在首帧又声明入场：${overlap.join('、')}`)
  const illustrationLayerNames = (record.animationStyle === 'character_illustration' || mapPortraitLayers) && Array.isArray(record.illustrationLayers)
    ? record.illustrationLayers.flatMap(value => value && typeof value === 'object' && !Array.isArray(value)
      && typeof (value as Record<string, unknown>).characterName === 'string'
      ? [String((value as Record<string, unknown>).characterName)] : [])
    : []
  // Character-illustration layers have their own enterStart/enterDuration
  // contract. Requiring the same layer to masquerade as a live-action entrant
  // duplicates one entrance and produces a fictitious walking path.
  const partition = [...initialNames, ...enteringNames,
    ...illustrationLayerNames.filter(name => !initialNames.includes(name) && !enteringNames.includes(name))]
  const missingCast = characters.filter((name) => !partition.includes(name))
  const unknownCast = partition.filter((name) => !characters.includes(name))
  if (missingCast.length || unknownCast.length) {
    throw new Error(`STORYBOARD_PROMPT_OVERLOAD: initialCharacters、enteringCharacters 与人物插画图层必须完整且仅覆盖 characters；缺少：${missingCast.join('、') || '无'}；多出：${unknownCast.join('、') || '无'}`)
  }
  record.initialCharacters = initialNames
  record.enteringCharacters = enteringCharacters
  contentCheck(() => validateNoUnallocatedSplitActions(record, scene))
  contentCheck(() => validateNoCompletedActionReplay(record, scene, expected.previousShot as Record<string, unknown> | undefined))
  // These facts are consumed by frame/voice routing, independently of whether
  // the authored continuity is convincing. Manual review relaxes story claims,
  // never an absent/malformed world-state or unsupported continuation mode.
  if (manual && isCinematicShot(record)) {
    if (!Array.isArray(record.presentCharacters) || record.presentCharacters.some(name => typeof name !== 'string' || !name.trim())) throw new Error('STORYBOARD_CONTINUITY_INVALID: presentCharacters 必须是人物姓名字符串数组')
    validateCinematicWorldState(record.worldState, record.presentCharacters as string[])
    const mode = (record.continuity as Record<string, unknown> | undefined)?.mode
    if (!['tail_continuation', 'coverage_cut', 'scene_cut'].includes(String(mode))) throw new Error('STORYBOARD_CONTINUITY_INVALID: 缺少可执行 continuity.mode')
  }
  contentCheck(() => validateCinematicShot(record, scene, expected.previousShot as Record<string, unknown> | undefined))
  const lastFramePrompt = requiredString(record, 'lastFramePrompt', 'history.storyboard')
  const stillFrameConstraint = '【静态尾帧】只呈现动作完成后的单一时间点与最终状态；单幅全画幅画面，禁止分镜、拼贴、分栏、上下三段、连环画、重复人物；画面内禁止字幕、水印、标题、标签及任何可读文字，榜文、竹简、牌匾等文字载体只能虚焦、背向镜头或呈现不可辨纹理。'
  record.lastFramePrompt = lastFramePrompt.includes('【静态尾帧】')
    ? lastFramePrompt
    : `${lastFramePrompt}\n${stillFrameConstraint}`
  const videoPrompt = requiredString(record, 'videoPrompt', 'history.storyboard')
  if (expected.aspectRatio) {
    const ratio = String(expected.aspectRatio)
    const conflicting = ratio === '16:9' ? /9[:：]16|竖屏/ : ratio === '9:16' ? /16[:：]9|横屏/ : undefined
    if (conflicting?.test([record.visualPrompt, record.lastFramePrompt, videoPrompt].join('\n'))) contentCheck(() => { throw new Error(`STORYBOARD_PROMPT_OVERLOAD: 画面提示与指定画幅 ${ratio} 冲突，所有字段必须统一画幅`) })
  }
  const entranceIssue = compiledDuration ? undefined : storyboardEntranceIssue(videoPrompt, enteringCharacters,durationV2)
  if (entranceIssue) throw new Error(`STORYBOARD_PROMPT_OVERLOAD: ${entranceIssue}`)
  if (compiledDuration) for (const entrant of enteringCharacters) {
    const premature=compiledDuration.speechWindows.find(window=>window.actorIds.includes(entrant.name)
      && window.deliveryStyle!=='narration'&&window.start<entrant.endSecond-.001)
    if (premature) throw new Error(`STORYBOARD_PACING_INVALID: ${entrant.name} 真正入场须在 ${entrant.endSecond} 秒完成后再发声，${premature.beatId} 却从 ${premature.start} 秒开始；保留原动作并修复入场与声部依赖`)
  }
  const audioType = requiredString(record, 'audioType', 'history.storyboard')
  const ambientOnly = isCinematicShot(record) && audioType === '环境声'
  if (audioType !== '旁白' && audioType !== '对白' && !ambientOnly) throw new Error('history.storyboard.audioType 只能是旁白或对白；cinematic-v1 另支持环境声')
  if (ambientOnly && record.audioText !== '') throw new Error('STORYBOARD_AUDIO_INVALID: 环境声模式 audioText 必须为空，不能藏入对白')
  const audioText = ambientOnly ? '' : requiredString(record, 'audioText', 'history.storyboard')
  if (record.pronunciationHints !== undefined) record.pronunciationHints = normalizePronunciationHints(record.pronunciationHints, audioText)
  contentCheck(() => validateStoryboardContinuity(record, expected))
  contentCheck(() => validateStoryboardBeatCoverage(record, scene))
  const speechRate = dynamic ? HISTORY_SPEECH_RATE : Math.max(2, Math.min(4, Number(expected.productionSpeechRate) || 4))
  const timingEstimate = compiledDuration?.timingEstimate ?? (dynamic ? dynamicStoryboardTiming(audioText, record.pacing as Record<string, unknown>, record) : estimateStoryboardTiming(audioText, videoPrompt, speechRate))
  if (timingEstimate.requiredDuration > 15) {
    throw new Error(`STORYBOARD_TIMING_OVERFLOW: 当前对白、明示停顿与尾帧预留预计至少需要 ${timingEstimate.requiredDuration} 秒，超过 15 秒上限；请压缩台词/停顿或拆分镜头`)
  }
  if (dynamic && !durationV2 && duration !== timingEstimate.requiredDuration) throw new Error(`STORYBOARD_PACING_INVALID: 按自然语速、必要动作、反应和0.3秒剪辑余量预算，本镜应为 ${timingEstimate.requiredDuration} 秒，实际声明 ${duration} 秒；调整完整时间轴，不拉长台词或删除剧情`)
  const promptIssue = durationV2 ? undefined : storyboardPromptIssue(videoPrompt, audioType, audioText, record.characters as string[], enteringCharacters, speechRate, duration)
  if (promptIssue) throw new Error(`STORYBOARD_PROMPT_OVERLOAD: ${promptIssue}`)
  validateStoryboardSpeechActivityCoverage(record)
  record.videoPrompt = appendLipSyncContract(videoPrompt, audioType, audioText, record.characters as string[], record)
  const historicalBasis = requiredString(record, 'historicalBasis', 'history.storyboard')
  if (!/\[史料\d+\]/.test(historicalBasis)) contentCheck(() => { throw new Error('history.storyboard.historicalBasis 必须包含 [史料N] 引用') })
  requiredString(record, 'adaptationBoundary', 'history.storyboard')
  const plannedDuration = Number(scene.targetDuration)
  const selectedDuration = duration
  record.duration = selectedDuration
  record.timingEstimate = {
    ...timingEstimate,
    plannedDuration: Number.isFinite(plannedDuration) ? plannedDuration : undefined,
    modelDuration: compiledDuration?.timingEstimate.modelDuration ?? duration,
    selectedDuration,
    ...(projectedEntrances?.projection ? { entranceProjection: projectedEntrances.projection } : {}),
    ...(anonymousIdentityChanges.length ? { anonymousIdentityProjection: { version: 'anonymous-entrance-identity-v1', changes: anonymousIdentityChanges } } : {}),
  }
  if (manual) record.qualityWarnings = [...new Set(qualityWarnings)]
  return record
}

/** Validates the model response used when one storyboard has to become several
 * independently generated 15-second clips. */
export function storyboardSegmentCompletionCriteria(requiredBeats: unknown, originalBeats: unknown = requiredBeats): string[] {
  if (!Array.isArray(requiredBeats)) return []
  const useful = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
  return [...new Set(requiredBeats.flatMap(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const beat = value as Record<string, unknown>, observable = beat.observable as Record<string, unknown> | undefined
    const visual = Array.isArray(observable?.visual) ? observable.visual.filter(useful) : []
    const audio = Array.isArray(observable?.audio) ? observable.audio.filter(useful) : []
    const anchors = Array.isArray(beat.mustShow) ? beat.mustShow.filter(useful) : []
    const original = Array.isArray(originalBeats) ? originalBeats.find(value => value && typeof value === 'object' && value.id === beat.id) as Record<string, unknown> | undefined : undefined
    const originalObservable = original?.observable as Record<string, unknown> | undefined
    const sameItems = (left: unknown, right: unknown) => JSON.stringify(Array.isArray(left) ? [...left].sort() : []) === JSON.stringify(Array.isArray(right) ? [...right].sort() : [])
    const completeBeat = original && sameItems(visual, originalObservable?.visual) && sameItems(audio, originalObservable?.audio) && sameItems(anchors, original.mustShow)
    // Whole allocated beats retain their approved performance, including who
    // narrates or sings. A bare audio quote alone would discard that obligation.
    // Partial beats cannot inherit the full description and repeat other parts.
    return [...(completeBeat && useful(original.description) ? ['原节拍表演：' + original.description] : []),
      ...visual.map(text => '画面呈现：' + text), ...audio.map(text => '完整听到：' + text),
      ...anchors.filter(text => !visual.includes(text) && !audio.includes(text)).map(text => '原锚点已呈现：' + text)]
  }))]
}

export function historicalStoryboardSegmentInputs(output: unknown, expected: Record<string, unknown>) {
  const wrapper = structuredRecord(output, 'history.storyboard.split')
  rejectUnexpectedKeys(wrapper, ['segments'], 'history.storyboard.split')
  const segments = wrapper.segments
  if (!Array.isArray(segments) || segments.length < 2) {
    throw new Error('history.storyboard.split.segments 至少需要两个分段')
  }
  const sourceScene = expected.scene && typeof expected.scene === 'object' && !Array.isArray(expected.scene)
    ? expected.scene as Record<string, unknown>
    : {}
  const sourceBeats = requiredStoryBeats(sourceScene, 'scene')
  const qualityWarnings: string[] = []
  const contentCheck = (check: () => unknown) => {
    if (expected.qualityDisposition !== 'manual-review-v1') { check(); return }
    try { check() } catch (error) { qualityWarnings.push(error instanceof Error ? error.message : String(error)) }
  }
  contentCheck(() => validateDramaStoryboardAllocation(segments, sourceScene))
  const sourceBeatIds = sourceBeats.map((beat) => beat.id)
  const segmentBeatIds = segments.map((segment, index) => {
    const candidate = structuredRecord(segment, `history.storyboard.split.segments[${index}]`)
    if (!sourceBeats.length && candidate.coveredBeatIds === undefined) return []
    if (!Array.isArray(candidate.coveredBeatIds)
      || candidate.coveredBeatIds.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new Error(`history.storyboard.split.segments[${index}].coveredBeatIds 必须是剧情节拍 id 数组`)
    }
    return candidate.coveredBeatIds as string[]
  })
  const allocations = segments.map((segment, index) => {
    const candidate = segment as Record<string, unknown>
    const declared = candidate.beatCoverage
    if (declared === undefined) return sourceBeats.filter((beat) => segmentBeatIds[index].includes(beat.id))
      .map((beat) => ({ beatId: beat.id, anchors: beat.mustShow }))
    if (!Array.isArray(declared) || declared.length !== segmentBeatIds[index].length) {
      throw new Error('history.storyboard.split.beatCoverage 必须逐项对应 coveredBeatIds')
    }
    return declared.map((value, beatIndex) => {
      const entry = structuredRecord(value, 'beatCoverage')
      rejectUnexpectedKeys(entry, ['beatId', 'anchors'], 'beatCoverage')
      const beat = sourceBeats.find((item) => item.id === entry.beatId)
      if (!beat || entry.beatId !== segmentBeatIds[index][beatIndex]) {
        throw new Error(`history.storyboard.split.beatCoverage 的 beatId=${String(entry.beatId ?? '')} 必须与当前分段 coveredBeatIds[${beatIndex}]=${String(segmentBeatIds[index][beatIndex] ?? '')} 一致，不得重新引入已完成节拍`)
      }
      if (!Array.isArray(entry.anchors)) {
        throw new Error(`history.storyboard.split.beatCoverage ${beat.id}.anchors 必须是当前分段承担的 mustShow 数组`)
      }
      const invalidAnchors = entry.anchors.map(String).filter((anchor) => !beat.mustShow.includes(anchor))
      if (invalidAnchors.length) {
        throw new Error(`history.storyboard.split.beatCoverage ${beat.id} 包含当前 scene.requiredBeats 未批准的锚点：${invalidAnchors.join('、')}；本次只允许：${beat.mustShow.length ? beat.mustShow.join('、') : '[]'}。previousScriptBeatDramaturgy 只是已完成历史，不得重演或写回当前分段；对白仅写入 beatDramaturgy.audio 和 pacing.beats，纯音频分段的 anchors 应为 []`)
      }
      return { beatId: beat.id, anchors: entry.anchors as string[] }
    })
  })
  if (sourceBeats.length) {
    const flattened = segmentBeatIds.flat()
    const ordered = flattened.filter((id, index) => index === 0 || id !== flattened[index - 1])
    if (ordered.length !== sourceBeatIds.length || ordered.some((id, index) => id !== sourceBeatIds[index])) {
      contentCheck(() => { throw new Error(`history.storyboard.split 必须按原顺序且恰好一次覆盖全部剧情节拍 ${sourceBeatIds.join('、')}，单个复杂节拍可在相邻分段以 beatCoverage 分配锚点`) })
    }
    if (segmentBeatIds.some((ids) => !ids.length || new Set(ids).size !== ids.length)) throw new Error('history.storyboard.split 每个分段至少覆盖一个剧情节拍且段内不得重复')
    for (const beat of sourceBeats) {
      const anchors = allocations.flat().filter((item) => item.beatId === beat.id).flatMap((item) => item.anchors)
      if (anchors.length !== beat.mustShow.length || beat.mustShow.some((anchor) => anchors.filter((value) => value === anchor).length !== 1)) {
        contentCheck(() => { throw new Error(`STORYBOARD_COVERAGE_INCOMPLETE: ${beat.id} 的锚点必须恰好分配一次：${beat.mustShow.join('、')}；跨段必须明确 beatCoverage，不得丢弃或重复剧情`) })
      }
    }
  }
  return segments.map((segment, index) => {
    const beatIds = new Set(segmentBeatIds[index])
    const splitScene = {
      ...sourceScene,
      id: `${String(sourceScene.id ?? 'scene')}-part-${index + 1}`,
      title: `${String(sourceScene.title ?? '镜头')}（${index + 1}/${segments.length}）`,
      targetDuration: (segment as Record<string, unknown>).duration,
      ...(sourceScene.dramaticUnitId ? { closesUnit: index === segments.length - 1 && sourceScene.closesUnit === true } : {}),
      continuityFromPrevious: index === 0 ? sourceScene.continuityFromPrevious === true : true,
      ...(isCinematicShot(segment as Record<string, unknown>) ? {
        contentContractVersion: (segment as Record<string, unknown>).contentContractVersion,
        sourceSceneId: sourceScene.sourceSceneId ?? sourceScene.id,
        continuityMode: ((segment as Record<string, unknown>).continuity as Record<string, unknown>)?.mode,
      } : {}),
      ...(sourceBeats.length ? { requiredBeats: sourceBeats.filter((beat) => beatIds.has(beat.id)).map((beat) => {
        const partitioned = partitionDramaBeat(beat, segment)
        const anchors = allocations[index].find((item) => item.beatId === beat.id)!.anchors
        return { ...partitioned,
          description: projectedDramaBeatDescription(beat, partitioned, anchors, sourceScene),
          mustShow: anchors }
      }) } : {}),
    }
    // The source's completion criteria describe the whole scene. A partition
    // must only require its allocated original actions/voices; the whole-scene
    // allocation was already checked above and stays in the approved outline.
    const completionCriteria = storyboardSegmentCompletionCriteria(splitScene.requiredBeats, sourceBeats)
    return { segment, splitScene: completionCriteria.length ? { ...splitScene, completionCriteria } : splitScene, qualityWarnings }
  })
}

export function validateHistoricalStoryboardSegments(output: unknown, expected: Record<string, unknown> = {}) {
  const inputs = historicalStoryboardSegmentInputs(output, expected)
  const ids = new Set<string>()
  return inputs.map(({ segment, splitScene, qualityWarnings }, index) => {
    const validated = validateHistoricalStructuredOutput('history.storyboard', segment, { ...expected, scene: splitScene,
      storyboardQualityWarnings: [...(Array.isArray(expected.storyboardQualityWarnings) ? expected.storyboardQualityWarnings : []), ...qualityWarnings],
      previousShot: index === 0 ? expected.previousShot : inputs[index - 1].segment }) as Record<string, unknown>
    const coverage = isCinematicShot(validated) && (validated.continuity as Record<string, unknown>)?.mode === 'coverage_cut'
    const requiredFirstFrameMode = splitScene.continuityFromPrevious && !coverage ? 'reuse_previous_tail' : 'reference'
    if (validated.firstFrameMode !== requiredFirstFrameMode) {
      throw new Error(index === 0
        ? `history.storyboard.split 第一段 firstFrameMode 必须为 ${requiredFirstFrameMode}`
        : 'history.storyboard.split 后续分段必须使用 reuse_previous_tail 续接前段尾帧')
    }
    const id = String(validated.id)
    if (ids.has(id)) throw new Error(`history.storyboard.split 存在重复 id：${id}`)
    ids.add(id)
    return validated
  })
}

/** Entrance body/path agreement does not depend on a compiled clock. Inspect
 * only shaped author data so an independent coverage failure cannot hide it. */
function collectDurationEntrancePathDiagnostics(record: Record<string, unknown>) {
  if (!isPlainRecord(record.pacing) || record.pacing.version !== DURATION_PACING_VERSION
    || !Array.isArray(record.pacing.beats) || !Array.isArray(record.enteringCharacters)) return []
  const rawBeats = record.pacing.beats
  if (!rawBeats.every(beat => isPlainRecord(beat) && ['action', 'reaction', 'speech', 'vocalization'].includes(String(beat.kind))
    && Array.isArray(beat.actorIds) && beat.actorIds.length > 0 && beat.actorIds.every(name => typeof name === 'string' && name.trim())
    && typeof beat.textOrVocalization === 'string' && beat.textOrVocalization.trim()
    && (beat.performanceInstruction === undefined || typeof beat.performanceInstruction === 'string'))) return []
  const beats = rawBeats as Array<Pick<DurationBeat, 'kind' | 'actorIds' | 'textOrVocalization' | 'performanceInstruction'>>
  return record.enteringCharacters.flatMap((entry, index) => {
    if (!isPlainRecord(entry) || typeof entry.name !== 'string' || !entry.name.trim() || typeof entry.path !== 'string' || !entry.path.trim()
      || !Number.isFinite(Number(entry.startSecond)) || !Number.isFinite(Number(entry.endSecond))
      || Number(entry.startSecond) < 0 || Number(entry.endSecond) <= Number(entry.startSecond)) return []
    const matches = matchingEntranceActions({ name: entry.name, path: entry.path,
      startSecond: Number(entry.startSecond), endSecond: Number(entry.endSecond) }, beats)
    if (matches.length === 1) return []
    const summary = `STORYBOARD_PROMPT_OVERLOAD: 入场人物“${entry.name}”的路径“${entry.path}”匹配 ${matches.length} 个可执行入场动作，必须唯一匹配；完整 path 须写在该人物 action 的 textOrVocalization 或 performanceInstruction，不能只写在手工 videoPrompt 或完成声明中`
    const details = { source: `enteringCharacters[${index}].path`, expectedPath: entry.path,
      candidateActions: rawBeats.flatMap((beat, beatIndex) => (beat as Record<string, unknown>).kind === 'action' ? [{
        field: `pacing.beats[${beatIndex}]`, id: (beat as Record<string, unknown>).id,
        kind: beats[beatIndex].kind, actorIds: beats[beatIndex].actorIds,
        textOrVocalization: beats[beatIndex].textOrVocalization,
        ...(beats[beatIndex].performanceInstruction !== undefined ? { performanceInstruction: beats[beatIndex].performanceInstruction } : {}),
      }] : []) }
    return [{ summary, message: `${summary}；原候选定位=${JSON.stringify(details)}；本项只检查原动作与路径，不使用尚未编译的时间窗口` }]
  })
}

/** Read-only repair diagnostics. A successful result still requires the complete
 * validator above; independent checks never erase obligations or edit a draft
 * to get past an earlier failure. Allocation-dependent checks run only after
 * the same split allocation contract used by the acceptance path has passed. */
export function collectHistoricalStoryboardDiagnostics(output: unknown, expected: Record<string, unknown> = {}): string[] {
  const errors = new Set<string>()
  const capture = (check: () => unknown, prefix = '') => {
    try { check(); return true } catch (error) {
      // Unexpected implementation failures are not instructions for a writer.
      if (!(error instanceof Error) || error instanceof TypeError || error instanceof RangeError) throw error
      errors.add(prefix + error.message)
      return false
    }
  }
  const split = isPlainRecord(output) && Array.isArray(output.segments)
  if (capture(() => split ? validateHistoricalStoryboardSegments(output, expected)
    : validateHistoricalStructuredOutput('history.storyboard', output, expected))) return []
  const values = split ? output.segments as unknown[] : [output]
  let inputs: ReturnType<typeof historicalStoryboardSegmentInputs> | undefined
  if (split) capture(() => { inputs = historicalStoryboardSegmentInputs(output, expected) })
  const names = (value: unknown): value is string[] => Array.isArray(value)
    && value.every(name => typeof name === 'string' && Boolean(name.trim()))
  for (const [index, value] of values.entries()) {
    const prefix = split ? `分段 ${index + 1}: ` : ''
    const run = (check: () => unknown) => capture(check, prefix)
    if (!isPlainRecord(value)) { run(() => structuredRecord(value, 'history.storyboard')); continue }
    const scopedExpected: Record<string,unknown> | undefined = split ? inputs && { ...expected, scene: inputs[index].splitScene,
      previousShot: index ? inputs[index - 1].segment : expected.previousShot } : expected
    const scene = isPlainRecord(scopedExpected?.scene) ? scopedExpected.scene : {}
    const record = normalizedStoryboardRecord(value, scene, scopedExpected ?? expected)
    if ((record.pacing as Record<string,unknown>)?.version === DURATION_PACING_VERSION || scopedExpected?.pacingVersion === DURATION_PACING_VERSION) {
      // v2 derives its timeline from beats. Legacy cue/window diagnostics would
      // invent a second 4.5-char clock and send a valid conservative plan back
      // through the exact bug this policy replaces.
      // An invalid wrapper/allocation has no trustworthy per-part scope yet.
      // Compiling each part against the whole scene would fabricate omissions.
      if (split && !inputs) continue
      run(() => validateHistoricalStructuredOutput('history.storyboard', value, scopedExpected ?? expected))
      collectDurationSpeechBudgetDiagnostics(record, { timingPolicy: scopedExpected?.timingPolicy }).forEach(message => errors.add(prefix + message))
      collectDurationVoiceLayoutDiagnostics(record, { timingPolicy: scopedExpected?.timingPolicy }).forEach(message => errors.add(prefix + message))
      collectDurationCoverageDiagnostics(record, { scene }).forEach(message => errors.add(prefix + message))
      for (const issue of collectDurationEntrancePathDiagnostics(record)) {
        errors.delete(prefix + issue.summary)
        errors.add(prefix + issue.message)
      }
      // Presence, world-state and narrative boundaries do not depend on a
      // successfully compiled clock. Report them alongside budget failures.
      const initial = record.initialCharacters ?? (record.firstFrameMode === 'reference' ? record.characters : undefined)
      const entrants = record.enteringCharacters ?? (record.firstFrameMode === 'reference' ? [] : undefined)
      if (names(record.characters) && names(initial) && Array.isArray(entrants) && entrants.every(isPlainRecord)) {
        run(() => validateCinematicShot({ ...record, initialCharacters: initial, enteringCharacters: entrants }, scene, scopedExpected?.previousShot as Record<string, unknown> | undefined))
      }
      if (expected.requireNarrativeClosure === true || scene.dramaticUnitId) run(() => validateNarrativeShot(record, scene))
      continue
    }
    // Each basic shape is independent; a bad cast cannot mask an invalid clock.
    for (const key of ['id', 'title', 'visualPrompt', 'camera', 'mood', 'firstFrameMode', 'lastFramePrompt', 'videoPrompt', 'audioType']) {
      run(() => requiredString(record, key, 'history.storyboard'))
    }
    const validCast = names(record.characters)
    if (!validCast) errors.add(prefix + 'history.storyboard.characters 必须是人物姓名字符串数组')
    const duration = Number(record.duration)
    const validDuration = Number.isInteger(duration) && duration >= 3 && duration <= 15
    if (!validDuration) errors.add(prefix + 'history.storyboard.duration 必须是 3 到 15 之间的整数')
    const dynamic = expected.requireDynamicPacing === true || Boolean(record.pacing)
    const validPacing = isPlainRecord(record.pacing) && record.pacing.version === HISTORY_PACING_VERSION
    if (dynamic && !validPacing) errors.add(prefix + 'STORYBOARD_PACING_INVALID: 缺少 dynamic-v1 pacing 预算，禁止沿用固定15秒旧分镜')
    const audioType = record.audioType
    const ambient = isCinematicShot(record) && audioType === '环境声'
    const validAudio = typeof record.audioText === 'string' && (ambient || Boolean(record.audioText.trim()))
    if (!validAudio) run(() => requiredString(record, 'audioText', 'history.storyboard'))
    if (!['旁白', '对白'].includes(String(audioType)) && !ambient) errors.add(prefix + 'history.storyboard.audioType 只能是旁白或对白；cinematic-v1 另支持环境声')
    if (ambient && record.audioText !== '') errors.add(prefix + 'STORYBOARD_AUDIO_INVALID: 环境声模式 audioText 必须为空，不能藏入对白')
    const initialCharacters = record.initialCharacters ?? (record.firstFrameMode === 'reference' && validCast ? record.characters : undefined)
    const rawEntrants = record.enteringCharacters ?? (record.firstFrameMode === 'reference' ? [] : undefined)
    const validEntrants = Array.isArray(rawEntrants) && rawEntrants.every(entrant => isPlainRecord(entrant)
      && typeof entrant.name === 'string' && Boolean(entrant.name.trim()) && typeof entrant.path === 'string' && Boolean(entrant.path.trim())
      && Number.isFinite(Number(entrant.startSecond)) && Number.isFinite(Number(entrant.endSecond))
      && Number(entrant.startSecond) >= 0 && Number(entrant.endSecond) > Number(entrant.startSecond)
      && validDuration && Number(entrant.endSecond) <= duration - historyTailSeconds(record))
    // Normalized execution fields are a new object, not a repair of the source.
    const prepared = { ...record, initialCharacters, ...(validEntrants ? { enteringCharacters: rawEntrants } : {}) }
    if (scopedExpected) {
      run(() => validateDramaStoryboard(record, scene))
      if (expected.requireDramaContract === true && !isCinematicShot(record)) errors.add(prefix + 'HISTORY_DRAMA_INVALID: 当前分镜必须输出 cinematic-v1 内容契约')
      if (expected.requireNarrativeClosure === true || scene.dramaticUnitId) run(() => validateNarrativeShot(record, scene))
      // The cinematic validator validates its own world-state shape. Entrants
      // must be shaped first because later continuity comparisons dereference them.
      if (validEntrants) run(() => validateCinematicShot(prepared, scene, scopedExpected.previousShot as Record<string, unknown> | undefined))
      if (validCast && validEntrants && names(initialCharacters)) run(() => validateStoryboardContinuity(prepared, scopedExpected))
      run(() => validateStoryboardBeatCoverage(record, scene))
    }
    const speechRate = dynamic ? HISTORY_SPEECH_RATE : Math.max(2, Math.min(4, Number(expected.productionSpeechRate) || 4))
    if (validAudio) {
      const audioText = record.audioText as string
      // Cue length has no timeline/anchor prerequisite. Share the acceptance
      // formula and message so an unbound long line is reported in this repair.
      if (audioType === '对白') for (const line of dialogueLines(audioText)) {
        const issue = dialogueCueLengthIssue(line, speechRate)
        if (issue) errors.add(prefix + `STORYBOARD_PROMPT_OVERLOAD: ${issue}`)
      }
      if (!dynamic || validPacing) run(() => {
        const timing = dynamic ? dynamicStoryboardTiming(audioText, record.pacing as Record<string, unknown>, record)
          : estimateStoryboardTiming(audioText, record.videoPrompt, speechRate)
        if (timing.requiredDuration > 15) throw new Error(`STORYBOARD_TIMING_OVERFLOW: 当前对白、明示停顿与尾帧预留预计至少需要 ${timing.requiredDuration} 秒，超过 15 秒上限；请压缩台词/停顿或拆分镜头`)
        if (dynamic && validDuration && duration !== timing.requiredDuration) throw new Error(`STORYBOARD_PACING_INVALID: 按自然语速、必要动作、反应和0.3秒剪辑余量预算，本镜应为 ${timing.requiredDuration} 秒，实际声明 ${duration} 秒；调整完整时间轴，不拉长台词或删除剧情`)
      })
      // A scalar budget error must not hide an independently malformed window.
      if (dynamic && validPacing) run(() => performanceStoryboardTiming(record.pacing as Record<string, unknown>, speechBudgetSeconds(audioText), record))
      if (validPacing && validCast && validEntrants && validDuration) run(() => validateStoryboardSpeechActivityCoverage(record))
      if (typeof record.videoPrompt === 'string' && typeof audioType === 'string' && validCast && validEntrants && validDuration) run(() => {
        const issue = storyboardPromptIssue(record.videoPrompt as string, audioType, audioText, record.characters as string[], rawEntrants as StoryboardEntrant[], speechRate, duration)
        if (issue) throw new Error(`STORYBOARD_PROMPT_OVERLOAD: ${issue}`)
      })
    }
  }
  return [...errors]
}

export function aggregateLoopOutputs(iterations: Array<Record<string, unknown>>, modes: Record<string, 'collect' | 'latest'> = {}) {
  const collected: Record<string, unknown[]> = {}
  for (const iteration of iterations) {
    for (const [key, value] of Object.entries(iteration)) collected[key] = [...(collected[key] ?? []), value]
  }
  return Object.fromEntries(Object.entries(collected).map(([key, items]) => [key,
    modes[key] === 'latest' ? items.at(-1) : { items, count: items.length },
  ]))
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
