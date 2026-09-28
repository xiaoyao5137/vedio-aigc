import { durationContentHash } from './duration-policy.ts'
import { DURATION_WRITER_CONTRACT } from './duration-prompts.ts'
import { MAX_NODE_ATTEMPTS } from './retry-budget.ts'
import { createStructuralJsonHasher, STRUCTURAL_JSON_HASH_ALGORITHM } from './structural-json-hash.ts'
import { cleanStoryboardForValidation, generateHistoricalStoryboard, sceneFromStoryboardSegment, storyboardCandidate, STORYBOARD_SEGMENTS_KEY } from './storyboard-runtime.ts'

type Value = Record<string, unknown>
type SplitNode = { id: string; kind: string; operation?: string; modelId?: string; prompt: string; mapInput?: unknown }
type SplitRun = Value & { id: string; status: string; node: SplitNode; loopGroupId?: string; loopIndex?: number; output?: unknown }
export type StoryboardSplitSource = {
  executionId: string; requestScopeId: string; generationScopeId: string; workflowId: string; nodeId: string; runId: string
  loopGroupId: string; loopIndex: number; attempt: number; revision: number; sceneId: string
  requestKey: string; httpStatus: number; modelExecutionId?: string
}
export type StoryboardSplitPlanEvidence = {
  version: 'storyboard-split-plan-v1'; hashAlgorithm: 'canonical-json-sha256'; scope: 'script-contract-candidate'
  source: StoryboardSplitSource; raw: unknown; segments: Value[]; originalScene: Value
  binding: { sourceIndex: number; prefixHashAlgorithm: typeof STRUCTURAL_JSON_HASH_ALGORITHM; sourceRunHashAlgorithm: typeof STRUCTURAL_JSON_HASH_ALGORITHM
    sourcePrefixSha256: string; sourceRunSha256: string; sourceOutputSha256: string
    runtimeInputsSha256: string; modelSha256: string; nodePromptSha256: string; sourceParamsSha256: string
    stableParamsSha256: string; timingPolicySha256: string; originalExpectedSha256: string; sceneSha256: string
    rawSha256: string; segmentsSha256: string; segmentSha256: string[]; projectedSceneSha256: string[] }
  planSha256: string
}
export type StoryboardSplitCandidateRef = { version: 'storyboard-split-candidate-ref-v1'; sourceRunId: string; planSha256: string; segmentIndex: number }
export type StoryboardSplitCandidateReference = StoryboardSplitCandidateRef
type CreateOptions = { source: StoryboardSplitSource; raw: unknown; validatedSegments: Value[]; sourceRun: SplitRun; sourcePrefix: SplitRun[]
  runtimeInputs: Value; sourceParams: Value; model: Value; originalScene: Value; timingPolicy: unknown; expected: Value }
type ReadOptions = { reference: unknown; currentPrefix: SplitRun[]; runtimeInputs: Value; currentNode: SplitNode
  currentRun: { id: string; loopGroupId?: string; loopIndex?: number }; model: Value; params: Value; scene: Value; timingPolicy: unknown
  executionIdentity: { executionId: string; requestScopeId: string; workflowId: string }; actualTailUrl?: string }

const object = (value: unknown): value is Value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
const hash = durationContentHash
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
function fail(message: string): never { throw Error(`STORYBOARD_SPLIT_CANDIDATE_INVALID: ${message}`) }
const sourceRunValue = (run: SplitRun) => Object.fromEntries(Object.entries(run).filter(([key]) => key !== 'storyboardSplitPlan'))
const stableParams = (params: Value) => Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'reviewImages'))
const completePrefix = (runs: SplitRun[]) => {
  if (!Array.isArray(runs) || runs.some(run => !object(run) || !text(run.id) || !['success', 'skipped'].includes(run.status))) fail('prefix must contain complete successful/skipped runs')
  if (new Set(runs.map(run => run.id)).size !== runs.length) fail('duplicate prefix run identity')
}
function nodeGuard(node: SplitNode, params: Value, model: Value) {
  if (!isManagedStoryboardSplitNode(node, params)
    || !object(model) || model.id !== node.modelId) fail('only the bound managed cinematic duration-v2 writer is eligible')
}
export function isManagedStoryboardSplitNode(node: unknown, params?: Value): node is SplitNode {
  return object(node) && node.kind === 'text' && node.operation === 'history.storyboard' && !node.mapInput
    && text(node.id) && text(node.modelId) && text(node.prompt) && node.prompt.includes('cinematic-v1')
    && node.prompt.split(DURATION_WRITER_CONTRACT).length === 2 && (params === undefined || params.pacingVersion === 'duration-v2')
}
function sourceGuard(source: StoryboardSplitSource) {
  if (!object(source) || Object.keys(source).some(key => !['executionId', 'requestScopeId', 'generationScopeId', 'workflowId', 'nodeId', 'runId', 'loopGroupId', 'loopIndex', 'attempt', 'revision', 'sceneId', 'requestKey', 'httpStatus', 'modelExecutionId'].includes(key))
    || !['executionId', 'requestScopeId', 'generationScopeId', 'workflowId', 'nodeId', 'runId', 'loopGroupId', 'sceneId', 'requestKey'].every(key => text(source[key as keyof StoryboardSplitSource]))
    || [source.generationScopeId, source.nodeId, source.sceneId].some(value => value.includes(':') || value !== value.trim())
    || !Number.isSafeInteger(source.loopIndex) || source.loopIndex < 0 || !Number.isSafeInteger(source.attempt) || source.attempt < 1
    || !Number.isSafeInteger(source.revision) || source.revision < 0 || !Number.isInteger(source.httpStatus) || source.httpStatus < 200 || source.httpStatus >= 300
    || source.modelExecutionId !== undefined && !text(source.modelExecutionId)) fail('complete successful provider/source identity is required')
  const prefix = `${source.generationScopeId}:attempt-${source.attempt}:revision-${source.revision}:${source.nodeId}:${source.loopIndex}:${source.sceneId}:generation-`
  const suffix = source.requestKey.startsWith(prefix) ? source.requestKey.slice(prefix.length) : ''
  if (!/^[1-9]\d*$/.test(suffix) || Number(suffix) > MAX_NODE_ATTEMPTS) fail('provider request namespace, scene or generation differs')
}
function selectedSegments(result: Value): Value[] {
  const values = result[STORYBOARD_SEGMENTS_KEY]
  if (!Array.isArray(values) || values.length < 2 || !values.every(object)) fail('complete validated split segments are required')
  return (values as Value[]).map(cleanStoryboardForValidation)
}

/** Preserve a complete successful script plan separately from business output.
 * Its raw provider response and normalized segments are different evidence.
 * Replay is local and cannot buy a request or assert observed media state. */
export async function createStoryboardSplitPlan(options: CreateOptions): Promise<StoryboardSplitPlanEvidence> {
  const { source, sourceRun, sourcePrefix, sourceParams, model, expected } = options
  sourceGuard(source); completePrefix(sourcePrefix); nodeGuard(sourceRun.node, sourceParams, model)
  if (!object(options.runtimeInputs) || !object(options.originalScene) || !object(expected) || !object(sourceParams)
    || !object(options.timingPolicy) || sourceRun.status !== 'success' || sourceRun.id !== source.runId
    || sourceRun.node.id !== source.nodeId || sourceRun.loopGroupId !== source.loopGroupId || sourceRun.loopIndex !== source.loopIndex
    || sourcePrefix.some(run => run.id === sourceRun.id) || expected.pacingVersion !== 'duration-v2'
    || hash(expected.scene) !== hash(options.originalScene) || hash(expected.timingPolicy) !== hash(options.timingPolicy)
    || hash(sourceParams.timingPolicy) !== hash(options.timingPolicy) || options.originalScene.id !== source.sceneId) fail('successful source run, original scene and policy must agree')
  const authored: unknown = storyboardCandidate(options.raw)
  if (!object(authored) || !Array.isArray(authored.segments) || authored.segments.length < 2) fail('supplier response must contain the complete split plan')
  const replay = await generateHistoricalStoryboard({ prompt: sourceRun.node.prompt, expected, initialCandidate: authored,
    initialRawResponse: options.raw, canGenerate: () => false, generate: async () => fail('provider calls are forbidden while saving a plan') })
  const segments = selectedSegments(replay)
  if (!Array.isArray(options.validatedSegments) || options.validatedSegments.length < 2 || !options.validatedSegments.every(object)
    || hash(segments) !== hash(options.validatedSegments.map(cleanStoryboardForValidation))) fail('segments differ from the complete current validated supplier plan')
  if (!object(sourceRun.output) || hash(cleanStoryboardForValidation(sourceRun.output)) !== hash(segments[0])) fail('successful source output differs from the validated first segment')
  if (hash(sourceRun.loopItem) !== hash(sceneFromStoryboardSegment(options.originalScene, segments[0], 0, segments.length))
    || !object(sourceRun.inputs) || hash(stableParams(sourceRun.inputs)) !== hash(stableParams(sourceParams))) fail('source projected scene or writer inputs differ')
  const raw = copy(options.raw), originalScene = copy(options.originalScene)
  const structuralHash = createStructuralJsonHasher()
  const binding = { sourceIndex: sourcePrefix.length, prefixHashAlgorithm: STRUCTURAL_JSON_HASH_ALGORITHM, sourceRunHashAlgorithm: STRUCTURAL_JSON_HASH_ALGORITHM,
    sourcePrefixSha256: structuralHash(sourcePrefix), sourceRunSha256: structuralHash(sourceRunValue(sourceRun)),
    sourceOutputSha256: hash(sourceRun.output), runtimeInputsSha256: hash(options.runtimeInputs), modelSha256: hash(model),
    nodePromptSha256: hash(sourceRun.node.prompt), sourceParamsSha256: hash(sourceParams), stableParamsSha256: hash(stableParams(sourceParams)),
    timingPolicySha256: hash(options.timingPolicy), originalExpectedSha256: hash(expected), sceneSha256: hash(originalScene),
    rawSha256: hash(raw), segmentsSha256: hash(segments), segmentSha256: segments.map(hash),
    projectedSceneSha256: segments.map((segment, index) => hash(sceneFromStoryboardSegment(originalScene, segment, index, segments.length))) }
  const plan = { version: 'storyboard-split-plan-v1' as const, hashAlgorithm: 'canonical-json-sha256' as const,
    scope: 'script-contract-candidate' as const, source: copy(source), raw, segments: copy(segments), originalScene, binding }
  return { ...plan, planSha256: hash(plan) }
}

export function storyboardSplitCandidateRef(plan: StoryboardSplitPlanEvidence, segmentIndex: number): StoryboardSplitCandidateRef {
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 1 || segmentIndex >= plan.segments.length) fail('reference must select a future segment')
  return { version: 'storyboard-split-candidate-ref-v1', sourceRunId: plan.source.runId, planSha256: plan.planSha256, segmentIndex }
}

/** Returns an unapproved candidate. The caller must run the complete CURRENT
 * validator against actualTail/previousShot before publishing script output. */
export function readStoryboardSplitCandidate(options: ReadOptions): { draft: Value; raw: unknown; provenance: Value } | undefined {
  if (options.reference === undefined) return undefined
  const ref = options.reference
  if (!object(ref) || Object.keys(ref).some(key => !['version', 'sourceRunId', 'planSha256', 'segmentIndex'].includes(key))
    || ref.version !== 'storyboard-split-candidate-ref-v1' || !text(ref.sourceRunId) || !Number.isSafeInteger(ref.segmentIndex)) fail('unknown or incomplete segment reference')
  completePrefix(options.currentPrefix)
  const sourceRun = options.currentPrefix.find(run => run.id === ref.sourceRunId)
  if (!sourceRun || !object(sourceRun.storyboardSplitPlan)) fail('source successful plan is absent from the immutable prefix')
  const plan = sourceRun.storyboardSplitPlan as unknown as StoryboardSplitPlanEvidence
  if (Object.keys(plan).some(key => !['version', 'hashAlgorithm', 'scope', 'source', 'raw', 'segments', 'originalScene', 'binding', 'planSha256'].includes(key))
    || plan.version !== 'storyboard-split-plan-v1' || plan.hashAlgorithm !== 'canonical-json-sha256' || plan.scope !== 'script-contract-candidate'
    || !object(plan.binding) || !Array.isArray(plan.segments) || !plan.segments.every(object) || plan.segments.length < 2
    || !object(plan.originalScene)) fail('unknown or incomplete split plan')
  sourceGuard(plan.source)
  const { planSha256, ...payload } = plan
  if (hash(payload) !== planSha256 || ref.planSha256 !== planSha256 || plan.binding.rawSha256 !== hash(plan.raw)
    || plan.binding.segmentsSha256 !== hash(plan.segments) || plan.binding.sceneSha256 !== hash(plan.originalScene)) fail('plan content or metadata hash changed')
  const index = Number(ref.segmentIndex), binding = plan.binding, source = plan.source
  const structuralHash = createStructuralJsonHasher()
  if (index < 1 || index >= plan.segments.length || !Number.isSafeInteger(binding.sourceIndex)
    || binding.prefixHashAlgorithm !== STRUCTURAL_JSON_HASH_ALGORITHM || binding.sourceRunHashAlgorithm !== STRUCTURAL_JSON_HASH_ALGORITHM
    || options.currentPrefix[binding.sourceIndex] !== sourceRun || sourceRun.status !== 'success' || sourceRun.id !== source.runId
    || structuralHash(options.currentPrefix.slice(0, binding.sourceIndex)) !== binding.sourcePrefixSha256
    || structuralHash(sourceRunValue(sourceRun)) !== binding.sourceRunSha256 || hash(sourceRun.output) !== binding.sourceOutputSha256) fail('source run or complete successful prefix changed')
  nodeGuard(options.currentNode, options.params, options.model)
  if (!text(options.executionIdentity.executionId) || options.executionIdentity.requestScopeId !== source.requestScopeId
    || options.executionIdentity.workflowId !== source.workflowId || options.currentNode.id !== source.nodeId
    || options.currentNode.modelId !== sourceRun.node.modelId || options.currentRun.loopGroupId !== source.loopGroupId
    || options.currentRun.loopIndex !== source.loopIndex + index || !text(options.currentRun.id)
    || options.currentRun.id === source.runId || hash(options.runtimeInputs) !== binding.runtimeInputsSha256
    || hash(options.model) !== binding.modelSha256 || hash(options.currentNode.prompt) !== binding.nodePromptSha256
    || hash(options.timingPolicy) !== binding.timingPolicySha256 || hash(options.params.timingPolicy) !== binding.timingPolicySha256
    || hash(stableParams(options.params)) !== binding.stableParamsSha256) fail('current scope, writer, runtime, params or policy changed')
  if (Object.hasOwn(options.params, 'reviewImages') && (!text(options.actualTailUrl) || hash(options.params.reviewImages) !== hash([options.actualTailUrl]))) fail('reviewImages must be the exact current actual tail attachment')
  if (!Object.hasOwn(options.params, 'reviewImages') && options.actualTailUrl !== undefined) fail('current actual tail attachment is missing from params')
  const draft = plan.segments[index]
  if (!Array.isArray(binding.segmentSha256) || binding.segmentSha256[index] !== hash(draft)
    || !Array.isArray(binding.projectedSceneSha256) || binding.projectedSceneSha256[index] !== hash(options.scene)
    || hash(sceneFromStoryboardSegment(plan.originalScene, draft, index, plan.segments.length)) !== hash(options.scene)) fail('candidate or scoped scene differs from its validated segment')
  return { draft: copy(draft), raw: copy(plan.raw), provenance: { kind: 'successful-split-plan-candidate',
    source: copy(source), planSha256, segmentIndex: index, draftSha256: binding.segmentSha256[index],
    currentValidationRequired: true, mediaAcceptance: 'unverified' } }
}
