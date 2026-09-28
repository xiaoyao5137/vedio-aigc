import { deriveMediaRequirements } from './media-requirement-coverage.ts'

/** Explain an uncertain report using authored requirements, without judging or
 * editing it. The embedded gate must bind deriveMediaRequirements explicitly. */
export function uncertainMediaReviewDiagnostic(review: unknown, shot: unknown): string {
  const generic = '证据不足，补充采证或重跑审查；不能因此购买新视频'
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const report = record(review), candidate = record(shot)
  if (!Array.isArray(report.requirementChecks)) return generic
  let requirements: ReturnType<typeof deriveMediaRequirements>
  try { requirements = deriveMediaRequirements(candidate) } catch { return generic }
  const checks = report.requirementChecks
  const unknowns = requirements.flatMap(requirement => {
    const matches = checks.filter(value => record(value).requirementId === requirement.id)
    if (matches.length !== 1) return []
    const check = record(matches[0]), refs = check.frameIndices
    if (check.status !== 'unobservable' || typeof check.evidence !== 'string' || !check.evidence.trim()
      || !Array.isArray(refs) || refs.some(index => !Number.isInteger(index) || Number(index) < 0) || new Set(refs).size !== refs.length
      || check.repair !== undefined || check.defectIndex !== undefined) return []
    return [{ requirementId: requirement.id, requirementPath: requirement.requirementPath, requirementQuote: requirement.requirementQuote,
      scope: requirement.scope, startSecond: requirement.startSecond, endSecond: requirement.endSecond,
      evidence: check.evidence, frameIndices: [...refs],
      ...(check.scopeNotes === undefined ? {} : { scopeNotes: check.scopeNotes }),
      ...(check.evidenceGaps === undefined ? {} : { evidenceGaps: check.evidenceGaps }) }]
  })
  if (!unknowns.length) return generic
  const pacing = record(candidate.pacing)
  const criticalityContext = [
    { sourcePath: 'completionCriteria', value: candidate.completionCriteria },
    { sourcePath: 'storyProgress', value: candidate.storyProgress },
    { sourcePath: 'pacing.performanceBeats', value: pacing.performanceBeats },
    { sourcePath: 'pacing.activityWindows', value: pacing.activityWindows },
  ].filter(source => source.value !== undefined)
  return generic + '。逐项复核以下报告未知，保留原始报告与证据：\n'
    + '可定位的原要求与本项未知（时间为原要求范围；frameIndices为报告引用，诊断函数未验证图片内容或帧边界）：'
    + JSON.stringify(unknowns) + '\n'
    + '原分镜剧情与表演上下文（sourcePath为原字段，value为完整原值，计划不证明实际发生）：' + JSON.stringify(criticalityContext) + '\n'
    + '核对原义务与未知原因是否针对同一属性。原文只约束某状态、未要求其形成或变化过程时，未观察到额外推断的过程不构成该原要求的验收未知；原文明示的动作过程仍须核对。'
    + '结合原要求、完成条件、故事阶段和明确表演节拍，按实际政策区分关键未知与非关键微差。支持evidenceGaps契约时，未观察细项及其原要求状态仍为unobservable，另以acceptanceImpact、政策条款、原上下文逐字引用和理由说明是否阻断；不能为了放warnings把未知写成complete。完成条件或节拍未重复某动作不代表可以忽略物件归属、场景行动、人物进出及明确持续状态等实质要求，不能仅凭动作幅度轻微降级。'
    + '不得凭采样未见编造已发生或已观察结论，不得自动改写unknown或把计划当实际证据；真实关键要求或关键性仍无法判断时保留unobservable，并补充同一素材的采证，不购买新视频。'
}
