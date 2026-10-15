type Run = { id: string; node: { id: string }; status: string; loopGroupId?: string;
  loopIndex?: number; output?: unknown }
type Review = { passed?: unknown; issues?: unknown }

/** Retry only a reviewed image defect; an invalid certificate or missing evidence stays stopped. */
export function planCoverageCutAutoRetry(runs: Run[], failedIndex: number, previousCount = 0) {
  const failed = runs[failedIndex]
  if (failed?.node.id !== 'sanguo-coverage-approval' || failed.status !== 'failed'
    || !Number.isInteger(previousCount) || previousCount < 0 || previousCount >= 2) return undefined
  const sameShot = (run: Run) => run.loopGroupId === failed.loopGroupId && run.loopIndex === failed.loopIndex
  const reviewIndex = runs.findIndex((run, index) => index < failedIndex && sameShot(run)
    && run.node.id === 'sanguo-coverage-review' && run.status === 'success')
  const imageIndex = runs.findIndex((run, index) => index < reviewIndex && sameShot(run)
    && run.node.id === 'sanguo-coverage-first-frame' && run.status === 'success')
  if (imageIndex < 0 || reviewIndex < 0 || runs.slice(imageIndex + 1, failedIndex)
    .some(run => !sameShot(run) || !['success', 'skipped'].includes(run.status))) return undefined
  const review = runs[reviewIndex].output as Review | undefined
  const issues = Array.isArray(review?.issues) ? review.issues : []
  if (review?.passed !== false || !issues.length || issues.length > 20
    || issues.some(issue => typeof issue !== 'string' && (!issue || typeof issue !== 'object'
      || Array.isArray(issue) || !['problem', 'description', 'detail'].some(key =>
        typeof (issue as Record<string, unknown>)[key] === 'string'
          && Boolean(String((issue as Record<string, unknown>)[key]).trim())))))
    return undefined
  const feedback = issues.map(issue => typeof issue === 'string' ? issue : JSON.stringify(issue)).join('；')
  return { imageIndex, reviewIndex, count: previousCount + 1,
    feedback: `上一张同场切镜首帧实图审核未通过：${feedback}。重新生成本镜新机位首帧；真实尾帧只用于现场和轴线，具名人物脸部与衣甲必须分别对应各自三视图。新图须重新采证审核。`,
    reviewRunId: runs[reviewIndex].id }
}
