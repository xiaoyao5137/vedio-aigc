import { FailedTextCandidateError, isFailedTextCandidateValidationMessage, makeFailedTextCandidateEvidence, readFailedTextCandidate, withFailedTextCandidate, type FailedTextCandidateBinding, type FailedTextCandidateEvidence } from './failed-text-candidate.ts'
import { generateHistoricalStoryboard } from './storyboard-runtime.ts'
import { StoryboardCandidateValidationError } from './storyboard-generation-error.ts'

type GeneratedCandidate = { raw: unknown; requestKey: string; modelExecutionId?: string; httpStatus: number }
type Options<T> = {
  binding?: FailedTextCandidateBinding
  carry?: FailedTextCandidateEvidence
  prompt: string
  maxGenerations: number
  canGenerate: () => boolean
  generate: (prompt: string) => Promise<GeneratedCandidate>
  normalizeCandidate: (raw: unknown) => unknown
  normalizeAndValidate: (raw: unknown) => T
  buildCorrection: (prompt: string, message: string, draft: unknown, attempt: number, unchanged: boolean) => string
  candidatesDiffer: (left: unknown, right: unknown) => boolean
}

/** Failed drafts are repair evidence, never an approved previousCandidate. Try
 * the full current validator before spending a generation. If still invalid,
 * every new request receives that draft and the complete current diagnostics.
 * The configured budget counts only requests bought by this execution. */
export async function executeFailedTextCandidate<T>(options: Options<T>) {
  if (!Number.isSafeInteger(options.maxGenerations) || options.maxGenerations < 1) throw new Error('FAILED_TEXT_EXECUTION_INVALID: maxGenerations must be positive')
  if (options.carry && !options.binding) throw new Error('FAILED_TEXT_EXECUTION_INVALID: recovered candidate requires a complete binding')
  const carry = options.carry ? readFailedTextCandidate(withFailedTextCandidate('', options.carry), options.binding!) : undefined
  let candidate: GeneratedCandidate | undefined = carry ? { raw: carry.raw, requestKey: carry.source.requestKey,
    modelExecutionId: carry.source.modelExecutionId, httpStatus: carry.source.httpStatus } : undefined
  let sourceBinding = carry?.binding ?? options.binding
  let previousDraft: unknown
  let draft: unknown
  let message = ''
  let unchanged = false
  let generations = 0
  let corrections = 0
  const validate = () => {
    try {
      return { result: options.normalizeAndValidate(candidate!.raw) }
    } catch (error) {
      const current = error instanceof Error ? error.message : String(error)
      // Configuration, transport, unsafe repair scopes and provider failures do
      // not authorize recovering a business draft or spending another request.
      if (!isFailedTextCandidateValidationMessage(current, options.binding?.operation)) throw error
      previousDraft = draft
      draft = options.normalizeCandidate(candidate!.raw)
      unchanged = previousDraft !== undefined && !options.candidatesDiffer(previousDraft, draft)
      message = current
      return undefined
    }
  }
  if (candidate) {
    const validated = validate()
    if (validated) return { ...validated, raw: candidate.raw, generations, recovered: carry }
  }
  while (generations < options.maxGenerations && options.canGenerate()) {
    const prompt = candidate
      ? options.buildCorrection(options.prompt, message, draft, ++corrections, unchanged)
      : options.prompt
    candidate = await options.generate(prompt)
    sourceBinding = options.binding
    generations += 1
    const validated = validate()
    if (validated) return { ...validated, raw: candidate.raw, generations, recovered: undefined }
  }
  if (!candidate || !message) throw new Error('FAILED_TEXT_EXECUTION_INVALID: no candidate or validator diagnostics available')
  if (!sourceBinding) throw new Error(message)
  const evidence = makeFailedTextCandidateEvidence({ ...candidate, draft, message, binding: sourceBinding })
  throw new FailedTextCandidateError(message, evidence)
}

/** Storyboards have their own complete shared normalization, split planner and
 * validator. Keep that executor authoritative; this adapter supplies bound
 * paid evidence and records the real last request without approving its draft. */
export async function executeRecoveredHistoricalStoryboard(options: Omit<Parameters<typeof generateHistoricalStoryboard>[0], 'generate' | 'initialCandidate' | 'initialRawResponse'> & {
  binding?: FailedTextCandidateBinding
  carry?: FailedTextCandidateEvidence
  /** A separately verified successful split plan is still only a candidate
   * here. Failed paid evidence takes priority over that older plan. */
  plannedCandidate?: { draft: Record<string, unknown>; raw: unknown }
  generate: (prompt: string) => Promise<GeneratedCandidate>
}) {
  if (options.carry && !options.binding) throw new Error('FAILED_TEXT_EXECUTION_INVALID: recovered candidate requires a complete binding')
  if (options.binding && options.binding.operation !== 'history.storyboard') throw new Error('FAILED_TEXT_EXECUTION_INVALID: storyboard executor requires its own operation binding')
  const carry = options.carry ? readFailedTextCandidate(withFailedTextCandidate('', options.carry), options.binding!) : undefined
  let lastGenerated: GeneratedCandidate | undefined
  let generations = 0
  try {
    const result = await generateHistoricalStoryboard({ ...options,
      initialCandidate: carry?.draft ?? options.plannedCandidate?.draft,
      initialRawResponse: carry?.raw ?? options.plannedCandidate?.raw,
      generate: async prompt => {
        lastGenerated = await options.generate(prompt)
        generations += 1
        if (!Number.isInteger(lastGenerated.httpStatus) || lastGenerated.httpStatus < 200 || lastGenerated.httpStatus >= 300) {
          throw new Error(`HTTP ${lastGenerated.httpStatus}: storyboard writer response did not succeed`)
        }
        return lastGenerated.raw
      } })
    return { result, generations, recovered: carry, source: lastGenerated ? { ...lastGenerated, binding: options.binding }
      : carry ? { raw: carry.raw, requestKey: carry.source.requestKey, httpStatus: carry.source.httpStatus,
        modelExecutionId: carry.source.modelExecutionId, binding: carry.binding } : undefined }
  } catch (error) {
    if (!(error instanceof StoryboardCandidateValidationError) || !options.binding
      || !isFailedTextCandidateValidationMessage(error.message, options.binding.operation)) throw error
    const source = lastGenerated ?? (carry ? { raw: carry.raw, requestKey: carry.source.requestKey,
      httpStatus: carry.source.httpStatus, modelExecutionId: carry.source.modelExecutionId } : undefined)
    if (!source) throw error
    const evidence = makeFailedTextCandidateEvidence({ ...source, draft: error.lastCandidate, message: error.message,
      binding: lastGenerated ? options.binding : carry!.binding })
    throw new FailedTextCandidateError(error.message, evidence)
  }
}
