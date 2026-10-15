/** Retake A/B review: sampled-frame model, real-speed watch and audio proof. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { extractTextResponse, parseStructuredJson } from
  '../src/workflow-core.ts'
import { extractFreshNativeJpeg } from
  './staged-scene-cut-a8b6-fresh-native.mjs'
import { readFreshA8B6Artifact,
  saveFreshA8B6Artifact, freshA8B6GeneratedFile } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'
import { readFreshA8B6MediaReceipt, readFreshA8B6PhaseBPlan,
  readFreshA8B6Acceptance } from
  './staged-scene-cut-a8b6-fresh-phases.mjs'
import { readFreshA8B6ReviewEvidence } from
  './staged-scene-cut-a8b6-fresh-review.mjs'
import { readFreshA8B6AudioIsolationV3 } from
  './staged-scene-cut-a8b6-fresh-audio-v3.mjs'

const SHA = /^[a-f0-9]{64}$/
const MODEL_ID = /^model-run-[\w-]+$/
const fail = reason => { throw Error(`A8B6_FRESH_REVIEW_V3_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const phaseName = phase => {
  if (phase !== 'A' && phase !== 'B') fail('phase must be A or B')
  return phase
}
const name = (phase, kind) => `phase-${phaseName(phase)}-${kind}.json`
const runtimeFile = (planId, phase, kind, root) => path.join(root,
  '.runtime/staged-scene-cut-a8b6-fresh', planId, name(phase, kind))
const key = async root => {
  const secret = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (secret.length !== 32) fail('staging signing key invalid')
  return secret
}

async function signOnce(planId, phase, kind, body, root) {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const filename = runtimeFile(planId, phase, kind, root)
  const value = { ...body, signature: createHmac('sha256', await key(root))
    .update(canonical(body)).digest('hex') }
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  await mkdir(path.dirname(filename), { recursive: true })
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST'
      || !(await readFile(filename)).equals(bytes))
      fail(`existing ${kind} differs`)
  }
  return { value, sha256: sha(bytes) }
}

async function readSigned(planId, phase, kind, root) {
  const bytes = await readFile(runtimeFile(planId, phase, kind, root))
  const value = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = value
  if (!SHA.test(String(signature))) fail(`${kind} signature invalid`)
  const expected = createHmac('sha256', await key(root))
    .update(canonical(body)).digest('hex')
  if (!timingSafeEqual(Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex'))) fail(`${kind} signature changed`)
  return { value, sha256: sha(bytes) }
}

async function readBaseRetakeEvidence(planId, phase, root) {
  const result = await readFreshA8B6ReviewEvidence(planId, phase, root)
  if (!['staged-a8b6-fresh-A-plan-v2',
    'staged-a8b6-fresh-A-plan-v3'].includes(result.manifest.version)
    || result.manifest.retake?.parentPlanId == null
    || result.manifest.version === 'staged-a8b6-fresh-A-plan-v3'
      && (phase !== 'B'
        || result.manifest.bRetake?.parentPlanId == null))
    fail('v3 review requires the signed A retake plan')
  assertFreshA8B6JpegReviewImagesV3(phase,
    result.evidence, result.manifest)
  return result
}

export function buildFreshA8B6ReviewEvidenceV3(base, baseSha256) {
  if (base?.version !== 'staged-a8b6-fresh-native-review-evidence-v1'
    || !SHA.test(String(baseSha256)))
    fail('v3 evidence requires verified signed native JPEG base')
  return { version: 'staged-a8b6-fresh-native-review-evidence-v3',
    planId: base.planId, phase: base.phase,
    taskId: base.taskId, videoSha256: base.videoSha256,
    mediaSha256: base.mediaSha256,
    nativeFrameDigestSha256: base.nativeFrameDigestSha256,
    priorV1EvidenceSha256: baseSha256,
    frames: base.frames, reviewImages: base.reviewImages }
}

export async function saveFreshA8B6ReviewEvidenceV3(planId, phase,
  root = process.cwd()) {
  const base = await readBaseRetakeEvidence(planId, phase, root)
  return signOnce(planId, phase, 'review-evidence-v3',
    buildFreshA8B6ReviewEvidenceV3(base.evidence,
      base.evidenceSha256), root)
}

export async function readFreshA8B6ReviewEvidenceV3(planId, phase,
  root = process.cwd()) {
  const base = await readBaseRetakeEvidence(planId, phase, root)
  const expected = buildFreshA8B6ReviewEvidenceV3(base.evidence,
    base.evidenceSha256)
  const { value: evidence, sha256: evidenceSha256 } = await readSigned(
    planId, phase, 'review-evidence-v3', root)
  if (canonical(evidence) !== canonical({ ...expected,
    signature: evidence.signature }))
    fail('signed v3 JPEG/native review evidence changed')
  return { evidence, evidenceSha256,
    media: base.media, native: base.native }
}

const readRetakeEvidence = readFreshA8B6ReviewEvidenceV3

/** Matches the live media-review endpoint's exact .jpg-only preflight. */
export function assertFreshA8B6JpegReviewImagesV3(phase,
  evidence, manifest) {
  phaseName(phase)
  const frames = evidence?.frames
  if (evidence?.phase !== phase || !Array.isArray(frames)
    || frames.length < 2
    || canonical(evidence.reviewImages)
      !== canonical(frames.map(frame => frame.url))
    || frames.some(frame =>
      !/^\/generated\/[\w.-]+\.jpg$/.test(frame.url ?? '')
      || !SHA.test(String(frame.sha256)))
    || frames.slice(1).some(frame =>
      frame.kind !== 'provider-native-frame'
      || frame.phase !== phase
      || frame.sourceVideoSha256 !== evidence.videoSha256))
    fail('v3 review images must all be signed local JPEG native frames')
  if (phase === 'A') {
    const entries = manifest?.compactTransport?.entries ?? []
    const first = entries.filter(entry => entry.role === 'first_frame')
    const cert = frames[0]
    if (first.length !== 1
      || cert.kind !== 'approved-new-first-frame'
      || cert.phase !== 'CERT' || cert.frameIndex !== -1
      || cert.url !== first[0].transport?.url
      || cert.sha256 !== first[0].transport?.sha256
      || cert.sourceOriginal?.url !== first[0].source?.url
      || cert.sourceOriginal?.sha256 !== first[0].source?.sha256
      || cert.sourceOriginal.sha256
        !== manifest.source?.approvedFirstFrameSha256)
      fail('v3 CERT is not the signed compact JPEG of the V9 PNG')
  } else if (frames[0].kind !== 'accepted-A-native-tail'
    || frames[0].phase !== 'A')
    fail('v3 B reference is not the accepted A native tail JPEG')
  return true
}

/** Only facts visible in the supplied JPEGs belong to model checks. */
export function freshA8B6FrameChecksV3(phase) {
  return phaseName(phase) === 'A'
    ? ['certifiedFirstFrameMatchesNativeF0',
      'frontWristKnotCompletedByNativeTail',
      'guardsHandsOffWristsAtNativeTail',
      'zhangAtOriginalStationInSamples',
      'noVisibleIdentityOrSceneDiscontinuityInSamples']
    : ['acceptedATailMatchesBFrame0',
      'stitchedBFrame1VisuallyContinuous',
      'frontWristKnotVisibleInAllSamples',
      'zhangAtStopMarkByFrame120Sample',
      'finalSamplePoseConsistent']
}

/** Temporal and mouth facts require a separately authored full 1x watch. */
export function freshA8B6PlaybackChecksV3(phase) {
  return phaseName(phase) === 'A'
    ? ['originalSpeedContinuousBinding',
      'frontWristKnotCompletedAndHeldThroughTail',
      'guardsReleaseWristAfterKnot',
      'zhangRemainsAtOriginalStation',
      'noSpeechMouthAtOriginalSpeed',
      'noSceneOrIdentityJumpAtOriginalSpeed']
    : ['actualATailToBFrame1AtOriginalSpeed',
      'guardsContinueWithdrawalWithoutRegrab',
      'frontWristKnotRemainsVisibleThroughout',
      'zhangApproachesAndStopsByNativeFrame120',
      'stableFinalSecond',
      'noSpeechMouthAtOriginalSpeed',
      'noSceneOrIdentityJumpAtOriginalSpeed']
}

const observationKey = frame => `${frame.phase}:f${frame.frameIndex}`

/** Essential sampled frames; the other supplied JPEGs remain optional prose. */
export function freshA8B6RequiredObservationsV3(phase, evidence) {
  phaseName(phase)
  const frames = evidence?.frames ?? []
  const last = frames.filter(frame => frame.phase === phase)
    .at(-1)?.frameIndex
  const required = phase === 'A'
    ? [['CERT:f-1'], ['A:f0'], ['A:f144'],
      [`A:f${last - 12}`, `A:f${last - 6}`], [`A:f${last}`]]
    : [[observationKey(frames[0] ?? {})], ['B:f0'], ['B:f1'],
      ['B:f120'], [`B:f${last}`]]
  const attached = new Set(frames.map(observationKey))
  if (!Number.isInteger(last)
    || required.some(group => !group.some(key => attached.has(key))))
    fail('essential v3 native observation frame missing from evidence')
  return required
}

export function freshA8B6FrameReviewPromptV3(phase, evidence) {
  if (evidence?.phase !== phase) fail('model prompt evidence phase changed')
  const checks = Object.fromEntries(freshA8B6FrameChecksV3(phase)
    .map(item => [item, false]))
  const rule = phase === 'A'
    ? 'A 参考图仅证明获批首帧来源，动作必须以新 A 原生抽帧为准。实际末帧必须清楚看见严颜两腕并拢、两腕之间已完成的前腕绳结、军士双手离腕；腰部缠绳或两手分开一律将 frontWristKnotCompletedByNativeTail 设 false、decision 设 revise。抽帧只能判断样本中的张飞站位与可见身份、场景，不得推断整段连续动作。'
    : 'B 参考图是新 A 已验收的实际尾帧；比较 B f0、f1 与该尾帧，并逐张核对样本中的腕结。只判断 f120 样本位置和末尾两张样本的姿态，不得宣称整段撤手、停步或末秒稳定。'
  const required = freshA8B6RequiredObservationsV3(phase, evidence)
    .map(group => group.join(' 或 ')).join('；')
  return `你是 JPEG 原生抽帧事实审核员。只判断附件画面直接可见的事实；没有整段视频或音频。不要判定原速连续性、全程语言口型、声音、音轨静音或整秒稳定，这些由独立播放与音频签证核验。逐项把 checks 设为 true 或 false；静态图像无法判断某项时 decision=uncertain。${rule}\n计划=${evidence.planId}，阶段=${phase}，视频SHA256=${evidence.videoSha256}，媒体证据SHA256=${evidence.mediaSha256}。附件顺序：${evidence.frames.map(frame => `${frame.phase}:f${frame.frameIndex}:${frame.sha256}`).join('；')}。\nobservations 必须逐条写这些关键附件的可见事实：${required}。其余附件可选；不得写不存在的帧，不得重复同一帧。\n只返回JSON：{"version":"staged-a8b6-fresh-frame-review-v3","phase":"${phase}","videoSha256":"${evidence.videoSha256}","decision":"accept|revise|uncertain","checks":${JSON.stringify(checks)},"observations":[{"phase":"A|B|CERT","frameIndex":0,"description":"可见事实"}],"issues":[]}。`
}

export async function saveFreshA8B6FrameReviewIntentV3(planId, phase,
  modelId, requestKey, root = process.cwd()) {
  const { evidence, evidenceSha256 } = await readRetakeEvidence(
    planId, phase, root)
  if (!/^[\w-]{3,128}$/.test(String(modelId))
    || !String(requestKey).startsWith(
      `staged-a8b6-fresh-frame-v3:${planId}:${phase}:${evidence.videoSha256}:`))
    fail('v3 model identity or request key invalid')
  return signOnce(planId, phase, 'frame-model-intent-v3', {
    version: 'staged-a8b6-fresh-frame-model-intent-v3', planId, phase,
    videoSha256: evidence.videoSha256, evidenceSha256, modelId,
    promptSha256: sha(freshA8B6FrameReviewPromptV3(phase, evidence)),
    requestKey, createdAt: new Date().toISOString(),
  }, root)
}

export async function readFreshA8B6FrameReviewIntentV3(planId, phase,
  root = process.cwd()) {
  const { evidence, evidenceSha256 } = await readRetakeEvidence(
    planId, phase, root)
  const { value: intent, sha256: intentSha256 } = await readSigned(
    planId, phase, 'frame-model-intent-v3', root)
  if (intent.version !== 'staged-a8b6-fresh-frame-model-intent-v3'
    || intent.planId !== planId || intent.phase !== phase
    || intent.videoSha256 !== evidence.videoSha256
    || intent.evidenceSha256 !== evidenceSha256
    || intent.promptSha256 !== sha(freshA8B6FrameReviewPromptV3(
      phase, evidence))
    || !String(intent.requestKey ?? '').startsWith(
      `staged-a8b6-fresh-frame-v3:${planId}:${phase}:${evidence.videoSha256}:`)
    || !Number.isFinite(Date.parse(intent.createdAt)))
    fail('signed v3 model intent changed')
  return { intent, intentSha256, evidence, evidenceSha256 }
}

export async function saveFreshA8B6FrameReviewSubmitV3(planId, phase,
  root = process.cwd()) {
  const { intent, intentSha256 } = await readFreshA8B6FrameReviewIntentV3(
    planId, phase, root)
  return signOnce(planId, phase, 'frame-model-submit-v3', {
    version: 'staged-a8b6-fresh-frame-model-submit-v3', planId, phase,
    requestKey: intent.requestKey, intentSha256,
    createdAt: new Date().toISOString(),
  }, root)
}

export async function readFreshA8B6FrameReviewSubmitV3(planId, phase,
  root = process.cwd()) {
  const { intent, intentSha256 } = await readFreshA8B6FrameReviewIntentV3(
    planId, phase, root)
  return readFrameReviewSubmitForIntent(planId, phase, root,
    intent, intentSha256)
}

async function readFrameReviewSubmitForIntent(planId, phase, root,
  intent, intentSha256) {
  const { value: submit, sha256: submitSha256 } = await readSigned(
    planId, phase, 'frame-model-submit-v3', root)
  assertFreshA8B6FrameReviewSubmitBindingV3(submit,
    planId, phase, intent, intentSha256)
  return { submit, submitSha256 }
}

export function assertFreshA8B6FrameReviewSubmitBindingV3(submit,
  planId, phase, intent, intentSha256) {
  if (submit.version !== 'staged-a8b6-fresh-frame-model-submit-v3'
    || submit.planId !== planId || submit.phase !== phase
    || submit.requestKey !== intent.requestKey
    || submit.intentSha256 !== intentSha256
    || !Number.isFinite(Date.parse(submit.createdAt)))
    fail('signed v3 one-shot submission changed')
  return true
}

export function assertFreshA8B6FrameModelLedgerV3(row, phase,
  evidence, intent) {
  const request = row?.request_data
  if (!MODEL_ID.test(String(row?.id))
    || row.channel !== 'workflow'
    || row.workflow_id !== 'wf-sanguo-history-drama'
    || row.node_id !== 'staged-a8b6-fresh-frame-review-v3'
    || row.model_id !== intent.modelId
    || row.capability !== 'text' || row.provider !== 'Codex'
    || row.status !== 'succeeded'
    || request?.operation !== 'history.media-review'
    || request.requestKey !== intent.requestKey
    || request.prompt !== freshA8B6FrameReviewPromptV3(phase, evidence)
    || canonical(request.params?.reviewImages)
      !== canonical(evidence.reviewImages)
    || request.reviewImageHashes?.length !== evidence.frames.length)
    fail('v3 model ledger did not see exact signed native JPEG samples')
  for (const [index, frame] of evidence.frames.entries()) {
    if (request.reviewImageHashes[index]?.url !== frame.url
      || request.reviewImageHashes[index]?.sha256 !== frame.sha256)
      fail(`v3 model attachment ${index} changed`)
  }
  let report
  try { report = parseStructuredJson(extractTextResponse(row.response_data)) }
  catch { fail('v3 model output is not structured JSON') }
  const checks = freshA8B6FrameChecksV3(phase)
  const attached = new Set(evidence.frames.map(observationKey))
  const observed = new Set()
  const observationsValid = Array.isArray(report?.observations)
    && report.observations.every(item => {
      const key = observationKey(item)
      if (!attached.has(key) || observed.has(key)
        || typeof item.description !== 'string'
        || item.description.trim().length < 12) return false
      observed.add(key)
      return true
    })
  if (report?.version !== 'staged-a8b6-fresh-frame-review-v3'
    || report.phase !== phase
    || report.videoSha256 !== evidence.videoSha256
    || !['accept', 'revise', 'uncertain'].includes(report.decision)
    || checks.some(item => typeof report.checks?.[item] !== 'boolean')
    || Object.keys(report.checks ?? {}).some(item => !checks.includes(item))
    || !Array.isArray(report.issues)
    || !observationsValid
    || freshA8B6RequiredObservationsV3(phase, evidence)
      .some(group => !group.some(key => observed.has(key))))
    fail('v3 model output does not report only sampled-frame facts')
  const accepted = report.decision === 'accept'
    && checks.every(item => report.checks[item] === true)
    && report.issues.length === 0
  return { row, report, accepted,
    ledgerSha256: sha(canonical(row)),
    promptSha256: sha(request.prompt), requestKey: request.requestKey }
}

export async function verifyFreshA8B6FrameModelLedgerV3(planId, phase,
  executionId, root = process.cwd(), query) {
  if (!MODEL_ID.test(String(executionId))) fail('model execution ID invalid')
  const { intent, intentSha256, evidence, evidenceSha256 } =
    await readFreshA8B6FrameReviewIntentV3(planId, phase, root)
  await readFrameReviewSubmitForIntent(planId, phase, root,
    intent, intentSha256)
  let db
  if (!query) {
    db = new pg.Client({ connectionString: process.env.DATABASE_URL
      ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
    await db.connect()
    query = db.query.bind(db)
  }
  let row
  try {
    row = (await query(`SELECT id,channel,workflow_id,node_id,model_id,
      capability,provider,status,request_data,response_data
      FROM model_execution_records WHERE id=$1`, [executionId])).rows[0]
  } finally { if (db) await db.end() }
  const checked = assertFreshA8B6FrameModelLedgerV3(row,
    phase, evidence, intent)
  if (!checked.accepted) fail('v3 frame review did not accept hard sample facts')
  return { ...checked, evidenceSha256 }
}

export function assertFreshA8B6PlaybackReportV3(report, context) {
  const { planId, phase, media, mediaSha256, native, evidenceSha256,
    model, audioIsolationSha256 } = context
  const checks = freshA8B6PlaybackChecksV3(phase)
  const watch = report?.playback
  let browserSourceValid = true
  if (watch?.surface === 'browser-1x-session') {
    try {
      const viewer = new URL(watch.viewerUrl)
      browserSourceValid = ['127.0.0.1', 'localhost'].includes(viewer.hostname)
        && viewer.pathname === media.videoUrl
        && !viewer.search && !viewer.hash
    } catch { browserSourceValid = false }
  }
  if (report?.version !== 'staged-a8b6-fresh-playback-review-v3'
    || report.planId !== planId || report.phase !== phase
    || report.videoSha256 !== media.videoSha256
    || report.mediaSha256 !== mediaSha256
    || report.nativeFrameDigestSha256 !== native.frameDigestSha256
    || report.evidenceSha256 !== evidenceSha256
    || report.frameModelExecutionId !== model.row.id
    || report.frameModelLedgerSha256 !== model.ledgerSha256
    || report.audioIsolationSha256 !== audioIsolationSha256
    || report.reviewMethod !== 'agent-direct-normal-speed-watch'
    || report.reviewer !== 'Codex' || report.verdict !== 'accept'
    || !['browser-1x-session', 'native-player-1x-session']
      .includes(watch?.surface)
    || !browserSourceValid
    || watch?.sourceUrl !== media.videoUrl
    || watch.sourceVideoSha256 !== media.videoSha256
    || watch.rate !== 1 || watch.startSeconds !== 0
    || Math.abs(watch.endSeconds - native.lastPts) > 1e-8
    || watch.continuous !== true
    || !Number.isFinite(Date.parse(watch.observedAt))
    || checks.some(item => report.checks?.[item] !== true)
    || Object.keys(report.checks ?? {}).some(item => !checks.includes(item))
    || !Array.isArray(report.observations)
    || report.observations.length < 3
    || report.observations.some(item =>
      !Number.isFinite(item.timeSeconds)
      || item.timeSeconds < 0 || item.timeSeconds > native.lastPts
      || typeof item.description !== 'string'
      || item.description.trim().length < 12)
    || !report.observations.some(item => item.timeSeconds === 0)
    || !report.observations.some(item =>
      Math.abs(item.timeSeconds - native.lastPts) < 1e-8)
    || !Array.isArray(report.limitations)
    || report.limitations.some(item =>
      /未观看|未播放|抽帧代替|not watched|not played/i.test(item))
    || phase === 'B' && report.seamVerdict !== 'accept')
    fail('v3 direct report lacks truthful full-speed watch or hard facts')
  return true
}

async function readManualContext(planId, phase, modelExecutionId, root,
  preloadedMedia) {
  const { media, mediaSha256, native } = preloadedMedia?.media
    ? preloadedMedia : await readFreshA8B6MediaReceipt(planId, phase, root)
  const model = await verifyFreshA8B6FrameModelLedgerV3(planId, phase,
    modelExecutionId, root)
  const { evidenceSha256 } = model
  const audio = await readFreshA8B6AudioIsolationV3(planId, phase, root)
  if (audio.receipt.videoSha256 !== media.videoSha256
    || audio.receipt.mediaSha256 !== mediaSha256
    || audio.receipt.nativeFrameDigestSha256 !== native.frameDigestSha256)
    fail('v3 audio isolation does not bind reviewed native video')
  return { planId, phase, media, mediaSha256, native, evidenceSha256,
    model, audioIsolationSha256: audio.receiptSha256 }
}

export async function saveFreshA8B6PlaybackReviewV3(planId, phase,
  report, root = process.cwd()) {
  const context = await readManualContext(planId, phase,
    report?.frameModelExecutionId, root)
  assertFreshA8B6PlaybackReportV3(report, context)
  return saveFreshA8B6Artifact(planId, name(phase, 'manual-review'),
    report, root)
}

export async function readFreshA8B6PlaybackReviewV3(planId, phase,
  root = process.cwd(), preloadedMedia) {
  const { value: report, sha256: reportSha256 } =
    await readFreshA8B6Artifact(planId,
      name(phase, 'manual-review'), root)
  const context = await readManualContext(planId, phase,
    report.frameModelExecutionId, root, preloadedMedia)
  assertFreshA8B6PlaybackReportV3(report, context)
  return { report, reportSha256, context }
}

/** Acceptance binds all three independent proofs to the actual last frame. */
export async function saveFreshA8B6AcceptanceV3(planId, phase,
  { frameModelExecutionId, reportSha256, acceptedFrameIndex },
  root = process.cwd()) {
  const { report, reportSha256: savedReportSha256,
    context } = await readFreshA8B6PlaybackReviewV3(planId, phase, root)
  const { media, mediaSha256, native, evidenceSha256,
    model, audioIsolationSha256 } = context
  if (frameModelExecutionId !== model.row.id
    || reportSha256 !== savedReportSha256
    || acceptedFrameIndex !== native.lastFrameIndex
    || Math.abs(acceptedFrameIndex / 24 - (phase === 'A' ? 8 : 6))
      > 1 / 24 + 1e-8)
    fail('v3 acceptance requires actual native tail and three matching proofs')
  const tail = await extractFreshNativeJpeg(freshA8B6GeneratedFile(
    media.videoUrl, 'video', root), acceptedFrameIndex)
  let seam
  if (phase === 'B') {
    const A = await readFreshA8B6Acceptance(planId, 'A', root)
    const B = await readFreshA8B6PhaseBPlan(planId, root)
    const zero = await extractFreshNativeJpeg(freshA8B6GeneratedFile(
      media.videoUrl, 'video', root), 0)
    const one = await extractFreshNativeJpeg(freshA8B6GeneratedFile(
      media.videoUrl, 'video', root), 1)
    if (A.acceptance.version !== 'staged-a8b6-fresh-native-acceptance-v3'
      || B.plan.sourceA.acceptanceSha256 !== A.acceptanceSha256
      || B.plan.sourceA.frameSha256 !== A.acceptance.acceptedFrameSha256
      || report.seamVerdict !== 'accept')
      fail('v3 B did not start from accepted new A native tail')
    seam = { phaseAFrameIndex: A.acceptance.acceptedFrameIndex,
      phaseAFrameSha256: A.acceptance.acceptedFrameSha256,
      phaseBFirstFrameIndex: 0, phaseBFirstFrameSha256: zero.sha256,
      stitchedPhaseBStartFrameIndex: 1,
      stitchedPhaseBFirstFrameSha256: one.sha256,
      directVerdict: report.seamVerdict }
  }
  return saveFreshA8B6Artifact(planId, name(phase, 'acceptance'), {
    version: 'staged-a8b6-fresh-native-acceptance-v3', planId, phase,
    taskId: media.taskId, videoSha256: media.videoSha256,
    mediaSha256, nativeFrameDigestSha256: native.frameDigestSha256,
    acceptedFrameIndex, acceptedFrameSha256: tail.sha256,
    evidenceSha256,
    directReview: { verdict: 'accept', reportSha256,
      reviewerMethod: 'agent-direct-normal-speed-watch',
      playbackRate: 1 },
    frameModelReview: { verdict: 'accept',
      executionId: model.row.id, ledgerSha256: model.ledgerSha256,
      promptSha256: model.promptSha256, requestKey: model.requestKey },
    audioIsolation: { verdict: 'accept',
      receiptSha256: audioIsolationSha256 },
    ...(seam ? { seam } : {}),
  }, root)
}

export async function readFreshA8B6AcceptanceV3(planId, phase,
  root = process.cwd(), preloaded) {
  const { media, mediaSha256, native } = preloaded?.media
    ? preloaded : await readFreshA8B6MediaReceipt(planId, phase, root)
  const { value: acceptance, sha256: acceptanceSha256 } =
    preloaded?.acceptance ? { value: preloaded.acceptance,
      sha256: preloaded.acceptanceSha256 }
      : await readFreshA8B6Artifact(
      planId, name(phase, 'acceptance'), root)
  if (acceptance.version !== 'staged-a8b6-fresh-native-acceptance-v3'
    || acceptance.planId !== planId || acceptance.phase !== phase
    || acceptance.taskId !== media.taskId
    || acceptance.videoSha256 !== media.videoSha256
    || acceptance.mediaSha256 !== mediaSha256
    || acceptance.nativeFrameDigestSha256 !== native.frameDigestSha256
    || acceptance.acceptedFrameIndex !== native.lastFrameIndex
    || Math.abs(native.lastPts - (phase === 'A' ? 8 : 6))
      > 1 / 24 + 1e-8
    || acceptance.directReview?.verdict !== 'accept'
    || acceptance.frameModelReview?.verdict !== 'accept'
    || acceptance.audioIsolation?.verdict !== 'accept')
    fail('signed v3 acceptance source or components changed')
  const manual = await readFreshA8B6PlaybackReviewV3(planId, phase,
    root, { media, mediaSha256, native })
  const model = manual.context.model
  const tailFile = freshA8B6GeneratedFile(media.videoUrl, 'video', root)
  const tail = await extractFreshNativeJpeg(tailFile,
    native.lastFrameIndex)
  if (acceptance.acceptedFrameSha256 !== tail.sha256
    || acceptance.evidenceSha256 !== manual.context.evidenceSha256
    || acceptance.directReview.reportSha256 !== manual.reportSha256
    || acceptance.directReview.reviewerMethod
      !== 'agent-direct-normal-speed-watch'
    || acceptance.directReview.playbackRate !== 1
    || acceptance.frameModelReview.executionId !== model.row.id
    || acceptance.frameModelReview.ledgerSha256 !== model.ledgerSha256
    || acceptance.frameModelReview.promptSha256 !== model.promptSha256
    || acceptance.frameModelReview.requestKey !== model.requestKey
    || acceptance.audioIsolation.receiptSha256
      !== manual.context.audioIsolationSha256
    || sha(await readFile(tailFile)) !== media.videoSha256)
    fail('signed v3 acceptance lost native frame, watch, model or audio proof')
  if (phase === 'B') {
    const A = await readFreshA8B6Acceptance(planId, 'A', root)
    const B = await readFreshA8B6PhaseBPlan(planId, root)
    const zero = await extractFreshNativeJpeg(freshA8B6GeneratedFile(
      media.videoUrl, 'video', root), 0)
    const one = await extractFreshNativeJpeg(freshA8B6GeneratedFile(
      media.videoUrl, 'video', root), 1)
    if (A.acceptance.version !== 'staged-a8b6-fresh-native-acceptance-v3'
      || B.plan.sourceA.acceptanceSha256 !== A.acceptanceSha256
      || B.plan.sourceA.frameSha256 !== A.acceptance.acceptedFrameSha256
      || acceptance.seam?.phaseAFrameIndex
        !== A.acceptance.acceptedFrameIndex
      || acceptance.seam.phaseAFrameSha256
        !== A.acceptance.acceptedFrameSha256
      || acceptance.seam.phaseBFirstFrameIndex !== 0
      || acceptance.seam.phaseBFirstFrameSha256 !== zero.sha256
      || acceptance.seam.stitchedPhaseBStartFrameIndex !== 1
      || acceptance.seam.stitchedPhaseBFirstFrameSha256 !== one.sha256
      || acceptance.seam.directVerdict !== 'accept'
      || manual.report.seamVerdict !== 'accept')
      fail('signed v3 A to B seam lost actual native frame mapping')
  }
  return { acceptance, acceptanceSha256, media, mediaSha256, native }
}
