import { durationContentHash } from './duration-policy.ts'
import { MAX_NODE_ATTEMPTS } from './retry-budget.ts'
import { normalizeStructuredTextOutput, extractTextResponse } from './workflow-core.ts'
import { storyboardCandidate, storyboardContinuityContext } from './storyboard-runtime.ts'
import { structuralJsonSha256, STRUCTURAL_JSON_HASH_ALGORITHM } from './structural-json-hash.ts'

type Value = Record<string, unknown>
const object = (value: unknown): value is Value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
const fail = (reason: string): never => { throw Error(`FAILED_TEXT_CANDIDATE_INVALID: ${reason}`) }
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const hash = (value: unknown) => durationContentHash(value)
const stableContext = (value: Value) => Object.fromEntries(Object.entries(value).filter(([key]) => !['retry', 'branch'].includes(key)))

export type FailedTextCandidateBinding = {
  executionId: string; requestScopeId: string; generationScopeId: string; workflowId: string; nodeId: string; runId: string
  operation: string; modelId: string; attempt: number; revision: number; loopGroupId: string | null; loopIndex: number; sceneId: string
  nodePromptSha256: string; runtimeInputsSha256: string; successfulPrefixSha256: string; inputContextSha256: string; inputsSha256: string
  successfulPrefixHashAlgorithm?: 'canonical-json-sha256' | typeof STRUCTURAL_JSON_HASH_ALGORITHM
}
export type FailedTextCandidateEvidence = {
  version: 'failed-text-candidate-v1'; hashAlgorithm: 'canonical-json-sha256'; message: string; raw: unknown; draft: Value
  rawSha256: string; draftSha256: string; provenanceSha256: string; binding: FailedTextCandidateBinding
  source: { requestKey: string; generation: number; modelExecutionId?: string; status: 'succeeded'; httpStatus: number }
}
type BindingInput = Omit<FailedTextCandidateBinding, 'loopGroupId' | 'loopIndex' | 'sceneId' | 'nodePromptSha256' | 'runtimeInputsSha256' | 'successfulPrefixSha256' | 'inputContextSha256' | 'inputsSha256'> & {
  loopGroupId?: string | null; loopIndex?: number | null; sceneId?: string; nodePrompt: string; runtimeInputs: unknown
  successfulPrefix: Array<{ status: string }>; inputContext: Value; inputs: Value
}

export function createFailedTextCandidateBinding(input: BindingInput): FailedTextCandidateBinding {
  if (!Array.isArray(input.successfulPrefix) || input.successfulPrefix.some(run => !object(run) || !['success', 'skipped'].includes(run.status))) fail('prefix must contain complete successful/skipped runs')
  if (!object(input.inputContext) || !object(input.inputs) || !object(input.runtimeInputs) || !text(input.nodePrompt)) fail('complete inputs and source prompt are required')
  const successfulPrefixHashAlgorithm = input.successfulPrefixHashAlgorithm ?? STRUCTURAL_JSON_HASH_ALGORITHM
  const binding = { executionId: input.executionId, requestScopeId: input.requestScopeId, generationScopeId: input.generationScopeId,
    workflowId: input.workflowId, nodeId: input.nodeId, runId: input.runId, operation: input.operation, modelId: input.modelId,
    attempt: input.attempt, revision: input.revision, loopGroupId: input.loopGroupId ?? null, loopIndex: input.loopIndex ?? 0, sceneId: input.sceneId ?? '',
    nodePromptSha256: hash(input.nodePrompt), runtimeInputsSha256: hash(input.runtimeInputs), successfulPrefixHashAlgorithm,
    successfulPrefixSha256: successfulPrefixHashAlgorithm === STRUCTURAL_JSON_HASH_ALGORITHM ? structuralJsonSha256(input.successfulPrefix) : hash(input.successfulPrefix),
    inputContextSha256: hash(stableContext(input.inputContext)), inputsSha256: hash(input.inputs) }
  validateBinding(binding)
  return binding
}

function validateBinding(binding: FailedTextCandidateBinding) {
  if (!object(binding) || !['executionId', 'requestScopeId', 'generationScopeId', 'workflowId', 'nodeId', 'runId', 'modelId'].every(key => text(binding[key as keyof FailedTextCandidateBinding]))
    || !['history.scene-outline', 'history.storyboard'].includes(binding.operation) || !Number.isSafeInteger(binding.attempt) || binding.attempt < 1
    || !Number.isSafeInteger(binding.revision) || binding.revision < 0 || !Number.isSafeInteger(binding.loopIndex) || binding.loopIndex < 0
    || typeof binding.sceneId !== 'string' || binding.operation === 'history.storyboard' && !text(binding.sceneId) || binding.loopGroupId !== null && !text(binding.loopGroupId)
    || binding.successfulPrefixHashAlgorithm !== undefined && !['canonical-json-sha256', STRUCTURAL_JSON_HASH_ALGORITHM].includes(binding.successfulPrefixHashAlgorithm)
    || [binding.generationScopeId, binding.nodeId, binding.sceneId].some(value => value.includes(':') || value !== value.trim())
    || !['nodePromptSha256', 'runtimeInputsSha256', 'successfulPrefixSha256', 'inputContextSha256', 'inputsSha256'].every(key => /^[a-f\d]{64}$/.test(String(binding[key as keyof FailedTextCandidateBinding])))) fail('source identity or SHA-256 binding is incomplete')
}

/** Existing evidence chooses its existing hash contract. Absent legacy flags
 * mean canonical JSON; new evidence uses the bounded structural commitment. */
export function failedTextCandidatePrefixHashAlgorithm(feedback: unknown): NonNullable<FailedTextCandidateBinding['successfulPrefixHashAlgorithm']> {
  const evidence = object(feedback) && object(feedback.repairContext) ? feedback.repairContext.failedCandidate : undefined
  if (evidence === undefined) return STRUCTURAL_JSON_HASH_ALGORITHM
  if (!object(evidence) || !object(evidence.binding)) fail('unknown or incomplete evidence envelope')
  const algorithm = ((evidence as Value).binding as Value).successfulPrefixHashAlgorithm
  if (algorithm === undefined) return 'canonical-json-sha256'
  if (algorithm !== 'canonical-json-sha256' && algorithm !== STRUCTURAL_JSON_HASH_ALGORITHM) fail('unknown successful prefix hash algorithm')
  return algorithm === STRUCTURAL_JSON_HASH_ALGORITHM ? STRUCTURAL_JSON_HASH_ALGORITHM : 'canonical-json-sha256'
}

export function failedTextCandidateRequestPrefix(binding: FailedTextCandidateBinding) {
  validateBinding(binding)
  return `${binding.generationScopeId}:attempt-${binding.attempt}:revision-${binding.revision}:${binding.nodeId}:${binding.loopIndex}:${binding.sceneId}:generation-`
}

/** Only a known executor's business diagnostics may carry a paid draft.
 * Transport failures, provider refusals and repair-scope escalation stay stopped. */
export function isFailedTextCandidateValidationMessage(message: unknown, operation = 'history.scene-outline'): message is string {
  if (!text(message) || /HTTP\s+\d{3}|MODEL_|risk control|safety|refus|rejected by|Failure to pass|Failed to fetch|NetworkError|socket|ECONNRESET|NODE_RESPONSE_INCOMPLETE|HISTORY_REPAIR_|DRAMA_.*LIMIT|FAILED_TEXT_CANDIDATE_INVALID|scope\s*=\s*upstream/i.test(message)) return false
  if (operation === 'history.storyboard') {
    const wrapped = /^分镜修复未通过（(\d+) 次(?:校验，(\d+) 次真实生成)?，已阻止媒体生成）：([\s\S]+)$/.exec(message)
    if (wrapped) {
      let attempts: unknown
      try { attempts = JSON.parse(wrapped[3]) } catch { return false }
      return Array.isArray(attempts) && attempts.length > 0 && attempts.length === Number(wrapped[1])
        && (wrapped[2] === undefined || Number(wrapped[2]) <= MAX_NODE_ATTEMPTS)
        && attempts.every((attempt, index) => object(attempt)
        && Object.keys(attempt).every(key => ['attempt', 'mode', 'errors', 'source'].includes(key))
        && attempt.attempt === index + 1 && ['repair', 'split'].includes(String(attempt.mode))
        && (attempt.source === undefined || ['recovered-candidate', 'generated'].includes(String(attempt.source)))
        && Array.isArray(attempt.errors) && attempt.errors.length > 0
        && attempt.errors.every(error => isFailedTextCandidateValidationMessage(error, operation)))
    }
    return message.split(/\r?\n/).filter(line => line.trim()).every(line => /^(?:STORYBOARD_(?:AUDIO_INVALID|CONTINUITY_INVALID|COVERAGE_INCOMPLETE|COVERAGE_INVALID|NARRATIVE_INCOMPLETE|PACING_INVALID|PROMPT_OVERLOAD|REFERENCE_OVERFLOW|TIMING_OVERFLOW|WORLD_STATE_INVALID):\s*|HISTORY_DRAMA_INVALID:\s*|HISTORY_CONTENT_REJECTED:\s*)/.test(line.trim()))
  }
  if (operation !== 'history.scene-outline') return false
  return message.split(/\r?\n/).filter(line => line.trim()).every(line => /^(?:HISTORY_DRAMA_INVALID:\s*|HISTORY_PLAN_[A-Z_]+:\s*|HISTORY_CONTENT_REJECTED:\s*|history\.scene-outline(?:\.|\s)|scenes(?:\[|\.)|dramaticScenes(?:\[|\.)|characterDramas(?:\[|\.)|historicalLocks(?:\[|\.)|adaptationSpace\.|episodeDrama\.|requiredBeats\s|场景大纲\s|第一镜\s|首个\s|跨越\s|dramaticScenes\s|[^\s]+ 的连续拍摄段|[^\s]+ 必须有实际声画义务)/.test(line.trim()))
}

/** Eligibility is deliberately narrower than the operation name. Old custom
 * or mapped executors retain their own retry behavior and request identities. */
export function isRecoverableFailedTextNode(node: { kind?: string; operation?: string; mapInput?: unknown; prompt?: string }, inputs: Value) {
  return node.kind === 'text' && !node.mapInput && typeof node.prompt === 'string' && node.prompt.includes('cinematic-v1')
    && (node.operation === 'history.scene-outline' || node.operation === 'history.storyboard' && inputs.pacingVersion === 'duration-v2')
}

/** Mirror the actual writer's read-only media projection before hashing its
 * request params. The accepted tail attachment is an input, not advisory text. */
export function failedTextCandidateWriterInputs(operation: string, inputs: Value, inputContext: Value): Value {
  if (operation !== 'history.storyboard') return inputs
  const projected = storyboardContinuityContext({ ...inputContext, qualityDisposition: inputs.qualityDisposition })
  const tail = object(projected.loop) && object(projected.loop.previous) ? projected.loop.previous.actualTailEvidence : undefined
  return object(tail) ? { ...inputs, reviewImages: [tail.url] } : inputs
}

const authoredDraft = (draft: unknown, operation: string): Value => {
  if (!object(draft)) fail('a complete authored draft is required')
  const record = draft as Value
  if (operation === 'history.scene-outline') {
    if (!Array.isArray(record.scenes) || !record.scenes.length) fail('a complete outline draft is required')
  } else if (operation === 'history.storyboard') {
    const shots: unknown[] = Array.isArray(record.segments) ? record.segments : [record]
    if (!shots.length || !shots.every(shot => object(shot) && text(shot.id) && shot.contentContractVersion === 'cinematic-v1'
      && object(shot.pacing) && shot.pacing.version === 'duration-v2' && Array.isArray(shot.pacing.beats) && shot.pacing.beats.length > 0
      && Array.isArray(shot.coveredBeatIds) && shot.coveredBeatIds.length > 0)) fail('a complete cinematic duration-v2 storyboard draft is required')
  } else fail('unsupported candidate operation')
  return json(Object.fromEntries(Object.entries(draft as Value).filter(([key]) => !['raw', 'text', 'model'].includes(key))))
}

export function parseFailedTextCandidateDraft(raw: unknown, operation: string): Value {
  return authoredDraft(operation === 'history.storyboard' ? storyboardCandidate(raw)
    : normalizeStructuredTextOutput(raw, extractTextResponse(raw), 'json'), operation)
}

export function makeFailedTextCandidateEvidence(input: { raw: unknown; draft: unknown; message: string; binding: FailedTextCandidateBinding; requestKey: string; modelExecutionId?: string; httpStatus: number }): FailedTextCandidateEvidence {
  if (!isFailedTextCandidateValidationMessage(input.message, input.binding.operation)) fail('failure is not an eligible business validation failure')
  const prefix = failedTextCandidateRequestPrefix(input.binding), suffix = input.requestKey.startsWith(prefix) ? input.requestKey.slice(prefix.length) : ''
  const generation = Number(suffix)
  if (!/^[1-9]\d*$/.test(suffix) || generation > MAX_NODE_ATTEMPTS || !Number.isInteger(input.httpStatus) || input.httpStatus < 200 || input.httpStatus >= 300) fail('successful provider request identity does not match the source')
  const raw = json(input.raw), draft = authoredDraft(input.draft, input.binding.operation)
  const actual = parseFailedTextCandidateDraft(raw, input.binding.operation)
  if (hash(actual) !== hash(draft)) fail('draft is not the exact parsed supplier response')
  const source = { requestKey: input.requestKey, generation, ...(input.modelExecutionId ? { modelExecutionId: input.modelExecutionId } : {}), status: 'succeeded' as const, httpStatus: input.httpStatus }
  const rawSha256 = hash(raw), draftSha256 = hash(draft), binding = json(input.binding)
  return { version: 'failed-text-candidate-v1', hashAlgorithm: 'canonical-json-sha256', message: input.message, raw, draft, rawSha256, draftSha256, binding, source,
    provenanceSha256: hash({ message: input.message, binding, source, rawSha256, draftSha256 }) }
}

/** An evidence envelope is advice and provenance; it never asserts acceptance. */
export function readFailedTextCandidate(feedback: unknown, current: FailedTextCandidateBinding): FailedTextCandidateEvidence | undefined {
  const evidence = object(feedback) && object(feedback.repairContext) ? feedback.repairContext.failedCandidate : undefined
  if (evidence === undefined) return undefined
  if (!object(evidence) || evidence.version !== 'failed-text-candidate-v1' || evidence.hashAlgorithm !== 'canonical-json-sha256' || !object(evidence.binding) || !object(evidence.source)) fail('unknown or incomplete evidence envelope')
  validateBinding(current)
  const value = evidence as unknown as FailedTextCandidateEvidence
  const restored = makeFailedTextCandidateEvidence({ ...value, requestKey: value.source.requestKey, modelExecutionId: value.source.modelExecutionId, httpStatus: value.source.httpStatus })
  if (value.source.status !== 'succeeded' || restored.source.generation !== value.source.generation || restored.rawSha256 !== value.rawSha256 || restored.draftSha256 !== value.draftSha256 || restored.provenanceSha256 !== value.provenanceSha256) fail('saved supplier response, draft or provenance hash changed')
  const source = value.binding
  if ((source.successfulPrefixHashAlgorithm ?? 'canonical-json-sha256') !== (current.successfulPrefixHashAlgorithm ?? 'canonical-json-sha256')) fail('candidate is bound to different successfulPrefixHashAlgorithm')
  for (const key of ['requestScopeId', 'workflowId', 'nodeId', 'runId', 'operation', 'modelId', 'loopGroupId', 'loopIndex', 'sceneId', 'nodePromptSha256', 'runtimeInputsSha256', 'successfulPrefixSha256', 'inputContextSha256', 'inputsSha256'] as const) {
    if (source[key] !== current[key]) fail(`candidate is bound to different ${key}`)
  }
  return value
}

export function withFailedTextCandidate(feedback: unknown, evidence: FailedTextCandidateEvidence): Value {
  const prior = object(feedback) ? feedback : {}
  return { ...prior, repairContext: { ...(object(prior.repairContext) ? prior.repairContext : {}), failedCandidate: evidence } }
}

export function withoutFailedTextCandidate(feedback: unknown): unknown {
  if (!object(feedback) || !object(feedback.repairContext) || feedback.repairContext.failedCandidate === undefined) return feedback
  const repairContext = Object.fromEntries(Object.entries(feedback.repairContext).filter(([key]) => key !== 'failedCandidate'))
  const result = Object.fromEntries(Object.entries(feedback).filter(([key]) => key !== 'repairContext'))
  return Object.keys(repairContext).length ? { ...result, repairContext } : Object.keys(result).length ? result : ''
}

export type FailedTextCandidateLedgerRecord = { id: string; workflowId?: string; nodeId?: string; modelId: string; capability: string; status: string; httpStatus?: number; requestData: unknown; responseData?: unknown }

export function failedTextCandidateFromLedger(records: FailedTextCandidateLedgerRecord[], binding: FailedTextCandidateBinding, message: string): FailedTextCandidateEvidence | undefined {
  if (!isFailedTextCandidateValidationMessage(message, binding.operation)) return undefined
  const prefix = failedTextCandidateRequestPrefix(binding)
  const matches = records.filter(row => object(row.requestData) && typeof row.requestData.requestKey === 'string' && row.requestData.requestKey.startsWith(prefix))
  if (!matches.length) return undefined
  for (const row of matches) {
    const suffix = String((row.requestData as Value).requestKey).slice(prefix.length)
    if (row.workflowId !== binding.workflowId || row.nodeId !== binding.nodeId || row.modelId !== binding.modelId || row.capability !== 'text' || row.status !== 'succeeded'
      || !object(row.requestData) || row.requestData.operation !== binding.operation || hash(row.requestData.params) !== binding.inputsSha256
      || !/^[1-9]\d*$/.test(suffix) || Number(suffix) > MAX_NODE_ATTEMPTS) fail('ledger row is not bound to the source operation and inputs')
  }
  const ordered = matches.map(row => ({ row, generation: Number((row.requestData as Value).requestKey?.toString().slice(prefix.length)) })).sort((a, b) => b.generation - a.generation)
  const last = ordered[0]
  if (ordered.filter(item => item.generation === last.generation).length !== 1) fail('ambiguous final successful provider response')
  return makeFailedTextCandidateEvidence({ raw: last.row.responseData,
    draft: parseFailedTextCandidateDraft(last.row.responseData, binding.operation), message, binding,
    requestKey: String((last.row.requestData as Value).requestKey), modelExecutionId: last.row.id, httpStatus: last.row.httpStatus ?? 0 })
}

export class FailedTextCandidateError extends Error {
  readonly evidence: FailedTextCandidateEvidence
  constructor(message: string, evidence: FailedTextCandidateEvidence) { super(message); this.name = 'FailedTextCandidateError'; this.evidence = evidence }
}
