import { storyboardTimelineMatches } from './storyboard-timeline.ts'
import { isCanonicalMediaReviewPrompt } from './canonical-media-review.ts'
import { validateScriptStateEvidence } from './script-state-evidence.ts'
import { resolveNativeFrameDisplayInterval } from './media-frame-display.ts'

/** Validate each model-reported defect independently. Persisted editable gates
 * bind validateScriptStateEvidence and resolveNativeFrameDisplayInterval. */
export function validateMediaDefectEvidence(review: Record<string, unknown>, evidence: Record<string, unknown>, contract?: {
  shot?: Record<string, unknown>; metrics?: Record<string, unknown>; policy?: Record<string, unknown>
}) {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
  const errorPrefix = 'REVIEW_RESULT_INVALID: ', errorSuffix = '；保留已确证缺陷，复核同一素材，不购买新视频'
  const invalid = (reason: string): never => { throw new Error(errorPrefix + reason + errorSuffix) }
  const validationErrors: string[] = []
  // Independent diagnostics are returned together so one report-format retry
  // can correct every defect. Unexpected runtime failures must still propagate.
  const collect = (check: () => void) => {
    try { check(); return true } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith(errorPrefix) || !error.message.endsWith(errorSuffix)) throw error
      const reason = error.message.slice(errorPrefix.length, -errorSuffix.length)
      if (!validationErrors.includes(reason)) validationErrors.push(reason)
      return false
    }
  }
  const issues = Array.isArray(review.issues) ? review.issues : []
  const checks = Array.isArray(review.visualChecks) ? review.visualChecks.map(record) : []
  const visualIndexes = checks.flatMap((check, index) => check.consistent === false ? [index] : [])
  if (!issues.length && !visualIndexes.length && review.defectEvidence === undefined) return { issues: [] as string[], retryPrompt: '', uncertainDefects: [] as unknown[] }
  if (!Array.isArray(review.defectEvidence)) invalid('每个 issues 与 consistent=false 的 visualChecks 必须有逐项 defectEvidence，不能把需确认的问题当作已确证拒绝')
  const rows = review.defectEvidence as unknown[]
  const seenIssues = new Set<number>(), seenVisual = new Set<number>()
  const confirmed: string[] = [], repairs: string[] = [], uncertainDefects: unknown[] = []
  // Only inspect the finding and complaint bound to this defect. Warnings,
  // another character's occlusion and unrelated defects do not invalidate it.
  const explicitlyUncertain = (value: unknown) => typeof value === 'string' && /疑似|可能(?:是|为|存在|属于|手持|持有|有)|可能性|需(?:要)?(?:进一步)?确认|(?:无法|不能|难以|未能)\s*(?:完全\s*)?(?:确定|确认|判断|辨认|区分|排除)|不(?:明确|确定|清楚)|证据不足|看不清|\b(?:unknown|uncertain|may|might|possibly|unclear|unconfirmed)\b/i.test(value)
  const validateRequirement = (row: Record<string, unknown>, label: string) => {
    if (!contract) return
    const shot = record(contract.shot), metrics = record(contract.metrics), policy = record(contract.policy)
    if (!['script', 'visual-artifact', 'speech'].includes(String(row.category))) invalid(label + ' confirmed 需提供 category script/visual-artifact/speech，并使用该类实际验收依据')
    if (row.category === 'speech') {
      if (row.rule === 'phonetic-error-rate') {
        const rate = record(evidence.speechValidation).phoneticErrorRate, threshold = policy.maxPhoneticErrorRate
        if (!Number.isFinite(rate) || !Number.isFinite(threshold) || Number(threshold) < 0 || Number(rate) <= Number(threshold)) invalid(label + ' 实际 phoneticErrorRate 未超过配置 maxPhoneticErrorRate 或缺少该采证（实际值=' + String(rate) + '，配置阈值=' + String(threshold) + '）；ASR同音字/字形差异与覆盖率疑问不能充当确证发音或漏词缺陷')
      } else if (row.rule === 'speech-timing') {
        const speech = Array.isArray(metrics.speech) ? metrics.speech : []
        if (!Number.isInteger(row.speechIndex) || Number(row.speechIndex) < 0 || Number(row.speechIndex) >= speech.length) invalid(label + ' speech-timing 需指向实际 media_metrics.speech 的 speechIndex')
        const metric = record(speech[Number(row.speechIndex)])
        if (metric.timingAssessment !== 'outside-allowance' || !Number.isFinite(metric.elapsed) || !Number.isFinite(metric.allowedSpan) || Number(metric.elapsed) <= Number(metric.allowedSpan)) invalid(label + ' 该句实际跨度在含容差 allowedSpan 内，不能把自然语速或ASR字形差异当成拖慢')
      } else invalid(label + ' 语音拒绝需 rule phonetic-error-rate 或 speech-timing 的程序实证，不能仅比较ASR文字字形')
      return
    }
    if (row.category === 'visual-artifact') {
      const rules = ['black-frame', 'visual-deformation', 'unexpected-overlay', 'object-discontinuity', 'identity-mismatch', 'era-anachronism', 'spatial-discontinuity']
      if (!rules.includes(String(row.rule))) invalid(label + ' 通用视觉缺陷需明确 rule：' + rules.join('/') + '；特定姿态、道具或动作要求须改用script引用原要求')
      if (['object-discontinuity', 'spatial-discontinuity'].includes(String(row.rule)) && (!Array.isArray(row.frameIndices) || new Set(row.frameIndices).size < 2)) invalid(label + ' 连续性变化需至少两张不同实际帧，不能由单帧或局部裁剪证明')
      return
    }
    if (!text(row.requirementPath) || !text(row.requirementQuote)) invalid(label + ' script 缺陷需 requirementPath 和 requirementQuote 逐字绑定当前分镜要求')
    const path = String(row.requirementPath).replace(/^(?:shot_script|shot)\./, '')
    const keys = path.split('.')
    if (keys.some(key => !key || ['__proto__', 'constructor', 'prototype'].includes(key))) invalid(label + ' requirementPath 非法')
    let target: unknown = shot
    const parents: Record<string, unknown>[] = []
    for (const key of keys) {
      if (!target || typeof target !== 'object') { target = undefined; break }
      parents.push(record(target));target = (target as Record<string, unknown>)[key]
    }
    if (!text(target)) invalid(label + ' requirementPath 未指向当前分镜中的文本要求')
    const source = String(target), quote = String(row.requirementQuote)
    const at = source.indexOf(quote)
    if (at < 0 || source.indexOf(quote, at + 1) >= 0) invalid(label + ' requirementQuote 不在指定原文中或定位不唯一；请逐字引用足以唯一定位的原要求')
    // Existing custom gates opt in explicitly; a supplied contract must always
    // validate, so malformed state evidence cannot be silently ignored.
    if (policy.requireScriptStateEvidence === true || row.stateEvidence !== undefined) {
      const errors = validateScriptStateEvidence(quote, row.stateEvidence)
      if (errors.length) invalid(label + ' stateEvidence：' + errors.join('；'))
    }
    const times = Array.isArray(evidence.frameTimes) ? evidence.frameTimes : []
    const lastIndex = (Array.isArray(evidence.frames) ? evidence.frames.length : 0) - 1
    const configuredTolerance = [policy.timingTolerance, policy.timingToleranceSeconds, record(metrics.policy).timingToleranceSeconds].find(value => Number.isFinite(value))
    let tolerance = configuredTolerance === undefined ? 0 : Math.max(0, Number(configuredTolerance))
    let scope: string, start: number, end: number
    if (/^(?:lastFramePrompt|endingStatePrompt)$/.test(path)) {
      scope = 'ending';start = Number(times[lastIndex]);end = start
      if (!Array.isArray(row.frameIndices) || row.frameIndices.some(index => index !== lastIndex)) invalid(label + ' lastFramePrompt 只约束实际尾帧，不能外推到全片或中段')
    } else if (/^(?:firstFramePrompt|visualPrompt)$/.test(path)) {
      scope = 'opening';start = Number(times[0]);end = start
      if (!Array.isArray(row.frameIndices) || row.frameIndices.some(index => index !== 0)) invalid(label + ' 开场状态只约束首帧，不能凭未写放下/离开动作推断全片保持')
    } else {
      const windows = storyboardTimelineMatches(source)
      const window = windows.find((match, index) => {
        const sectionEnd = source.indexOf('【', match.index + match[0].length)
        return at >= match.index && at + quote.length <= Math.min(windows[index + 1]?.index ?? source.length, sectionEnd < 0 ? source.length : sectionEnd)
      })
      const parent = [...parents].reverse().find(value => Number.isFinite(value.startSecond) && Number.isFinite(value.endSecond))
      if (window) {
        scope = 'interval';start = Number(window[1]);end = Number(window[2])
        const pacing = record(shot.pacing)
        if (pacing.version === 'duration-v2' && path === 'videoPrompt') {
          const timeline = Array.isArray(pacing.timelineWindows) ? pacing.timelineWindows.map(record) : []
          const bindings = timeline.filter(item => item.startSecond === start && item.endSecond === end)
          if (bindings.length !== 1 || !Array.isArray(bindings[0].beatIds)) invalid(label + ' duration-v2原窗缺少生成前唯一节拍绑定')
          if ((bindings[0].beatIds as unknown[]).length) {
            const beatQuotes = Array.isArray(bindings[0].beatQuotes) ? bindings[0].beatQuotes.map(record) : []
            const boundQuotes = beatQuotes.filter(item => item.beatId === row.timingBeatId && text(item.quote) && item.quote.includes(quote))
            const beats = Array.isArray(pacing.beats) ? pacing.beats.map(record) : [], schedule = Array.isArray(pacing.schedule) ? pacing.schedule.map(record) : []
            const beat = beats.find(item => item.id === row.timingBeatId), slot = schedule.find(item => item.beatId === row.timingBeatId)
            const constraint = record(slot?.timingConstraint)
            if (boundQuotes.length !== 1 || !beat || !slot || beat.sourceBeatId !== row.sourceBeatId || slot.sourceBeatId !== row.sourceBeatId
              || !['reference', 'hard'].includes(String(constraint.mode))
              || ['mode', 'notBeforeSecond', 'deadlineSecond'].some(key => constraint[key] !== record(beat.timingConstraint)[key])) {
              invalid(label + ' duration-v2缺陷须逐字绑定单一timingBeatId/sourceBeatId的原beatQuote；不能借并行节拍扩大硬范围')
            }
            tolerance = 0
            start = constraint.mode === 'hard' ? Number(constraint.notBeforeSecond ?? 0) : 0
            end = constraint.mode === 'hard' ? Math.min(Number(evidence.duration), Number(constraint.deadlineSecond ?? evidence.duration)) : Number(evidence.duration)
            if (constraint.mode === 'reference') {
              const completion = record(review.durationCompletion), observed = Array.isArray(completion.checks)
                ? completion.checks.map(record).filter(item => item.beatId === row.timingBeatId && item.sourceBeatId === row.sourceBeatId) : []
              const began = record(observed[0]?.observedStart), finished = record(observed[0]?.observedEnd)
              if (observed.length !== 1 || !Number.isFinite(began.lower) || !Number.isFinite(finished.upper)
                || Number(began.lower) < 0 || Number(finished.upper) < Number(began.lower) || Number(finished.upper) > Number(evidence.duration)) {
                invalid(label + ' 参考窗缺陷必须绑定本节拍实际事件区间，不能用事件尚未开始前的姿态作反证')
              }
              start = Number(began.lower); end = Number(finished.upper)
            }
          }
        }
      }
      else if (parent) { scope = 'interval';start = Number(parent.startSecond);end = Number(parent.endSecond) }
      else if (/全片|全程|始终|从头到尾|throughout|entire (?:clip|shot)/i.test(quote)) { scope = 'whole-shot';start = 0;end = Number(evidence.duration) }
      else invalid(label + ' 原要求未明确持续时段；不能把未写变化过程解释成全片保持，需引用带时间窗的原动作或开场/尾帧字段')
    }
    if (row.scope !== scope!) invalid(label + ' scope 必须为原要求对应的 ' + scope! + '，不能外推要求持续范围')
    if (!Number.isFinite(start!) || !Number.isFinite(end!) || start! < 0 || end! < start! || end! > Number(evidence.duration) + tolerance) invalid(label + ' 原要求缺少有效实际范围或尾帧时刻')
    if (scope! === 'interval' || scope! === 'whole-shot' || row.startSecond !== undefined || row.endSecond !== undefined) {
      if (!Number.isFinite(row.startSecond) || !Number.isFinite(row.endSecond) || Number(row.endSecond) < Number(row.startSecond)
        || Number(row.startSecond) < start! - tolerance || Number(row.endSecond) > end! + tolerance) invalid(label + ' 声称缺陷的时间范围超出原要求 ' + start! + '–' + end! + '秒；不能从局部时段外推全片')
    }
    const evidenceStart = Number.isFinite(row.startSecond) ? Math.max(start!, Number(row.startSecond)) : start!
    const evidenceEnd = Number.isFinite(row.endSecond) ? Math.min(end!, Number(row.endSecond)) : end!
    if (!Array.isArray(row.frameIndices) || row.frameIndices.some(index => {
      if (!Number.isFinite(times[Number(index)])) return true
      const display = resolveNativeFrameDisplayInterval(evidence, Number(index))
      const inside = Number(times[Number(index)]) >= evidenceStart - tolerance && Number(times[Number(index)]) <= evidenceEnd + tolerance
      return !inside && !(scope! !== 'opening' && scope! !== 'ending' && display && display.startSecond <= evidenceEnd && display.endSecond > evidenceStart)
    })) invalid(label + ' 引用帧不在原要求与声称缺陷的实际时段内，不能借用时段外姿态证明本项失败')
  }
  for (const [index, value] of rows.entries()) {
    const row = record(value), label = 'defectEvidence[' + index + ']'
    const hasIssue = row.issueIndex !== undefined, hasVisual = row.visualCheckIndex !== undefined
    const rowErrorCount = validationErrors.length
    const structureValid = collect(() => {
      if ((!hasIssue && !hasVisual) || !['confirmed', 'uncertain'].includes(String(row.status)) || !text(row.finding)) invalid(label + ' 需绑定 issueIndex 或 visualCheckIndex，并提供 status confirmed/uncertain 与实际 finding')
    })
    const issueBindingValid = collect(() => {
      if (hasIssue && (!Number.isInteger(row.issueIndex) || Number(row.issueIndex) < 0 || Number(row.issueIndex) >= issues.length || seenIssues.has(Number(row.issueIndex)))) invalid(label + '.issueIndex 越界或重复')
    })
    const visualBindingValid = collect(() => {
      if (hasVisual && (!Number.isInteger(row.visualCheckIndex) || !visualIndexes.includes(Number(row.visualCheckIndex)) || seenVisual.has(Number(row.visualCheckIndex)))) invalid(label + '.visualCheckIndex 必须唯一绑定 consistent=false 的实际人物检查')
    })
    if (!structureValid || !issueBindingValid || !visualBindingValid) continue
    if (hasIssue) seenIssues.add(Number(row.issueIndex))
    if (hasVisual) seenVisual.add(Number(row.visualCheckIndex))
    const complaint = hasIssue ? issues[Number(row.issueIndex)] : undefined
    const visual = hasVisual ? checks[Number(row.visualCheckIndex)] : undefined
    collect(() => { if (hasIssue && !text(complaint)) invalid(label + ' 对应 issues 必须是具体问题文本') })
    if (row.status === 'uncertain') { uncertainDefects.push(value); continue }
    collect(() => {
      if ([row.finding, complaint, visual?.evidence, row.repair].some(explicitlyUncertain)) invalid(label + ' 声称 confirmed，但同一缺陷的依据明确为疑似、需确认或无法确定；应标 uncertain，不能用可能性触发重拍')
    })
    collect(() => { if (!text(row.repair)) invalid(label + ' 已确证缺陷需提供仅修复该缺陷的局部 repair') })
    collect(() => {
      if (row.source !== 'frame' && row.source !== 'asr') invalid(label + ' 已确证缺陷需指定 source frame/asr，不能用计划或猜测作采证')
      if (contract && row.category === 'speech' && row.source !== 'asr') invalid(label + ' 语音缺陷必须依据实际音轨/ASR采证，图片不能证明发音错误')
      if (contract && ['script', 'visual-artifact'].includes(String(row.category)) && row.source !== 'frame') invalid(label + ' 视觉或剧本动作缺陷必须引用实际图片，ASR不能证明手势或持物')
      if (row.source === 'frame') {
        if (!Array.isArray(row.frameIndices) || !row.frameIndices.length || new Set(row.frameIndices).size !== row.frameIndices.length
          || row.frameIndices.some(frame => !Number.isInteger(frame) || Number(frame) < 0 || Number(frame) >= (Array.isArray(evidence.frames) ? evidence.frames.length : 0))) invalid(label + ' 缺少有效实际采样帧编号')
      } else {
        const start = row.startSecond, end = row.endSecond
        const alignment = record(evidence.speechValidation).alignment
        if (!Number.isFinite(start) || !Number.isFinite(end) || Number(start) < 0 || Number(end) <= Number(start) || Number(end) > Number(evidence.duration)
          || !Array.isArray(alignment) || !(contract
            ? Math.min(...alignment.map(value => Number(record(value).actualStart))) <= Number(start) && Math.max(...alignment.map(value => Number(record(value).actualEnd))) >= Number(end)
            : alignment.some(value => { const segment = record(value); return Number(segment.actualStart) <= Number(start) && Number(segment.actualEnd) >= Number(end) }))) invalid(label + ' 缺少实际ASR对齐范围内的起止时间')
      }
    })
    // Requirement scope and measured speech thresholds do not depend on the
    // model's source field being valid; diagnose both on this same attempt.
    collect(() => validateRequirement(row, label))
    if (validationErrors.length !== rowErrorCount) continue
    if (hasIssue) confirmed.push(String(complaint))
    if (hasVisual && !hasIssue) confirmed.push(String(visual!.character) + '道具不符：' + String(visual!.evidence))
    repairs.push(String(row.repair))
  }
  collect(() => {
    if (seenIssues.size !== issues.length || visualIndexes.some(index => !seenVisual.has(index))) invalid('defectEvidence 必须逐项覆盖全部 issues 和 consistent=false 的 visualChecks，不能漏掉拒绝依据')
  })
  if (validationErrors.length) invalid(validationErrors.map((reason, index) => '(' + (index + 1) + ') ' + reason).join('；'))
  if (!confirmed.length && uncertainDefects.length) invalid('本报告全部拒绝项仍为 uncertain，缺少任何已确证质量缺陷')
  return { issues: confirmed, retryPrompt: [...new Set(repairs)].join('；'), uncertainDefects }
}

export const MEDIA_DEFECT_EVIDENCE_PROMPT = `
【逐缺陷证据与开场状态 v1】
issues 只列已确证质量缺陷；可能、疑似、需确认、无法排除的对象是 uncertain，不能仅因未能证明不存在而拒绝。未知手部状态不得伪装为确定持物或确定空手。每个 issues 及 consistent=false 的 visualChecks 必须由 defectEvidence 唯一覆盖。返回 defectEvidence:[{issueIndex:对应issues的0起索引,visualCheckIndex:同一缺陷对应visualChecks的0起索引,status:"confirmed或uncertain",source:"frame或asr",frameIndices:[实际采样帧编号],finding:"只写该缺陷实际可见/听到的确证或不确定原因",repair:"只修正该已确证缺陷的局部指令"}]；两个索引至少提供一个，同一缺陷可同时绑定两者，不适用的索引省略；ASR项用startSecond/endSecond替代frameIndices并引用实际对齐区间。每项独立判断，不能用另一人物或另一问题的证据补齐本项。没有缺陷时 defectEvidence=[]。标confirmed的同一项不能又写疑似、需确认、无法确定；未解决的疑问放warnings。若确证缺陷与不确定项并存，保留确证缺陷，不确定项不可进入重拍修复指令。
开場已存在的状态不要求在镜头开始前重演形成过程。“双手拱于胸前”“坐于案旁”等姿态或位置描述允许第一帧已经成立；仅有0–1秒时间窗并不自动要求从另一状态开始。只有候选明确写出从何状态经何动作变成何状态时才核对该变化过程；引用原动作要求，不能自行增加“从静立抬手”“先站后坐”等未写动作。真实明确要求的动作缺失仍须拒绝。
【逐缺陷证据与开场状态结束】`;

export function refreshMediaDefectEvidencePrompt(prompt: string) {
  return isCanonicalMediaReviewPrompt(prompt) || prompt.includes('【逐缺陷证据与开场状态 v1】') ? prompt : prompt + MEDIA_DEFECT_EVIDENCE_PROMPT
}

export const SCOPED_MEDIA_DEFECT_PROMPT = `
【缺陷需求范围与语音证据 v1】
每个confirmed defectEvidence还必须有category。category=script用于剧本动作、姿态、计划道具/角色等要求：提供requirementPath（当前shot_script内路径，如videoPrompt、lastFramePrompt）、requirementQuote（该字段中逐字且能唯一定位的原文）、scope=interval/opening/ending/whole-shot。视频时间轴要求必须引用其原时段，并给startSecond/endSecond限定实际缺陷范围，frameIndices仅引用该时段内的真实帧；某一时间窗要求保持某姿态，不等于全片保持。visualPrompt/firstFramePrompt只约束opening与帧0；lastFramePrompt只约束ending与最后一帧，不外推中段。未写放下动作本身不能把局部姿态升级为持续义务；原文明确写保持或尾帧仍须保持的，需按真正时段保留有证据的拒绝。
category=visual-artifact用于不依赖新增剧本要求的通用缺陷，rule允许black-frame/visual-deformation/unexpected-overlay/object-discontinuity/identity-mismatch/era-anachronism/spatial-discontinuity。物体或空间连续性变化至少引用两张不同实际帧。不得将特定剧本姿态的误差改名为通用畸变来跳过原要求绑定。
category=speech必须source=asr，rule=phonetic-error-rate时，实际speechValidation.phoneticErrorRate须超过配置maxPhoneticErrorRate；rule=speech-timing时，提供speechIndex，且对应media_metrics.speech必须为outside-allowance并实际elapsed>allowedSpan。同音字/字形识别差异、较低ASR覆盖率或词概率不能单独证明真实错音或漏词，不允许通过要求发音区分同音字来触发重拍。真正非同音发音错误/漏词造成的实际音素错误率超阈值、真实逐句拖慢仍必须拒绝。引用多句时startSecond/endSecond可以覆盖实际ASR多段范围，但不能超出首末实际对齐时刻。
【缺陷需求范围与语音证据结束】`;

export function refreshScopedMediaDefectPrompt(prompt: string) {
  return isCanonicalMediaReviewPrompt(prompt) || prompt.includes('【缺陷需求范围与语音证据 v1】') ? prompt : prompt + SCOPED_MEDIA_DEFECT_PROMPT
}
