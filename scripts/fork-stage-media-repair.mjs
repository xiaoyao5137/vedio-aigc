// Import already-generated, explicitly reviewed replacements into a NEW record.
// Default dry-run; no model, media-generation or source-record mutation occurs.
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { aggregateConcatReviews } from '../src/concat-review.ts'
import { assessAudioVisualEventEvidence } from '../src/audio-visual-event-evidence.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { prepareStageAudioReview, rewriteLiveOutputReferences } from './review-stage-audio.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const own = (value, key) => Object.hasOwn(value, key) && value[key] !== undefined
const fail = message => { throw Error(`STAGE_MEDIA_REPAIR_INVALID: ${message}`) }
const roles = { shot: 'shot_script', take: 'video_take', evidence: 'video_evidence', accepted: 'video_shot' }
const snapshotFields = new Set(['context', 'inputs', 'inputContext', 'routeInputContext', 'routeInputOverrides', 'loopPrevious', 'loopItem', 'retryFeedback', 'branchState', 'branchCarry'])
const reviews = new Set(['shot_script_review', 'media_review', 'media_observations', 'media_requirement_reviews'])
const scope = run => JSON.stringify([run.loopGroupId ?? null, run.loopIndex ?? null])
const clipUrl = clip => typeof clip === 'string' ? clip : clip?.url
const tail = value => value.extractedLastFrameUrl ?? value.lastFrameUrl ?? value.frames?.at(-1)
const referencesUrl = (value, url) => nonempty(url) && (value === url || Array.isArray(value) && value.some(item => referencesUrl(item, url))
  || object(value) && Object.values(value).some(item => referencesUrl(item, url)))
const body = shot => String(shot.audioText ?? '').split(/\r?\n/).filter(nonempty)
  .map(line => shot.audioType === '对白' ? line.replace(/^\s*[^：:]+[：:]\s*/, '') : line.replace(/^\s*旁白[：:]\s*/, '')).join('').replace(/[\p{P}\p{Z}\s]/gu, '')
const outputHash = (run, hash) => hash({ present: own(run, 'output'), ...(own(run, 'output') ? { output: run.output } : {}) })

function validateMedia(shot, take, evidence, accepted, label) {
  if (![shot, take, evidence, accepted].every(object) || ![shot.id, take.url, evidence.url, evidence.evidenceUrl].every(nonempty)) fail(`${label} lacks a complete shot/take/evidence/accepted identity`)
  const quality = object(accepted.qualityReview) ? accepted.qualityReview : {}
  if (accepted.manualDecisionRequired === true || quality.manualDecisionRequired === true
    || accepted.concatAllowed === false || quality.concatAllowed === false
    || quality.canProceed === false || quality.status === 'rejected'
    || accepted.technicalValidation?.passed === false) {
    fail(`${label} still has an active manual hold or media rejection; passed=true does not authorize concat`)
  }
  if (evidence.originalUrl !== take.url || accepted.originalUrl !== take.url || accepted.url !== evidence.url || accepted.evidenceUrl !== evidence.evidenceUrl) fail(`${label} media triplet points to different original videos or evidence`)
  if (evidence.decoded !== true || accepted.decoded !== true || !['duration', 'width', 'height'].every(key => Number.isFinite(evidence[key]) && evidence[key] > 0 && accepted[key] === evidence[key])) fail(`${label} lacks matching decoded media metadata`)
  if (!Array.isArray(evidence.frames) || !evidence.frames.length || !evidence.frames.every(nonempty) || !nonempty(tail(evidence)) || tail(accepted) !== tail(evidence)) fail(`${label} lacks matching real frame/tail evidence`)
  if (accepted.passed !== true) fail(`${label} replacement is not an accepted clip; retain it separately rather than splicing a failed result`)
  const scheduleHash = shot.scheduleHash ?? shot.pacing?.scheduleHash
  if (scheduleHash) {
    if (take.params?.scheduleHash !== scheduleHash || accepted.params?.scheduleHash !== scheduleHash) fail(`${label} take/acceptance uses a different shot schedule`)
    if (evidence.evidenceRequest?.scheduleHash !== scheduleHash) fail(`${label} evidence was not collected for the replacement schedule`)
  }
}

function continuityReview(value, label, required) {
  if (!object(value) || !['verified', 'not-applicable'].includes(value.status) || !nonempty(value.reason)) fail(`${label} requires an explicit continuity disposition and reason`)
  if (required && value.status !== 'verified') fail(`${label} changes a first/tail dependency and requires verified continuity`)
  if (value.status === 'verified' && (!Array.isArray(value.evidenceRefs) || !value.evidenceRefs.length || !value.evidenceRefs.every(nonempty))) fail(`${label} verification requires actual evidence references`)
}

function targetedRepairReview(repair) {
  const current = repair.accepted.new, old = repair.accepted.old
  const media = (accepted, evidence) => ({ url: evidence.url, duration: evidence.duration,
    sha256: evidence.sha256 ?? evidence.sourceSha256 ?? accepted.sha256 ?? accepted.sourceSha256 })
  const prior = assessAudioVisualEventEvidence(media(old, repair.evidence.old), old.audioVisualEventReviews, old.targetedRepairAssessment)
  const next = assessAudioVisualEventEvidence(media(current, repair.evidence.new), current.audioVisualEventReviews, current.targetedRepairAssessment)
  const targets = current.targetedRepairAssessment?.targets ?? []
  const sameSource = (a, b) => ['videoUrl', 'sha256', 'actorId', 'startSecond', 'endSecond'].every(key => a?.[key] === b?.[key])
  for (const issue of prior.issues.filter(issue => issue.code === 'reported_audio_visual_defect')) {
    if (!targets.some(target => sameSource(target.sourceDefect, issue.evidence))) fail('replacement dropped an unresolved user-reported audio-visual defect')
  }
  for (const target of prior.targetResults) {
    if (!targets.some(next => next.id === target.targetId && sameSource(next.sourceDefect, target.sourceDefect))) fail('replacement dropped a prior targeted audio-visual repair obligation')
  }
  if (next.issues.length || targets.length && (next.targetResults.length !== targets.length || next.targetResults.some(target => target.status !== 'resolved')))
    fail('replacement has unresolved audio-visual repair targets; passed=true or a new URL is not proof of repair')
  return { status: next.targetResults.length ? 'resolved' : 'not-assessed', targetResults: next.targetResults }
}

/** Manifest shape: {format:'stage-media-repair-v1',sourceRecordId,
 * repairs:[{loopIndex,loopGroupId?,reason,shot:{old,new,runId?},take:{old,new},
 * evidence:{old,new},accepted:{old,new},outputs:[{runId,old,new}],
 * snapshots?:[{runId,field,old,new}],continuity:{incoming,outgoing}}],
 * concats:[{runId?,loopIndex,loopGroupId?,old,new}]}.
 * The caller supplies evidence; this importer does not claim it watched or
 * listened to a clip. Whole old outputs bind every edit to the saved checkpoint. */
export function prepareStageMediaRepair(source, manifest, { id = `record-media-repair-${randomUUID()}`, createdAt = new Date().toISOString() } = {}) {
  if (!object(source) || !nonempty(source.id) || !nonempty(source.workflow_id) || !object(source.result)) fail('missing source record')
  if (!nonempty(id) || id === source.id || !Number.isFinite(Date.parse(createdAt))) fail('a NEW record ID and valid timestamp are required')
  if (!object(manifest) || manifest.format !== 'stage-media-repair-v1' || manifest.sourceRecordId !== source.id
    || !Array.isArray(manifest.repairs) || !manifest.repairs.length || !Array.isArray(manifest.concats)) fail('manifest identity or repair/concat arrays are invalid')
  if (manifest.concatAllowed === false) fail('manifest explicitly forbids concat for this replacement')
  const hash = createJsonHasher(), sourceResultHash = hash(source.result), manifestHash = hash(manifest)
  if (manifest.sourceResultHash !== undefined && manifest.sourceResultHash !== sourceResultHash) fail('manifest sourceResultHash is stale')
  const original = decodeExecutionState(source.result)
  if (original.id !== source.id || original.workflowId !== source.workflow_id || !Array.isArray(original.nodeRuns) || !original.nodeRuns.length) fail('source state identity/nodeRuns are invalid')
  if (original.context !== undefined && !object(original.context) || original.branchHistory !== undefined && !Array.isArray(original.branchHistory)) fail('source live context or branch history is invalid')
  const ids = new Set()
  for (const run of original.nodeRuns) {
    if (!object(run) || !nonempty(run.id) || !object(run.node) || !nonempty(run.node.id) || ids.has(run.id)) fail('source has duplicate or incomplete run identities')
    ids.add(run.id)
    if (!['success', 'idle', 'skipped', 'failed'].includes(run.status)) fail(`${run.id} is active or has invalid status`)
    if (run.attempts !== undefined && !Array.isArray(run.attempts)) fail(`${run.id} has invalid historical attempts`)
    for (const key of ['loopIndex', 'attempt', 'errorAttempt', 'revision']) if (run[key] !== undefined && (!Number.isSafeInteger(run[key]) || run[key] < 0)) fail(`${run.id} has an invalid ${key}`)
  }
  if (manifest.reassessSavedAudio !== undefined && typeof manifest.reassessSavedAudio !== 'boolean') fail('reassessSavedAudio must be boolean')
  const updates = new Map(), patches = new Map(), selectedScopes = new Set(), repaired = [], explicitlyReplaced = new Set()
  let audioReassessment
  if (manifest.reassessSavedAudio === true) {
    const reviewed = prepareStageAudioReview(source, { id, createdAt })
    audioReassessment = { reviewedSegmentCount: reviewed.proof.reviewedSegmentCount, reviewedConcatCount: reviewed.proof.reviewedConcatCount }
    for (const [index, run] of reviewed.state.nodeRuns.entries()) if (['video_shot', 'stage_video'].includes(run.node.resultVar) && outputHash(run, hash) !== outputHash(original.nodeRuns[index], hash)) {
      updates.set(index, { output: run.output, kind: 'saved-audio-reassessment' })
    }
  }
  const locate = (entry, resultVar, repair) => {
    if (!object(entry) || !object(entry.old) || !object(entry.new)) fail(`${resultVar} requires complete old and new outputs`)
    const found = original.nodeRuns.flatMap((run, index) => run.status === 'success' && run.node.resultVar === resultVar
      && (entry.runId ? run.id === entry.runId : run.loopIndex === repair.loopIndex && (repair.loopGroupId === undefined || run.loopGroupId === repair.loopGroupId)) ? [index] : [])
    if (found.length !== 1) fail(`${resultVar} does not uniquely identify a successful source run`)
    const index = found[0], run = original.nodeRuns[index]
    if (run.loopIndex !== repair.loopIndex || repair.loopGroupId !== undefined && run.loopGroupId !== repair.loopGroupId || hash(run.output) !== hash(entry.old)) fail(`${run.id} old output or loop identity differs from the source checkpoint`)
    return index
  }
  const register = (index, output, kind) => {
    if (explicitlyReplaced.has(index)) fail(`${original.nodeRuns[index].id} has duplicate replacement declarations`)
    explicitlyReplaced.add(index)
    updates.set(index, { output, kind })
  }
  const patch = (index, field, value) => {
    const next = patches.get(index) ?? {}
    if (own(next, field) && hash(next[field]) !== hash(value)) fail(`${original.nodeRuns[index].id}.${field} has conflicting replacements`)
    next[field] = value; patches.set(index, next)
  }
  for (const repair of manifest.repairs) {
    if (!object(repair) || !Number.isSafeInteger(repair.loopIndex) || repair.loopIndex < 0 || !nonempty(repair.reason)) fail('each repair requires loopIndex and a concrete reason')
    if (repair.concatAllowed === false) fail(`loop ${repair.loopIndex} explicitly forbids concat for this replacement`)
    const indexes = Object.fromEntries(Object.entries(roles).map(([role, resultVar]) => [role, locate(repair[role], resultVar, repair)]))
    const key = scope(original.nodeRuns[indexes.accepted])
    if (selectedScopes.has(key) || Object.values(indexes).some(index => scope(original.nodeRuns[index]) !== key)) fail('duplicate repair or mixed loop groups')
    selectedScopes.add(key)
    const { shot, take, evidence, accepted } = repair
    validateMedia(shot.new, take.new, evidence.new, accepted.new, `loop ${repair.loopIndex}`)
    const targetedReview = targetedRepairReview(repair)
    if (shot.old.id !== shot.new.id || shot.old.dramaticSceneId !== shot.new.dramaticSceneId) fail('a media repair cannot silently change the scene identity')
    if (body(shot.old) !== body(shot.new) && !(repair.contentChange?.approved === true && nonempty(repair.contentChange.reason) && repair.contentChange.evidenceRefs?.length)) fail('dialogue body changed without explicit, evidence-linked contentChange approval')
    if (take.old.url !== evidence.old.originalUrl || accepted.old.url !== evidence.old.url || accepted.old.originalUrl !== take.old.url) fail('old triplet does not bind the same source clip')
    if (accepted.old.url === accepted.new.url) fail('replacement must have a new media URL; never overwrite paid media in place')
    for (const [role, index] of Object.entries(indexes)) register(index, repair[role].new, `replacement-${role}`)
    if (!object(take.new.params) || !object(evidence.new.evidenceRequest)) fail('replacement must retain actual generation and evidence request inputs')
    patch(indexes.take, 'inputs', take.new.params)
    patch(indexes.evidence, 'inputs', evidence.new.evidenceRequest)
    for (const entry of repair.outputs ?? []) {
      if (!object(entry) || !nonempty(entry.runId)) fail('supplemental outputs require a source runId')
      const run = original.nodeRuns.find(run => run.id === entry.runId)
      if (!run || scope(run) !== key || entry.resultVar !== undefined && entry.resultVar !== run.node.resultVar) fail('supplemental output is outside the repaired loop or has a mismatched resultVar')
      const index = locate(entry, run.node.resultVar, { loopIndex: run.loopIndex, loopGroupId: run.loopGroupId })
      if (hash(entry.old) === hash(entry.new)) fail(`${run.id} supplemental replacement is unchanged; old derived evidence cannot authorize new media`)
      if (reviews.has(run.node.resultVar) && entry.new.reviewUnavailable !== true && (entry.reviewEvidence?.videoUrl !== evidence.new.url
        || !Array.isArray(entry.reviewEvidence?.evidenceRefs) || !entry.reviewEvidence.evidenceRefs.length || !entry.reviewEvidence.evidenceRefs.every(nonempty))) fail(`${run.id} supplemental review requires explicit evidence tied to the replacement video`)
      register(index, entry.new, `replacement-${run.node.resultVar}`)
    }
    const shotChanged = hash(shot.old) !== hash(shot.new)
    for (const [index, run] of original.nodeRuns.entries()) {
      if (run.status !== 'success' || scope(run) !== key || updates.has(index)) continue
      const resultVar = run.node.resultVar
      if (['media_request', 'media_metrics'].includes(resultVar) || shotChanged && resultVar === 'shot_candidate' && hash(run.output) !== hash(shot.old)) fail(`${run.id} (${resultVar}) needs a fresh supplemental output; old derived data cannot describe replacement media`)
      if (reviews.has(resultVar) && (resultVar !== 'shot_script_review' || shotChanged)) {
        register(index, { ...(nonempty(run.output?.model) ? { model: run.output.model } : {}), reviewUnavailable: true,
          warnings: ['此审核属于被替换的旧素材或旧分镜；新素材尚无此节点的独立审核，旧结论已保存为历史。'],
          reviewInvalidation: { method: 'stage-media-repair', sourceRecordId: source.id, sourceRunId: run.id, videoUrl: evidence.new.url, evidenceUrl: evidence.new.evidenceUrl } }, 'stale-review-invalidated')
        if (Array.isArray(run.inputs?.reviewImages)) patch(index, 'inputs', { ...run.inputs, reviewImages: evidence.new.frames })
      }
      if (resultVar === 'last_frame') {
        if (run.output?.url !== tail(evidence.old)) fail(`${run.id} old tail is not bound to the repaired clip`)
        register(index, { ...run.output, url: tail(evidence.new), source: 'extracted-from-video', available: true, warning: '',
          mediaRepair: { sourceRecordId: source.id, videoUrl: evidence.new.url } }, 'replacement-last-frame')
      }
    }
    for (const entry of repair.snapshots ?? []) {
      const index = original.nodeRuns.findIndex(run => run.id === entry?.runId)
      if (index < 0 || scope(original.nodeRuns[index]) !== key || !snapshotFields.has(entry.field)
        || !own(entry, 'old') || !own(entry, 'new') || hash(original.nodeRuns[index][entry.field] ?? null) !== hash(entry.old)) fail('snapshot patch does not bind an exact source live field')
      patch(index, entry.field, entry.new)
    }
    repaired.push({ repair, indexes, key, shotChanged, targetedReview })
  }
  // A changed boundary must explicitly account for the next already-paid shot.
  for (const { repair, indexes, key } of repaired) {
    const group = original.nodeRuns[indexes.accepted].loopGroupId
    const previous = original.nodeRuns.find(run => run.status === 'success' && run.node.resultVar === 'video_shot' && run.loopGroupId === group && run.loopIndex === repair.loopIndex - 1)
    const nextShotRun = original.nodeRuns.find(run => run.status === 'success' && run.node.resultVar === 'shot_script' && run.loopGroupId === group && run.loopIndex === repair.loopIndex + 1)
    const nextTake = original.nodeRuns.find(run => run.status === 'success' && run.node.resultVar === 'video_take' && run.loopGroupId === group && run.loopIndex === repair.loopIndex + 1)
    const nextShot = nextShotRun && (updates.get(original.nodeRuns.indexOf(nextShotRun))?.output ?? nextShotRun.output)
    const incomingDependency = repair.shot.new.firstFrameMode === 'reuse_previous_tail' || repair.shot.new.continuity?.mode === 'continuous'
      || previous && referencesUrl(repair.take.new.params, tail(previous.output))
    const outgoingDependency = nextShot?.firstFrameMode === 'reuse_previous_tail' || nextShot?.continuity?.mode === 'continuous'
      || nextTake && referencesUrl(nextTake.output?.params ?? nextTake.inputs, tail(repair.evidence.old))
    continuityReview(repair.continuity?.incoming, `${key} incoming`, Boolean(previous && incomingDependency))
    continuityReview(repair.continuity?.outgoing, `${key} outgoing`, Boolean(nextTake && outgoingDependency))
    if (nextTake && outgoingDependency && !repair.continuity.outgoing.dependentRunIds?.includes(nextTake.id)) fail(`${key} continuity review must name dependent paid run ${nextTake.id}`)
    if (repair.continuity?.incoming?.status === 'verified' && repair.continuity.incoming.videoUrl !== repair.evidence.new.url
      || repair.continuity?.outgoing?.status === 'verified' && repair.continuity.outgoing.videoUrl !== repair.evidence.new.url) fail(`${key} boundary review is not bound to the replacement video`)
  }
  const mediaMap = new Map(repaired.map(({ repair }) => [repair.accepted.old.url, repair.accepted.new]))
  const repairHashes = new Map(repaired.map(({ repair }) => [repair.accepted.new.url, repair.evidence.new.sha256 ?? repair.evidence.new.sourceSha256]))
  if (mediaMap.size !== repaired.length) fail('one old media URL ambiguously belongs to multiple repaired scenes')
  const affectedConcats = original.nodeRuns.flatMap((run, index) => run.status === 'success' && run.node.resultVar === 'stage_video'
    && Array.isArray(run.output?.clips) && run.output.clips.some(clip => mediaMap.has(clipUrl(clip))) ? [index] : [])
  if (!affectedConcats.length) fail('the replacements do not occur in any successful stage concat')
  for (const entry of manifest.concats) {
    const index = locate(entry, 'stage_video', entry), run = original.nodeRuns[index]
    if (!affectedConcats.includes(index)) fail(`${run.id} is not an affected concat`)
    const expectedUrls = run.output.clips.map(clip => mediaMap.get(clipUrl(clip))?.url ?? clipUrl(clip))
    const next = entry.new
    if (!nonempty(next.url) || next.url === run.output.url || !Array.isArray(next.clips) || next.count !== expectedUrls.length
      || JSON.stringify(next.clips.map(clipUrl)) !== JSON.stringify(expectedUrls)) fail(`${run.id} concat changed order/count/unrelated clips or kept the old output URL`)
    if (!Array.isArray(next.sourceSha256) || next.sourceSha256.length !== next.clips.length || next.clips.some((clip, i) => !/^[a-f\d]{64}$/i.test(clip?.sha256 ?? '') || next.sourceSha256[i] !== clip.sha256)) fail(`${run.id} concat is missing consistent source byte hashes`)
    const sources = next.clips.map((clip, i) => {
      const oldClip = run.output.clips[i], replacement = mediaMap.get(clipUrl(oldClip))
      if (!replacement && (oldClip?.sha256 && clip.sha256 !== oldClip.sha256)) fail(`${run.id} changed an unrelated paid clip's bytes`)
      if (replacement && repairHashes.get(replacement.url) && repairHashes.get(replacement.url) !== clip.sha256) fail(`${run.id} replacement review hash differs from actual concat source bytes`)
      const matches = original.nodeRuns.flatMap((candidate, at) => candidate.status === 'success' && candidate.node.resultVar === 'video_shot' && at < index
        && candidate.output?.url === clipUrl(oldClip) ? [{ at, candidate }] : [])
      const distinct = [...new Map(matches.map(value => [hash(value.candidate.output), value])).values()]
      if (distinct.length !== 1) fail(`${run.id} clip ${i} lacks a unique source acceptance`)
      const accepted = replacement ?? updates.get(distinct[0].at)?.output ?? distinct[0].candidate.output
      return { ...accepted, sourceSha256: clip.sha256, shotId: accepted.shotId ?? distinct[0].candidate.inputContext?.shot_script?.id }
    })
    // Derived reviews are regenerated locally from each exact accepted source;
    // a passed review on the old concat cannot migrate to changed media.
    register(index, { ...next, ...aggregateConcatReviews({ videos: sources, qualityDisposition: next.qualityDisposition ?? run.output.qualityDisposition }, next.clips) }, 'replacement-stage-concat')
  }
  if (affectedConcats.some(index => !explicitlyReplaced.has(index))) fail('every affected successful stage concat requires its actual newly assembled output')
  const rewritten = rewriteLiveOutputReferences(original, updates, { sourceRecordId: source.id, createdAt,
    method: 'precomputed-stage-media-repair', historicalField: 'stageMediaRepairHistorical', reason: '保留替换前的完整原片、审核与上下文；新媒体及衔接证据来自显式修复清单。' })
  const changedIds = new Set(rewritten.changedRuns.map(run => run.runId)), nodeRuns = rewritten.nodeRuns.slice()
  for (const [index, fields] of patches) {
    const before = original.nodeRuns[index], next = { ...nodeRuns[index] }
    if (!changedIds.has(before.id)) {
      const { attempts, ...archived } = before
      next.attempts = [...(attempts ?? []), { ...archived, historical: true, stageMediaRepairHistorical: { sourceRecordId: source.id, sourceRunId: before.id, reviewedAt: createdAt, method: 'precomputed-stage-media-repair' } }]
      changedIds.add(before.id)
    }
    for (const [field, value] of Object.entries(fields)) next[field] = rewritten.refresh(value)
    nodeRuns[index] = next
  }
  const forked = { ...original, id, parentExecutionId: source.id, mode: 'step', historical: false, nodeRuns, context: rewritten.context,
    requestScopeId: original.requestScopeId ?? original.id, generationScopeId: original.generationScopeId ?? original.id,
    logs: [...(original.logs ?? []), `从 ${source.id} 创建可追溯媒体修复副本；导入 ${repaired.length} 个已生成片段及 ${affectedConcats.length} 个已重新拼接阶段结果。原片、旧审核和完整上下文保留在历史尝试；本导入过程不调用模型、不生成媒体。`] }
  for (const field of ['loopRerun', 'routeRecovery']) if (own(original, field)) forked[field] = rewritten.refresh(original[field])
  const invariants = {
    branchHistoryPreserved: hash(forked.branchHistory ?? null) === hash(original.branchHistory ?? null),
    loopRerunHistoryPreserved: hash(forked.loopRerunHistory ?? null) === hash(original.loopRerunHistory ?? null),
    priorAttemptsPreserved: nodeRuns.every((run, i) => hash((run.attempts ?? []).slice(0, original.nodeRuns[i].attempts?.length ?? 0)) === hash(original.nodeRuns[i].attempts ?? [])),
    originalChangedRunsArchived: nodeRuns.every((run, i) => !changedIds.has(run.id) || hash(Object.fromEntries(Object.entries(run.attempts.at(-1)).filter(([key]) => !['historical', 'stageMediaRepairHistorical'].includes(key)))) === hash(Object.fromEntries(Object.entries(original.nodeRuns[i]).filter(([key]) => !['attempts', 'historical', 'stageMediaRepairHistorical'].includes(key))))),
    statusAndCountersPreserved: nodeRuns.every((run, i) => ['status', 'attempt', 'errorAttempt', 'revision'].every(key => hash(run[key] ?? null) === hash(original.nodeRuns[i][key] ?? null))),
    unrelatedPaidOutputsPreserved: nodeRuns.every((run, i) => changedIds.has(run.id) || outputHash(run, hash) === outputHash(original.nodeRuns[i], hash)),
  }
  if (Object.values(invariants).some(value => !value)) fail('history/counter/prefix preservation invariant failed')
  const audit = { format: 'stage-media-repair-v1', sourceRecordId: source.id, newRecordId: id, sourceResultHash, manifestHash,
    createdAt, method: 'precomputed-manifest-import', modelsCalled: 0, mediaFilesWritten: 0, fullVideoListened: false, fullVideoWatched: false,
    repairedLoops: repaired.map(({ repair, targetedReview }) => ({ loopIndex: repair.loopIndex, reason: repair.reason, oldVideoUrl: repair.accepted.old.url, newVideoUrl: repair.accepted.new.url, continuity: repair.continuity,
      targetedRepairStatus: targetedReview.status, targetedRepairResults: targetedReview.targetResults })),
    replacedConcatCount: affectedConcats.length, ...(audioReassessment ? { audioReassessment } : {}), changedRunIds: [...changedIds], ...invariants }
  if (original.stageMediaRepair) forked.stageMediaRepairHistory = [...(original.stageMediaRepairHistory ?? []), original.stageMediaRepair]
  forked.stageMediaRepair = audit
  const encoded = encodeExecutionState(forked), roundTrip = decodeExecutionState(JSON.parse(JSON.stringify(encoded)))
  if (createJsonHasher()(roundTrip) !== hash(forked)) fail('serialization changed the prepared repair fork')
  if (createJsonHasher()(source.result) !== sourceResultHash || createJsonHasher()(manifest) !== manifestHash) fail('preparation mutated source or manifest')
  return { state: forked, encoded, proof: { ...audit, referenceReplacements: rewritten.referenceReplacements,
    snapshotPatches: [...patches].map(([index, fields]) => ({ runId: original.nodeRuns[index].id, fields: Object.keys(fields) })),
    roundTripVerified: true, sourceUnchanged: true, manifestUnchanged: true } }
}

export function parseArguments(args) {
  const options = { apply: false }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (flag === '--help') { options.help = true; continue }
    const key = { '--source': 'sourceId', '--manifest': 'manifestPath', '--id': 'id', '--proof': 'proofPath', '--expected-source-md5': 'expectedMd5' }[flag]
    if (!key || options[key] !== undefined || !nonempty(args[i + 1]) || args[i + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = args[++i]
  }
  if (options.help) return options
  if (!options.sourceId || !options.manifestPath) fail('--source and --manifest are required')
  if (options.expectedMd5 !== undefined && !/^[a-f\d]{32}$/i.test(options.expectedMd5)) fail('--expected-source-md5 must be a 32-digit MD5')
  return options
}

export async function forkStageMediaRepair(client, options, manifest) {
  if (!nonempty(options?.sourceId) || options.apply !== undefined && typeof options.apply !== 'boolean') fail('invalid source/apply options')
  const apply = options.apply === true
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const source = (await client.query(`SELECT *, md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${apply ? ' FOR SHARE' : ''}`, [options.sourceId])).rows[0]
    if (!source) fail('source record was not found')
    if (options.expectedMd5 && options.expectedMd5.toLowerCase() !== source.result_md5) fail('source MD5 differs from reviewed checkpoint')
    const prepared = prepareStageMediaRepair(source, manifest, options)
    if (apply) {
      const { state, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id, workflow_id, workflow_name, mode, title, runtime_inputs, result, succeeded_count, failed_count, total_count)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`, [state.id, source.workflow_id, source.workflow_name, 'step', `媒体修复副本 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encoded), state.nodeRuns.filter(run => run.status === 'success').length,
        state.nodeRuns.filter(run => run.status === 'failed').length, state.nodeRuns.length])
      const inserted = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!inserted || createJsonHasher()(decodeExecutionState(inserted.result)) !== createJsonHasher()(state)) fail('inserted record differs from the prepared repair')
    }
    const after = (await client.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]?.result_md5
    if (after !== source.result_md5) fail('source changed during repair import')
    await client.query('COMMIT')
    return { ...prepared.proof, applied: apply, sourceResultMd5: source.result_md5, sourceResultMd5After: after }
  } catch (error) { await client.query('ROLLBACK'); throw error }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) { console.log('node scripts/fork-stage-media-repair.mjs --source RECORD --manifest JSON [--id NEW_ID] [--proof JSON] [--expected-source-md5 MD5] [--apply]\nDefault is read-only. --apply inserts one new fork and never executes models, writes media or modifies the source.'); return }
  const manifest = JSON.parse(await readFile(options.manifestPath, 'utf8'))
  options.id ??= `record-media-repair-${randomUUID()}`
  options.proofPath ??= path.join('logs', `${options.id}-proof.json`)
  await mkdir(path.dirname(options.proofPath), { recursive: true })
  const proofFile = await open(options.proofPath, 'wx')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  let proof
  try {
    const client = await pool.connect()
    try { proof = await forkStageMediaRepair(client, options, manifest) } finally { client.release() }
    await proofFile.writeFile(JSON.stringify(proof, null, 2) + '\n')
    console.log(JSON.stringify({ newRecordId: proof.newRecordId, applied: proof.applied, sourceUnchanged: proof.sourceUnchanged,
      repairedLoops: proof.repairedLoops, replacedConcatCount: proof.replacedConcatCount, changedRunCount: proof.changedRunIds.length,
      ...(options.proofPath ? { proofPath: options.proofPath } : {}) }, null, 2))
  } catch (error) {
    if (!proof) await rm(options.proofPath, { force: true })
    if (proof?.applied) throw Error(`媒体修复副本 ${proof.newRecordId} 已创建；proof 输出失败，请勿重复创建：${error instanceof Error ? error.message : String(error)}`)
    throw error
  } finally { await proofFile.close(); await pool.end() }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
