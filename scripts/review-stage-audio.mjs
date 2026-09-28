// Reassess saved audio evidence without generating or changing media.
// Default: read-only proof. --apply inserts one NEW, traceable review fork.
import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { acceptPrincipleMedia } from '../src/principle-media-quality.ts'
import { aggregateConcatReviews } from '../src/concat-review.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const fail = message => { throw new Error(`STAGE_AUDIO_REVIEW_INVALID: ${message}`) }
const own = (value, key) => Object.hasOwn(value, key) && value[key] !== undefined
const qualityFields = ['passed', 'issues', 'retryPrompt', 'warnings', 'qualityPolicy', 'qualityDisposition', 'qualityReview',
  'technicalValidation', 'visualReview', 'audioEvidenceAssessment']
const concatReviewFields = ['clipReviews', 'qualityWarnings', 'unscopedQualityWarnings', 'voiceConsistency', 'qualityReview',
  'qualityDisposition', 'manualReviewRequired']
const snapshotFields = ['context', 'inputs', 'inputContext', 'routeInputContext', 'routeInputOverrides', 'loopPrevious', 'loopItem', 'retryFeedback', 'branchState', 'branchCarry']
const historicalFields = new Set(['attempts', 'branchHistory', 'loopRerunHistory', 'stageAudioReviewHistory', 'stageMediaRepairHistory'])
const scope = run => JSON.stringify([run.loopGroupId ?? null, run.loopIndex ?? null])
const outputHash = (run, hash) => hash({ present: own(run, 'output'), ...(own(run, 'output') ? { output: run.output } : {}) })
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))

function reviewParams(run) {
  const params = { ...(object(run.inputs) ? run.inputs : {}) }
  const disposition = run.output.qualityDisposition ?? params.qualityDisposition ?? 'strict-v1'
  if (!['strict-v1', 'manual-review-v1'].includes(disposition)) fail(`${run.id} has an unknown original quality disposition`)
  if (run.output.qualityPolicy !== 'principle-v1') fail(`${run.id} is not a saved principle-policy acceptance; cannot reinterpret another policy`)
  params.qualityDisposition = disposition
  return params
}

/** Shared adoption boundary for an audited output or an independently verified
 * replacement artifact. Callers validate which outputs may change and enforce
 * media-specific invariants; this helper preserves all superseded evidence. */
export function rewriteLiveOutputReferences(original, outputUpdates, { sourceRecordId, createdAt,
  method = 'saved-evidence-reassessment', reason = '保留重新计算语音证据之前的完整输出与上下文。',
  historicalField = 'stageAudioReviewHistorical', hash = createJsonHasher() } = {}) {
  if (!object(original) || !Array.isArray(original.nodeRuns) || !(outputUpdates instanceof Map)) fail('live reference rewrite requires nodeRuns and a Map of indexed output updates')
  if (!nonempty(sourceRecordId) || !nonempty(createdAt) || !Number.isFinite(Date.parse(createdAt))
    || !nonempty(historicalField) || ['__proto__', 'prototype', 'constructor', 'attempts', 'output', 'context'].includes(historicalField)) fail('invalid live reference rewrite audit metadata')
  const updates = new Map(), replacements = new Map()
  for (const [index, update] of outputUpdates) {
    const run = original.nodeRuns[index]
    if (!Number.isSafeInteger(index) || index < 0 || !object(run) || !own(run, 'output') || !object(update) || !own(update, 'output')) fail('output update has no existing stable run output')
    const before = hash(run.output), after = hash(update.output)
    if (before === after) continue
    const existing = replacements.get(before)
    if (existing && hash(existing.value) !== after) fail('identical old outputs have ambiguous review replacements')
    replacements.set(before, { value: update.output, counts: 0, sourceRunId: run.id, kind: update.kind })
    updates.set(index, update)
  }
  // Match complete JSON values, never coincidental strings or URL fragments.
  const replaced = new WeakMap()
  const replaceReferences = value => {
    if (!object(value) && !Array.isArray(value)) return value
    if (replaced.has(value)) return replaced.get(value)
    const replacement = replacements.get(hash(value))
    if (replacement) { replacement.counts++; replaced.set(value, replacement.value); return replacement.value }
    let changed = false
    const next = Array.isArray(value) ? value.map(item => {
      const updated = replaceReferences(item); if (updated !== item) changed = true; return updated
    }) : Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const updated = historicalFields.has(key) ? item : replaceReferences(item)
      if (updated !== item) changed = true
      return [key, updated]
    }))
    replaced.set(value, changed ? next : value)
    return changed ? next : value
  }
  const changedRuns = []
  const nodeRuns = original.nodeRuns.map((run, index) => {
    // Producers sometimes retain structurally identical output copies. Refresh
    // their complete matching result too; never recursively alter another
    // producer's unrelated result merely because it embeds an older artifact.
    const shared = own(run, 'output') ? replacements.get(hash(run.output)) : undefined
    const update = updates.get(index) ?? (shared ? { output: shared.value, kind: shared.kind } : undefined)
    const next = { ...run, ...(update ? { output: update.output } : {}) }, changedFields = []
    for (const key of snapshotFields) if (own(run, key)) {
      next[key] = replaceReferences(run[key])
      if (next[key] !== run[key]) changedFields.push(key)
    }
    if (!update && !changedFields.length) return run
    const archived = { ...without(run, ['attempts']), historical: true,
      [historicalField]: { sourceRecordId, sourceRunId: run.id, reviewedAt: createdAt, method, reason } }
    next.attempts = [...(run.attempts ?? []), archived]
    changedRuns.push({ index, runId: run.id, kind: update?.kind ?? 'live-context-refresh', contextFields: changedFields,
      originalOutputHash: outputHash(run, hash), reviewedOutputHash: outputHash(next, hash),
      originalAttemptCount: run.attempts?.length ?? 0, appendedHistoricalAttempt: true })
    return next
  })
  const context = replaceReferences(original.context ?? {})
  const referenceReplacements = [...replacements].map(([sourceOutputHash, value]) => ({ sourceOutputHash, sourceRunId: value.sourceRunId, matchedObjectCount: value.counts }))
  // Callers may explicitly refresh other known-live root fields. They should
  // not indiscriminately traverse audit metadata or historical checkpoints.
  return { nodeRuns, context, changedRuns, referenceReplacements, refresh: replaceReferences }
}

/** Pure JSON preparation. Only derived review fields change. Original outputs
 * and live snapshots superseded by the audit are retained as historical attempts;
 * all previous attempts and backward-branch scenes stay byte-for-byte semantic. */
export function prepareStageAudioReview(source, { id = `record-audio-review-${randomUUID()}`, createdAt = new Date().toISOString() } = {}) {
  if (!object(source) || !nonempty(source.id) || !nonempty(source.workflow_id) || !object(source.result)) fail('source record/result is missing')
  if (!nonempty(id) || id === source.id) fail('review requires a NEW record ID')
  if (!nonempty(createdAt) || !Number.isFinite(Date.parse(createdAt))) fail('invalid review timestamp')
  const hash = createJsonHasher(), sourceResultHash = hash(source.result), original = decodeExecutionState(source.result)
  if (original.id !== source.id || original.workflowId !== source.workflow_id) fail('source record/state identity disagrees')
  if (!Array.isArray(original.nodeRuns) || !original.nodeRuns.length) fail('source has no complete nodeRuns')
  if (original.context !== undefined && !object(original.context)) fail('invalid root context')
  if (original.branchHistory !== undefined && !Array.isArray(original.branchHistory)) fail('invalid branch history')
  const runIds = new Set()
  for (const [index, run] of original.nodeRuns.entries()) {
    if (!object(run) || !nonempty(run.id) || !object(run.node) || !nonempty(run.node.id) || runIds.has(run.id)) fail(`invalid or duplicate run identity at ${index}`)
    runIds.add(run.id)
    if (!['idle', 'success', 'failed', 'skipped'].includes(run.status)) fail(`${run.id} is running or has an invalid status`)
    if (run.attempts !== undefined && !Array.isArray(run.attempts)) fail(`${run.id} has invalid historical attempts`)
    if (run.loopIndex !== undefined && (!Number.isSafeInteger(run.loopIndex) || run.loopIndex < 0)) fail(`${run.id} has invalid loopIndex`)
  }
  const updates = new Map(), scopeValues = new Map(), accepted = [], reviewedSegments = [], reviewedConcats = []
  const register = (index, next, kind) => {
    const run = original.nodeRuns[index], before = hash(run.output), after = hash(next)
    if (before === after) return
    updates.set(index, { output: next, kind, before, after })
  }
  for (const [index, run] of original.nodeRuns.entries()) {
    if (run.status !== 'success') continue
    const resultVar = run.node.resultVar, key = scope(run), local = scopeValues.get(key) ?? {}
    if (resultVar === 'video_shot' && object(run.output) && nonempty(run.output.url)) {
      const context = { ...(object(run.inputContext) ? run.inputContext : {}), ...local }
      // Prefer the actual inputs captured immediately before acceptance. They
      // can carry approved contextual fields absent from an earlier producer.
      for (const name of ['shot_script', 'video_take', 'video_evidence', 'media_review', 'historical_sources']) {
        if (own(run.inputContext ?? {}, name)) context[name] = run.inputContext[name]
      }
      if (!object(context.shot_script) || !object(context.video_take) || !object(context.video_evidence)) fail(`${run.id} lacks the saved shot/take/evidence triplet`)
      if (context.video_evidence.url !== run.output.url || context.video_evidence.originalUrl !== context.video_take.url
        || run.output.originalUrl !== context.video_evidence.originalUrl) fail(`${run.id} saved acceptance does not bind the same original media`)
      const params = reviewParams(run), computed = acceptPrincipleMedia(context, params)
      if (computed.url !== run.output.url || computed.originalUrl !== run.output.originalUrl) fail(`${run.id} reassessment changed a media URL`)
      const next = { ...run.output }
      for (const name of qualityFields) if (own(computed, name)) next[name] = computed[name]
      register(index, next, 'media-acceptance')
      const entry = { index, runId: run.id, loopIndex: run.loopIndex ?? null, loopGroupId: run.loopGroupId ?? null,
        shotId: context.shot_script.id ?? null, qualityDisposition: params.qualityDisposition, old: run.output, output: next }
      accepted.push(entry)
      reviewedSegments.push({ runId: run.id, loopIndex: entry.loopIndex, shotId: entry.shotId, videoUrl: next.url,
        originalUrl: next.originalUrl, evidenceUrl: next.evidenceUrl, duration: next.duration,
        qualityDisposition: params.qualityDisposition, speechVerifiedBefore: run.output.technicalValidation?.speechVerified ?? null,
        speechVerifiedAfter: next.technicalValidation?.speechVerified ?? null, audioEvidenceAssessment: next.audioEvidenceAssessment,
        principleIssues: next.qualityReview?.principleIssues ?? [], warnings: next.qualityReview?.warnings ?? [] })
    }
    if (resultVar === 'stage_video' && object(run.output) && Array.isArray(run.output.clips)) {
      if (!nonempty(run.output.url)) fail(`${run.id} stage concat has no actual saved URL`)
      const priorReviews = Array.isArray(run.output.clipReviews) ? run.output.clipReviews : []
      const clipSources = run.output.clips.map((clip, clipIndex) => {
        const videoUrl = typeof clip === 'string' ? clip : clip?.url
        if (!nonempty(videoUrl)) fail(`${run.id} clip ${clipIndex} has no stable media URL`)
        const matches = accepted.filter(item => item.index < index && item.output.url === videoUrl)
        const unique = [...new Map(matches.map(item => [hash({ shotId: item.shotId, output: item.output }), item])).values()]
        if (unique.length > 1) fail(`${run.id} clip ${clipIndex} ambiguously matches different accepted shots`)
        const prior = object(priorReviews[clipIndex]) && priorReviews[clipIndex].videoUrl === videoUrl ? priorReviews[clipIndex] : {}
        if (!unique.length) return { ...prior, url: videoUrl, qualityWarnings: [...(prior.qualityWarnings ?? []), {
          code: 'source_acceptance_unavailable', problem: '当前执行没有该原片可唯一追踪的成功验收记录，旧证据保持，不能从相邻片段补造通过。',
        }] }
        const found = unique[0]
        const retainedVoiceReview = object(prior.voiceConsistency)
          && ['user-listening', 'automatic-binding-fallback', 'manual-review-pending'].includes(prior.voiceConsistency.method)
          && (!prior.sourceSha256 || !clip?.sha256 || prior.sourceSha256 === clip.sha256)
        return { ...found.output, shotId: found.shotId,
          ...(typeof clip?.sha256 === 'string' ? { sourceSha256: clip.sha256 } : {}),
          // A saved listening decision belongs to this exact original clip.
          ...(retainedVoiceReview ? { voiceConsistency: prior.voiceConsistency } : {}),
        }
      })
      const aggregated = aggregateConcatReviews({ videos: clipSources, qualityDisposition: run.output.qualityDisposition ?? run.inputs?.qualityDisposition }, run.output.clips)
      const next = { ...run.output }
      for (const name of concatReviewFields) if (own(aggregated, name)) next[name] = aggregated[name]
      register(index, next, 'stage-concat-review')
      reviewedConcats.push({ runId: run.id, loopIndex: run.loopIndex ?? null, videoUrl: next.url, clipCount: next.clips.length,
        clips: next.clips, clipReviews: next.clipReviews, totalDuration: next.totalDuration ?? next.duration ?? null })
    }
    if (nonempty(resultVar) && own(run, 'output')) local[resultVar] = run.output
    scopeValues.set(key, local)
  }
  if (!reviewedSegments.length) fail('no completed principle-policy video acceptances were found')
  if (!reviewedConcats.length) fail('no completed stage concatenations were found')
  const { nodeRuns, context, changedRuns, referenceReplacements } = rewriteLiveOutputReferences(original, updates, { sourceRecordId: source.id, createdAt, hash })
  const forked = { ...original, id, mode: 'step', historical: false, nodeRuns, context,
    requestScopeId: original.requestScopeId ?? original.id,
    logs: [...(original.logs ?? []), `从 ${source.id} 创建语音证据复核副本；仅重算保存的验收与逐片报告，不调用模型、不改变视频URL或媒体字节。旧输出与上下文已留存历史尝试。`] }
  const budget = run => ({ branchState: run.branchState ? { visits: run.branchState.visits, counts: run.branchState.counts } : null,
    branchCarry: object(run.branchCarry) ? Object.fromEntries(Object.entries(run.branchCarry).map(([key, carry]) => [key, {
      loopIndex: carry?.loopIndex, state: carry?.state ? { visits: carry.state.visits, counts: carry.state.counts } : null,
    }])) : null })
  const invariants = {
    branchHistoryPreserved: hash(original.branchHistory ?? null) === hash(forked.branchHistory ?? null),
    priorAttemptsPreserved: nodeRuns.every((run, index) => hash((run.attempts ?? []).slice(0, original.nodeRuns[index].attempts?.length ?? 0)) === hash(original.nodeRuns[index].attempts ?? [])),
    mediaOutputsPreserved: nodeRuns.every((run, index) => {
      const before = original.nodeRuns[index], kind = updates.get(index)?.kind ?? changedRuns.find(change => change.index === index)?.kind
      return kind === 'media-acceptance' ? hash(without(run.output, qualityFields)) === hash(without(before.output, qualityFields))
        : kind === 'stage-concat-review' ? hash(without(run.output, concatReviewFields)) === hash(without(before.output, concatReviewFields))
          : outputHash(run, hash) === outputHash(before, hash)
    }),
    statusAndBudgetsPreserved: nodeRuns.every((run, index) => ['status', 'attempt', 'errorAttempt', 'revision'].every(key => hash(run[key] ?? null) === hash(original.nodeRuns[index][key] ?? null))
      && hash(budget(run)) === hash(budget(original.nodeRuns[index]))),
    requestScopePreserved: forked.requestScopeId === (original.requestScopeId ?? original.id),
  }
  if (Object.values(invariants).some(value => value !== true)) fail('media/history/counter preservation invariant failed')
  const audit = { format: 'stage-audio-review-v1', sourceRecordId: source.id, sourceResultHash, reviewedAt: createdAt,
    newRecordId: id, method: 'saved-evidence-reassessment', modelsCalled: 0, mediaFilesWritten: 0,
    mediaRegenerated: false, fullVideoListened: false, fullVideoWatched: false,
    historicalEvidence: '原branchHistory及既有attempts原样保留；被更新的当前输出和上下文追加至对应run.attempts并标为historical。',
    ...invariants, reviewedSegmentCount: reviewedSegments.length, reviewedConcatCount: reviewedConcats.length, changedRuns }
  if (original.stageAudioReview) forked.stageAudioReviewHistory = [...(original.stageAudioReviewHistory ?? []), original.stageAudioReview]
  forked.stageAudioReview = audit
  const encoded = encodeExecutionState(forked), roundTrip = decodeExecutionState(JSON.parse(JSON.stringify(encoded)))
  if (createJsonHasher()(roundTrip) !== hash(forked)) fail('serialization changed the prepared review fork')
  if (createJsonHasher()(source.result) !== sourceResultHash) fail('preparation mutated the source record')
  const proof = { ...audit, hashAlgorithm: 'sha256-merkle-json-v1', sourceResultMd5: source.result_md5 ?? null,
    sourceBranchHistoryHash: hash(original.branchHistory ?? null), forkedBranchHistoryHash: hash(forked.branchHistory ?? null),
    sourceContextHash: hash(original.context ?? null), forkedContextHash: hash(forked.context),
    referenceReplacements,
    segments: reviewedSegments, concats: reviewedConcats, roundTripVerified: true, sourceUnchanged: true }
  return { state: forked, encoded, proof }
}

export function parseArguments(args) {
  const options = { apply: false }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (flag === '--help') { options.help = true; continue }
    const key = { '--source': 'sourceId', '--proof': 'proofPath', '--id': 'id', '--expected-source-md5': 'expectedMd5' }[flag]
    if (!key || options[key] !== undefined || !nonempty(args[index + 1]) || args[index + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = args[++index]
  }
  if (options.help) return options
  if (!options.sourceId) fail('--source is required')
  if (options.expectedMd5 !== undefined && !/^[a-f\d]{32}$/i.test(options.expectedMd5)) fail('--expected-source-md5 must be a 32-digit MD5')
  return options
}

export async function reviewStageAudio(client, options) {
  if (!nonempty(options?.sourceId) || options.apply !== undefined && typeof options.apply !== 'boolean') fail('invalid source/apply options')
  const apply = options.apply === true
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const source = (await client.query(`SELECT *, md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${apply ? ' FOR SHARE' : ''}`, [options.sourceId])).rows[0]
    if (!source) fail('source record was not found')
    if (options.expectedMd5 && source.result_md5 !== options.expectedMd5.toLowerCase()) fail('source MD5 differs from the reviewed checkpoint')
    const prepared = prepareStageAudioReview(source, options)
    if (apply) {
      const { state, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id, workflow_id, workflow_name, mode, title, runtime_inputs, result, succeeded_count, failed_count, total_count)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`, [state.id, source.workflow_id, source.workflow_name, 'step',
        `语音证据复核副本 · ${source.id} · 原视频未改`, JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encoded),
        state.nodeRuns.filter(run => run.status === 'success').length, state.nodeRuns.filter(run => run.status === 'failed').length, state.nodeRuns.length])
      const inserted = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!inserted || createJsonHasher()(decodeExecutionState(inserted.result)) !== createJsonHasher()(state)) fail('inserted record does not match the prepared review fork')
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]?.result_md5
    if (sourceAfter !== source.result_md5) fail('source changed during review')
    await client.query('COMMIT')
    return { ...prepared.proof, applied: apply, sourceResultMd5After: sourceAfter, sourceUnchanged: true }
  } catch (error) { await client.query('ROLLBACK'); throw error }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/review-stage-audio.mjs --source RECORD [--id NEW_ID] [--proof FILE] [--expected-source-md5 MD5] [--apply]\nDefault is read-only; --apply creates one review fork. No nodes/models/media tools are executed and no source records or video files are modified.')
    return
  }
  options.proofPath ??= path.join('logs/stage-audio-review', `${options.sourceId.replace(/[^\w.-]/g, '_')}-${Date.now()}.json`)
  // Reject an existing/unwritable proof destination before --apply can create
  // any record. A successful insert must never be retried due to a path clash.
  await mkdir(path.dirname(options.proofPath), { recursive: true })
  const proofFile = await open(options.proofPath, 'wx')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  let proof
  try {
    const client = await pool.connect()
    try { proof = await reviewStageAudio(client, options) } finally { client.release() }
    await proofFile.writeFile(JSON.stringify(proof, null, 2) + '\n')
    const { segments, concats, changedRuns, referenceReplacements, ...summary } = proof
    console.log(JSON.stringify({ ...summary, changedRunCount: changedRuns.length, referenceReplacementCount: referenceReplacements.length,
      proofPath: options.proofPath, segmentCount: segments.length, concatCount: concats.length }, null, 2))
  } catch (error) {
    if (!proof) await rm(options.proofPath, { force: true })
    if (proof?.applied) throw new Error(`复核副本 ${proof.newRecordId} 已创建；proof输出失败，请勿再次创建副本：${error instanceof Error ? error.message : String(error)}`)
    throw error
  } finally { await proofFile.close(); await pool.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1
})
