type Run = { id: string; node: { id: string }; status: string; loopGroupId?: string;
  loopIndex?: number; output?: unknown }
type ReviewIssue = { code?: unknown; beatId?: unknown; problem?: unknown;
  detail?: unknown; evidence?: unknown; pixelEvidence?: unknown }
type Review = { passed?: unknown; issues?: unknown }

function retryIssue(value: unknown) {
  if (typeof value === 'string') {
    const match = value.trim().match(/^([\w-]+)：(.{15,})$/u)
    return match ? { code: 'VISUAL_ACTION_REJECTED', beatId: match[1],
      problem: match[2] } : undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const issue = value as ReviewIssue
  const problem = [issue.problem, issue.detail, issue.evidence]
    .find(text => typeof text === 'string' && text.trim())
  const pixelEvidence = typeof issue.pixelEvidence === 'string' && issue.pixelEvidence.trim()
    ? issue.pixelEvidence.trim() : undefined
  // Vision reports may identify a failed beat without emitting a separate code.
  // In that case require both a concrete problem and pixel evidence before
  // authorizing another paid image request.
  const code = typeof issue.code === 'string' && issue.code.trim()
    ? issue.code.trim() : typeof issue.beatId === 'string' && issue.beatId.trim()
      && problem && pixelEvidence ? 'VISUAL_ACTION_REJECTED' : undefined
  return code && problem ? { code, beatId: issue.beatId, problem, pixelEvidence } : undefined
}

/** Only a real, image-bound review rejection can purchase another first frame. */
export function planSceneCutAutoRetry(runs: Run[], failedIndex: number, previousCount = 0) {
  const failed = runs[failedIndex]
  if (failed?.node.id !== 'sanguo-scene-cut-approval' || failed.status !== 'failed'
    || !Number.isInteger(previousCount) || previousCount < 0 || previousCount >= 5) return undefined
  const sameShot = (run: Run) => run.loopGroupId === failed.loopGroupId && run.loopIndex === failed.loopIndex
  const reviewIndex = runs.findIndex((run, index) => index < failedIndex && sameShot(run)
    && run.node.id === 'sanguo-scene-cut-review' && run.status === 'success')
  const imageIndex = runs.findIndex((run, index) => index < reviewIndex && sameShot(run)
    && run.node.id === 'sanguo-scene-cut-first-frame' && run.status === 'success')
  if (imageIndex < 0 || reviewIndex < 0 || runs.slice(imageIndex + 1, failedIndex)
    .some(run => !sameShot(run) || !['success', 'skipped'].includes(run.status))) return undefined
  const review = runs[reviewIndex].output as Review | undefined
  const issues = Array.isArray(review?.issues) ? review.issues : []
  const parsedIssues = issues.map(retryIssue)
  if (review?.passed !== false || !issues.length || issues.length > 20
    || parsedIssues.some(issue => !issue)) return undefined
  const feedback = parsedIssues.map(issue => JSON.stringify(issue)).join('；')
  return { imageIndex, reviewIndex, count: previousCount + 1,
    feedback: `上一张首帧经实图审核未通过：${feedback}。仅重生成本镜首帧；保持已批准分镜、零秒动作计划和冻结人物资产。新图必须重新采证审核，不继承上次结论。`,
    reviewRunId: runs[reviewIndex].id }
}
