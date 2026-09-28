import { deriveMediaRequirements, type MediaRequirement } from './media-requirement-coverage.ts'
import { MEDIA_REQUIREMENT_SCOPE_RULES } from './media-review-rubric.ts'
import { validateScriptStateEvidence } from './script-state-evidence.ts'
import { MEDIA_EVIDENCE_GAPS_PROMPT, validateMediaEvidenceGaps } from './media-evidence-gaps.ts'
import { resolveNativeFrameDisplayInterval } from './media-frame-display.ts'

export type RequirementReviewInput = {
  requirement: MediaRequirement
  compatibleRequirements: Array<MediaRequirement & { overlapStartSecond: number; overlapEndSecond: number }>
  criticalityContext: Array<{ sourcePath: string; value: unknown }>
  frameReferences: Array<{ index: number; second: number; url: string; displayStartSecond?: number; displayEndSecond?: number }>
  attachmentReferences: Array<{ index: number; second: number; displayStartSecond?: number; displayEndSecond?: number;
    scopeIntersection?: { startSecond: number; endSecond: number }; evidenceRole?: 'pts-in-window' | 'boundary-context' }>
  reviewImages: string[]
  reviewImageDetail?: Record<string, unknown>
  evidenceStatus: 'available' | 'unobservable'
}

/** Each mapped request sees just one original requirement and its own images.
 * Original frame indexes deliberately remain outside the model prompt. */
export const REQUIREMENT_MEDIA_REVIEW_PROMPT = `你是独立的单项画面验收员。本次只有一项原要求与其范围内的原始图片；逐张查看本次附件，不能把首张姿态复制到后续图片。
原要求：${'${requirementInput.requirement}'}
同一时刻的兼容性约束：${'${requirementInput.compatibleRequirements}'}
原分镜剧情与表演上下文（sourcePath为原字段，value为完整原值，不是验收结论）：${'${requirementInput.criticalityContext}'}
实际门禁政策：${'${params.reviewPolicy}'}
本次原帧编号与采样时刻：${'${requirementInput.attachmentReferences}'}
采证状态：${'${requirementInput.evidenceStatus}'}

${MEDIA_REQUIREMENT_SCOPE_RULES}
${MEDIA_EVIDENCE_GAPS_PROMPT}
本次只评原要求的视觉部分。兼容性约束仅在其overlapStartSecond到overlapEndSecond内防止解释或repair破坏其他原文，不增加本项义务，不把邻项动作继承到整段。opening只核对开场，ending只核对结尾，interval只核对原时间窗；开场已成立的状态不需要重演形成过程。图片无法确认的实质要求为unobservable，不得猜测complete或incomplete。
duration-v2若原要求有timingBeatId/sourceBeatId及eventSearchRanges，本项已拆成唯一原节拍：原startSecond/endSecond保留导演编排，eventSearchRanges仅用于同素材查找该节拍实际发生。reference允许晚于参考窗但须核对本项实际动作，不把这段动作或持续姿态扩成全片义务；hard只看本项明确边界，不能借另一reference节拍的范围。不能因参考窗没拍到就确证缺失；dependsOn、硬边界与最终完成由逐节拍完成门禁单独核验。没有这些字段的历史要求仍按原时间窗。
原文可能含对白；本项仅核对其视觉部分。图片不能判断发音、同音字、ASR识别、台词完整性、语速与说话时刻，不得因此拒绝或要求修改台词。原文只有声音要求而无实质视觉要求时，说明本项无图片可验收的视觉义务；声音由独立音轨门禁判断。

仅输出一个JSON对象：{"requirementId":"原要求id","status":"complete或incomplete或unobservable","evidence":"实际可见事实；unobservable保留未知原因","frameIndices":[0],"warnings":["可选外观差异提醒"],"scopeNotes":[],"evidenceGaps":[]}。complete/incomplete的evidence只写其确证事实。原要求的任何未知都列evidenceGaps且本行保持unobservable，不能单放warnings或写已完成；scopeNotes仅说明验收方法限制。
仅incomplete还须提供repair和defect：{"repair":"仅修复原范围内已确证视觉缺陷","defect":{"basis":"visible-state-contradiction","violatedQuote":"本项requirementQuote中被违反的逐字原文子句","requiredStateQuote":"violatedQuote内逐字写出的目标属性或状态，不能补写未约束属性","observedState":"同一属性实际呈现的正面可见反证，不写未采到/未观察到","temporalBasis":"state-at-sample或sustained-state","persistenceQuote":"仅sustained-state提供，本项原文明确要求保持/持续的逐字依据"}}。
state-at-sample可用于开场、尾帧或时间窗内明确静态属性的反证，不要求原文另写保持；不能用于推断短暂动作没有发生。sustained-state须有明确原文持续义务，不能把轻微短暂过程改称持续状态。若只有少量静帧未捕捉动作，不满足确证defect契约，应重新判断实质视觉部分和采样限制，不能因此捏造反证或重拍。complete/unobservable省略defect和repair。
frameIndices仅使用本次原帧从0开始的编号，不是全片原帧编号。sequence-grid附件须逐格查看，cells.evidenceIndex对应本次原帧号，attachmentIndex不能用作帧号；nativeFrameIndex追溯实际解码帧。连续性只按明确的native帧号与PTS判断，拼图本身不证明全片覆盖；实际看不清仍保留未知。displayStartSecond/displayEndSecond是原帧真实显示区间；boundary-context只在scopeIntersection内支持原窗边界，不改PTS、不增加窗外义务，不证明动作完成。complete/incomplete须引用至少一张实际原帧；incomplete必须有可见的实质反证及明确局部repair，不能用猜测或未排除可能性拒绝。unobservable可引用遮挡/不足的原帧或空数组，不给repair。若本次没有附件，只能unobservable。不要返回综合成片决定，也不要增写原文没有的要求。`

/** Embed with deriveMediaRequirements and resolveNativeFrameDisplayInterval. */
export function deriveRequirementReviewInputs(shot: Record<string, unknown>, evidence: Record<string, unknown>): RequirementReviewInput[] {
  const invalid = (reason: string): never => { throw Error('MEDIA_REQUIREMENT_REVIEW_INPUT_INVALID: ' + reason + '；修复同素材采证配置，不购买新视频') }
  const requirements = deriveMediaRequirements(shot)
  // These authored values provide context for the existing evidence policy.
  // Their presence or absence never computes a requirement's criticality.
  const pacing = shot.pacing && typeof shot.pacing === 'object' && !Array.isArray(shot.pacing) ? shot.pacing as Record<string, unknown> : {}
  const criticalityContext = [
    { sourcePath: 'completionCriteria', value: shot.completionCriteria },
    { sourcePath: 'storyProgress', value: shot.storyProgress },
    { sourcePath: 'pacing.performanceBeats', value: pacing.performanceBeats },
    { sourcePath: 'pacing.activityWindows', value: pacing.activityWindows },
    ...(pacing.version === 'duration-v2' ? [{ sourcePath: 'pacing.beats', value: pacing.beats }] : []),
  ].filter(source => source.value !== undefined)
  if (!Array.isArray(evidence.frames) || !Array.isArray(evidence.frameTimes) || evidence.frames.length !== evidence.frameTimes.length) invalid('frames与frameTimes必须逐项对应')
  const frames = evidence.frames as unknown[], times = evidence.frameTimes as unknown[]
  const displays = frames.map((_, index) => resolveNativeFrameDisplayInterval(evidence, index))
  const native = evidence.nativeSequence && typeof evidence.nativeSequence === 'object' && !Array.isArray(evidence.nativeSequence) ? evidence.nativeSequence as Record<string, unknown> : undefined
  const nativeRefs = native ? evidence.frameReferences as Array<Record<string, unknown>> : undefined
  if (native && (!Array.isArray(nativeRefs) || nativeRefs.length !== frames.length || nativeRefs.some((ref, index) => !ref || ref.evidenceIndex !== index
    || ref.url !== frames[index] || ref.second !== times[index] || !Number.isSafeInteger(ref.nativeFrameIndex) || !Number.isSafeInteger(ref.pts)
    || typeof ref.timeBase !== 'string' || typeof ref.sourceSha256 !== 'string'))) invalid('原生帧映射必须逐项绑定实际URL、PTS、解码编号及源哈希')
  if (frames.some(url => typeof url !== 'string' || !url.trim()) || times.some((time, index) => !Number.isFinite(time) || Number(time) < 0 || (index > 0 && Number(time) < Number(times[index - 1])))) invalid('原图片URL与真实采样时刻必须有效且按时间排序')
  const epsilon = (...values: number[]) => Number.EPSILON * 8 * Math.max(1, ...values.map(Math.abs))
  if (times.length && Number(times[0]) > epsilon(Number(times[0]))) invalid('opening需要实际0秒首帧，不能借用之后的画面')
  const effectiveRange = (requirement: MediaRequirement, discovery = false) => requirement.scope === 'opening' ? [0, 0]
    : requirement.scope === 'ending' ? [Number(times.at(-1) ?? requirement.startSecond), Number(times.at(-1) ?? requirement.endSecond)]
      : discovery && requirement.eventSearchRanges?.length ? [requirement.eventSearchRanges[0].startSecond,
        requirement.eventSearchRanges[0].timingConstraint.mode === 'reference' || requirement.eventSearchRanges[0].timingConstraint.deadlineSecond === undefined
          ? Number(evidence.duration) : Math.min(Number(evidence.duration), requirement.eventSearchRanges[0].endSecond)]
      : [requirement.startSecond, requirement.endSecond]
  return requirements.map(requirement => {
    const [start, end] = effectiveRange(requirement, true)
    const frameReferences = frames.flatMap((url, index) => {
      const second = Number(times[index])
      const display = displays[index]
      const selected = requirement.scope === 'opening' ? index === 0 : requirement.scope === 'ending' ? index === frames.length - 1
        : second >= start - epsilon(second, start) && second <= end + epsilon(second, end)
          || Boolean(display && display.startSecond <= end + epsilon(display.startSecond, end)
            && display.endSecond > start + epsilon(display.endSecond, start))
      return selected ? [{ index, second, url: String(url), ...(display ? { displayStartSecond: display.startSecond, displayEndSecond: display.endSecond } : {}) }] : []
    })
    const [authoredStart, authoredEnd] = effectiveRange(requirement)
    const compatibleRequirements = requirements.flatMap(other => {
      if (other.id === requirement.id) return []
      const [otherStart, otherEnd] = effectiveRange(other), overlapStartSecond = Math.max(authoredStart, otherStart), overlapEndSecond = Math.min(authoredEnd, otherEnd)
      return overlapStartSecond <= overlapEndSecond + epsilon(overlapStartSecond, overlapEndSecond)
        ? [{ ...other, overlapStartSecond, overlapEndSecond: Math.max(overlapStartSecond, overlapEndSecond) }] : []
    })
    const nativeMetadata = nativeRefs ? frameReferences.map((frame, index) => ({ evidenceIndex: index, nativeFrameIndex: nativeRefs[frame.index].nativeFrameIndex,
      url: frame.url, time: frame.second, pts: nativeRefs[frame.index].pts, timeBase: nativeRefs[frame.index].timeBase })) : undefined
    return { requirement: { ...requirement }, compatibleRequirements,
      criticalityContext: JSON.parse(JSON.stringify(criticalityContext)) as RequirementReviewInput['criticalityContext'], frameReferences,
      attachmentReferences: frameReferences.map((frame, index) => ({ index, second: frame.second,
        ...(nativeMetadata ? { nativeFrameIndex: nativeMetadata[index].nativeFrameIndex, pts: nativeMetadata[index].pts, timeBase: nativeMetadata[index].timeBase } : {}),
        ...(frame.displayStartSecond === undefined ? {} : { displayStartSecond: frame.displayStartSecond, displayEndSecond: frame.displayEndSecond,
          scopeIntersection: { startSecond: Math.max(start, frame.displayStartSecond), endSecond: Math.min(end, frame.displayEndSecond!) },
          evidenceRole: frame.second < start ? 'boundary-context' as const : 'pts-in-window' as const }) })),
      ...(nativeMetadata ? { reviewImageDetail: { transport: { mode: 'sequence-grid', columns: 2, rows: 2, format: 'jpeg', quality: 95, chromaSubsampling: '4:4:4' }, frameMetadata: nativeMetadata } } : {}),
      reviewImages: frameReferences.map(frame => frame.url), evidenceStatus: frameReferences.length ? 'available' : 'unobservable' }
  })
}

/** A derived view only: keep the primary report intact in provenance, append
 * confirmed independent defects, and never promote a decision to acceptance.
 * Embedded gates must bind validateScriptStateEvidence and validateMediaEvidenceGaps explicitly. */
export function combineIndependentMediaReviews(primaryReview: Record<string, unknown>, mappedOutput: unknown, inputs: RequirementReviewInput[], policy: { allowNoncriticalEvidenceGaps?: boolean } = {}): Record<string, unknown> {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  // Workflow inputs are JSON; its isolated VM has no host structuredClone API.
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
  const invalid = (reason: string): never => { throw Error('REVIEW_RESULT_INVALID: 独立原要求审核：' + reason + '；复核同一素材，不购买新视频') }
  if (!primaryReview || typeof primaryReview !== 'object' || Array.isArray(primaryReview)) invalid('primaryReview必须为实际综合报告对象，不能补猜或丢弃原报告')
  const errors: string[] = []
  const uncertain = (value: unknown) => typeof value === 'string' && /疑似|可能(?:是|为|存在|属于|手持|持有|有)|可能性|需(?:要)?(?:进一步)?确认|(?:无法|不能|难以|未能)\s*(?:完全\s*)?(?:确定|确认|判断|辨认|区分|排除)|不(?:明确|确定|清楚)|证据不足|看不清|\b(?:unknown|uncertain|may|might|possibly|unclear|unconfirmed)\b/i.test(value)
  const rows = Array.isArray(mappedOutput) ? mappedOutput : record(mappedOutput).items
  if (!Array.isArray(rows)) invalid('映射结果必须为items数组或数组')
  if (!Array.isArray(inputs)) invalid('缺少本次逐项原要求输入')
  const ids = new Set<string>()
  for (const [index, input] of inputs.entries()) {
    const requirement = record(record(input).requirement), refs = record(input).frameReferences
    if (!nonempty(requirement.id) || ids.has(String(requirement.id)) || !nonempty(requirement.requirementPath) || !nonempty(requirement.requirementQuote)
      || !['opening', 'interval', 'ending'].includes(String(requirement.scope)) || !Number.isFinite(requirement.startSecond) || !Number.isFinite(requirement.endSecond)
      || Number(requirement.startSecond) < 0 || Number(requirement.endSecond) < Number(requirement.startSecond)) errors.push('inputs[' + index + '] 原要求缺失、重复或范围非法')
    ids.add(String(requirement.id))
    if (!Array.isArray(refs) || refs.some(value => {
      const frame = record(value)
      return !Number.isInteger(frame.index) || Number(frame.index) < 0 || !Number.isFinite(frame.second) || Number(frame.second) < 0 || !nonempty(frame.url)
        || (frame.displayStartSecond !== undefined || frame.displayEndSecond !== undefined)
          && (frame.displayStartSecond !== frame.second || !Number.isFinite(frame.displayEndSecond) || Number(frame.displayEndSecond) < Number(frame.second))
    }) || new Set(Array.isArray(refs) ? refs.map(value => record(value).index) : []).size !== (Array.isArray(refs) ? refs.length : 0)
      || !Array.isArray(input.reviewImages) || !Array.isArray(input.attachmentReferences)
      || input.reviewImages.length !== (Array.isArray(refs) ? refs.length : 0) || input.attachmentReferences.length !== (Array.isArray(refs) ? refs.length : 0)
      || (Array.isArray(refs) && refs.some((value, index) => input.reviewImages[index] !== record(value).url || record(input.attachmentReferences[index]).index !== index || record(input.attachmentReferences[index]).second !== record(value).second
        || record(input.attachmentReferences[index]).displayStartSecond !== record(value).displayStartSecond
        || record(input.attachmentReferences[index]).displayEndSecond !== record(value).displayEndSecond))) errors.push('inputs[' + index + '] 附件与原帧映射不一致')
  }
  for (const [index, value] of (rows as unknown[]).entries()) if (!ids.has(String(record(value).requirementId))) errors.push('items[' + index + '] requirementId不属于本次原要求')
  if (primaryReview.issues !== undefined && !Array.isArray(primaryReview.issues)) errors.push('primaryReview.issues不是数组，不能丢弃原拒绝')
  if (primaryReview.defectEvidence !== undefined && !Array.isArray(primaryReview.defectEvidence)) errors.push('primaryReview.defectEvidence不是数组，不能丢弃原缺陷')
  if (primaryReview.warnings !== undefined && !Array.isArray(primaryReview.warnings)) errors.push('primaryReview.warnings不是数组，不能丢弃原提醒')
  if (errors.length) invalid(errors.join('；'))
  const view = clone(primaryReview), issues = Array.isArray(view.issues) ? view.issues : [], defects = Array.isArray(view.defectEvidence) ? view.defectEvidence : []
  const warnings = Array.isArray(view.warnings) ? view.warnings : []
  const checks: Array<Record<string, unknown>> = []
  let incomplete = false, unknown = false
  for (const input of inputs) {
    const requirement = input.requirement, matches = (rows as unknown[]).filter(value => record(value).requirementId === requirement.id), label = requirement.id
    if (matches.length !== 1) { errors.push(label + '必须恰好有一份独立审核，当前' + matches.length + '份'); continue }
    const row = record(matches[0]), errorCount = errors.length
    if (!['complete', 'incomplete', 'unobservable'].includes(String(row.status)) || !nonempty(row.evidence)) errors.push(label + '缺少合法status与实际evidence')
    if (row.warnings !== undefined && (!Array.isArray(row.warnings) || row.warnings.some(warning => !nonempty(warning)))) errors.push(label + 'warnings必须为非空文本数组，关键要求未知仍须unobservable')
    const localRefs = row.frameIndices
    if (!Array.isArray(localRefs) || new Set(localRefs).size !== localRefs.length || localRefs.some(index => !Number.isInteger(index) || Number(index) < 0 || Number(index) >= input.frameReferences.length)
      || (row.status !== 'unobservable' && !localRefs.length)) errors.push(label + 'frameIndices必须是本次附件的有效局部编号0..' + (input.frameReferences.length - 1))
    if (!input.frameReferences.length && row.status !== 'unobservable') errors.push(label + '没有该范围的原图，只能unobservable')
    if (row.status !== 'unobservable' && uncertain(row.evidence)) errors.push(label + '确定状态与不确定证据矛盾')
    const gaps = validateMediaEvidenceGaps(row, requirement, input.frameReferences.map((_, index) => index), input.criticalityContext, policy)
    errors.push(...gaps.errors.map(error => label + ' ' + error))
    if (row.status === 'incomplete') {
      if (!nonempty(row.repair) || uncertain(row.repair)) errors.push(label + '确证incomplete必须有明确局部repair')
      if (/\bASR\b|音素|同音字|错音|发音|读音|漏词|台词字形/i.test(String(row.evidence) + '\n' + String(row.repair))) errors.push(label + '图片不能证明语音或ASR缺陷，需由实际音轨与指标独立验收')
      errors.push(...validateScriptStateEvidence(requirement.requirementQuote, row.defect).map(error => label + ' incomplete需defect' + error))
    } else if (row.repair !== undefined || row.defect !== undefined) errors.push(label + '只有确证incomplete可以提供repair或defect')
    if (errors.length !== errorCount) continue
    if (Array.isArray(row.warnings)) warnings.push(...row.warnings.map(warning => requirement.id + '：' + warning))
    const frameIndices = (localRefs as number[]).map(index => input.frameReferences[index].index)
    if (row.status === 'complete') {
      // A shared frame and original obligation make these reports incompatible;
      // neither report is automatically selected as the visual truth. Separate
      // requirements, other times, and artifact/speech checks remain independent.
      for (const [index, value] of (Array.isArray(primaryReview.defectEvidence) ? primaryReview.defectEvidence : []).entries()) {
        const primary = record(value), refs = primary.frameIndices
        if (primary.status !== 'confirmed' || primary.category !== 'script' || primary.source !== 'frame'
          || primary.scope !== requirement.scope || (primary.requirementId !== undefined && primary.requirementId !== requirement.id)
          || requirement.timingBeatId !== undefined && (primary.timingBeatId !== requirement.timingBeatId || primary.sourceBeatId !== requirement.sourceBeatId)
          || typeof primary.requirementPath !== 'string' || primary.requirementPath.replace(/^(?:shot_script|shot)\./, '') !== requirement.requirementPath
          || !nonempty(primary.requirementQuote) || !requirement.requirementQuote.includes(primary.requirementQuote)) continue
        if (!Array.isArray(refs) || !refs.length || new Set(refs).size !== refs.length || refs.some(index => !Number.isInteger(index)
          || !input.frameReferences.some(frame => frame.index === index)) || !refs.some(index => frameIndices.includes(Number(index)))) continue
        if (requirement.scope === 'interval') {
          const start = Number(primary.startSecond), end = Number(primary.endSecond)
          const search = requirement.eventSearchRanges?.[0]
          const scopeStart = search?.startSecond ?? requirement.startSecond
          const scopeEnd = search ? search.timingConstraint.mode === 'reference' || search.timingConstraint.deadlineSecond === undefined
            ? Math.max(...input.frameReferences.map(frame => frame.displayEndSecond ?? frame.second)) : search.endSecond : requirement.endSecond
          const epsilon = Number.EPSILON * 8 * Math.max(1, Math.abs(start), Math.abs(end), requirement.endSecond)
          if (!Number.isFinite(primary.startSecond) || !Number.isFinite(primary.endSecond) || end < start
            || start < scopeStart - epsilon || end > scopeEnd + epsilon
            || refs.some(index => {
              const frame = input.frameReferences.find(frame => frame.index === index)!
              return (frame.second < start - epsilon || frame.second > end + epsilon)
                && !(frame.displayStartSecond !== undefined && frame.displayEndSecond !== undefined && frame.displayStartSecond <= end && frame.displayEndSecond > start)
            })) continue
        }
        errors.push(label + ' 审核分歧：独立原要求报告为complete，综合defectEvidence[' + index + ']却对同一原要求和共同实际帧'
          + JSON.stringify(refs.filter(index => frameIndices.includes(Number(index))))
          + '声称confirmed script缺陷；必须依据原图与逐字原要求共同复核，不能自动选边、改写原报告或购买重拍')
      }
    }
    const check: Record<string, unknown> = { requirementId: requirement.id, status: row.status, evidence: row.evidence, frameIndices }
    if (row.scopeNotes !== undefined) check.scopeNotes = clone(row.scopeNotes)
    if (Array.isArray(row.evidenceGaps)) check.evidenceGaps = row.evidenceGaps.map(value => {
      const gap = clone(record(value))
      gap.frameIndices = (gap.frameIndices as number[]).map(index => input.frameReferences[index].index)
      return gap
    })
    if (row.status === 'incomplete') {
      incomplete = true;check.defectIndex = defects.length
      const issueIndex = issues.length
      issues.push('原要求未完成（' + requirement.id + '）：' + row.evidence)
      defects.push({ issueIndex, status: 'confirmed', category: 'script', source: 'frame', requirementPath: requirement.requirementPath,
        requirementQuote: requirement.requirementQuote, scope: requirement.scope,
        ...(requirement.scope === 'interval' ? requirement.timingBeatId ? {
          timingBeatId: requirement.timingBeatId, sourceBeatId: requirement.sourceBeatId,
          startSecond: Math.min(...(localRefs as number[]).map(index => input.frameReferences[index].second)),
          endSecond: Math.max(...(localRefs as number[]).map(index => input.frameReferences[index].second))
        } : { startSecond: requirement.startSecond, endSecond: requirement.endSecond } : {}),
        requirementId: requirement.id, frameIndices: [...frameIndices], finding: row.evidence, repair: row.repair,
        stateEvidence: clone(row.defect), independentDefect: clone(row.defect) })
    } else if (gaps.blocking) unknown = true
    checks.push(check)
  }
  if (errors.length) invalid(errors.join('；'))
  view.issues = issues;view.defectEvidence = defects;view.requirementChecks = checks;view.warnings = warnings
  view.independentReviewProvenance = { version: 1, primaryReview: clone(primaryReview), mappedOutput: clone(mappedOutput), inputs: clone(inputs) }
  if (incomplete) { view.decision = 'rejected';view.passed = false }
  else if (unknown) {
    if (view.decision !== 'rejected' && !issues.length && !defects.some(value => record(value).status === 'confirmed')) view.decision = 'uncertain'
    view.passed = false
  }
  return view
}
