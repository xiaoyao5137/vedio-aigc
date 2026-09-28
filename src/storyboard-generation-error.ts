export type StoryboardValidationAttempt = {
  attempt: number
  mode: 'repair' | 'split'
  errors: string[]
  source?: 'recovered-candidate' | 'generated'
}

/** Unapproved author evidence for the execution checkpoint. These fields must
 * never be merged into a successful shot or substituted for a validated one. */
export class StoryboardCandidateValidationError extends Error {
  readonly lastRawResponse: unknown
  readonly lastCandidate: unknown
  readonly attempts: StoryboardValidationAttempt[]
  readonly diagnostics: string[]
  readonly generationAttempts: number

  constructor(message: string, evidence: {
    lastRawResponse: unknown
    lastCandidate: unknown
    attempts: StoryboardValidationAttempt[]
    generationAttempts: number
  }) {
    super(message)
    this.name = 'StoryboardCandidateValidationError'
    this.lastRawResponse = structuredClone(evidence.lastRawResponse)
    this.lastCandidate = structuredClone(evidence.lastCandidate)
    this.attempts = structuredClone(evidence.attempts)
    this.diagnostics = [...(this.attempts.at(-1)?.errors ?? [])]
    this.generationAttempts = evidence.generationAttempts
  }
}
