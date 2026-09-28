import { invalidateRunExecution } from './run-invalidation.ts'
import { MAX_NODE_ATTEMPTS } from './retry-budget.ts'
import { modelRetryStopped } from './model-failure.ts'
import { collectTargetedRepairRetry, withTargetedRepairRetry } from './targeted-repair-retry.ts'

/** Workflow-level bounded retries. Nothing here knows what a quality check means. */
export type AcceptancePolicy = { passedPath: string; retryFrom: string; maxAttempts: number; feedbackPath?: string }
export type RetryRun = {
  node: { id: string; resultVar: string; kind: string; acceptance?: AcceptancePolicy }
  status: string; output?: unknown; context: Record<string, unknown>; inputContext?: Record<string, unknown>
  inputs?: Record<string, unknown>; error?: string; durationMs: number; startedAt?: number
  loopGroupId?: string; loopIndex?: number
  attempt?: number; retryFeedback?: unknown; attempts?: Array<Record<string, unknown>>
}
const at = (value: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => v && typeof v === 'object' && !['__proto__', 'constructor', 'prototype'].includes(k) ? (v as Record<string, unknown>)[k] : undefined, value)

export function validateAcceptancePolicy(policy: AcceptancePolicy) {
  if (!policy.passedPath?.trim() || !policy.retryFrom?.trim() || !Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > MAX_NODE_ATTEMPTS) throw new Error(`RETRY_CONFIG_INVALID: 需配置判定字段、回退节点及 1–${MAX_NODE_ATTEMPTS} 次总尝试上限`)
}

export function acceptanceTransition<R extends RetryRun>(runs: R[], index: number, output: unknown) {
  const gate = runs[index]
  const policy = gate.node.acceptance
  if (!policy) return undefined
  validateAcceptancePolicy(policy)
  const passed = at(output, policy.passedPath)
  if (typeof passed !== 'boolean') throw new Error(`REVIEW_RESULT_INVALID: ${policy.passedPath} 必须为布尔值；缺失报告不能触发重新生成`)
  if (passed) return undefined
  const start = runs.findIndex((r, i) => i <= index && r.node.id === policy.retryFrom && r.loopGroupId === gate.loopGroupId && r.loopIndex === gate.loopIndex)
  if (start < 0 || runs.slice(start, index + 1).some(r => r.node.kind === 'loop' || r.loopGroupId !== gate.loopGroupId || r.loopIndex !== gate.loopIndex)) throw new Error('RETRY_CONFIG_INVALID: 回退必须指向同一轮已执行节点，不能跨循环或重建循环')
  const attempt = gate.attempt ?? 1
  const exhausted = attempt >= policy.maxAttempts
  const feedback = at(output, policy.feedbackPath ?? 'issues')
  const repairCarry = collectTargetedRepairRetry(runs.map((run, i) => i === index ? { ...run, output } : run), start, index)
  const reason = `验收未通过（${attempt}/${policy.maxAttempts}）：${typeof feedback === 'string' ? feedback : JSON.stringify(feedback ?? output)}`
  const snapshot = (r: R, i: number) => ({ attempt: r.attempt ?? 1, status: i === index ? 'rejected' : r.status, output: i === index ? output : r.output, inputs: r.inputs, durationMs: r.durationMs })
  const nextRuns = runs.map((r, i) => {
    if (i < start || i > index) return r
    const attempts = [...(r.attempts ?? []), snapshot(r, i)]
    if (exhausted) return i === index ? { ...r, attempts, output, status: 'failed', error: reason } : { ...r, attempts }
    return { ...invalidateRunExecution(r), attempts, attempt: attempt + 1, errorAttempt: 1, retryFeedback: withTargetedRepairRetry(i === start ? feedback : undefined, repairCarry) }
  }) as R[]
  return { runs: nextRuns, index: exhausted ? index : start, exhausted, reason, context: runs[start].inputContext ?? {} }
}

export type ErrorRetryPolicy = { retryFrom: string; maxAttempts: number; patterns: string[]; reviewRetryTargets?: string[]; retryContextSources?: Record<string, string[]> }
/** Reviewer/infrastructure failures have a separate budget and never rewind the
 * generator unless the workflow explicitly configured that error recovery. */
export function errorRetryTransition<R extends RetryRun & { node: RetryRun['node'] & { errorRetry?: ErrorRetryPolicy }; errorAttempt?: number; revision?: number }>(runs: R[], index: number, error: string) {
  const policy=runs[index].node.errorRetry
  if(modelRetryStopped(error))return undefined
  if(!policy || !policy.patterns.some(pattern=>pattern && error.includes(pattern)))return undefined
  const original=runs[index]
  const patched=runs.map((r,i)=>i===index?{...r,attempt:r.errorAttempt??1,node:{...r.node,acceptance:{passedPath:'passed',retryFrom:policy.retryFrom,maxAttempts:policy.maxAttempts,feedbackPath:'error'}}}:r)
  const transition=acceptanceTransition(patched,index,{passed:false,error})!
  const updated=transition.runs.map((r,i)=>r===runs[i]?r:{...r,node:runs[i].node,attempt:runs[i].attempt,
    errorAttempt:transition.exhausted?(original.errorAttempt??1):(original.errorAttempt??1)+1,
    revision:(runs[i].revision??0)+(transition.exhausted?0:1)}) as R[]
  return {...transition,runs:updated,reason:'节点异常复核：'+transition.reason}
}

export function manualRetryStart<R extends RetryRun & { node: RetryRun['node'] & { errorRetry?: ErrorRetryPolicy } }>(runs: R[], index: number) {
  const run=runs[index]
  if(!run || run.status!=='failed')return index
  const output=run.output as Record<string,unknown>|undefined
  const target=run.node.acceptance && at(output,run.node.acceptance.passedPath)===false ? run.node.acceptance.retryFrom
    : run.node.errorRetry && run.node.errorRetry.patterns.some(p=>String(run.error??output?.error??'').includes(p)) ? run.node.errorRetry.retryFrom : undefined
  if(!target)return index
  const start=runs.findIndex((r,i)=>i<=index&&r.node.id===target&&r.loopGroupId===run.loopGroupId&&r.loopIndex===run.loopIndex)
  return start<0?index:start
}
