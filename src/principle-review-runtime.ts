import { resolveRetryAttemptLimit } from './retry-budget.ts'
import { modelRetryStopped } from './model-failure.ts'
import { DEFAULT_PRINCIPLE_REVIEW_ATTEMPTS } from './principle-quality-budget.ts'

/** Quality review is advisory unless it returns an evidenced principle problem.
 * Transport/JSON failures get bounded same-input retries, then stay explicit. */
export async function runPrincipleReview(options: {
  generate: (attempt: number, correction: string) => Promise<unknown>
  normalize: (raw: unknown) => unknown
  maxAttempts?: number
}) {
  const limit = resolveRetryAttemptLimit(options.maxAttempts, DEFAULT_PRINCIPLE_REVIEW_ATTEMPTS)
  const attempts: Array<{ attempt: number; error?: string; raw?: unknown }> = []
  let correction = ''
  let upstreamExhausted = false
  let upstreamStopped = false
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    let raw: unknown
    try {
      raw = await options.generate(attempt, correction)
      const report = options.normalize(raw)
      if (!report || typeof report !== 'object' || Array.isArray(report)) throw Error('审核需返回JSON对象')
      const row = report as Record<string, unknown>
      if (row.version !== 'principle-review-v1' || !['pass', 'revise', 'uncertain'].includes(String(row.decision)) || !Array.isArray(row.issues)) {
        throw Error('审核需包含version=principle-review-v1、decision=pass/revise/uncertain及issues数组；无法判断用uncertain，不能编造通过')
      }
      attempts.push({ attempt, raw })
      return { ...row, reviewTransport: { attempts, recovered: attempt > 1 } }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      attempts.push({ attempt, error: message, ...(raw === undefined ? {} : { raw }) })
      // The provider already used the shared transport budget. Replaying the
      // same review here would multiply twenty upstream attempts into four hundred.
      if (/MODEL_TRANSPORT_EXHAUSTED|"retryExhausted"\s*:\s*true/.test(message)) { upstreamExhausted = true; break }
      if (modelRetryStopped(message)) { upstreamStopped = true; break }
      correction = '\n【报告纠错】' + message + '。只重试同一输入的原则审核；不改候选，不新增审美门槛。'
    }
  }
  return { reviewUnavailable: true, warnings: ['原则审核暂不可用；保留作品并提示人工查看，可从本审核节点重新执行。'],
    reviewTransport: { attempts, recovered: false, exhausted: true, ...(upstreamExhausted ? { upstreamExhausted: true } : {}), ...(upstreamStopped ? { upstreamStopped: true } : {}) } }
}
