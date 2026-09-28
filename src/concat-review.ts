import { assessAudioVisualEventEvidence } from './audio-visual-event-evidence.ts'
import { deriveAudioSourceProvenance } from './audio-source-provenance.ts'
import { assessPrincipleSubtitleEvidence } from './principle-media-quality.ts'
type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const url = (value: unknown): string => typeof value === 'string' ? value : String(object(value).url ?? '')
const unknownVoice = (): Value => ({ status: 'uncertain', method: 'not-reviewed', note: '此原片没有可追踪的逐片声音审查记录，不能从后续片段推定通过。' })
const unknownQuality = (): Value => ({ status: 'unavailable', scope: 'original-clip', note: '旧前缀未保存逐片质量记录；媒体保留，质量未知。' })

/** Enforce the current clip's declared output requirement. Previous concat
 * prefixes keep their historical reviews and do not acquire a new obligation. */
export function assertConcatSubtitleEvidence(params: Value, actualClips?: unknown[]) {
  const configuredPolicy = (value: Value) => {
    if (!Object.hasOwn(value, 'subtitlePolicy')) return undefined
    if (value.subtitlePolicy !== 'none' && value.subtitlePolicy !== 'allow') throw Error('SUBTITLE_POLICY_INVALID: subtitlePolicy 仅支持 none 或 allow；请修正配置')
    return value.subtitlePolicy
  }
  const globalPolicy = configuredPolicy(params)
  const append = (value: unknown) => {
    if (value === undefined || value === null || value === '') return
    if (Array.isArray(value)) { value.forEach(append); return }
    const source = object(value)
    if (Array.isArray(source.items) && !url(value)) { source.items.forEach(append); return }
    // A previous assembly is an historical manifest, not a newly reviewed clip.
    if (Array.isArray(source.clips)) return
    const policy = configuredPolicy(source) ?? configuredPolicy(object(source.params))
      ?? configuredPolicy(object(object(source.raw).params)) ?? configuredPolicy(object(source.qualityReview)) ?? globalPolicy
    if (policy !== 'none') return
    const quality = object(source.qualityReview), report = object(quality.rawReport)
    const assessment = object(source.subtitleAssessment ?? quality.subtitleAssessment)
    const valid = report.version === 'principle-review-v1' && ['pass', 'revise', 'uncertain'].includes(String(report.decision)) && Array.isArray(report.issues)
    const checked = assessPrincipleSubtitleEvidence(source, report, valid)
    const actual = actualClips?.filter(clip => url(clip) === url(source))
    const changedBytes = actualClips !== undefined && (actual?.length !== 1 || typeof source.sha256 !== 'string'
      || object(actual[0]).sha256 !== source.sha256)
    if (source.decoded !== true || !url(source) || typeof source.evidenceUrl !== 'string' || !source.evidenceUrl
      || source.originalUrl !== object(source.raw).url || !source.originalUrl || source.passed !== true || quality.canProceed !== true
      || assessment.policy !== 'none' || assessment.status !== 'clear' || assessment.canProceed !== true
      || assessment.evidenceUrl !== source.evidenceUrl || JSON.stringify(assessment.frameIndices) !== JSON.stringify(checked.frameIndices)
      || checked.status !== 'clear' || changedBytes) {
      throw Error('VIDEO_CONCAT_SUBTITLE_REJECTED: 当前无字幕片段缺少绑定当前素材的明确无字幕验收；复核或清除同一原片字幕后再拼接：' + url(source))
    }
  }
  append(params.videos)
  append(params.currentVideo)
}

/** Only already-evidenced technical speech defects block. Unverified ASR,
 * voice identity and lip movement remain warnings, including in old prefixes. */
export function concatSpeechEvidenceBlockers(params: Value): Array<Value & { segmentIndex: number; videoUrl: string }> {
  const sources: Array<{ videoUrl: string; source: Value }> = []
  let enforced = params.speechEvidencePolicy === 'enforce-evidenced-v1'
  const append = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(append); return }
    const source = object(value)
    if (source.speechEvidencePolicy === 'enforce-evidenced-v1') enforced = true
    if (Array.isArray(source.clips)) {
      source.clips.forEach((clip, index) => {
        const prior = object(array(source.clipReviews)[index])
        const stale = typeof prior.sourceSha256 === 'string' && typeof object(clip).sha256 === 'string' && prior.sourceSha256 !== object(clip).sha256
        const matched = prior.videoUrl === url(clip) ? stale ? { targetedRepairAssessment: prior.targetedRepairAssessment } : prior : {}
        if (matched.speechEvidencePolicy === 'enforce-evidenced-v1') enforced = true
        sources.push({ videoUrl: url(clip), source: matched })
      })
    } else if (Array.isArray(source.items) && !url(value)) source.items.forEach(append)
    else if (url(value)) sources.push({ videoUrl: url(value), source })
  }
  append(params.videos); append(params.previousVideo); append(params.currentVideo)
  if (!enforced) return []
  return sources.flatMap(({ source, videoUrl }, segmentIndex) => {
    const assessed = assessAudioVisualEventEvidence({ ...source, url: videoUrl }, source.audioVisualEventReviews, source.targetedRepairAssessment)
    const issues = [...array(object(source.technicalValidation).issues), ...array(object(source.qualityReview).principleIssues), ...assessed.issues]
    const unique = new Set<string>()
    return issues.map(object).filter(issue => {
      const evidence = object(issue.evidence), code = String(issue.code ?? '')
      const technicalSource = ({ missing_audio: 'probe', wrong_speech: 'asr', inaudible_speech: 'audio', unexpected_speech: 'asr' } as Record<string, string>)[code]
      const verifiedEvent = assessed.issues.includes(issue)
      const key = code + ':' + String(evidence.eventId ?? evidence.targetId ?? '')
      if ((!verifiedEvent && (!technicalSource || evidence.source !== technicalSource)) || evidence.recognitionConfidence === 'unverified' || unique.has(key)) return false
      unique.add(key); return true
    }).map(issue => ({ segmentIndex, videoUrl, ...issue }))
  })
}

export function assertConcatSpeechEvidence(params: Value) {
  const blockers = concatSpeechEvidenceBlockers(params)
  if (blockers.length) throw Error('VIDEO_CONCAT_SPEECH_REJECTED: 语音或声画问题尚未解决，须复核修复后拼接：' + blockers.map(issue =>
    '第' + (Number(issue.segmentIndex) + 1) + '片 ' + issue.code + '（' + issue.videoUrl + '）：' + String(issue.problem ?? '')).join('；'))
}

/** A concat operation proves assembly only. Preserve each source's own evidence;
 * even individually passed clips do not prove a whole-episode listening pass. */
export function aggregateConcatReviews(params: Value, outputClips: unknown[]) {
  assertConcatSubtitleEvidence(params, outputClips)
  const inputs: Array<{ videoUrl: string; source: Value }> = []
  const unscopedWarnings: unknown[] = []
  const append = (value: unknown) => {
    if (value === undefined || value === null || value === '') return
    if (Array.isArray(value)) { value.forEach(append); return }
    const source = object(value)
    if (Array.isArray(source.clips)) {
      unscopedWarnings.push(...array(Array.isArray(source.clipReviews) ? source.unscopedQualityWarnings : source.qualityWarnings))
      source.clips.forEach((clip, index) => {
        const prior = object(array(source.clipReviews)[index])
        inputs.push({ videoUrl: url(clip), source: prior.videoUrl === url(clip) ? prior : {} })
      })
    } else if (Array.isArray(source.items) && !url(value)) source.items.forEach(append)
    else inputs.push({ videoUrl: url(value), source })
  }
  append(params.videos); append(params.previousVideo); append(params.currentVideo)
  const clipReviews = outputClips.map((clip, index) => {
    const candidate = inputs[index]?.videoUrl === url(clip) ? inputs[index].source : {}
    const expectedHash = candidate.sourceSha256 ?? candidate.sha256
    const changedBytes = typeof expectedHash === 'string' && typeof object(clip).sha256 === 'string' && expectedHash !== object(clip).sha256
    // Playback conclusions expire with the bytes. An explicit user repair
    // target remains unresolved until the replacement has its own evidence.
    const source = changedBytes ? { targetedRepairAssessment: candidate.targetedRepairAssessment } : candidate
    const metadata: Value = {}
    for (const key of ['generationScopeId', 'requestScopeId', 'voiceExecutionId', 'requestKey', 'qualityDisposition', 'subtitlePolicy', 'subtitleAssessment', 'speechEvidencePolicy', 'blockingSpeechIssues', 'characterVoices', 'nativeGroupVoices', 'voiceManifest', 'audioEvidenceAssessment', 'audioVisualEventReviews', 'audioVisualEvidenceAssessment', 'targetedRepairAssessment', 'pronunciationAssessment', 'technicalValidation', 'duration', 'shotId', 'hasAudio', 'meanVolumeDb']) {
      if (source[key] !== undefined) metadata[key] = source[key]
    }
    // Keep compact speech findings with their actual source clip. ASR success
    // says nothing about voice identity, and a later clip cannot repair a
    // previous line's missing or uncertain evidence.
    if (source.speechValidation !== undefined) {
      const speech = object(source.speechValidation)
      metadata.speechValidation = Object.fromEntries(['passed', 'method', 'issues', 'warnings', 'phoneticErrorRate', 'phoneticErrorRateMeaning', 'pronunciationAssessment', 'lastSpeechEnd', 'dialogueCompletenessVerified', 'lipSyncVerified']
        .filter(key => speech[key] !== undefined).map(key => [key, speech[key]]))
    }
    if (Array.isArray(source.transcript)) metadata.transcript = source.transcript.map(value => {
      const item = object(value)
      return { start: item.start, end: item.end, text: item.text }
    })
    return { index, videoUrl: url(clip), ...(object(clip).sha256 ? { sourceSha256: object(clip).sha256 } : {}), ...metadata,
      audioSource: deriveAudioSourceProvenance(source),
      voiceConsistency: Object.keys(object(source.voiceConsistency)).length ? object(source.voiceConsistency) : unknownVoice(),
      qualityReview: Object.keys(object(source.qualityReview)).length ? object(source.qualityReview) : unknownQuality(),
      qualityWarnings: changedBytes ? [{ code: 'source_bytes_changed', problem: '同一地址的视频字节已变化，旧声音及质量审查不能证明当前素材。', previousSha256: expectedHash, sourceSha256: object(clip).sha256 }] : array(source.qualityWarnings),
    }
  })
  const qualityWarnings = [...unscopedWarnings, ...clipReviews.flatMap(clip => [
    ...clip.qualityWarnings.map(warning => ({ segmentIndex: clip.index, warning })),
    ...array(clip.qualityReview.warnings).map(warning => ({ segmentIndex: clip.index, warning })),
  ])]
  const principleIssues = clipReviews.flatMap(clip => array(clip.qualityReview.principleIssues).map(issue => ({ segmentIndex: clip.index, issue })))
  const scope: Value = {}
  for (const key of ['generationScopeId', 'requestScopeId', 'voiceExecutionId', 'requestKey']) {
    const value = params[key] ?? object(params.currentVideo)[key]
    if (value !== undefined) scope[key] = value
  }
  const manual = params.qualityDisposition === 'manual-review-v1' || clipReviews.some(clip => object(clip).qualityDisposition === 'manual-review-v1')
  const enforced = params.speechEvidencePolicy === 'enforce-evidenced-v1' || object(params.previousVideo).speechEvidencePolicy === 'enforce-evidenced-v1' || clipReviews.some(clip => object(clip).speechEvidencePolicy === 'enforce-evidenced-v1')
  const blockingSpeechIssues = concatSpeechEvidenceBlockers({ speechEvidencePolicy: enforced ? 'enforce-evidenced-v1' : undefined, videos: clipReviews.map(clip => ({ ...clip, url: clip.videoUrl })) })
  const speechPolicy = enforced ? { speechEvidencePolicy: 'enforce-evidenced-v1', blockingSpeechIssues } : {}
  return { ...scope, ...speechPolicy, clipReviews, qualityWarnings, unscopedQualityWarnings: unscopedWarnings,
    ...(manual ? { qualityDisposition: 'manual-review-v1', manualReviewRequired: true } : {}),
    voiceConsistency: { status: 'uncertain', method: 'segment-review-aggregate', scope: 'individual-source-clips', fullVideoListened: false,
      clipCount: clipReviews.length,
      individuallyListenedCount: clipReviews.filter(clip => clip.voiceConsistency.method === 'user-listening' && clip.voiceConsistency.status === 'passed').length,
      unknownClipCount: clipReviews.filter(clip => clip.voiceConsistency.method === 'not-reviewed').length,
      pendingClipCount: clipReviews.filter(clip => clip.voiceConsistency.status !== 'passed').length,
      note: '保留逐片声音证据；累计视频未完成整段听审，当前片段通过不能代表全部原片通过。' },
    qualityReview: { status: blockingSpeechIssues.length ? 'rejected' : 'needs_attention', canProceed: blockingSpeechIssues.length === 0, scope: 'individual-source-clips', fullVideoWatched: false, ...speechPolicy,
      manualReviewRequired: true, principleIssues, warnings: qualityWarnings,
      note: '原片已拼接，逐片质量记录保留；累计成片质量未宣称通过。' },
  }
}
