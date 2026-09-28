type Value = Record<string, unknown>

/** This validates review provenance and scope; it never manufactures a hearing
 * or playback result. Kept self-contained for persisted code-node runtimes. */
export function audioVisualEventEvidenceRuntimeFactory() {
  const obj = (v: unknown): Value => v && typeof v === 'object' && !Array.isArray(v) ? v as Value : {}
  const rows = (v: unknown): Value[] => Array.isArray(v) ? v.map(obj) : v && typeof v === 'object' ? [obj(v)] : []
  const text = (v: unknown): v is string => typeof v === 'string' && Boolean(v.trim())
  const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{64}$/i.test(v)
  const range = (v: Value, duration: unknown) => number(v.startSecond) && number(v.endSecond) && v.startSecond >= 0
    && v.endSecond > v.startSecond && number(duration) && v.endSecond <= duration + .001
  const covers = (outer: Value, inner: Value) => number(outer.startSecond) && number(outer.endSecond)
    && number(inner.startSecond) && number(inner.endSecond) && outer.startSecond <= inner.startSecond && outer.endSecond >= inner.endSecond
  const userReport = (v: unknown) => text(obj(v).reference) && text(obj(v).quote)
  const currentHash = (media: Value) => media.sha256 ?? media.sourceSha256
  const bound = (review: Value, media: Value) => text(media.url) && review.videoUrl === media.url && sha(currentHash(media))
    && sha(review.sha256) && String(review.sha256).toLowerCase() === String(currentHash(media)).toLowerCase()
    && number(review.duration) && number(media.duration) && Math.abs(review.duration - media.duration) <= .05
  const normalized = (value: unknown) => typeof value === 'string' ? value.replace(/[\s，。！？、；：,.!?;:]/g, '') : ''
  const project = (value: unknown, keys: string[]) => Object.fromEntries(keys.filter(key => obj(value)[key] !== undefined).map(key => [key, obj(value)[key]]))
  const voiceAsset = (value: unknown) => {
    const keys = ['characterId', 'characterName', 'voiceId', 'originalVoiceId', 'version', 'referenceHash', 'elementId']
    return { ...project(value, keys), ...(Object.keys(obj(obj(value).videoBinding)).length ? { videoBinding: project(obj(value).videoBinding, keys) } : {}) }
  }
  /** Portable, bounded raw proof for concat/import revalidation. This copies
   * collector evidence; it does not grant approval or invent visual findings. */
  function buildRequiredSpeechPresenceEvidence(context: Value, visualReview: unknown) {
    const e = obj(context.video_evidence), take = obj(context.video_take), speech = obj(e.speechValidation)
    return { version: 'required-speech-presence-v1', videoUrl: e.url, sha256: currentHash(e), duration: e.duration, sourceTakeUrl: take.url, originalUrl: e.originalUrl,
      ...project(e, ['decoded', 'evidenceUrl', 'hasAudio', 'meanVolumeDb']),
      plannedSpeechWindows: rows(obj(obj(context.shot_script).pacing).speechWindows),
      transcript: rows(e.transcript).map(segment => ({ ...project(segment, ['start', 'end', 'text']),
        words: rows(segment.words).map(word => project(word, ['start', 'end', 'word', 'probability'])) })),
      speechValidation: { ...project(speech, ['passed', 'issues', 'phoneticErrorRate', 'dialogueCompletenessVerified']),
        alignment: rows(speech.alignment).map(row => project(row, ['planned', 'actualStart', 'actualEnd', 'matchedStart', 'matchedEnd',
          'alignmentCoverage', 'firstTokenMatched', 'lastTokenMatched', 'boundaryEvidenceVersion', 'boundaryStatus', 'boundaryUncertaintyReasons',
          'utteranceCandidateStart', 'utteranceCandidateEnd'])) },
      characterVoices: rows(take.characterVoices).map(voiceAsset), voiceManifest: { characters: rows(obj(take.voiceManifest).characters).map(voiceAsset) },
      requestVoiceAssets: rows(obj(take.params).voiceAssets).map(voiceAsset), visualReview,
    }
  }
  function requiredSpeechPresence(media: Value, value: unknown, actorId: unknown, interval: Value) {
    const e = obj(value), reasons: string[] = [], speech = obj(e.speechValidation), windows = rows(e.plannedSpeechWindows)
    const alignment = rows(speech.alignment), transcript = rows(e.transcript), visual = obj(e.visualReview)
    const fail = (condition: unknown, reason: string) => { if (!condition) reasons.push(reason) }
    fail(e.version === 'required-speech-presence-v1' && bound(e, media), 'speech-presence-proof-not-bound-to-current-media')
    fail(text(e.sourceTakeUrl) && e.sourceTakeUrl === e.originalUrl, 'voice-request-not-bound-to-decoded-take')
    fail(e.decoded === true && text(e.evidenceUrl) && e.hasAudio === true && number(e.meanVolumeDb) && e.meanVolumeDb > -50, 'decoded-audible-track-not-established')
    // This scope establishes speech presence, not a word-perfect reading.
    // Interior phonetic uncertainty may remain; missing first/last words or
    // uncertain timing cannot be used to certify the target interval.
    fail(number(speech.phoneticErrorRate) && speech.phoneticErrorRate <= .2, 'required-speech-phonetic-correspondence-insufficient')
    fail(windows.length > 0 && windows.length === alignment.length, 'planned-and-measured-line-count-mismatch')
    const actorLines: Value[] = [], speechIntervals: Value[] = [], spans = new Set<string>()
    let lastEnd = -1
    windows.forEach((window, index) => {
      const row = obj(alignment[index]), planned = obj(row.planned), start = row.matchedStart ?? row.actualStart, end = row.matchedEnd ?? row.actualEnd
      const actors = Array.isArray(window.actorIds) ? window.actorIds : []
      fail(normalized(window.text) && normalized(window.text) === normalized(planned.text) && JSON.stringify(actors) === JSON.stringify(planned.actorIds)
        && actors.length > 0 && (!window.beatId || window.beatId === planned.beatId)
        && (!window.sourceBeatId || window.sourceBeatId === planned.sourceBeatId), 'speech-line-plan-or-actor-unbound')
      const boundaryReasons = Array.isArray(row.boundaryUncertaintyReasons) ? row.boundaryUncertaintyReasons : undefined
      fail(number(row.alignmentCoverage) && row.alignmentCoverage >= .8 && row.firstTokenMatched === true && row.lastTokenMatched === true && row.boundaryEvidenceVersion === 2
        && boundaryReasons && (row.boundaryStatus === 'reliable' && !boundaryReasons.length
          || row.boundaryStatus === 'uncertain' && boundaryReasons.length > 0 && boundaryReasons.every(reason => reason === 'partial-phonetic-alignment')),
      'speech-line-presence-or-boundaries-unverified')
      const actual = { startSecond: start, endSecond: end }, span = String(start) + ':' + String(end)
      fail(range(actual, media.duration) && Number(start) >= lastEnd - .15 && !spans.has(span), 'speech-line-times-reused-or-out-of-order')
      if (number(end)) lastEnd = Math.max(lastEnd, end)
      spans.add(span)
      fail(number(row.utteranceCandidateStart) && number(row.utteranceCandidateEnd) && number(start) && number(end)
        && Math.abs(row.utteranceCandidateStart - start) <= .15 && Math.abs(row.utteranceCandidateEnd - end) <= .15, 'speech-candidate-boundaries-disagree')
      const words = transcript.flatMap(segment => rows(segment.words)).filter(word => number(word.start) && number(word.end)
        && word.end > Number(start) && word.start < Number(end))
      const probabilities = words.map(word => word.probability), spoken = words.map(word => normalized(word.word)).join('')
      const validWords = words.length && words.every(word => normalized(word.word) && number(word.start) && number(word.end) && word.end > word.start
        && word.start >= Number(start) - .15 && word.end <= Number(end) + .15 && number(word.probability) && word.probability >= 0 && word.probability <= 1)
      const average = probabilities.reduce<number>((sum, probability) => sum + Number(probability), 0) / probabilities.length
      const minimum = Math.min(...probabilities.map(Number))
      fail(validWords && spoken.length >= 2 && (average >= .78 && minimum >= .55 || spoken.length >= 4 && average >= .68 && minimum >= .45)
        && Math.abs(Number(words[0]?.start) - Number(start)) <= .15 && Math.abs(Number(words.at(-1)?.end) - Number(end)) <= .15,
      'credible-timed-asr-words-not-established')
      if (actors.includes(actorId)) {
        actorLines.push(actual)
        // An utterance can contain a long silent gap. Do not let its enclosing
        // first/last word range certify continuously speaking visuals there.
        for (const word of words) {
          const previous = speechIntervals.at(-1)
          if (previous && Number(word.start) - Number(previous.endSecond) <= .3) previous.endSecond = word.end
          else speechIntervals.push({ startSecond: word.start, endSecond: word.end })
        }
      }
    })
    fail(actorLines.length > 0, 'target-actor-has-no-required-speech')
    const forActor = (assets: unknown) => rows(assets).filter(asset => asset.characterName === actorId || asset.characterId === actorId)
    const asset = forActor(e.characterVoices), manifest = forActor(obj(e.voiceManifest).characters), requests = forActor(e.requestVoiceAssets)
    const requested = requests.map(request => Object.keys(obj(request.videoBinding)).length ? obj(request.videoBinding) : request)
    fail(asset.length === 1 && manifest.length === 1 && requested.length === 1 && text(asset[0]?.voiceId) && sha(asset[0]?.referenceHash)
      && number(asset[0]?.version) && asset[0].version >= 1 && [manifest[0], requested[0]].every(candidate => candidate
        && candidate.voiceId === asset[0].voiceId && candidate.referenceHash === asset[0].referenceHash && candidate.version === asset[0].version),
    'target-actor-frozen-request-voice-binding-unverified')
    fail(bound(visual, media) && visual.method === 'agent-continuous-visual-review' && obj(visual.reviewer).kind === 'agent'
      && text(obj(visual.reviewer).id) && text(visual.reviewedAt) && Number.isFinite(Date.parse(String(visual.reviewedAt)))
      && Array.isArray(visual.evidenceRefs) && visual.evidenceRefs.length && visual.evidenceRefs.every(text), 'continuous-visual-review-provenance-missing')
    const coverage = obj(visual.coverage)
    fail(range(coverage, media.duration) && covers(coverage, interval) && visual.actorId === actorId
      && visual.completeness === 'all-visible-speech-intervals' && text(visual.finding)
      && (coverage.method === 'continuous-video' && coverage.videoWatched === true
        || coverage.method === 'continuous-frame-sequence' && number(coverage.maxFrameGapSeconds) && coverage.maxFrameGapSeconds > 0 && coverage.maxFrameGapSeconds <= .1),
    'continuous-target-visual-coverage-not-established')
    const speaking = rows(visual.speakingIntervals)
    // A visual performance edge and an ASR word edge are different evidence.
    // The presence-only policy permits a bounded transition; it is deliberately
    // not a lip-sync tolerance or a claim that the uncovered edge is silent.
    const maximumEdgeUncertaintySeconds = .25, minimumSpeechOverlap = .8
    const visualSpeechCoverage = speaking.map(window => {
      const matches = speechIntervals.map(line => {
        const overlap = Math.max(0, Math.min(Number(line.endSecond), Number(window.endSecond)) - Math.max(Number(line.startSecond), Number(window.startSecond)))
        return { speechInterval: line, overlapRatio: overlap / (Number(window.endSecond) - Number(window.startSecond)),
          leadingUncoveredSeconds: Math.max(0, Number(line.startSecond) - Number(window.startSecond)),
          trailingUncoveredSeconds: Math.max(0, Number(window.endSecond) - Number(line.endSecond)) }
      }).sort((a, b) => b.overlapRatio - a.overlapRatio)
      const best = matches[0], verified = range(window, media.duration) && covers(coverage, window) && best
        && best.overlapRatio >= minimumSpeechOverlap && best.leadingUncoveredSeconds <= maximumEdgeUncertaintySeconds + .000001
        && best.trailingUncoveredSeconds <= maximumEdgeUncertaintySeconds + .000001
      const edgeUncoveredIntervals = best ? [
        ...(best.leadingUncoveredSeconds > 0 ? [{ startSecond: window.startSecond, endSecond: Math.min(Number(window.endSecond), Number(best.speechInterval.startSecond)), edge: 'leading' }] : []),
        ...(best.trailingUncoveredSeconds > 0 ? [{ startSecond: Math.max(Number(window.startSecond), Number(best.speechInterval.endSecond)), endSecond: window.endSecond, edge: 'trailing' }] : []),
      ] : []
      return { visibleInterval: { startSecond: window.startSecond, endSecond: window.endSecond }, ...(best ?? {}), edgeUncoveredIntervals, verified: Boolean(verified) }
    })
    fail(speaking.length > 0 && visualSpeechCoverage.every(row => row.verified), 'visible-speaking-interval-without-required-speech')
    return { verified: reasons.length === 0, reasons: [...new Set(reasons)], actorId, actualSpeechIntervals: speechIntervals,
      visualSpeechCoverage, maximumEdgeUncertaintySeconds, minimumSpeechOverlap,
      exactSpeechVerified: speech.passed === true && speech.dialogueCompletenessVerified === true && alignment.every(row => row.alignmentCoverage === 1 && row.boundaryStatus === 'reliable'),
      speechValidationIssues: speech.issues ?? [], lineCoverage: alignment.map(row => row.alignmentCoverage ?? null),
      scope: 'required-speech-present', speakerIdentityVerified: false, lipSyncVerified: false, audioListened: false }
  }
  function rebindRetryTargets(media: Value, feedbackValue: unknown, existingValue?: unknown) {
    const existing = obj(existingValue), carry = obj(obj(obj(feedbackValue).repairContext).targetedMediaRepair)
    if (carry.version !== 'targeted-media-repair-retry-v1' || !Array.isArray(carry.targets) || !carry.targets.length) return existing
    const key = (target: Value) => JSON.stringify([target.id, target.sourceDefect, target.userReport])
    const unresolved = (target: Value) => ({ id: target.id, sourceDefect: target.sourceDefect, userReport: target.userReport,
      ...(target.repairScope ? { repairScope: target.repairScope } : {}), status: 'unresolved' } as Value)
    const targets = new Map(rows(carry.targets).map(target => [key(target), unresolved(target)]))
    for (const target of rows(existing.targets)) {
      const fresh = bound(existing, media)
      targets.set(key(target), fresh ? target : unresolved(target))
    }
    return { version: 'targeted-audio-visual-repair-v1', videoUrl: media.url ?? null, sha256: currentHash(media) ?? null, duration: media.duration ?? null,
      targets: [...targets.values()], retryProvenance: { sourceRunId: carry.sourceRunId ?? null, retryFromRunId: carry.retryFromRunId ?? null, scope: carry.scope ?? null } }
  }
  function assess(media: Value, reportValues: unknown, targetedValue?: unknown) {
    const issues: Value[] = [], warnings: Value[] = [], events: Value[] = [], targetResults: Value[] = []
    const reports = rows(reportValues), validIds = new Set<string>(), resolutionEvents = new Map<string, Value>()
    const warn = (id: unknown, reasons: string[]) => warnings.push({ code: 'audio_visual_evidence_unverified', eventId: id ?? null,
      problem: '声画复核证据未形成可用的连续同片证明，保留未知。', reasons })
    for (const report of reports) {
      const common: string[] = []
      if (report.version !== 'audio-visual-event-review-v1' || !text(report.id) || validIds.has(String(report.id))) common.push('review-identity-invalid-or-duplicate')
      else validIds.add(report.id)
      if (!bound(report, media)) common.push('current-video-url-sha256-or-duration-unbound')
      const reviewer = obj(report.reviewer)
      if (!text(reviewer.id) || !text(report.reviewedAt) || !Number.isFinite(Date.parse(String(report.reviewedAt)))) common.push('reviewer-or-review-time-missing')
      const reported = report.method === 'user-report' && reviewer.kind === 'user' && userReport(report.userReport)
      const continuous = report.method === 'agent-continuous-review' && reviewer.kind === 'agent'
        || report.method === 'user-continuous-review' && reviewer.kind === 'user' && text(report.userConfirmationRef)
      if (!reported && !continuous) common.push('review-method-unverified')
      if (!Array.isArray(report.events) || !report.events.length) { warn(report.id, [...common, 'no-events']); continue }
      const eventIds = new Set<string>()
      for (const event of rows(report.events)) {
        const reasons = common.slice(), key = String(report.id) + ':' + String(event.id)
        if (!text(event.id) || eventIds.has(String(event.id))) reasons.push('event-identity-invalid-or-duplicate')
        else eventIds.add(event.id)
        if (event.code !== 'unvoiced_visible_speech' || !text(event.actorId) || !text(event.finding)) reasons.push('event-code-actor-or-finding-missing')
        if (!range(event, media.duration)) reasons.push('event-interval-invalid')
        const playback = obj(event.playback), visual = obj(event.visual), audio = obj(event.audio)
        if (continuous) {
          if (!Array.isArray(report.evidenceRefs) || !report.evidenceRefs.length || !report.evidenceRefs.every(text)) reasons.push('playback-evidence-references-missing')
          if (playback.mode !== 'continuous-audio-video' || playback.videoWatched !== true || playback.audioListened !== true
            || !range(playback, media.duration) || !covers(playback, event)) reasons.push('continuous-audio-video-playback-not-established')
          if (visual.basis !== 'continuous-video' || !text(visual.finding) || audio.basis !== 'direct-listening' || !text(audio.finding)) reasons.push('direct-audio-and-continuous-visual-findings-required')
          if (!['confirmed', 'not-observed', 'uncertain'].includes(String(event.status))) reasons.push('independent-review-status-invalid')
          if (event.status === 'confirmed' && (visual.languageMouthMotion !== 'observed' || audio.speech !== 'absent')) reasons.push('unvoiced-visible-speech-not-established')
          if (event.status === 'not-observed' && !(visual.languageMouthMotion === 'not-observed' && ['absent', 'present'].includes(String(audio.speech))
            || visual.languageMouthMotion === 'observed' && audio.speech === 'present' && audio.actorMatches === true && event.synchrony === 'matched')) reasons.push('absence-or-matched-speaking-not-established')
        } else if (reported && !['reported', 'unresolved'].includes(String(event.status))) reasons.push('user-report-is-not-independent-confirmation')
        if (event.status === 'uncertain') reasons.push('reviewer-explicitly-uncertain')
        const verified = reasons.length === 0
        events.push({ reviewId: report.id ?? null, eventId: event.id ?? null, actorId: event.actorId ?? null,
          startSecond: event.startSecond ?? null, endSecond: event.endSecond ?? null, status: verified ? event.status : 'unverified', method: report.method ?? null,
          independentlyConfirmed: verified && continuous && event.status === 'confirmed', reasons })
        if (!verified) { warn(event.id, reasons); continue }
        if (continuous && event.status === 'not-observed') { resolutionEvents.set(key, event); continue }
        issues.push({ code: reported ? 'reported_audio_visual_defect' : 'unvoiced_visible_speech', problem: event.finding,
          repair: text(event.repair) ? event.repair : '保留原剧情义务，针对该角色及时间区间修复并复核同一替换素材的连续声画。',
          evidence: { source: reported ? 'user-report' : 'continuous-audio-video', status: event.status, independentlyConfirmed: continuous,
            reviewId: report.id, eventId: event.id, actorId: event.actorId, videoUrl: media.url, sha256: currentHash(media),
            startSecond: event.startSecond, endSecond: event.endSecond, method: report.method,
            ...(reported ? { userReport: report.userReport } : { evidenceRefs: report.evidenceRefs }) } })
      }
    }
    const targeted = obj(targetedValue)
    if (Object.keys(targeted).length) {
      const currentBound = targeted.version === 'targeted-audio-visual-repair-v1' && bound(targeted, media)
      for (const target of rows(targeted.targets)) {
        const source = obj(target.sourceDefect), required = obj(target.requiredInterval)
        const sourceValid = text(target.id) && source.code === 'unvoiced_visible_speech' && text(source.videoUrl) && sha(source.sha256)
          && text(source.actorId) && number(source.startSecond) && number(source.endSecond) && source.startSecond >= 0 && source.endSecond > source.startSecond && userReport(target.userReport)
        if (!sourceValid) { warn(target.id, ['target-has-no-traceable-explicit-user-defect']); continue }
        const interval = Object.keys(required).length ? required : { startSecond: 0, endSecond: media.duration }
        const reference = obj(target.resolution), reviewed = resolutionEvents.get(String(reference.reviewId) + ':' + String(reference.eventId))
        const technicalPresence = reference.scope === 'required-speech-present' ? requiredSpeechPresence(media, reference.evidence, source.actorId, interval) : undefined
        const currentConfirmedCounterevidence = issues.filter(issue => issue.code === 'unvoiced_visible_speech' && obj(issue.evidence).actorId === source.actorId
          && Number(obj(issue.evidence).endSecond) > Number(interval.startSecond) && Number(obj(issue.evidence).startSecond) < Number(interval.endSecond))
        if (technicalPresence && target.repairScope !== 'required-speech-present') {
          technicalPresence.verified = false
          technicalPresence.reasons.push('target-scope-does-not-authorize-speech-presence-only-resolution')
        }
        if (technicalPresence && currentConfirmedCounterevidence.length) {
          technicalPresence.verified = false
          technicalPresence.reasons.push('current-media-has-confirmed-unvoiced-visible-speech')
        }
        const resolved = currentBound && target.status === 'resolved' && range(interval, media.duration)
          && (reviewed && reviewed.actorId === source.actorId && covers(reviewed, interval) || technicalPresence?.verified === true)
        targetResults.push({ targetId: target.id, status: resolved ? 'resolved' : 'unresolved', requestedStatus: target.status ?? null,
          sourceDefect: source, requiredInterval: interval, currentMediaBound: currentBound,
          resolutionEvidenceVerified: Boolean(resolved), ...(technicalPresence ? { resolutionScope: 'required-speech-present', technicalPresence,
            repairScope: target.repairScope ?? 'precise-visible-speech-coverage', fullAudioVisualRepairVerified: false,
            remainingVerification: ['speaker-identity', 'precise-lip-sync'], currentConfirmedCounterevidence,
            speakerIdentityVerified: false, lipSyncVerified: false } : {}) })
        if (resolved && technicalPresence) warnings.push({ code: 'speech_presence_only', targetId: target.id,
          problem: '已证实目标角色所需台词音轨在已复核的讲话段内存在；边缘时间差另列，声纹身份与逐字口型同步仍未验证。',
          speakerIdentityVerified: false, lipSyncVerified: false, audioListened: false })
        if (resolved && technicalPresence && technicalPresence.visualSpeechCoverage.some(row => Number(row.leadingUncoveredSeconds) > 0 || Number(row.trailingUncoveredSeconds) > 0)) {
          warnings.push({ code: 'speech_presence_edge_timing_uncertain', targetId: target.id,
            problem: '可见讲话表演的边缘超出 ASR 词时间；仅按有限端点不确定度证明该段有人声，未验证这些边缘的发声或口型同步。',
            visualSpeechCoverage: technicalPresence.visualSpeechCoverage, maximumEdgeUncertaintySeconds: technicalPresence.maximumEdgeUncertaintySeconds,
            lipSyncVerified: false, audioListened: false })
        }
        if (!resolved) issues.push({ code: 'targeted_audio_visual_repair_unresolved', problem: '用户已报告的声画缺陷尚无替换素材的连续声画消除证据：' + String(target.userReport && obj(target.userReport).quote),
          repair: '保留用户原报告；对替换素材所需区间进行实际连续声画复核，未知不得标记为已修复。', evidence: { source: 'targeted-repair', status: 'unresolved',
            targetId: target.id, sourceDefect: source, userReport: target.userReport, videoUrl: media.url ?? null, sha256: currentHash(media) ?? null,
            requiredInterval: interval, currentMediaBound: currentBound, independentlyConfirmed: false } })
      }
    }
    return { version: 'audio-visual-event-assessment-v1', videoUrl: media.url ?? null, sha256: currentHash(media) ?? null,
      events, targetResults, issues, warnings, lipSyncVerified: false, fullVideoWatched: false, fullVideoListened: false }
  }
  return { assess, rebindRetryTargets, buildRequiredSpeechPresenceEvidence }
}

export const { assess: assessAudioVisualEventEvidence, buildRequiredSpeechPresenceEvidence } = audioVisualEventEvidenceRuntimeFactory()
