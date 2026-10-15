import { storyboardTimelineMatches } from './storyboard-timeline.ts'
import { resolveDramaGenerationLimit } from './drama-generation-budget.ts'
import { MAX_NODE_ATTEMPTS } from './retry-budget.ts'
import { refreshDramaticExpressionPrompt } from './dramatic-expression.ts'
import { modelRetryStopped } from './model-failure.ts'
import { storyboardContinuityContract, storyboardContinuityInstruction } from './storyboard-continuity-contract.ts'
import {
  applyNodeOutputToContext, buildStoryboardRepairSuffix, extractTextResponse, normalizeStructuredTextOutput,
  reconcileStoryboardPacingBudget, repairStoryboardDialogueBindings, repairStoryboardNarrationEntrances,
  storyboardDialogueScheduleHint, validateHistoricalStoryboardSegments, validateHistoricalStructuredOutput,
  collectHistoricalStoryboardDiagnostics,
  storyboardSegmentCompletionCriteria,
  historicalStoryboardSegmentInputs,
  storyboardStatePrompt,
} from './workflow-core.ts'
import { historyTailSeconds, narrativeTransitionIssue } from './history-pacing.ts'
import { cinematicContinuityIssue, cinematicShotAllowsEmptyCast, expectedEndPresentCharacters, isActorlessTableauRepresentationCut, isCinematicShot, principleDurationTransitionIssue, principleMediaEvidenceIssue, principleTailWorldState, validateCinematicPresenceReview, validateCinematicWorldState } from './history-cinema.ts'
import { adjacentSceneCutBridgeIssue, approvedSceneCutEllipsis, boundaryText,
  canonicalJson, enactedVisualTextCovers, partitionDramaBeat, projectedDramaBeatDescription } from './history-drama.ts'
import { storyboardAdvisories } from './storyboard-advisories.ts'
import { repairStoryboardPacingMetadata } from './storyboard-pacing-repair.ts'
import { normalizeRawStoryboardDurationCandidate, type StoryboardDurationNormalizationChange } from './storyboard-duration-normalization.ts'
import { repairStoryboardAnonymousSpeakerBindings } from './storyboard-actor-bindings.ts'
import { repairGroupSpeechPerformance } from './storyboard-group-semantics.ts'
import { normalizeStoryboardAnonymousEntranceIdentities } from './storyboard-entrance.ts'
import { planDurationSourceBeatSplit } from './duration-schedule.ts'
import { StoryboardCandidateValidationError, type StoryboardValidationAttempt } from './storyboard-generation-error.ts'

export const STORYBOARD_SEGMENTS_KEY = '__storyboardSegments'
type RecordValue = Record<string, unknown>
export type StoryboardAttempt = StoryboardValidationAttempt

/** The writer receives the same conservative clock used for acceptance before
 * spending its split attempt. This is advice, never a generated/approved shot. */
export function storyboardDurationSourceSplitHint(candidate: unknown, expected: RecordValue): string {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return ''
  const current = candidate as RecordValue
  let inputs: Array<{ segment: RecordValue; expected: RecordValue }>
  try {
    inputs = Array.isArray(current.segments)
      ? historicalStoryboardSegmentInputs(current, expected).map(({ segment, splitScene }) => ({ segment, expected: { ...expected, scene: splitScene } }))
      : [{ segment: current, expected }]
  } catch { return '' } // Unsafe allocation needs the original contract error, not a guessed scope.
  const plans = inputs.flatMap(({ segment, expected: scoped }, index) => {
    const plan = planDurationSourceBeatSplit(segment, { scene: scoped.scene, timingPolicy: scoped.timingPolicy })
    if (!plan || (plan.minimumSegments !== undefined && plan.minimumSegments < 2)) return []
    return [{ ...(inputs.length > 1 ? { segmentIndex: index, segmentId: segment.id } : {}), ...plan }]
  })
  if (!plans.length) return ''
  return '\n【共享排程的完整原节拍拆分方案】以下只读预算来自当前稿全部真实动作、完整原文、已声明依赖/双方并行、各声部保守上界及收尾保留；不是仅累加台词，也不能用测量容差或手填duration跳过。'
    + JSON.stringify(plans)
    + '\n优先按groups中的有序sourceBeatIds写完整segments；每组beatIds保留当前原表演，所列requiredDuration是该组全部内容加endingReadabilityReserve后的允许整数下界，仍须通过完整声画、覆盖与连续性校验。minimumSegments只是在本稿完整source边界、原依赖及预算不变时的最少组数，不是新候选的固定段数门槛；新增必要表演可能需要更多段，不能继续沿用会超过maximumProviderDuration的两段划分。'
    + '\ncompletedDependencyBeatIds是前段计划完整完成、后段必须承接的表演义务：原动作与台词仍在前段恰好执行一次，本段通过连续性开场状态承接其结果，dependsOn只能引用本段实际存在的beat.id。未实拍的前段计划不能声称observed。不得把已完成表演重新写进本段、保留不存在本段的依赖id、移除本段内部依赖或伪造并行。每段使用自己的局部排程原点并保留真实收尾状态，不能把整场最终状态提前复制到中间段。'
    + '\n若groups为空且oversizedSourceBeatIds非空，完整单个原节拍仍超限，须由作者沿其原动作/音频义务继续拆成相邻段，按beatCoverage与beatDramaturgy完整一次分配；不得机械截断一句台词、删动作或伪造可行预算。'
}

/** beatCoverage is allocation metadata, not a second container for spoken
 * lines. Models commonly copy approved narration into anchors while splitting
 * a long beat. Remove only text that is demonstrably copied from that beat's
 * approved audio or separately declared visual obligation, and only when the remaining anchors still allocate every
 * approved mustShow exactly once. This cannot invent or discard story content:
 * the actual pacing/audio coverage is validated independently afterwards. */
export function repairStoryboardSplitCoverageMetadata(value: unknown, expected: RecordValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as RecordValue
  if (!Array.isArray(candidate.segments) || candidate.segments.length < 2) return undefined
  const scene = expected.scene as RecordValue | undefined
  if (!scene || !Array.isArray(scene.requiredBeats)) return undefined
  const beats = scene.requiredBeats.filter(beat => beat && typeof beat === 'object' && !Array.isArray(beat)) as RecordValue[]
  const byId = new Map(beats.map(beat => [String(beat.id ?? ''), beat]))
  const coverageKey = (value: unknown) => String(value ?? '').normalize('NFKC').replace(/[\s，。；、：,.!?！？;:“”"'‘’（）()\-—]/g, '')
  let changed = false
  const segments = candidate.segments.map(segment => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return segment
    const record = segment as RecordValue
    if (!Array.isArray(record.coveredBeatIds) || !Array.isArray(record.beatCoverage)
      || record.coveredBeatIds.length !== record.beatCoverage.length) return segment
    const coveredBeatIds = record.coveredBeatIds as unknown[]
    const originalCoverage = record.beatCoverage as unknown[]
    const coverage = originalCoverage.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
      const entry = raw as RecordValue
      const beatId = String(entry.beatId ?? '')
      const beat = byId.get(beatId)
      if (!beat || beatId !== coveredBeatIds[index] || !Array.isArray(entry.anchors)) return raw
      const mustShow = Array.isArray(beat.mustShow) ? beat.mustShow.map(String) : []
      const observable = beat.observable && typeof beat.observable === 'object' && !Array.isArray(beat.observable)
        ? beat.observable as RecordValue : undefined
      const audio = Array.isArray(observable?.audio) ? (observable.audio as unknown[]).map(String) : []
      const visual = Array.isArray(observable?.visual) ? (observable.visual as unknown[]).map(String) : []
      const approvedVisualAliases = visual.length === mustShow.length
        ? new Map(visual.map((anchor, visualIndex) => [anchor, mustShow[visualIndex]])) : new Map<string, string>()
      const anchors = entry.anchors.map(String)
      const invalid = anchors.filter(anchor => !mustShow.includes(anchor))
      const implemented = Array.isArray(record.beatDramaturgy)
        ? (record.beatDramaturgy as unknown[]).find(value => value && typeof value === 'object' && !Array.isArray(value)
          && String((value as RecordValue).beatId ?? '') === beatId) as RecordValue | undefined
        : undefined
      const implementedVisual = Array.isArray(implemented?.visual) ? (implemented.visual as unknown[]).map(String) : []
      const implementedAudio = Array.isArray(implemented?.audio) ? (implemented.audio as unknown[]).map(String) : []
      // observable.visual is independently allocated through beatDramaturgy.
      // A source beat may approve more visuals than its mustShow shortlist.
      // Correct only the duplicated metadata; never remove the authored action.
      const separatelyDeclaredVisual = (anchor: string) => visual.some(approved => coverageKey(approved) === coverageKey(anchor)
        && implementedVisual.some(actual => coverageKey(actual).includes(coverageKey(approved))))
      const matchingWholeVisual = (anchor: string) => mustShow.find(whole => coverageKey(whole).includes(coverageKey(anchor))
        && implementedVisual.some(actual => coverageKey(actual).includes(coverageKey(whole))))
      const approvedAudioFragment = (anchor: string) => audio.some(line => coverageKey(line).includes(coverageKey(anchor))
        || coverageKey(anchor).includes(coverageKey(line)))
      if (!invalid.length) return raw
      if (invalid.some(anchor => !approvedVisualAliases.has(anchor) && !matchingWholeVisual(anchor)
        && !separatelyDeclaredVisual(anchor) && !approvedAudioFragment(anchor))) return raw
      const filtered = [...new Set(anchors.flatMap(anchor => mustShow.includes(anchor) ? [anchor]
        : approvedVisualAliases.has(anchor) ? [approvedVisualAliases.get(anchor)!]
          : matchingWholeVisual(anchor) ? [matchingWholeVisual(anchor)!] : []))]
      // [] may carry approved audio or an observable-only action. Its actual
      // obligation remains in beatDramaturgy and passes the full allocation gate.
      if (!filtered.length && !visual.some(separatelyDeclaredVisual)
        && !implementedAudio.some(part => audio.some(whole => coverageKey(whole).includes(coverageKey(part))))) return raw
      changed = true
      return { ...entry, anchors: filtered }
    })
    return coverage.some((entry, index) => entry !== originalCoverage[index]) ? { ...record, beatCoverage: coverage } : segment
  })
  if (!changed) return undefined
  for (const beat of beats) {
    const id = String(beat.id ?? '')
    const mustShow = Array.isArray(beat.mustShow) ? beat.mustShow.map(String) : []
    const allocated = segments.flatMap(segment => {
      if (!segment || typeof segment !== 'object' || Array.isArray(segment) || !Array.isArray((segment as RecordValue).beatCoverage)) return []
      return ((segment as RecordValue).beatCoverage as unknown[]).flatMap(entry => entry && typeof entry === 'object' && !Array.isArray(entry)
        && String((entry as RecordValue).beatId ?? '') === id && Array.isArray((entry as RecordValue).anchors)
        ? ((entry as RecordValue).anchors as unknown[]).map(String) : [])
    })
    if (allocated.length !== mustShow.length || mustShow.some(anchor => allocated.filter(value => value === anchor).length !== 1)) return undefined
  }
  return { candidate: { ...candidate, segments }, changes: [{ source: 'approved-beat-coverage', path: 'segments[].beatCoverage', before: 'mustShow+approved-audio', after: 'mustShow' }] }
}

/** A later clip in one split cannot open as a new scene. When the writer uses
 * scene_cut/reference for such a clip, project the already-authored previous
 * tail into the required continuation fields. An explicit coverage_cut stays
 * untouched because it is a legitimate editorial choice with its own gate. */
export function repairStoryboardSplitContinuityMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as RecordValue
  if (!Array.isArray(candidate.segments) || candidate.segments.length < 2) return undefined
  let changed = false
  const segments = candidate.segments.map((segment, index, all) => {
    if (!index || !segment || typeof segment !== 'object' || Array.isArray(segment)) return segment
    const current = segment as RecordValue
    const previous = all[index - 1] && typeof all[index - 1] === 'object' && !Array.isArray(all[index - 1])
      ? all[index - 1] as RecordValue : undefined
    const continuity = current.continuity && typeof current.continuity === 'object' && !Array.isArray(current.continuity)
      ? current.continuity as RecordValue : {}
    if (!previous || continuity.mode === 'coverage_cut' || (continuity.mode !== 'scene_cut' && current.firstFrameMode !== 'reference')) return segment
    if (typeof previous.id !== 'string' || !previous.id.trim() || typeof previous.lastFramePrompt !== 'string'
      || !previous.lastFramePrompt.trim() || !Array.isArray(previous.endCharacters)) return segment
    changed = true
    return { ...current, firstFrameMode: 'reuse_previous_tail', visualPrompt: storyboardStatePrompt(previous.lastFramePrompt),
      initialCharacters: [...previous.endCharacters], continuity: { ...continuity, mode: 'tail_continuation',
        previousShotId: previous.id, bridgeType: 'same_frame', bridgeAnchor: '' } }
  })
  return changed ? { candidate: { ...candidate, segments }, changes: [{ source: 'split-tail-continuity',
    path: 'segments[1:].continuity', before: 'scene_cut/reference', after: 'tail_continuation/reuse_previous_tail' }] } : undefined
}

/** Build a writer-only view of the previous shot. Completed scripts remain
 * immutable evidence; a continuous take starts from the accepted real image. */
export function storyboardContinuityContext(context: RecordValue): RecordValue {
  const sourceScene = context.scene as RecordValue | undefined
  const sourcePrior = (context.loop as RecordValue)?.previous as RecordValue | undefined
  const sourceShot = sourcePrior?.shot_script as RecordValue | undefined
  const scene = sourceScene && isActorlessTableauRepresentationCut(sourceScene, sourceShot)
    && sourceScene.continuityMode === 'tail_continuation'
    ? { ...sourceScene, continuityMode: 'coverage_cut' }
    : sourceScene
  let projectedContext = scene === sourceScene ? context : { ...context, scene }
  const manual = context.qualityDisposition === 'manual-review-v1'
  const noteContentIssue = (message: string) => {
    if (!manual) throw new Error(message)
    projectedContext = { ...projectedContext, storyboardQualityWarnings: [...(Array.isArray(projectedContext.storyboardQualityWarnings) ? projectedContext.storyboardQualityWarnings : []), message] }
  }
  const prior = (projectedContext.loop as RecordValue)?.previous as RecordValue | undefined
  const priorVideo = prior?.video_shot as RecordValue | undefined
  const priorCompletion = priorVideo?.durationCompletion as RecordValue | undefined
  const advisoryDuration = manual && priorVideo?.passed === true
    && priorVideo.qualityDisposition === 'manual-review-v1'
    && priorCompletion?.assessment === 'uncertain'
    && priorCompletion.evidenceRef === priorVideo.evidenceUrl
    && Array.isArray(priorVideo.qualityRisks)
    && priorVideo.qualityRisks.some(value => (value as RecordValue)?.code === 'duration_evidence_limit')
  // The approved outline owns transitions between source scenes. A storyboard
  // bridgeAnchor cannot silently add a missing move while preserving the same
  // restrained, carried or otherwise active physical state in a new location.
  const approvedOutline = projectedContext.approved_scene_outline as RecordValue | undefined
  const outlineScenes = Array.isArray(approvedOutline?.scenes) ? approvedOutline.scenes as RecordValue[] : []
  const sourceSceneId = scene?.sourceSceneId ?? scene?.id
  const sourceIndex = outlineScenes.findIndex(item => item?.id === sourceSceneId)
  const authoredScene = (value: RecordValue) => {
    const { sourceSceneId: _projection, ...authored } = value
    void _projection
    return authored
  }
  let approvedEllipsis: ReturnType<typeof approvedSceneCutEllipsis> | undefined
  if (scene?.continuityMode === 'scene_cut') {
    if (sourceIndex < 0 || !approvedOutline || !scene
      || canonicalJson(authoredScene(scene)) !== canonicalJson(outlineScenes[sourceIndex]))
      throw new Error('STORYBOARD_SCENE_BRIDGE_UNVERIFIED: 换场场景不在已批准大纲中，或场景内容被改写')
    const projectedOutline = projectedContext.scene_outline as RecordValue | undefined
    if (projectedOutline) {
      const projectedScenes = Array.isArray(projectedOutline.scenes)
        ? projectedOutline.scenes as RecordValue[] : []
      const currentProjection = projectedScenes[sourceIndex] ?? {}
      if (!Array.isArray(projectedOutline.scenes)
        || currentProjection.sourceSceneId !== undefined
          && currentProjection.sourceSceneId !== outlineScenes[sourceIndex].id
        || canonicalJson(authoredScene(currentProjection))
          !== canonicalJson(outlineScenes[sourceIndex]))
        throw new Error('STORYBOARD_SCENE_BRIDGE_UNVERIFIED: 当前场景与已批准大纲不一致')
      if (sourceIndex > 0) {
        const priorProjection = projectedScenes[sourceIndex - 1] ?? {}
        const priorApproved = outlineScenes[sourceIndex - 1]
        const priorShot = prior?.shot_script as RecordValue | undefined
        const expectedPriorProjection = priorShot
          ? sceneFromStoryboardSegment(priorApproved, priorShot, 0, 1) : priorApproved
        if (priorProjection.sourceSceneId !== undefined
          && priorProjection.sourceSceneId !== priorApproved.id
          || canonicalJson(priorProjection) !== canonicalJson(priorApproved)
            && canonicalJson(priorProjection) !== canonicalJson(expectedPriorProjection))
          throw new Error('STORYBOARD_SCENE_BRIDGE_UNVERIFIED: 前场投影超出受管分镜字段')
      }
    }
    if (sourceIndex > 0) {
      const previousScene = outlineScenes[sourceIndex - 1]
      if (prior?.shot_script && (prior.shot_script as RecordValue).id !== previousScene.id)
        throw new Error('STORYBOARD_SCENE_BRIDGE_UNVERIFIED: 上一已验收分镜与批准大纲前场不一致')
      const issue = adjacentSceneCutBridgeIssue(previousScene, outlineScenes[sourceIndex])
      if (issue) throw new Error(`STORYBOARD_SCENE_BRIDGE_UNVERIFIED: ${issue}`)
      approvedEllipsis = approvedSceneCutEllipsis(previousScene, outlineScenes[sourceIndex])
    }
  }
  if (approvedEllipsis && priorVideo?.qualityPolicy !== 'principle-v1')
    throw new Error('STORYBOARD_NARRATIVE_INCOMPLETE: 批准省略切场缺少前镜原则审查和实测完成证据')
  if (priorVideo?.qualityPolicy === 'principle-v1') {
    const shot = prior?.shot_script as RecordValue | undefined
    const issue = principleMediaEvidenceIssue(priorVideo, shot)
    if (issue || !shot?.id) throw new Error(`STORYBOARD_CONTINUITY_EVIDENCE_MISSING: ${issue ?? '缺少前镜分镜来源'}`)
    const progress = shot.storyProgress as RecordValue | undefined
    if ((shot.pacing as RecordValue | undefined)?.version === 'duration-v2'
      && (scene?.continuityMode === 'scene_cut' || scene?.continuityFromPrevious === false)
      && !scene?.dramaticUnitId) {
      throw new Error('STORYBOARD_NARRATIVE_INCOMPLETE: 换场缺少已批准 dramaticUnitId，不能绕过前镜实测完成门禁')
    }
    if (scene?.dramaticUnitId) {
      if (!progress || !['continuing', 'complete'].includes(String(progress.status))) {
        throw new Error('STORYBOARD_NARRATIVE_INCOMPLETE: 前镜缺少可靠剧情状态，禁止开始下一镜')
      }
      if (progress.status === 'continuing' && (scene.dramaticUnitId !== progress.unitId
        || scene.continuityFromPrevious !== true)) {
        throw new Error('STORYBOARD_NARRATIVE_INCOMPLETE: 前镜剧情尚未结束，必须先续完原单元，禁止换场')
      }
      if (progress.status === 'complete') {
        if (scene.dramaticUnitId === progress.unitId || !Array.isArray(progress.pendingActions) || progress.pendingActions.length) {
          throw new Error('STORYBOARD_NARRATIVE_INCOMPLETE: 前镜剧情完成声明与下一单元或待办动作相矛盾')
        }
        const completionIssue = principleDurationTransitionIssue(shot, priorVideo)
        if (completionIssue) {
          if (!advisoryDuration) throw new Error(`STORYBOARD_NARRATIVE_INCOMPLETE: ${completionIssue}；禁止凭计划结束态或尾帧静图换场`)
          noteContentIssue(`前镜逐节拍完成状态未证实：${completionIssue}；本镜不得把未证实的束缚、行走或对白当成已观察事实，应按批准场景重新建立连续关系`)
        }
        if (approvedEllipsis) {
          const tailUrl = priorVideo.lastFrameUrl
          const frames = Array.isArray(priorVideo.frames) ? priorVideo.frames : []
          const tail = prior?.last_frame as RecordValue | undefined
          const review = priorVideo.visualReview as RecordValue | undefined
          const tailEvidence = review?.endingStateEvidence as RecordValue | undefined
          const endingState = typeof review?.endingState === 'string' ? review.endingState : ''
          if (priorVideo.decoded !== true || typeof tailUrl !== 'string' || !tailUrl
            || frames.at(-1) !== tailUrl || tail?.available !== true || tail.url !== tailUrl
            || tail.source !== 'extracted-from-video' || review?.passed !== true
            || tailEvidence?.method !== 'actual-tail-image' || tailEvidence.frame !== tailUrl
            || !endingState || approvedEllipsis.sharedCast.some(name => !endingState.includes(name))) {
            if (!advisoryDuration || priorVideo.decoded !== true || tail?.url !== tailUrl || frames.at(-1) !== tailUrl)
              throw new Error('STORYBOARD_NARRATIVE_INCOMPLETE: 批准硬切需要前镜真实成片末帧和具名人物状态证据')
            noteContentIssue('前镜实际尾帧已绑定，但人物与动作状态尚未完整证实；本镜开场须独立呈现批准的空间、人物和动作关系')
          }
        }
      }
    }
    if (scene?.continuityFromPrevious !== true) return projectedContext
    const tail = prior?.last_frame as RecordValue | undefined
    if (tail?.available !== true || tail.url !== priorVideo.lastFrameUrl) throw new Error('STORYBOARD_CONTINUITY_EVIDENCE_MISSING: 连续镜头必须引用上一成片的实际尾帧')
    const review = priorVideo.visualReview as RecordValue | undefined
    const evidence = review?.endingStateEvidence as RecordValue | undefined
    const reportedEnding = evidence?.method === 'actual-tail-image' && evidence.frame === priorVideo.lastFrameUrl
      && typeof review?.endingState === 'string' ? review.endingState.trim() : ''
    const ending = reportedEnding || '以上一镜实际尾帧图片为开场依据；未得到可靠文字观察的人物位置、持物与动作状态保持未知，不按计划尾帧补写。'
    const presentCharacters = expectedEndPresentCharacters(shot)
    const worldState = isCinematicShot(shot) ? principleTailWorldState(shot, priorVideo) : undefined
    return { ...projectedContext, loop: { ...(projectedContext.loop as RecordValue), previous: { ...prior,
      shot_script: { ...shot, lastFramePrompt: ending,
        ...(worldState ? { worldState, presentCharacters, worldStateEvidence: { method: 'actual-tail-image', frame: priorVideo.lastFrameUrl, qualityPolicy: 'principle-v1' } } : {}),
        videoPrompt: `上一镜批准的台词：${String(shot.audioText ?? '')}。以实际尾帧图片续接；尾帧报告原文（未确认部分保持未知）：${ending}。原则通行不代表每项动作或人声已实测通过。` },
      actualTailEvidence: { previousShotId: shot.id, url: priorVideo.lastFrameUrl, qualityPolicy: 'principle-v1',
        qualityReview: priorVideo.qualityReview, ...(reportedEnding ? { reportedEndingState: reportedEnding } : {}),
        ...(worldState ? { worldState, expectedPresentCharacters: presentCharacters } : {}) },
    } } }
  }
  const transitionIssue = narrativeTransitionIssue(scene ?? {}, prior?.shot_script as RecordValue, prior?.video_shot as RecordValue)
  if (transitionIssue) noteContentIssue(`STORYBOARD_NARRATIVE_INCOMPLETE: ${transitionIssue}`)
  if (scene?.continuityFromPrevious !== true) return projectedContext
  const loop = projectedContext.loop as RecordValue | undefined
  const previous = loop?.previous as RecordValue | undefined
  const shot = previous?.shot_script as RecordValue | undefined
  const video = previous?.video_shot as RecordValue | undefined
  const tail = previous?.last_frame as RecordValue | undefined
  const review = video?.visualReview as RecordValue | undefined
  const url = video?.lastFrameUrl
  const cast = review?.endCharacters
  const ending = typeof review?.endingState === 'string' ? review.endingState.trim() : ''
  if (!shot?.id || (video?.technicalValidation as RecordValue)?.passed !== true
    || !((video?.speechValidation as RecordValue)?.passed === true || (isCinematicShot(shot ?? {}) && video?.audioMode === 'ambient' && video?.hasAudio === true)) || review?.passed !== true
    || !Array.isArray(review?.issues) || review.issues.length || !ending
    || typeof url !== 'string' || !/^\/generated\/verified-[\w-]+-frame-5\.jpg$/.test(url)
    || !Array.isArray(video?.frames) || video.frames.at(-1) !== url
    || (review?.endingStateEvidence as RecordValue)?.method !== 'actual-tail-image'
    || (review?.endingStateEvidence as RecordValue)?.frame !== url
    || tail?.available !== true || tail.url !== url
    || !Array.isArray(cast) || (!cast.length && !(isCinematicShot(shot) && cinematicShotAllowsEmptyCast(shot)
      && Array.isArray(shot.presentCharacters) && shot.presentCharacters.length === 0)) || !Array.isArray(shot.endCharacters)
    || JSON.stringify([...cast].sort()) !== JSON.stringify([...shot.endCharacters].sort())
    || cast.some(name => typeof name !== 'string' || !ending.includes(name))) {
    throw new Error('STORYBOARD_CONTINUITY_EVIDENCE_MISSING: 连续镜头需要上一轮已验收成片的实际尾帧、可见人物和状态，不能回退到计划尾帧')
  }
  if (isCinematicShot(shot)) validateCinematicPresenceReview(shot, review)
  const presentCharacters = expectedEndPresentCharacters(shot)
  const worldState = isCinematicShot(shot) ? validateCinematicWorldState(review.worldState, presentCharacters, '前镜实测 worldState') : undefined
  return { ...projectedContext, loop: { ...loop, previous: { ...previous,
    shot_script: { ...shot, lastFramePrompt: ending, endCharacters: [...cast],
      ...(worldState ? { worldState, presentCharacters, worldStateEvidence: review.endingStateEvidence } : {}),
      videoPrompt: `上一镜已经完成的台词：${String(shot.audioText ?? '')}。下一镜开始前的实际状态：${ending}。不得重演前镜已完成动作。` },
    actualTailEvidence: { previousShotId: shot.id, url, endingState: ending, endCharacters: [...cast],
      ...(worldState ? { worldState, presentCharacters } : {}) },
  } } }
}

export function historicalContinuityIssue(shot: RecordValue, video: RecordValue | undefined, previousShot: unknown, previousVideo: RecordValue | undefined) {
  if (isCinematicShot(shot) && (shot.continuity as RecordValue)?.mode === 'coverage_cut') return cinematicContinuityIssue(shot, previousShot as RecordValue | undefined, previousVideo)
  if (shot.deriveFromPrevious !== true && shot.firstFrameMode !== 'reuse_previous_tail') return undefined
  try {
    const context = storyboardContinuityContext({ scene: { continuityFromPrevious: true }, loop: { previous: {
      shot_script: previousShot, video_shot: previousVideo, last_frame: { available: true, url: previousVideo?.lastFrameUrl },
    } } })
    const prior = ((context.loop as RecordValue).previous as RecordValue).shot_script as RecordValue
    if (previousVideo?.qualityPolicy === 'principle-v1' || video?.qualityPolicy === 'principle-v1') {
      if ((shot.continuity as RecordValue)?.previousShotId !== prior.id
        || (video?.params as RecordValue)?.referenceImage !== previousVideo?.lastFrameUrl) return '连续镜头未绑定上一镜及其实际尾帧来源'
      return isCinematicShot(shot) ? cinematicContinuityIssue(shot, previousShot as RecordValue, previousVideo) : undefined
    }
    if ((shot.continuity as RecordValue)?.previousShotId !== prior.id || shot.visualPrompt !== prior.lastFramePrompt
      || (video?.params as RecordValue)?.referenceImage !== previousVideo?.lastFrameUrl
      || typeof video?.firstFrameDifference !== 'number' || video.firstFrameDifference > 0.10) {
      return '连续镜头的开场文本、首帧引用或实测首尾画面不匹配上一轮实际尾帧'
    }
  } catch (error) { return error instanceof Error ? error.message : String(error) }
  return undefined
}

export function storyboardCandidate(value: unknown) {
  const responseText = extractTextResponse(value)
  const blocks: Array<{ source: string; closed: boolean }> = []
  let fence: { marker: string; json: boolean; lines: string[] } | undefined
  for (const line of responseText.split(/\r?\n/)) {
    const marker = line.match(/^[ \t]*(`{3,})([^`]*)$/)
    if (!fence) {
      if (marker) fence = { marker: marker[1], json: /^(?:json)?\s*$/i.test(marker[2].trim()), lines: [] }
    } else if (marker && marker[1].length >= fence.marker.length && !marker[2].trim()) {
      if (fence.json) blocks.push({ source: fence.lines.join('\n'), closed: true })
      fence = undefined
    } else {
      fence.lines.push(line)
    }
  }
  if (fence?.json) blocks.push({ source: fence.lines.join('\n'), closed: false })
  if (blocks.length > 1) {
    // Multiple complete shot blocks are one split response. Keeping only the
    // first silently discards approved story content; choosing a plausible
    // block would also hide duplicate candidates or a malformed later segment.
    const segments = blocks.map((block, index) => {
      if (!block.closed) throw new Error(`STORYBOARD_RESPONSE_INVALID: 第 ${index + 1} 个 JSON 代码块未闭合，不能丢弃后续分段而只读取首段`)
      try { return JSON.parse(block.source) as unknown } catch (error) {
        throw new Error(`STORYBOARD_RESPONSE_INVALID: 第 ${index + 1} 个 JSON 代码块解析失败，不能忽略损坏分段：${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    })
    for (const [index, segment] of segments.entries()) {
      const shot = segment && typeof segment === 'object' && !Array.isArray(segment) ? segment as RecordValue : undefined
      const pacing = shot?.pacing
      if (!shot || !['id', 'title', 'visualPrompt', 'lastFramePrompt', 'videoPrompt', 'audioType', 'audioText', 'camera', 'mood', 'firstFrameMode'].every(key => typeof shot[key] === 'string')
        || !String(shot.id).trim() || !String(shot.title).trim() || typeof shot.duration !== 'number'
        || !pacing || typeof pacing !== 'object' || Array.isArray(pacing) || typeof (pacing as RecordValue).version !== 'string'
        || !Array.isArray(shot.characters) || !Array.isArray(shot.coveredBeatIds) || !shot.coveredBeatIds.length
        || shot.coveredBeatIds.some(id => typeof id !== 'string' || !id.trim())) {
        throw new Error(`STORYBOARD_RESPONSE_INVALID: 第 ${index + 1} 个 JSON 代码块不是含 id、pacing、coveredBeatIds 与完整声画字段的独立分镜；多个代码块必须全部为完整分镜，不能选取首块或跳过其他候选`)
      }
    }
    return { segments, text: responseText, raw: value }
  }
  return normalizeStructuredTextOutput(value, responseText, 'json')
}

function validate(value: unknown, expected: RecordValue) {
  const wrapper = value as RecordValue
  return wrapper && Array.isArray(wrapper.segments)
    ? validateHistoricalStoryboardSegments(value, expected)
    : [validateHistoricalStructuredOutput('history.storyboard', value, expected) as RecordValue]
}

function normalizeDurationMetadata(value: unknown, expected: RecordValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as RecordValue
  if (!Array.isArray(candidate.segments)) return normalizeRawStoryboardDurationCandidate(candidate, {
    scene: expected.scene as RecordValue | undefined, timingPolicy: expected.timingPolicy, qualityDisposition: expected.qualityDisposition,
  })
  let inputs: ReturnType<typeof historicalStoryboardSegmentInputs> | undefined
  try { inputs = historicalStoryboardSegmentInputs(candidate, expected) } catch { /* Keep invalid allocation for the full validator. */ }
  const changes: StoryboardDurationNormalizationChange[] = []
  const segments = candidate.segments.map((segment, index) => {
    const normalized = normalizeRawStoryboardDurationCandidate(segment, { scene: inputs?.[index].splitScene, timingPolicy: expected.timingPolicy, qualityDisposition: expected.qualityDisposition })
    if (!normalized) return segment
    changes.push(...normalized.changes.map(change => ({ ...change, path: `segments[${index}].${change.path}` })))
    return normalized.candidate
  })
  return changes.length ? { candidate: { ...candidate, segments }, changes } : undefined
}

/** The prior accepted tail is authoritative input, not creative output. Repair
 * only the opening-state projection that can be copied mechanically; leave
 * character presence, exits and all authored action to the full validator. */
export function repairStoryboardOpeningWorldState(value: unknown, expected: RecordValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const wrapper = value as RecordValue
  const shot = Array.isArray(wrapper.segments) ? wrapper.segments[0] as RecordValue | undefined : wrapper
  const scene = expected.scene as RecordValue | undefined
  const previous = expected.previousShot as RecordValue | undefined
  const evidence = previous?.worldStateEvidence as RecordValue | undefined
  const priorWorld = previous?.worldState as RecordValue | undefined
  const priorRows = Array.isArray(priorWorld?.characters) ? priorWorld.characters as RecordValue[] : undefined
  const present = shot && Array.isArray(shot.presentCharacters) && shot.presentCharacters.every(name => typeof name === 'string' && name.trim())
    ? shot.presentCharacters as string[] : undefined
  const priorPresent = previous && Array.isArray(previous.presentCharacters) ? previous.presentCharacters as string[] : undefined
  const declaredEntrants = shot && Array.isArray(shot.enteringCharacters)
    ? shot.enteringCharacters.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) && typeof (value as RecordValue).name === 'string' ? [String((value as RecordValue).name)] : [])
    : []
  const illustrationEntrants = shot && Array.isArray(shot.illustrationLayers)
    ? shot.illustrationLayers.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) && typeof (value as RecordValue).characterName === 'string' ? [String((value as RecordValue).characterName)] : [])
    : []
  if (!shot || scene?.continuityFromPrevious !== true || evidence?.method !== 'actual-tail-image'
    || !priorWorld || !priorRows || !present || !priorPresent || priorPresent.some(name => !present.includes(name))
    || present.some(name => !priorPresent.includes(name) && !declaredEntrants.includes(name) && !illustrationEntrants.includes(name))
    || !['tail_continuation', 'coverage_cut'].includes(String((shot.continuity as RecordValue | undefined)?.mode))) return undefined
  const currentWorld = shot.worldState as RecordValue | undefined
  const priorByName = new Map(priorRows.map(row => [String(row.name), row]))
  const nextRows = present.map(name => priorByName.get(name) ?? {
    name,
    position: { status: 'unknown' },
    heldProps: { status: 'unknown' },
    pendingAction: { status: 'unknown' },
  })
  const nextWorld = { settingId: priorWorld.settingId, characters: nextRows }
  if (JSON.stringify(currentWorld) === JSON.stringify(nextWorld)) return undefined
  const repairedShot = { ...shot, worldState: nextWorld }
  return {
    candidate: Array.isArray(wrapper.segments)
      ? { ...wrapper, segments: [repairedShot, ...wrapper.segments.slice(1)] }
      : repairedShot,
    changes: [{ path: Array.isArray(wrapper.segments) ? 'segments[0].worldState' : 'worldState', reason: 'copied-authoritative-accepted-tail' }],
  }
}

/** Restore authoritative dramaturgy metadata when the writer changed only
 * full-/half-width punctuation. These fields are immutable source allocation,
 * not creative prose, so paying for another generation cannot improve them. */
export function repairStoryboardDramaturgyTypography(value: unknown, expected: RecordValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const shot = value as RecordValue
  if (Array.isArray(shot.segments) || !Array.isArray(shot.beatDramaturgy)) return undefined
  const scene = expected.scene as RecordValue | undefined
  if (!scene || !Array.isArray(scene.requiredBeats)) return undefined
  const source = new Map((scene.requiredBeats as RecordValue[]).map(beat => [String(beat.id ?? ''), beat]))
  const changes: Array<{ path: string; reason: string }> = []
  const rows = (shot.beatDramaturgy as unknown[]).map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const row = value as RecordValue, approved = source.get(String(row.beatId ?? ''))
    if (!approved) return value
    let next = row
    for (const key of ['function', 'stateChange'] as const) {
      if (typeof approved[key] !== 'string' || typeof row[key] !== 'string' || approved[key] === row[key]
        || boundaryText(approved[key]) !== boundaryText(row[key])) continue
      next = { ...next, [key]: approved[key] }
      changes.push({ path: `beatDramaturgy[${index}].${key}`, reason: 'restored-authoritative-typography' })
    }
    return next
  })
  return changes.length ? { candidate: { ...shot, beatDramaturgy: rows }, changes } : undefined
}

/** Approved beats may name anonymous participants (for example 病者 or 围观饥民)
 * without promoting them into continuity-tracked character identities. Text
 * models often put those labels into both actorGroups and character arrays.
 * Canonicalize only groups grounded in approved beat actions; named cast
 * members remain untouched and strict. */
export function repairStoryboardAnonymousActorGroups(value: unknown, expected: RecordValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const wrapper = value as RecordValue
  if (Array.isArray(wrapper.segments)) return undefined
  const shot = wrapper
  const scene = expected.scene as RecordValue | undefined
  const pacing = shot.pacing as RecordValue | undefined
  if (!scene || !Array.isArray(scene.cast) || !pacing || !Array.isArray(pacing.beats)) return undefined
  const inheritedNames = scene.continuityFromPrevious === true && Array.isArray((expected.previousShot as RecordValue | undefined)?.presentCharacters)
    ? ((expected.previousShot as RecordValue).presentCharacters as unknown[]).filter((name): name is string => typeof name === 'string' && Boolean(name.trim())) : []
  // scene.cast describes the named performers assigned new action in this
  // partition. A same-scene continuation can legitimately inherit another
  // named person who stays present without acting. Protect that authoritative
  // identity from anonymous-group cleanup just like an explicit current cast
  // member; otherwise a source phrase such as “张角之道” can make the cleanup
  // misclassify and delete the real inherited 张角.
  const cast = new Set([...(scene.cast.filter(name => typeof name === 'string') as string[]), ...inheritedNames])
  const approved = JSON.stringify(scene.requiredBeats ?? [])
  const sourceBeats = Array.isArray(scene.requiredBeats) ? scene.requiredBeats as RecordValue[] : []
  const approvedVisuals = (sourceBeatId: unknown) => sourceBeats
    .filter(row => row.id === sourceBeatId)
    .flatMap(row => [
      ...(typeof row.description === 'string' ? [row.description] : []),
      ...(Array.isArray((row.observable as RecordValue | undefined)?.visual) ? (row.observable as RecordValue).visual as unknown[] : []),
      ...(Array.isArray(row.mustShow) ? row.mustShow as unknown[] : []),
    ]).filter((anchor): anchor is string => typeof anchor === 'string' && anchor.trim().length > 0)
  // An approved anchor can name a group with a different word order ("百姓围观"
  // versus "围观百姓"). Retain that declared group when the same source beat
  // executes the exact approved anchor and every character in the concise group
  // label occurs in that anchor. memberDescription is explanatory prose and is
  // intentionally not required to repeat a four-character anchor fragment: the
  // latest scene-11 candidates correctly described "围观百姓" as villagers in a
  // village, and the old overlap heuristic deleted the valid group before the
  // duration validator saw it. An invented label still fails the character test.
  const groundedReorderedGroup = (id: string, group: RecordValue | undefined) => {
    const label = group?.label
    const description = group?.memberDescription
    if (typeof label !== 'string' || !/^[\u3400-\u9fff]{2,8}$/.test(label)
      || typeof description !== 'string') return false
    return (pacing.beats as unknown[]).some(value => {
      const beat = value as RecordValue
      if (!Array.isArray(beat?.actorIds) || !beat.actorIds.includes(id)
        || !['action', 'reaction'].includes(String(beat.kind))) return false
      const sourceVisuals = approvedVisuals(beat.sourceBeatId)
      // A beat may call its visible participants "人群" while its approved
      // dramatic function names them "百姓". Function/stateChange can ground
      // that role identity, but cannot prove its action was performed: the
      // concrete visual anchors below still have to be enacted by this group.
      const sourceText = sourceVisuals.join('')
      const roleIdentityText = [...sourceVisuals, ...sourceBeats.filter(row => row.id === beat.sourceBeatId)
        .flatMap(row => [row.function, row.stateChange]).filter((text): text is string => typeof text === 'string')].join('')
      const performed = [beat.textOrVocalization, beat.performanceInstruction]
        .filter((text): text is string => typeof text === 'string' && Boolean(text.trim())).join('。')
      const knownRoles = [...label.matchAll(/病患|病者|百姓|乡人|家属|弟子|军士|士兵|饥民|流民|群众|宾客|门生|官吏/g)].map(match => match[0])
      const roleGrounded = knownRoles.length
        ? knownRoles.every(role => roleIdentityText.includes(role))
        : (() => {
            const core = label.replace(/围观|周围|其他|部分|有人|人群|众多|多名|数名/g, '')
            return core.length >= 2 && sourceText.includes(core)
          })()
      if (!performed || !roleGrounded) return false
      const needsRoleContext = knownRoles.some(role => !sourceText.includes(role))
      return sourceVisuals.some(anchor => {
        if (needsRoleContext) {
          // Contextual role evidence cannot give a group somebody else's
          // action. It only resolves a generic visible collective subject:
          // "围观百姓" + "围观人群增多", never "弟子向围观人群示意".
          const subject = anchor.match(/^([^，,。；;]{0,16}?)(?:人群|众人|人们)/)
          if (!subject) return false
          const qualifierText = (text: string) => text.replace(/^(?:(?:部分|其余|更多|原有|有些|一群|多名|数名|其他|周围|附近|外围|在场))*/, '').replace(/的$/, '')
          const qualifier = qualifierText(label.replace(/病患|病者|百姓|乡人|家属|弟子|军士|士兵|饥民|流民|群众|宾客|门生|官吏/g, ''))
          if (qualifierText(subject[1]) !== qualifier) return false
        }
        const containsCharacters = (text: string, fragment: string) => {
          const available = [...text]
          return [...fragment].every(character => {
            const index = available.indexOf(character)
            if (index < 0) return false
            available.splice(index, 1)
            return true
          })
        }
        // Group labels are identities, not source-action quotations. A writer
        // may therefore call “周围百姓围拢观看” the group “围观百姓” and expand
        // the enacted action with route details. Ground the same label in both
        // the approved anchor and the actor-bound action instead of requiring
        // the entire anchor to survive as one contiguous substring.
        // A source beat can deliberately contain multiple anonymous subgroups
        // (for example 病患 and 围观百姓). The group label may therefore be
        // grounded across that beat's approved description/anchors rather than
        // repeated byte-for-byte in one anchor. Still require the bound action
        // to enact one concrete approved visual, so a label assembled from
        // unrelated source nouns cannot authorize an invented performance.
        return enactedVisualTextCovers(performed, anchor)
          || (containsCharacters(performed, anchor) && containsCharacters(sourceText, label))
      })
    })
  }
  const originalGroups = Array.isArray(pacing.actorGroups) ? pacing.actorGroups.filter(row => row && typeof row === 'object' && !Array.isArray(row)) as RecordValue[] : []
  const rawBeats = pacing.beats as RecordValue[]
  // A model sometimes adds a decorative crowd reaction after all approved
  // actions. It is not a missing story obligation and should not consume five
  // repairs merely because that invented crowd has no approved identity. Drop
  // only an unapproved anonymous reaction that no other beat depends on; named
  // cast, approved reaction text and dependency-bearing beats remain strict.
  const unsupportedReactionIds = new Set(rawBeats.flatMap(beat => {
    const ids = Array.isArray(beat.actorIds) ? beat.actorIds.filter(id => typeof id === 'string') as string[] : []
    const body = typeof beat.textOrVocalization === 'string' ? beat.textOrVocalization.trim() : ''
    const referenced = rawBeats.some(other => other !== beat && (Array.isArray(other.dependsOn) && other.dependsOn.includes(beat.id)
      || Array.isArray(other.overlapAllowedWith) && other.overlapAllowedWith.includes(beat.id)))
    if (beat.kind !== 'reaction' || !ids.length || ids.some(id => cast.has(id) || id === '旁白')
      || !body || approved.includes(body) || referenced) return []
    const groups = ids.map(id => originalGroups.find(row => row.id === id || row.label === id))
    return groups.every((group, index) => group && typeof group.label === 'string'
      && !approved.includes(group.label) && !groundedReorderedGroup(ids[index], group)) ? [String(beat.id ?? '')] : []
  }).filter(Boolean))
  const eligibleBeats = rawBeats.filter(beat => !unsupportedReactionIds.has(String(beat.id ?? '')))
  const actorIds = [...new Set(eligibleBeats.flatMap(value => {
    const beat = value as RecordValue
    return Array.isArray(beat?.actorIds) ? beat.actorIds.filter(id => typeof id === 'string') as string[] : []
  }))]
  const anonymousCandidates = actorIds.filter(id => id !== '旁白' && !cast.has(id)).flatMap(id => {
    const group = originalGroups.find(row => row.id === id || row.label === id)
    const label = typeof group?.label === 'string' ? group.label : id
    return approved.includes(label) || approved.includes(id) || groundedReorderedGroup(id, group)
      ? [{ id, label, group }] : []
  })
  const anonymous = [...new Map(anonymousCandidates.map(row => [row.label, row])).values()]
  const identityValues = [shot.characters, shot.presentCharacters, shot.initialCharacters, shot.endCharacters,
    (shot.worldState as RecordValue | undefined)?.characters].flatMap(value => Array.isArray(value) ? value : [])
    .flatMap(value => typeof value === 'string' ? [value]
      : value && typeof value === 'object' && !Array.isArray(value) && typeof (value as RecordValue).name === 'string'
        ? [String((value as RecordValue).name)] : [])
  // Writers sometimes collapse two approved anonymous labels into one identity
  // string (for example “病患与家属”). It is still a crowd description, not a
  // cast member. Remove it only when every component occurs in the approved
  // beat text and none is a declared cast identity.
  const anonymousIdentityNames = [...new Set(identityValues.filter(name => {
    if (cast.has(name)) return false
    const parts = name.split(/[与和及、]/).map(part => part.trim()).filter(Boolean)
    return parts.length > 0 && parts.every(part => !cast.has(part) && part.length >= 2 && approved.includes(part))
  }))]
  if (!anonymous.length && !anonymousIdentityNames.length && !unsupportedReactionIds.size) return undefined
  const used = new Set<string>(), replacements = new Map<string, string>(), labels = new Set<string>()
  const groups = anonymous.map(({ id, label, group }, index) => {
    let canonical = typeof group?.id === 'string' && group.id !== label && !cast.has(group.id) ? group.id : `group-${label}`
    while (used.has(canonical)) canonical = `group-${label}-${index + 1}`
    used.add(canonical); labels.add(label); replacements.set(id, canonical); replacements.set(label, canonical)
    return { id: canonical, label, memberDescription: typeof group?.memberDescription === 'string' && group.memberDescription.trim()
      ? group.memberDescription : `已批准场景中的匿名参与者：${label}` }
  })
  anonymousIdentityNames.forEach(name => labels.add(name))
  let beats = eligibleBeats.map(value => {
    const beat = value as RecordValue
    if (!Array.isArray(beat?.actorIds)) return value
    const next = beat.actorIds.map(id => typeof id === 'string' ? replacements.get(id) ?? id : id)
    return JSON.stringify(next) === JSON.stringify(beat.actorIds) ? value : { ...beat, actorIds: next }
  })
  // overlapAllowedWith is a symmetric relation, but writers regularly state it
  // on only the later anonymous crowd action. Once every performer is approved,
  // at least one side is an independently grounded group, and the two actions
  // have disjoint performers with no dependency on each other, completing the
  // reciprocal metadata cannot change who performs what. Keep named-only pairs,
  // shared performers, speech and dependency-bearing pairs on the strict path.
  const anonymousGroupIds = new Set(groups.map(group => group.id))
  const approvedActorIds = new Set([...anonymousGroupIds, ...cast])
  let reciprocalOverlapRepaired = false
  beats = beats.map(value => {
    const beat = value as RecordValue
    if (!['action', 'reaction'].includes(String(beat.kind)) || !Array.isArray(beat.actorIds) || !beat.actorIds.length
      || !beat.actorIds.every(id => approvedActorIds.has(String(id))) || !Array.isArray(beat.overlapAllowedWith)
      || typeof beat.id !== 'string') return value
    const beatId = beat.id
    const beatActorIds = beat.actorIds
    const beatOverlaps = beat.overlapAllowedWith
    const additions = beats.flatMap(otherValue => {
      const other = otherValue as RecordValue
      if (other === beat || typeof other.id !== 'string' || !Array.isArray(other.overlapAllowedWith)
        || !other.overlapAllowedWith.includes(beatId) || beatOverlaps.includes(other.id)
        || !['action', 'reaction'].includes(String(other.kind)) || !Array.isArray(other.actorIds) || !other.actorIds.length
        || !other.actorIds.every(id => approvedActorIds.has(String(id)))
        || ![...beatActorIds, ...other.actorIds].some(id => anonymousGroupIds.has(String(id)))
        || other.actorIds.some(id => beatActorIds.includes(id))
        || (Array.isArray(beat.dependsOn) && beat.dependsOn.includes(other.id))
        || (Array.isArray(other.dependsOn) && other.dependsOn.includes(beatId))) return []
      return [other.id]
    })
    if (!additions.length) return value
    reciprocalOverlapRepaired = true
    return { ...beat, overlapAllowedWith: [...beatOverlaps, ...additions] }
  })
  const compactCoverage = (value: unknown) => String(value ?? '').replace(/[\s，,。；;：:'"“”‘’（）()【】\-—]/g, '')
  let coverageDeclarationsRepaired = false
  const actualVisual = [shot.visualPrompt, shot.videoPrompt].filter((text): text is string => typeof text === 'string').join('。')
  const groupLabelById = new Map(groups.map(group => [group.id, group.label]))
  const dramaturgy = Array.isArray(shot.beatDramaturgy) ? shot.beatDramaturgy.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const row = value as RecordValue
    const source = sourceBeats.find(beat => beat.id === row.beatId)
    const observable = source?.observable as RecordValue | undefined
    if (!source || !Array.isArray(observable?.visual) || !Array.isArray(row.visual)) return value
    const sourceScopedBeats = beats.filter(value => (value as RecordValue).sourceBeatId === row.beatId) as RecordValue[]
    const requiredVisuals = observable.visual.filter((anchor): anchor is string => typeof anchor === 'string' && Boolean(anchor.trim()))
    const declared = row.visual.filter((anchor): anchor is string => typeof anchor === 'string').flatMap(anchor => {
      if (enactedVisualTextCovers(actualVisual, anchor)) return [anchor]
      const matching = sourceScopedBeats.filter(beat => ['action', 'reaction'].includes(String(beat.kind))
        && beat.textOrVocalization === anchor && Array.isArray(beat.actorIds) && beat.actorIds.length === 1)
      if (matching.length !== 1) return [anchor]
      const label = groupLabelById.get(String((matching[0].actorIds as unknown[])[0]))
      const actorBound = label && !anchor.includes(label) ? `${label}${anchor}` : ''
      if (actorBound && enactedVisualTextCovers(actualVisual, actorBound)) {
        coverageDeclarationsRepaired = true
        return [actorBound]
      }
      // A model may copy a supporting reaction into beatDramaturgy even though
      // the source did not approve it as a visual obligation. If that reaction
      // cannot satisfy any approved anchor, leave its real pacing action intact
      // but remove the false completion declaration that would otherwise make
      // an optional flourish block the whole scene.
      const requiredBySource = requiredVisuals.some(required => compactCoverage(anchor).includes(compactCoverage(required)))
      if (matching[0].kind === 'reaction' && !requiredBySource) {
        coverageDeclarationsRepaired = true
        return []
      }
      return [anchor]
    })
    const enacted = sourceScopedBeats
      .flatMap(value => {
        return [value.textOrVocalization, value.performanceInstruction].filter((text): text is string => typeof text === 'string')
      }).join('。')
    const additions = requiredVisuals
      .filter(anchor => !declared.some(item => compactCoverage(item).includes(compactCoverage(anchor)))
        && enactedVisualTextCovers(enacted, anchor))
    if (!additions.length) return value
    coverageDeclarationsRepaired = true
    return { ...row, visual: [...declared, ...additions] }
  }) : shot.beatDramaturgy
  const anonymousIdentityKeys = new Set([...labels, ...replacements.values()])
  const intent = shot.shotIntent as RecordValue | undefined
  const viewpointRepair = !cast.size && typeof intent?.viewpointCharacter === 'string'
    && anonymousIdentityKeys.has(intent.viewpointCharacter)
  const cleanNames = (names: unknown) => Array.isArray(names) ? names.filter(name => typeof name !== 'string' || !anonymousIdentityKeys.has(name)) : names
  const cleanEntrances = (entries: unknown) => Array.isArray(entries) ? entries.filter(entry => !(entry && typeof entry === 'object'
    && !Array.isArray(entry) && anonymousIdentityKeys.has(String((entry as RecordValue).name)))) : entries
  const world = shot.worldState as RecordValue | undefined
  const nextWorld = world && Array.isArray(world.characters)
    ? { ...world, characters: world.characters.filter(row => !(row && typeof row === 'object' && !Array.isArray(row) && anonymousIdentityKeys.has(String((row as RecordValue).name)))) }
    : world
  const candidate = { ...shot, pacing: { ...pacing, actorGroups: groups, beats },
    ...(viewpointRepair ? { shotIntent: { ...intent, viewpointCharacter: '观众' } } : {}),
    ...(coverageDeclarationsRepaired ? { beatDramaturgy: dramaturgy } : {}),
    characters: cleanNames(shot.characters), presentCharacters: cleanNames(shot.presentCharacters),
    initialCharacters: cleanNames(shot.initialCharacters), endCharacters: cleanNames(shot.endCharacters),
    enteringCharacters: cleanEntrances(shot.enteringCharacters),
    ...(nextWorld ? { worldState: nextWorld } : {}) }
  if (JSON.stringify(candidate) === JSON.stringify(shot)) return undefined
  return { candidate, changes: [
    { path: 'pacing.actorGroups', reason: 'canonicalized-approved-anonymous-actors' },
    ...(viewpointRepair ? [{ path: 'shotIntent.viewpointCharacter', reason: 'canonicalized-anonymous-audience-viewpoint' }] : []),
    ...(reciprocalOverlapRepaired ? [{ path: 'pacing.beats[*].overlapAllowedWith', reason: 'completed-reciprocal-approved-group-overlap' }] : []),
    ...(coverageDeclarationsRepaired ? [{ path: 'beatDramaturgy[*].visual', reason: 'restored-source-visual-declaration-from-executed-action' }] : []),
    ...(unsupportedReactionIds.size ? [{ path: 'pacing.beats', reason: 'removed-unapproved-anonymous-reaction', beatIds: [...unsupportedReactionIds] }] : []),
  ] }
}

/** Complete a one-sided overlap declaration only for disjoint, approved
 * action/reaction performers when at least one side is an explicitly declared
 * actor group. The full compiler still checks source coverage, dependencies,
 * resources and timing after this metadata repair. */
export function repairStoryboardReciprocalGroupOverlaps(value: unknown, expected: RecordValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const shot = value as RecordValue
  if (Array.isArray(shot.segments)) return undefined
  const pacing = shot.pacing as RecordValue | undefined
  const scene = expected.scene as RecordValue | undefined
  if (!pacing || !Array.isArray(pacing.actorGroups) || !Array.isArray(pacing.beats) || !Array.isArray(scene?.cast)) return undefined
  const groupIds = new Set(pacing.actorGroups.flatMap(value => value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as RecordValue).id === 'string' ? [String((value as RecordValue).id)] : []))
  const approved = new Set([...groupIds, ...scene.cast.filter(name => typeof name === 'string') as string[]])
  const beats = pacing.beats as RecordValue[]
  let changed = false
  const repaired = beats.map(beat => {
    if (!['action', 'reaction'].includes(String(beat.kind)) || typeof beat.id !== 'string'
      || !Array.isArray(beat.actorIds) || !beat.actorIds.length || !beat.actorIds.every(id => approved.has(String(id)))
      || !Array.isArray(beat.overlapAllowedWith)) return beat
    const beatId = beat.id
    const actorIds = beat.actorIds
    const overlaps = beat.overlapAllowedWith
    const additions = beats.flatMap(other => {
      if (other === beat || !['action', 'reaction'].includes(String(other.kind)) || typeof other.id !== 'string'
        || !Array.isArray(other.actorIds) || !other.actorIds.length || !other.actorIds.every(id => approved.has(String(id)))
        || !Array.isArray(other.overlapAllowedWith) || !other.overlapAllowedWith.includes(beatId)
        || overlaps.includes(other.id) || other.actorIds.some(id => actorIds.includes(id))
        || ![...actorIds, ...other.actorIds].some(id => groupIds.has(String(id)))
        || (Array.isArray(beat.dependsOn) && beat.dependsOn.includes(other.id))
        || (Array.isArray(other.dependsOn) && other.dependsOn.includes(beatId))) return []
      return [other.id]
    })
    if (!additions.length) return beat
    changed = true
    return { ...beat, overlapAllowedWith: [...overlaps, ...additions] }
  })
  return changed ? { candidate: { ...shot, pacing: { ...pacing, beats: repaired } }, changes: [{
    path: 'pacing.beats[*].overlapAllowedWith', reason: 'completed-reciprocal-approved-group-overlap',
  }] } : undefined
}

/** Companion diagnostics use the same obligations and immutable candidate as
 * acceptance, while collecting independent failures for a single repair. */
export function storyboardDiagnostics(value: unknown, expected: RecordValue) {
  return collectHistoricalStoryboardDiagnostics(value, expected)
}

function reviewedStoryboardResult(segments: RecordValue[], audit: RecordValue, contentReview?: RecordValue) {
  const annotated = segments.map((segment) => ({ ...segment,
    scriptValidation: { ...audit, policy: 'executable-with-advice-v1',
      ...(Array.isArray(segment.qualityWarnings) ? { scope: 'executable-structure', qualityDisposition: 'manual-review-v1', qualityStatus: 'needs_attention' } : {}),
      warnings: [...storyboardAdvisories(segment), ...(Array.isArray(segment.qualityWarnings) ? segment.qualityWarnings : [])] },
    ...(contentReview ? { contentReview } : {}) }))
  return annotated.length > 1 ? { ...annotated[0], [STORYBOARD_SEGMENTS_KEY]: annotated } : annotated[0]
}

function storyboardSourceScopeInstruction(scene: RecordValue, durationV2: boolean, previous?: RecordValue) {
  const beats = Array.isArray(scene.requiredBeats) ? scene.requiredBeats as RecordValue[] : []
  if (!beats.length) return ''
  const closure = typeof scene.closesUnit === 'boolean'
    ? `最后分段的 storyProgress.status 必须为 ${scene.closesUnit ? 'complete、pendingActions=[]' : 'continuing，并保留完整戏尚待后续场景实现的行动'}，此前分段为 continuing。`
    : '最后分段仍须遵循已批准的完整戏结束边界。'
  const audioScope = durationV2 ? '每段只能使用一种音轨类型；画外旁白 narration 与出镜对白、吟唱或歌唱分别编入连续分段，并在同一次响应完整返回。画外旁白声部的合法写法为 kind=speech、deliveryStyle=narration、actorIds=["旁白"]，该段 audioType=旁白；“旁白”是画外声部身份，不加入 characters、presentCharacters、initialCharacters、endCharacters 或 worldState.characters，也不需要演员资产。旧模板中 actorIds 仅用场内人物全名的概括说明，对此旁白声部使用本条明确例外；场内动作仍绑定其实际人物，不能把旁白台词挂到出镜角色名下。保留已批准的原台词、说话人和 deliveryStyle，不能把旁白改成角色对白，也不能把吟唱改成旁白来适配单一音轨。若返回分段，JSON顶层只有segments，每个元素必须包含原模板的全部独立分镜字段（含id、contentContractVersion、dramaticSceneId），不得改用segmentId/segmentIndex或把共同字段提到顶层省略。' : ''
  const inherited = scene.continuityFromPrevious === true && Array.isArray(previous?.presentCharacters)
    ? previous.presentCharacters.filter((name): name is string => typeof name === 'string' && Boolean(name.trim())) : []
  const identityScope = [...new Set([...(Array.isArray(scene.cast) ? scene.cast.filter((name): name is string => typeof name === 'string') : []), ...inherited])]
  const anonymousScope = Array.isArray(scene.cast) && !identityScope.length && cinematicShotAllowsEmptyCast({}, scene)
    ? '本镜没有批准的具名人物：characters、presentCharacters、initialCharacters、enteringCharacters、endCharacters、worldState.characters 使用空数组，shotIntent.viewpointCharacter="观众"。匿名真人群演仍须真实完成批准动作，通过 pacing.actorGroups/actorIds 绑定，不能为填满人物数组虚构历史人物。匿名发声者与听众必须分别声明 actorGroups；audioText 的说话人名称须与该 speech.actorIds 指向的 group.label 一致，其自身站立/移动/讲述动作也绑定本人群体，不能因角色匿名而把说话和本人动作交给听众。保留全部有词对白、无词 vocalization 及原音轨类型，不得改旁白或静音来解决身份绑定。' : ''
  const anonymousVoiceScope = anonymousScope
    ? '新编匿名角色有词对白且没有具名肖像绑定时，只有原义务未要求可见嘴部同步说话或指定画内发声，才优先采用明确的角色画外对白：audioType=对白、speech.deliveryStyle=dialogue、actorIds绑定该匿名角色group.id，audioText标签写“群体label（画外）：原对白”。可通过该角色背侧面、听众与动作反应完成原讲述义务，不能同时要求正脸可见开口/同步口型。画外角色对白仍是原角色的声音，不改为旁白、不删改已批准台词。原义务强制画内发声或可见口型时保留原要求，不得为规避声音绑定改画外；历史候选的原标记也不得被本地修复自动更改。' : ''
  const castScope = durationV2 && Array.isArray(scene.cast)
    ? `已批准 scene.cast=${JSON.stringify(scene.cast)}，当前镜动作人物身份使用上述原全名，不用新 actorGroup 重新命名。${inherited.length ? `本镜为连续镜头，前镜仍在场的具名人物=${JSON.stringify(inherited)} 也是本镜批准的连续性身份；即使不承担本镜动作且不在 scene.cast 中，也必须按实际在场关系保留在 initialCharacters、presentCharacters、endCharacters 与 worldState.characters，不能把继承人物改成匿名群体或为过校验删除。` : ''}group.id 只作 pacing 的 actorIds 等群体引用；匿名病患、家属、百姓等群体的到场、移动和反应直接写在绑定该 group.id 的 action 中，不加入人物连续性名单或 enteringCharacters。characters、presentCharacters、initialCharacters、enteringCharacters.name、endCharacters 与 worldState.characters.name 等人物字段不能放 group.id，且只能使用本镜批准具名身份 ${JSON.stringify(identityScope)}。` : ''
  const anchorScope = durationV2 ? '\n【声画锚点执行契约】声明层保留已批准 requiredBeats 原锚点和本段 beatDramaturgy/beatCoverage 声画义务；执行层在对应 sourceBeatId 的 pacing.beats 中实际表演。身份字段与首尾帧人物点名仍用批准全名，不把“两人/二人/双方”填入 actorIds 或人物名单；已批准原锚点中的代称不因此改写。简单入场沿用同主体入场规则；共享校验器已识别的明确双主体互动仅在批准场景恰有两名角色、同一 kind=action 的 actorIds 恰为这两名角色时，允许原代称或两人全名联合主语，仅可插入批准场地或同节拍来源原文已有的地点/持物修饰，动作谓词保留原字，主体身份与对象不变。mustShow 与 observable.visual 若是同一动作的简述和细述，可由这一实际动作共同满足，不要求再演一次或机械堆砌短句。匿名群体名称可以保留明确数量及角色并带跪拜等姿态修饰，audioText 仍使用同一个已声明群体身份。齐声应和/齐声高呼等群体表演说明写在 speech.performanceInstruction，speech.textOrVocalization 只写实际说出的原台词；不得为机械匹配 mustShow 把“万人齐声应和”等导演说明塞入台词。beatDramaturgy.audio 可写“群体齐声应和：原台词”，其表演与台词分别在同源群体 speech 中执行。未知或未被上述有限规则识别的复合锚点仍须连续原文，不允许任意同义改写；否定、计划、回忆、旁观或命令不算当场执行。动作必须落在 textOrVocalization 或适用的 performanceInstruction，仅 completion.evidenceAnchor/finalState、标题、静态帧或手写 videoPrompt 不构成可执行正文；旧模板把 evidenceAnchor 与动作正文并列的概括，以本条为准。台词、说话人和声部仍按原契约保留。' : ''
  return `\n【本次分镜覆盖范围】当前场景 ${String(scene.id ?? '')} 的已批准 requiredBeats=${JSON.stringify(beats)}。本次调用必须按原顺序完整交付 ${JSON.stringify(beats.map(beat => beat.id))} 的全部动作、原台词、function/stateChange 和声画锚点。单个分镜的 coveredBeatIds 必须覆盖本次全部节拍；若 15 秒放不下，同一次响应返回完整 {"segments":[...]}，所有分段合计覆盖全部原节拍，不能只返回首段，不能以 pendingActions 承诺以后再生成本次未交付的节拍，也不能仅补填未实际实现的 id。${audioScope}${castScope}${anonymousScope}${anonymousVoiceScope}每段只承担其分配节拍的完成条件；分段不改变完整戏的结束边界，${closure}${anchorScope}`
}

/** App supplies the frame-bound writer projection as expected.previousShot.
 * Append it at execution time so saved nodes with an old/empty template path
 * receive the same canonical facts as validation, including on every repair. */
function storyboardOpeningStateInstruction(expected: RecordValue) {
  const scene = expected.scene as RecordValue | undefined
  const previous = expected.previousShot as RecordValue | undefined
  const evidence = previous?.worldStateEvidence as RecordValue | undefined
  if (scene?.continuityFromPrevious !== true || evidence?.method !== 'actual-tail-image' || !previous?.worldState) return ''
  const principleTail = expected.qualityMode === 'principle-v1' && isCinematicShot(previous) && scene.continuityMode === 'tail_continuation'
    && evidence.qualityPolicy === 'principle-v1' && typeof evidence.frame === 'string' && /^\/generated\/[\w./-]+\.(?:jpg|jpeg|png|webp)$/i.test(evidence.frame)
  return `\n【权威开场继承状态】以下JSON与本次校验使用同一份前镜可信投影：${JSON.stringify(previous.worldState)}\n来源previousShotId=${JSON.stringify(previous.id)}，实际尾帧=${JSON.stringify(evidence.frame)}。本镜worldState中已有在场人物的position/heldProps/pendingAction逐字段继承该JSON：unknown字段按该JSON原样继承（例如{"status":"unknown"}），不得从附件图像、尾帧文字描述或本镜拟拍动作升级为observed；即使能描述图中站位，也不代表获得新的结构化实测认证。observed必须完整保留原value/evidence，不改成同义句，不降为unknown。新入场人物按已批准入场声明保留unknown。场景、人物名单、入场/离场与连续性仍须单独满足原契约；此处不授权改写作者动作、瞬移人物或转移道具。模板中的旧空白状态字段不覆盖以上JSON。`
    + (principleTail ? '\n【原则模式实际尾帧续拍】本镜保持cinematic-v1、tail_continuation、same_frame以及前镜id、开场人物和世界状态，visualPrompt可追加与实际尾帧一致的场景及机位说明，不要求与前镜尾帧描述逐字相同。不得借追加说明改变场所、在场人物、实测位置或道具；旧模板的逐字复制要求以本条实际状态继承契约为准。' : '')
}

export async function generateHistoricalStoryboard(options: {
  prompt: string
  expected: RecordValue
  generate: (prompt: string) => Promise<unknown>
  canGenerate?: () => boolean
  initialCandidate?: unknown
  initialRawResponse?: unknown
  review?: (candidate: RecordValue) => Promise<RecordValue>
  atomic?: boolean
  onAttempt?: (attempt: StoryboardAttempt) => void
}): Promise<RecordValue> {
  const sourceScene = options.expected.scene as RecordValue ?? {}
  const previousShot = options.expected.previousShot as RecordValue | undefined
  const cinematic = options.expected.requireDramaContract === true || sourceScene.contentContractVersion === 'cinematic-v1'
  // Input conflicts need upstream diagnosis before the first model request,
  // rather than twenty attempts asking a candidate to change its own inputs.
  const continuityWarnings: string[] = []
  const continuityOptions = { qualityDisposition: options.expected.qualityDisposition, warnings: continuityWarnings }
  if (cinematic) storyboardContinuityContract(sourceScene, previousShot, continuityOptions)
  const continuityInstruction = cinematic ? storyboardContinuityInstruction(sourceScene, previousShot, continuityOptions) : ''
  if (continuityWarnings.length) options = { ...options, expected: { ...options.expected,
    storyboardQualityWarnings: [...(Array.isArray(options.expected.storyboardQualityWarnings) ? options.expected.storyboardQualityWarnings : []), ...new Set(continuityWarnings)] } }
  const attempts: StoryboardAttempt[] = []
  const localRepairs: unknown[] = []
  let candidate: unknown = options.initialCandidate
  // Keep exact supplier authorship apart from the mechanically normalized
  // working candidate. The checkpoint is repair evidence, never shot output.
  let lastRawResponse = options.initialRawResponse
  let lastCandidate = candidate === undefined ? undefined : structuredClone(candidate)
  let generationAttempts = 0
  let suffix = ''
  let contentError = ''
  let mode: 'repair' | 'split' = 'repair'
  let sourceSplitRequired = false
  let lastSignature = ''
  let repeatedRounds = 0
  const durationV2 = options.expected.pacingVersion === 'duration-v2' || (options.initialCandidate as RecordValue)?.pacing && ((options.initialCandidate as RecordValue).pacing as RecordValue).version === 'duration-v2'
  const legacySplitInstruction = '\n【自动拆镜】返回 {"segments":[...]}，至少两段，每段完整字段、动态3–15秒、独立时间轴、pacing与storyProgress。当前 scene.requiredBeats 是本次唯一可分配义务；previousScriptBeatDramaturgy 只用于识别已完成历史，禁止将其动作、对白或锚点写回任一新分段。按顺序分配 coveredBeatIds，普通节拍恰好覆盖一次。如果一个复杂节拍需要多段，可在相邻段重复其 id，但必须为每段增加 beatCoverage:[{"beatId":"原始id","anchors":["本段承担的原始mustShow"]}]；anchors 只能从当前 scene.requiredBeats 同 beatId 的 mustShow 逐字选取；observable.visual 中未列入 mustShow 的已批准动作只在 beatDramaturgy.visual 和实际 pacing 中分配，不填入 anchors，也不能删除或重复；不得填 observable.audio、对白或已完成前镜动作；合起来每个原始锚点恰好分配一次，实际动作不能重复或遗漏。没有 mustShow 分配、只承担已批准 observable.visual 或音频的分段使用anchors:[]；声画义务仍须在beatDramaturgy和pacing中完整执行，音频按顺序逐字承接。第二段起继续同一戏；tail_continuation时initialCharacters 等于前段 endCharacters，visualPrompt 原样复制前段 lastFramePrompt 静态正文，continuity.previousShotId 指向前段 id。cinematic-v1也可选择coverage_cut反打，保持同unit、settingId及presentCharacters，characters只列本段实际可见/行动者，保留开场worldState及人物/戏剧节拍；未实拍分段的计划状态不能声称observed。保留全部台词与剧情，按自然4.5字/秒预算，禁止拖腔或加速补救；非最后分段storyProgress.status=continuing且声明pendingActions；最后分段继承原完整戏闭合契约：scene.closesUnit=false时仍为continuing，只有scene.closesUnit=true时才为complete。'
  const splitInstruction = durationV2 ? legacySplitInstruction.replace('按自然4.5字/秒预算', '沿用duration-v2共享timingPolicy，按各声部deliveryStyle及结构化beats上界预算；跨段依赖必须绑定已完成的原节拍，程序编译窗口与哈希') : legacySplitInstruction
  // Parent allocation and child repairs share the caller's writer budget. Repeated diagnostics
  // change the repair instructions but must not silently reduce the configured attempt limit.
  const maxAttempts = resolveDramaGenerationLimit(options.expected.maxGenerationAttempts, 2, options.expected.qualityDisposition)
  const baseWriterPrompt = options.prompt.includes('cinematic-v1') || options.expected.requireDramaContract === true
    ? refreshDramaticExpressionPrompt(options.prompt, 'storyboard') : options.prompt
  const writerPrompt = durationV2 ? `${baseWriterPrompt}\n【结构与声部校验】mapAnnotations 只属于 historical_map 路线；live_action 分镜不得输出该字段。动作正文若写“问答”、喊话或其他实际发声，必须在同一演员的 speech/vocalization 声部及可执行时间窗中落实；若批准剧情只要求动作，不要添加未经批准的交谈。` : baseWriterPrompt
  // A recovered draft receives the complete current normalizer and validator
  // before a writer request. Its preflight spends no part of the new budget.
  const hasRecoveredCandidate = candidate !== undefined
  for (let attempt = 0; attempt < maxAttempts + Number(hasRecoveredCandidate); attempt += 1) {
    if (candidate === undefined) {
      if (options.canGenerate && !options.canGenerate()) break
      const rawResponse = await retryHistoricalText(() => options.generate(writerPrompt
        + (durationV2 ? '\n【duration-v2 分镜执行规则】逐原sourceBeatId保留完整台词、可观察动作与主体，使用timingPolicy、deliveryStyle、beats的保守上界、dependsOn、双方overlapAllowedWith及完成证据通道。程序统一生成videoPrompt窗口、speechWindows、sampleTimes和scheduleHash，不另输出activityWindows/actionSeconds/reactionSeconds，不套用旧唯一最短时长公式。已声明无词哼唱也必须有正数预算与实际可听的完成条件；动作依赖和主体资源不得为缩短时长而删改。选择安全预算以上的允许整数时长，超15秒保留全部原义务拆段；没有实际成片时不得写observed。'
          : '\n【分镜执行规则】时间轴可用“0秒-4秒：”或“0-4秒：”。3–6段和650字符是建议，不因段数、描述长或姿态保持而重写。必须从0连续覆盖duration，保留完整台词及原动作；预算错误只修算术与边界，不把旁白时间当成无声空等。action/reaction预算及overlapWith可由已有合法窗口计算，程序会修正这些冗余字段；不能缺失必要活动或伪造实测状态。')
        + (durationV2 ? '\n【入场与正式排程】enteringCharacters 的 startSecond/endSecond 是估计值，程序按同一人物唯一的实际入场 action 编译窗口投影。完整 path 必须写入该 action 的 textOrVocalization 或 performanceInstruction；只写入手工 videoPrompt 不会进入实际发送正文。简单“人名+入内/入画”锚点允许在同人物的实际入场动作中加入持物细节，但不能删除入场、写成入场计划或旁观，也不能安排人物在入场前说话。' : '')
        + '\n【换场首帧可核验起点】scene_cut 使用 reference 首帧时，从零秒开始押送、跨门或走近的具名执行者必须在首帧可见，列入 initialCharacters，在批准起点静止站立且留出后续路线；即使站在门外，只要已入画就不是 enteringCharacters。保留原入院/走近动作及全部束缚、押解状态，不要让执行者零秒在画外、审核时无法核对起点。'
        + (mode === 'split' ? splitInstruction : '') + suffix
        + storyboardSourceScopeInstruction(options.expected.scene as RecordValue ?? {}, Boolean(durationV2), options.expected.previousShot as RecordValue | undefined)
        + storyboardOpeningStateInstruction(options.expected) + continuityInstruction), undefined, options.canGenerate).catch(error => {
          if (!attempts.length) throw error
          throw new Error(`分镜生成中断：${error instanceof Error ? error.message : String(error)}；此前候选诊断：${JSON.stringify(attempts)}`, { cause: error })
        })
      generationAttempts += 1
      lastRawResponse = rawResponse
      candidate = storyboardCandidate(rawResponse)
      lastCandidate = structuredClone(candidate)
    }
    if (candidate && typeof candidate === 'object' && Array.isArray((candidate as RecordValue).segments) && ((candidate as RecordValue).segments as unknown[]).length === 1) candidate = ((candidate as RecordValue).segments as unknown[])[0]
    if (candidate && typeof candidate === 'object' && !Array.isArray((candidate as RecordValue).segments)) {
      const scene = options.expected.scene as RecordValue
      if (scene?.id) candidate = { ...candidate as RecordValue, id: scene.id }
      const previous = options.expected.previousShot as RecordValue | undefined
      if (scene?.continuityFromPrevious !== true && previous && candidate) {
        const current = candidate as RecordValue
        const continuity = current.continuity as RecordValue | undefined
        if (!isCinematicShot(current) && (!continuity || continuity.bridgeType === 'opening' || continuity.bridgeType === 'cut')) {
          candidate = { ...current, firstFrameMode: 'reference', continuity: { previousShotId: previous.id, bridgeType: 'cut', bridgeAnchor: continuity?.bridgeAnchor || String(scene.purpose ?? scene.title ?? '后续剧情换场') } }
        }
      }
      if (scene?.continuityFromPrevious === true && previous?.lastFramePrompt && !isCinematicShot(candidate as RecordValue)) {
        const current = candidate as RecordValue
        candidate = { ...current, firstFrameMode: 'reuse_previous_tail', visualPrompt: String(previous.lastFramePrompt).split('【静态尾帧】')[0].trim(),
          continuity: { previousShotId: previous.id, bridgeType: 'same_frame', bridgeAnchor: '' } }
      }
    }
    const dramaturgyTypographyRepair = repairStoryboardDramaturgyTypography(candidate, options.expected)
    if (dramaturgyTypographyRepair) {
      candidate = dramaturgyTypographyRepair.candidate
      localRepairs.push(...dramaturgyTypographyRepair.changes)
    }
    const anonymousSpeakerRepair = repairStoryboardAnonymousSpeakerBindings(candidate, options.expected)
    if (anonymousSpeakerRepair) {
      candidate = anonymousSpeakerRepair.candidate
      localRepairs.push(...anonymousSpeakerRepair.changes)
    }
    const groupPerformanceRepair = repairGroupSpeechPerformance(candidate, options.expected)
    if (groupPerformanceRepair) {
      candidate = groupPerformanceRepair.candidate
      localRepairs.push(...groupPerformanceRepair.changes)
    }
    const anonymousEntranceIdentityRepair = normalizeStoryboardAnonymousEntranceIdentities(candidate, options.expected)
    if (anonymousEntranceIdentityRepair) {
      candidate = anonymousEntranceIdentityRepair.candidate
      localRepairs.push(...anonymousEntranceIdentityRepair.changes)
    }
    const anonymousActorRepair = options.expected.qualityDisposition === 'manual-review-v1' ? undefined : repairStoryboardAnonymousActorGroups(candidate, options.expected)
    if (anonymousActorRepair) {
      candidate = anonymousActorRepair.candidate
      localRepairs.push(...anonymousActorRepair.changes)
    }
    const reciprocalOverlapRepair = repairStoryboardReciprocalGroupOverlaps(candidate, options.expected)
    if (reciprocalOverlapRepair) {
      candidate = reciprocalOverlapRepair.candidate
      localRepairs.push(...reciprocalOverlapRepair.changes)
    }
    const openingStateRepair = repairStoryboardOpeningWorldState(candidate, options.expected)
    if (openingStateRepair) {
      candidate = openingStateRepair.candidate
      localRepairs.push(...openingStateRepair.changes)
    }
    const continuityRepair = repairStoryboardSplitContinuityMetadata(candidate)
    if (continuityRepair) {
      candidate = continuityRepair.candidate
      localRepairs.push(...continuityRepair.changes)
    }
    const coverageRepair = repairStoryboardSplitCoverageMetadata(candidate, options.expected)
    if (coverageRepair) {
      candidate = coverageRepair.candidate
      localRepairs.push(...coverageRepair.changes)
    }
    const metadataRepair = repairStoryboardPacingMetadata(candidate)
    if (metadataRepair) {
      candidate = metadataRepair.candidate
      localRepairs.push(...metadataRepair.changes)
    }
    const durationNormalization = normalizeDurationMetadata(candidate, options.expected)
    if (durationNormalization) {
      candidate = durationNormalization.candidate
      localRepairs.push(...durationNormalization.changes)
    }
    try {
      const segments = validate(candidate, options.expected)
      const contentReview = options.review ? await options.review(segments.length > 1 ? { [STORYBOARD_SEGMENTS_KEY]: segments } : segments[0]).catch((error) => { contentError = error instanceof Error ? error.message : String(error); throw error }) : undefined
      contentError = ''
      const audit = { passed: true, scope: 'script-contract', attempts, generationAttempts,
        ...(hasRecoveredCandidate ? { recoveredCandidate: true } : {}), ...(localRepairs.length ? { localRepair: true, localRepairs } : {}) }
      return reviewedStoryboardResult(segments, audit, contentReview)
    } catch (error) {
      if (contentError && !contentError.startsWith('HISTORY_CONTENT_REJECTED:')) throw error
      // Local repairs may only rebind existing dialogue/entrances or re-derive the pacing clock. They
      // must pass the whole contract; never append missing story content to pass.
      for (const repair of contentError ? [] : [repairStoryboardNarrationEntrances, repairStoryboardDialogueBindings, reconcileStoryboardPacingBudget]) {
        const repaired = repair(candidate)
        if (!repaired) continue
        try {
          const segments = validate(repaired, options.expected)
          const contentReview = options.review ? await options.review(segments.length > 1 ? { [STORYBOARD_SEGMENTS_KEY]: segments } : segments[0]) : undefined
          const audit = { passed: true, scope: 'script-contract', attempts, generationAttempts,
            ...(hasRecoveredCandidate ? { recoveredCandidate: true } : {}), localRepair: true, localRepairs }
          return reviewedStoryboardResult(segments, audit, contentReview)
        } catch (error) {
          candidate = repaired
          if (error instanceof Error && error.message.includes('HISTORY_CONTENT_REJECTED')) contentError = error.message
          else if (error instanceof Error && /HISTORY_REVIEW_INVALID|HTTP|network|fetch failed/.test(error.message)) throw error
        }
      }
      const errors = [...storyboardDiagnostics(candidate, options.expected), ...(contentError ? [contentError] : [])]
      contentError = ''
      const event: StoryboardAttempt = { attempt: attempt + 1, mode, errors,
        source: hasRecoveredCandidate && attempt === 0 ? 'recovered-candidate' : 'generated' }
      attempts.push(event)
      options.onAttempt?.(event)
      // A split shares the writer budget too. Stop here with the actual parent
      // diagnostics instead of entering an empty child and losing the cause.
      if (options.canGenerate && !options.canGenerate()) break
      // Missing words are not proof that 15 seconds is too short. Repair the
      // single shot first. Only time overflow or exhausted coverage repair splits.
      const sourceScene = options.expected.scene as RecordValue
      const beats = sourceScene?.requiredBeats
      const sourceCoverageMissing = errors.some(message => message.includes('STORYBOARD_COVERAGE_INCOMPLETE:')
        && /coveredBeatIds|sourceBeatIds|未分配(?:任何|完整)声画表演/.test(message))
      const multiSource = Array.isArray(beats) && beats.length > 1
      const candidates = Array.isArray((candidate as RecordValue)?.segments) ? (candidate as RecordValue).segments as RecordValue[] : [candidate as RecordValue]
      const mixedTrack = errors.some(message => /STORYBOARD_PACING_INVALID:.*(?:对白轨不能将声部伪装为画外旁白|旁白声部须逐字覆盖 audioText)/.test(message))
        && candidates.some(shot => {
          const speech = (((shot?.pacing as RecordValue)?.beats ?? []) as RecordValue[])
            .filter(beat => beat.kind === 'speech')
          return speech.some(beat => beat.deliveryStyle === 'narration') && speech.some(beat => beat.deliveryStyle !== 'narration')
        })
      // A missing source id is a truncated response, not a missing word inside
      // an otherwise complete shot. Ask for the complete split immediately;
      // repeatedly allocating one call per beat would exhaust the shared budget.
      // The same applies when a complete v2 draft exceeds one clip's duration
      // or combines incompatible tracks. Retain its original voice types and
      // allocate the entire scene in one response, including on later repairs.
      if (durationV2 && multiSource && (sourceCoverageMissing || mixedTrack
        || errors.some(message => message.includes('STORYBOARD_TIMING_OVERFLOW:')))) sourceSplitRequired = true
      if (!options.atomic && multiSource && (sourceCoverageMissing || sourceSplitRequired)) mode = 'split'
      if (!options.atomic && !sourceSplitRequired && Array.isArray(beats) && beats.length > 1
        && (errors.some((message) => /STORYBOARD_(?:TIMING|REFERENCE)_OVERFLOW:/.test(message))
          // Legacy candidates do not identify missing source ids separately,
          // so retain their bounded per-beat fallback. Duration-v2 does: a
          // local anchor/wording defect is not evidence that the whole scene
          // needs splitting, and routing it to one beat discarded the other
          // approved obligations for the remaining writer budget.
          || (!durationV2 && attempt >= 2 && errors.some((message) => message.includes('STORYBOARD_COVERAGE_INCOMPLETE:'))))) {
        // Deterministic allocation: the model writes one obligation at a time,
        // rather than repeatedly inventing a split that loses the same beat.
        const planned: RecordValue[] = []
        for (const [index, beat] of (beats as RecordValue[]).entries()) {
          if (options.canGenerate && !options.canGenerate()) {
            throw new Error(`分镜修复未通过（共享生成预算已用尽，已规划 ${planned.length} 段，尚待节拍 ${String(beat.id)}；已阻止媒体生成）：${JSON.stringify(attempts)}`, { cause: error })
          }
          const previous = planned.at(-1) ?? options.expected.previousShot
          const partScene = { ...sourceScene, id: `${String(sourceScene.id)}-beat-${index + 1}`, title: String(beat.description), purpose: String(beat.description),
            requiredBeats: [beat], sequence: Number(sourceScene.sequence ?? 1) + index, targetDuration: sourceScene.targetDuration,
            completionCriteria: storyboardSegmentCompletionCriteria([beat]),
            ...(sourceScene.dramaticUnitId ? { closesUnit: index === beats.length - 1 && sourceScene.closesUnit === true } : {}),
            continuityFromPrevious: index ? true : sourceScene.continuityFromPrevious,
            ...(index && sourceScene.continuityMode ? { continuityMode: sourceScene.continuityMode === 'coverage_cut' ? 'coverage_cut' : 'tail_continuation' } : {}) }
          const partPrompt = promptForStoryboardScene(options.prompt, partScene, previous)
            + `\n【原场景分段关系】原场景目的=${String(sourceScene.purpose ?? '')}；全场完成条件=${JSON.stringify(sourceScene.completionCriteria ?? [])}，由全部分段共同实现。本段之后尚待原节拍=${JSON.stringify((beats as RecordValue[]).slice(index + 1))}。保留上述剧情的先后关系，本段只执行当前分配。`
          const part = await generateHistoricalStoryboard({ ...options, atomic: true, initialCandidate: undefined, initialRawResponse: undefined, review: undefined,
            prompt: partPrompt, expected: { ...options.expected, scene: partScene, previousShot: previous } }).catch(childError => {
              throw new Error(`分镜分段修复未通过（父场景 ${String(sourceScene.id)} 已校验 ${attempts.length} 次，当前节拍 ${String(beat.id)}；父子共享 ${maxAttempts} 次生成预算，已阻止媒体生成）：父场景诊断=${JSON.stringify(attempts)}；分段诊断=${childError instanceof Error ? childError.message : String(childError)}`, { cause: childError })
            })
          const parts = Array.isArray(part[STORYBOARD_SEGMENTS_KEY]) ? part[STORYBOARD_SEGMENTS_KEY] as RecordValue[] : [part]
          planned.push(...parts.map(cleanStoryboardForValidation))
        }
        const validated = validateHistoricalStoryboardSegments({ segments: planned }, options.expected)
        const contentReview = options.review ? await options.review({ [STORYBOARD_SEGMENTS_KEY]: validated }) : undefined
        return reviewedStoryboardResult(validated, { passed: true, scope: 'script-contract', strategy: 'ordered-beats', attempts }, contentReview)
      }
      if (errors.some((message) => message.includes('STORYBOARD_TIMING_OVERFLOW:') || (attempt >= 2 && message.includes('STORYBOARD_REFERENCE_OVERFLOW:')))
        || (!durationV2 && !options.atomic && Array.isArray(beats) && beats.length > 1 && attempt >= 2
          && errors.some((message) => message.includes('STORYBOARD_COVERAGE_INCOMPLETE:')))) mode = 'split'
      suffix = buildStoryboardRepairSuffix(errors.join('\n'), cleanStoryboardRepairCandidate(candidate), `第 ${attempt + 1} 次校验，修复全部问题`, options.expected.pacingVersion) + storyboardDialogueScheduleHint(candidate, Number(options.expected.productionSpeechRate) || 4, errors.join('\n'))
      if (mode === 'split') suffix += (durationV2 ? storyboardDurationSourceSplitHint(candidate, options.expected) : '')
        + '\n返回完整 {"segments":[...]}，保留已合规分段，不要重复生成相同错误。'
      candidate = undefined
      // A repeated diagnostic list is not proof that all later repairs will fail. Keep the
      // actionable candidate and escalate instructions within the explicit shared budget.
      const signature = errors.join('\u0000')
      if (signature === lastSignature) {
        repeatedRounds += 1
        suffix += `\n相同缺陷已连续出现 ${repeatedRounds + 1} 轮；必须针对下列诊断修改候选，不能只改完成声明。`
        suffix += durationV2 ? '\n【duration-v2 重复缺陷】按诊断中的field、expected、candidate修复对应字段：连续性修continuity/firstFrameMode及开场状态，时间预算修pacing依赖与声部，覆盖错误修实际动作；不能把所有错误都当作时长问题。批准scene与已完成前镜保持原值；若诊断明确scope=upstream，不能靠改写当前候选解决。超过15秒保留剧情拆段，不删原动作。'
          : '\n【上一轮定点修复后得到完全相同的缺陷清单】重复同样的措辞不可能通过。本轮必须换一种分镜写法：改变时间段的划分与句子结构（锚点短语仍须连续、台词仍逐字），必要时改用更多连续分段或把附加动作并入对白时间窗；不得再次提交与上一版相同的 videoPrompt、lastFramePrompt 或 beatDramaturgy 文本。'
      } else {
        repeatedRounds = 0
        lastSignature = signature
      }
    }
  }
  const message = `分镜修复未通过（${attempts.length} 次校验，${generationAttempts} 次真实生成，已阻止媒体生成）：${JSON.stringify(attempts)}`
  const diagnostics = attempts.at(-1)?.errors ?? []
  if (lastCandidate !== undefined && diagnostics.length && diagnostics.every(error => /^(?:STORYBOARD_|HISTORY_DRAMA_INVALID:|history\.storyboard(?:\.|\s))/.test(error))
    && !diagnostics.some(error => /scope=upstream|STORYBOARD_CONTINUITY_EVIDENCE_MISSING|HTTP\s+\d{3}|MODEL_|risk control|safety|refusal/i.test(error))) {
    throw new StoryboardCandidateValidationError(message, { lastRawResponse, lastCandidate, attempts, generationAttempts })
  }
  throw new Error(message)
}

/** Public scene partitions must retain only their own obligations. Otherwise a
 * retry of part 2 asks for all original beats again and recursively re-splits. */
export function sceneFromStoryboardSegment(source: unknown, segment: RecordValue, partIndex: number, partCount: number) {
  const scene = source && typeof source === 'object' && !Array.isArray(source) ? source as RecordValue : {}
  const beats = Array.isArray(scene.requiredBeats) ? scene.requiredBeats as RecordValue[] : []
  const ids = Array.isArray(segment.coveredBeatIds) ? segment.coveredBeatIds : []
  const allocation = Array.isArray(segment.beatCoverage) ? segment.beatCoverage as RecordValue[] : []
  const requiredBeats: RecordValue[] = beats.filter((beat) => ids.includes(beat.id)).map((beat) => {
    const partitioned = partitionDramaBeat(beat, segment)
    const rawAnchors = allocation.find((entry) => entry.beatId === beat.id)?.anchors ?? beat.mustShow
    const anchors = Array.isArray(rawAnchors) ? rawAnchors.map(String) : []
    return { ...partitioned, description: projectedDramaBeatDescription(beat, partitioned, anchors, scene), mustShow: anchors }
  })
  return {
    ...scene, id: segment.id, title: segment.title, cast: segment.characters,
    ...(isCinematicShot(segment) ? { contentContractVersion: segment.contentContractVersion,
      sourceSceneId: scene.sourceSceneId ?? scene.id,
      continuityMode: (segment.continuity as RecordValue)?.mode, settingId: (segment.worldState as RecordValue)?.settingId } : {}),
    sequence: Number(scene.sequence ?? 1) + partIndex,
    purpose: requiredBeats.length ? requiredBeats.map((beat) => beat.description).join('；') : `${String(scene.purpose ?? '')}；自动拆分段 ${partIndex + 1}/${partCount}`,
    ...(beats.length ? { requiredBeats, completionCriteria: storyboardSegmentCompletionCriteria(requiredBeats, beats) } : {}),
    historicalBasis: segment.historicalBasis, adaptationBoundary: segment.adaptationBoundary,
    targetDuration: segment.duration, continuityFromPrevious: partIndex === 0 ? scene.continuityFromPrevious === true : true,
    ...(scene.dramaticUnitId ? { closesUnit: partIndex === partCount - 1 && scene.closesUnit === true } : {}),
  }
}

function cleanStoryboardRepairCandidate(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate
  const cleaned = cleanStoryboardForValidation(candidate as RecordValue)
  if (Array.isArray(cleaned.segments)) cleaned.segments = cleaned.segments.map(cleanStoryboardRepairCandidate)
  return cleaned
}

export function cleanStoryboardForValidation(output: RecordValue) {
  return Object.fromEntries(Object.entries(output).filter(([key]) => !['raw', 'model', 'text', 'executionLogs', 'timingEstimate', 'scriptValidation', 'contentReview', 'factualReview', 'dramaturgyReview', 'repairProvenance', 'worldStateEvidence', 'qualityWarnings', 'passed', 'issues', 'reviewVersion', 'repairContext', STORYBOARD_SEGMENTS_KEY].includes(key)))
}

/** Reset branch outputs per iteration in both full runs and step/resume runs. */
export function loopIterationContext(base: RecordValue, resultVars: string[], itemVar: string, item: unknown, index: number, previous: unknown,
  completed: Array<{ resultVar: string; output: unknown; kind?: string }> = [], validationResultVars?: ReadonlySet<string>) {
  const context = { ...base }
  resultVars.forEach((key) => { delete context[key] })
  let next: RecordValue = { ...context, [itemVar]: item, loop: { index: index + 1, zeroIndex: index, previous } }
  for (const run of completed) next = applyNodeOutputToContext(next, run.resultVar, run.output,
    validationResultVars ? { validationResultVars, sourceKind: run.kind ?? '' } : undefined)
  return next
}

/** Replace stale embedded scene/previous data rather than appending a second,
 * contradictory task at the end of a long prompt. */
export function promptForStoryboardScene(prompt: string, scene: RecordValue, previous: unknown) {
  const prior = previous && typeof previous === 'object' ? previous as RecordValue : {}
  const priorBeats = prior.pacing && typeof prior.pacing === 'object' && Array.isArray((prior.pacing as RecordValue).beats)
    ? ((prior.pacing as RecordValue).beats as RecordValue[]) : []
  const completedStates = priorBeats.flatMap(beat => {
    const completion = beat.completion && typeof beat.completion === 'object' ? beat.completion as RecordValue : {}
    return typeof completion.finalState === 'string' && completion.finalState.trim()
      ? [{ sourceBeatId: beat.sourceBeatId, actorIds: beat.actorIds, finalState: completion.finalState }] : []
  })
  return prompt.replace(/上一镜承接信息（第一镜为空）：[\s\S]*?(?=当前场景：)/,
    `上一镜承接信息（第一镜为空）：\n${JSON.stringify(prior)}\n\n`)
    .replace(/当前场景：[\s\S]*?(?=\n\n史料原文：|$)/,
      `当前场景：${JSON.stringify(scene)}`)
    + `\n【本次唯一任务】只生成 ${String(scene.id)}。当前节拍 ${JSON.stringify(scene.requiredBeats)} 必须完整拍摄，不能用单纯提及替代人物到场或动作发生。本段完成条件仅为 ${JSON.stringify(scene.completionCriteria ?? [])}；同一完整戏其他节拍及其完成条件由其他分段承担，不能在本段抢演。上一镜 id=${String(prior.id ?? '')}；上一镜已完成的具名人物与匿名 actorGroups 末态=${JSON.stringify(completedStates)}，这些是本镜开场状态，不得重新表演到达该状态的动作；只执行当前 requiredBeats 与上一镜 pendingActions 的交集。continuityFromPrevious=${String(scene.continuityFromPrevious === true)}，continuityMode=${String(scene.continuityMode ?? '')}。前镜只有计划分镜、没有实际尾帧证据时，开场 worldState 事实保持 unknown，不把计划末态写成 observed。`
}

export async function retryHistoricalText<T>(request: () => Promise<T>, wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), canRetry?: () => boolean): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await request() } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (canRetry?.() === false || modelRetryStopped(message) || /retryExhausted/.test(message) || attempt >= MAX_NODE_ATTEMPTS - 1 || !/error code:\s*(?:408|429|5\d\d)|upstream error|fetch failed|network|ECONN|timeout|HTTP (?:408|429|5\d\d)|"status"\s*:\s*(?:408|429|5\d\d)/i.test(message)) throw error
      await wait(750 * (attempt + 1))
    }
  }
}

export function plannedSpeechWindows(shot: RecordValue) {
  const text = String(shot.audioText ?? '')
  if (isCinematicShot(shot) && shot.audioType === '环境声' && !text.trim()) return []
  if (shot.audioType === '旁白') return [{ start: 0.5, end: Number(shot.duration ?? 15) - historyTailSeconds(shot), text }]
  const prompt = String(shot.videoPrompt ?? '').split(/【(?!\s*(?:第\s*)?\d)/)[0]
  const matches = storyboardTimelineMatches(prompt)
  const normalize = (value: string) => value.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '')
  return text.split(/\n+/).filter(Boolean).map((line) => {
    const content = line.replace(/^[^：:]+[：:]/, '')
    const index = matches.findIndex((match, i) => normalize(prompt.slice(match.index! + match[0].length, matches[i + 1]?.index)).includes(normalize(content)))
    if (index < 0) throw new Error('对白没有可用于成片核对的时间窗')
    return { start: Number(matches[index][1]), end: Number(matches[index][2]), text: content }
  })
}
