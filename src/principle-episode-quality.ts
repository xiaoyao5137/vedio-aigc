import { principleMediaQualityRuntimeFactory, PRINCIPLE_MEDIA_RUNTIME_FACTORY_CODE } from './principle-media-quality.ts'
import { serializeRuntimeFunction } from './serialized-runtime.ts'
import { DRAMATIC_EXPRESSION_EPISODE_REVIEW_PROMPT } from './dramatic-expression.ts'

type Value = Record<string, unknown>

/** Episode review reuses the segment principle policy. Its own responsibility
 * is to bind every ordered timeline entry to the actual approved media. */
export function principleEpisodeQualityRuntimeFactory() {
  const media = principleMediaQualityRuntimeFactory()
  const obj = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
  const rows = (value: unknown): Value[] => Array.isArray(value) ? value.map(obj) : Array.isArray(obj(value).items) ? (obj(value).items as unknown[]).map(obj) : []
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
  const values = (value: unknown): unknown[] => Array.isArray(value) ? [...value] : []
  const parameters = (context: Value, params: Value) => {
    const aspect = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(text(obj(context.episode_timeline).aspectRatio))
    return { ...params, ...(aspect ? { aspectWidth: params.aspectWidth ?? Number(aspect[1]), aspectHeight: params.aspectHeight ?? Number(aspect[2]) } : {}) }
  }
  function collectEvidence(context: Value, params: Value = {}) {
    const timeline = obj(context.episode_timeline), clips = rows(timeline.clips), shots = rows(context.shot_script), videos = rows(context.video_shot)
    const missing: Value[] = [], segments: Value[] = [], warnings: unknown[] = [], principleIssues: Value[] = [], reviewImages: string[] = []
    let elapsed: number | null = 0
    if (!clips.length) missing.push({ code: 'missing_timeline', problem: '缺少实际时间线及原片引用' })
    if (!shots.length) missing.push({ code: 'missing_shots', problem: '缺少已分配分镜，不能确认时间线是否遗漏原片' })
    if (clips.length !== shots.length) missing.push({ code: 'missing_clip', problem: '时间线片段数与实际分镜数不一致', expected: shots.length, actual: clips.length })
    if (new Set(shots.map(shot => shot.id)).size !== shots.length || shots.some(shot => !text(shot.id))) missing.push({ code: 'invalid_shot_identity', problem: '实际分镜缺少唯一 id' })
    const usedUrls = new Set<string>()
    for (const [index, clip] of clips.entries()) {
      const shot = shots[index]
      if (!shot || clip.shotId !== shot.id) { missing.push({ code: 'timeline_binding', segmentIndex: index, problem: '时间线顺序或 shotId 未绑定对应已分配分镜' }); elapsed = null; continue }
      const videoUrl = text(clip.videoUrl), matches = videos.filter(video => video.url === videoUrl)
      if (!videoUrl || matches.length !== 1 || usedUrls.has(videoUrl)) { missing.push({ code: 'missing_clip', segmentIndex: index, shotId: shot.id, problem: '原片缺失、重复或存在多个同 URL 候选，不能以重复片段冒充完整时间线' }); elapsed = null; continue }
      usedUrls.add(videoUrl)
      const video = matches[0], take = obj(video.raw), pacing = obj(shot.pacing), inherited = obj(video.qualityReview)
      if (pacing.version === 'duration-v2' && (!text(pacing.scheduleHash) || obj(take.params).scheduleHash !== pacing.scheduleHash)) {
        missing.push({ code: 'schedule_binding', segmentIndex: index, shotId: shot.id, problem: '原片未绑定当前已批准排程' }); elapsed = null; continue
      }
      let measured: ReturnType<typeof media.acceptMedia>
      try {
        measured = media.acceptMedia({ shot_script: shot, video_evidence: video, video_take: take, media_review: inherited.rawReport }, parameters(context, params))
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('MEDIA_EVIDENCE_MISSING:')) throw error
        missing.push({ code: 'unusable_media', segmentIndex: index, shotId: shot.id, problem: error.message }); elapsed = null; continue
      }
      const inheritedIssues = values(inherited.principleIssues).map(obj)
      const combined = [...inheritedIssues, ...measured.qualityReview.principleIssues]
      const unique = new Set<string>()
      for (const issue of combined) {
        if (!text(issue.problem)) continue
        const key = String(issue.code) + ':' + issue.problem
        if (unique.has(key)) continue
        unique.add(key)
        principleIssues.push({ ...issue, segmentIndex: index, shotId: shot.id, videoUrl, inherited: inheritedIssues.includes(issue) })
      }
      warnings.push(...values(inherited.warnings).map(warning => ({ segmentIndex: index, warning })))
      if (video.qualityPolicy !== 'principle-v1' || !['passed', 'needs_attention', 'unavailable', 'rejected'].includes(String(inherited.status))) {
        warnings.push({ segmentIndex: index, warning: '片段没有可用的原则审核状态；保留实际媒体，详细质量未确认' })
      } else if (inherited.status !== 'passed' || inherited.canProceed !== true) {
        warnings.push({ segmentIndex: index, warning: '片段原质量状态保留为 ' + String(inherited.status) + '，不能写成详细审查通过' })
      }
      // These warnings come from the same media policy, not stricter episode
      // quotas. Missing ASR and frame timing are evidence gaps, not missing clips.
      warnings.push(...measured.qualityReview.warnings.map(warning => ({ segmentIndex: index, warning })))
      const frameUrls = values(video.frames), frameTimes = values(video.frameTimes)
      const selected = [...new Set([0, Math.floor((frameUrls.length - 1) / 2), frameUrls.length - 1])]
      const frames = selected.filter(frameIndex => text(frameUrls[frameIndex])).map(frameIndex => ({ index: frameIndex, url: frameUrls[frameIndex],
        second: Number.isFinite(frameTimes[frameIndex]) ? frameTimes[frameIndex] : null,
        episodeSecond: elapsed !== null && Number.isFinite(frameTimes[frameIndex]) ? elapsed + Number(frameTimes[frameIndex]) : null }))
      if (frames.some(frame => frame.second === null)) warnings.push({ segmentIndex: index, warning: '实际帧缺少部分时间定位，时间相关细项仍未知' })
      const transcript = rows(video.transcript).filter(row => text(row.text)).map(row => ({ text: row.text,
        start: Number.isFinite(row.start) ? row.start : null, end: Number.isFinite(row.end) ? row.end : null }))
      reviewImages.push(...frames.map(frame => String(frame.url)))
      segments.push({ index, shotId: shot.id, videoUrl, evidenceUrl: video.evidenceUrl, duration: video.duration, startSecond: elapsed,
        frames, transcript, audioMode: video.audioMode ?? (shot.audioType === '环境声' ? 'ambient' : 'speech'), hasAudio: video.hasAudio,
        qualityPolicy: video.qualityPolicy ?? null, qualityReview: video.qualityReview ?? null,
        script: { videoPrompt: shot.videoPrompt ?? '', audioText: shot.audioText ?? '' } })
      if (elapsed !== null) elapsed += Number(video.duration)
    }
    const complete = clips.length > 0 && shots.length === clips.length && segments.length === clips.length && missing.length === 0
    return { version: 'principle-episode-evidence-v1', qualityPolicy: 'principle-v1', status: complete ? 'ready' : 'blocked',
      shouldReview: segments.length > 0, complete, expectedClips: shots.length, actualClips: segments.length, segments, reviewImages,
      missing, principleIssues, warnings, totalDuration: complete ? elapsed : null,
      scope: 'ordered-sampled-frames-and-actual-asr', fullVideoWatched: false, renderedEpisodeVerified: false, plannedTranscriptUsed: false }
  }

  function acceptEpisode(context: Value, params: Value = {}) {
    const manual = params.qualityDisposition === 'manual-review-v1'
    // Do not trust a stale evidence object's complete=true or an old review:
    // binding is derived again from the current timeline and original clips.
    const e = collectEvidence(context, params), rawReport = context.episode_dramaturgy_review ?? null
    let parsed = rawReport
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) } catch { parsed = null } }
    const review = obj(parsed), warnings = [...e.warnings, ...values(review.warnings)], principleIssues = [...e.principleIssues]
    const valid = review.version === 'principle-review-v1' && ['pass', 'revise', 'uncertain'].includes(String(review.decision)) && Array.isArray(review.issues) && Array.isArray(review.warnings)
    if (!valid) warnings.push('整集审核报告缺失或格式不可用；不阻断可用素材，保留未审看状态并允许按需重试本审核节点')
    const suppliedEvidence = obj(context.episode_review_evidence)
    const mediaIdentity = (segments: Value[]) => JSON.stringify(segments.map(segment => ({ index: segment.index, shotId: segment.shotId, videoUrl: segment.videoUrl,
      evidenceUrl: segment.evidenceUrl, frames: rows(segment.frames).map(frame => ({ index: frame.index, url: frame.url })), transcript: segment.transcript })))
    const reportCurrent = !Object.keys(suppliedEvidence).length || mediaIdentity(rows(suppliedEvidence.segments)) === mediaIdentity(e.segments)
    if (!reportCurrent) warnings.push('本次时间线或实际素材已变化，旧整集报告不用于判定新原片，保留为待复核记录')
    const shots = rows(context.shot_script), videos = rows(context.video_shot)
    for (const row of reportCurrent ? rows(review.issues) : []) {
      const index = row.segmentIndex, segment = e.segments.find(item => item.index === index), proof = obj(row.evidence)
      const frameIndices = values(proof.frameIndices), availableFrames = rows(segment?.frames).map(frame => frame.index)
      const frameBound = proof.source !== 'frame' || (frameIndices.length > 0 && frameIndices.every(frameIndex => availableFrames.includes(frameIndex)))
      if (!Number.isInteger(index) || !segment || !frameBound) {
        warnings.push({ problem: '整集意见未绑定当前片段或本次实际提供的采样帧，只保留建议', reportedIssue: row }); continue
      }
      const video = videos.find(item => item.url === segment.videoUrl)!
      const checked = media.acceptMedia({ shot_script: shots[Number(index)], video_evidence: video, video_take: video.raw,
        media_review: { ...review, issues: [row], warnings: [] } }, parameters(context, params))
      const acceptedIssue = checked.qualityReview.principleIssues.find(issue => issue.code === row.code && issue.problem === row.problem && issue.repair === row.repair)
      if (acceptedIssue) principleIssues.push({ ...acceptedIssue, segmentIndex: index, shotId: segment.shotId, videoUrl: segment.videoUrl, inherited: false })
      else warnings.push({ problem: '整集意见不是有实际证据的原则错误，只保留建议', reportedIssue: row })
    }
    if (review.decision === 'uncertain') warnings.push('整集细节仍有未知，未宣称连续看过全部成片')
    if (review.decision === 'revise' && !principleIssues.length) warnings.push('编辑和叙事建议可按需回到对应节点处理，不自动重拍整集')
    if (review.fullVideoWatched === true || (review.scope !== undefined && review.scope !== e.scope)) warnings.push('原报告宣称的观看范围没有实际连续播放证据，输出保持抽帧范围')
    if (manual) warnings.push({ code: 'manual_review_required', problem: '整集质量由用户自主验收；保留各片段问题，可选择局部重做，不自动重拍', reportedIssues: principleIssues })
    const canProceed = e.complete && (manual || principleIssues.length === 0)
    const status = !e.complete ? 'blocked' : !manual && principleIssues.length ? 'rejected' : !valid ? 'unavailable' : manual || warnings.length || review.decision !== 'pass' ? 'needs_attention' : 'passed'
    return { version: 'principle-episode-review-v1', qualityPolicy: 'principle-v1', qualityDisposition: manual ? 'manual-review-v1' : 'strict-v1', passed: canProceed, status, complete: e.complete,
      qualityReview: { status, canProceed, principleIssues, warnings, rawReport, manualReviewRequired: manual, automaticRetakeAllowed: !manual },
      label: !e.complete ? '时间线或原片未完整可用' : manual ? '素材可用，质量待用户验收' : principleIssues.length ? '有已证实原则问题，待局部处理' : '片段素材可继续使用，整集未连续审看',
      issues: principleIssues, warnings, missing: e.missing, segments: e.segments,
      actualClips: e.actualClips, expectedClips: e.expectedClips, totalDuration: e.totalDuration,
      scope: e.scope, fullVideoWatched: false, renderedEpisodeVerified: false, plannedTranscriptUsed: false, automaticReshoot: false,
      reviewSummary: { segmentTechnical: e.complete ? 'usable' : 'incomplete', segmentQuality: e.segments.map(segment => ({ index: segment.index, shotId: segment.shotId, qualityReview: segment.qualityReview })),
        episodePlayback: 'not-reviewed', fullVideoWatched: false } }
  }
  return { collectEvidence, acceptEpisode }
}

export const { collectEvidence: collectPrincipleEpisodeEvidence, acceptEpisode: acceptPrincipleEpisodeQuality } = principleEpisodeQualityRuntimeFactory()
const runtime = serializeRuntimeFunction(principleEpisodeQualityRuntimeFactory, [{ dependency: principleMediaQualityRuntimeFactory, expression: PRINCIPLE_MEDIA_RUNTIME_FACTORY_CODE }])
  .replace(/\$\{([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\}/g, (_match, expression: string) => '${(' + expression + ')}')
export const PRINCIPLE_EPISODE_EVIDENCE_CODE = 'return ' + runtime + '().collectEvidence(context,params);'
export const PRINCIPLE_EPISODE_ACCEPT_CODE = 'const episodeResult = ' + runtime + `().acceptEpisode(context,params);
return episodeResult.passed ? episodeResult : {...episodeResult,routeError:'EPISODE_PRINCIPLE_BLOCKED: '+JSON.stringify(episodeResult.missing.length?episodeResult.missing:episodeResult.issues)};`

export const PRINCIPLE_EPISODE_REVIEW_PROMPT = `【整集原则审查 v1】
沿本次提供的有序实际抽帧与ASR查看，只指出足以阻止使用且有实际证据的原则问题。各片段原 qualityReview 是既有判定，必须保留；needs_attention、unavailable 不等于失败。仅可用这些错误代码：wrong_character、missing_main_character、historical_era、core_event_contradiction、unusable_picture、missing_or_wrong_speech。问题必须定位当前 segmentIndex、该段本次提供的实际帧 index 或实际ASR逐字原文；不能引用未提供帧、计划台词或别段素材充当实测。
叙事漂亮程度、节奏、微表情、逐场细项缺证、普通重复感、结尾余韵、抽帧看不清的动作都写 warnings，不要求每片再填完整报告。source=frame 的 frameIndices 是该片段 frames.index，不是附件总编号；source=asr 的 quote 只能来自该片段 transcript.text。core_event_contradiction 另须 path=videoPrompt或audioText，quote 精确引用该段 script 的原要求，finding 说明实际声画如何明确相反。未知写 uncertain，禁止把没采到当确定缺失。
本任务只有抽帧和ASR，fullVideoWatched 必须为 false，scope 必须为 ordered-sampled-frames-and-actual-asr。不能宣称整集连续播放通过、完成最终合成验证或逐帧口型验证。时间线缺片时仍只评价已有素材。所有意见供局部处理，不自动重拍整集。
返回 JSON {"version":"principle-review-v1","decision":"pass或revise或uncertain","issues":[{"segmentIndex":0,"code":"上述原则代码","problem":"明确原则问题","repair":"保留其余剧情和原片的局部处理","evidence":{"source":"frame或asr","frameIndices":[0],"finding":"实际反证","path":"核心事件必填本段脚本文字路径","quote":"对应实际ASR或核心事件脚本原文"}}],"warnings":[],"fullVideoWatched":false,"scope":"ordered-sampled-frames-and-actual-asr"}。
${DRAMATIC_EXPRESSION_EPISODE_REVIEW_PROMPT}
本次实际素材及每片原判定：\${episode_review_evidence}
【整集原则审查结束】`
