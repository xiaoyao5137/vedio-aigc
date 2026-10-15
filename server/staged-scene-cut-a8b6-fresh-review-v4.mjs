/** B3-only, one-shot clarification of an undefined v3 stop mark.
 * Five signed native JPEGs establish sampled facts. A separate 1x playback
 * review still establishes the motion and stable final second. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { extractTextResponse, parseStructuredJson } from
  '../src/workflow-core.ts'
import { freshA8B6GeneratedFile } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'
import { readFreshA8B6ReviewEvidenceV3,
  assertFreshA8B6FrameModelLedgerV3,
  freshA8B6FrameReviewPromptV3 } from
  './staged-scene-cut-a8b6-fresh-review-v3.mjs'

export const B3_FRAME_V4_RECOVERY = Object.freeze({
  planId: '73a576f163f38988a80db26ba0687846fcdb1b5aefac74c0748f82fd06cf0cc9',
  videoSha256: 'a54b5dbe6ae249348dad67ad937a814d6b2941b088254e22b36ca8ac392ae829',
  v3EvidenceSha256: '97f358fbd5cd1bfb51b3c4a6e8733b1c401ca5f5f8adbf4e0accf68676969869',
  v3IntentSha256: '08ef21318807b6487a49e1b9d33b4208dd6a222c255fb27e9263b3159d0c147c',
  v3SubmitSha256: '04042fc11918d6ae695ee73b6f8514b50c7c6cc76b82a3dbc94ee8fbb8496fa2',
  v3ExecutionId: 'model-run-munhy9nu-hwrxks9',
  v3LedgerSha256: '4cb314e2f669b295422c52116e3445963d2d5cd8b2c9c7e0e6cdf6c723bd4df1',
})

const SHA = /^[a-f0-9]{64}$/
const MODEL_ID = /^model-run-[\w-]+$/
const FRAME_INDICES = Object.freeze([84, 108, 120, 132, 144])
const CHECKS = Object.freeze([
  'zhangNearYanLeftFacingByF120Sample',
  'zhangFeetGroundedAndPoseConsistentAtF120F132F144Samples',
])
const fail = reason => { throw Error(`A8B6_FRESH_REVIEW_V4_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const directory = (planId, root) => path.join(root,
  '.runtime/staged-scene-cut-a8b6-fresh', planId)
const filename = (planId, kind, root) => path.join(directory(planId, root),
  `phase-B-${kind}.json`)

function assertB3(planId, phase) {
  if (planId !== B3_FRAME_V4_RECOVERY.planId || phase !== 'B')
    fail('v4 clarification is limited to the exact B3 video')
}

async function key(root) {
  const secret = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (secret.length !== 32) fail('staging signing key invalid')
  return secret
}

async function signedFile(file, root) {
  const bytes = await readFile(file)
  const value = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = value
  if (!SHA.test(String(signature))) fail(`${path.basename(file)} signature invalid`)
  const expected = createHmac('sha256', await key(root))
    .update(canonical(body)).digest('hex')
  if (!timingSafeEqual(Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex')))
    fail(`${path.basename(file)} signature changed`)
  return { value, sha256: sha(bytes) }
}

async function signOnce(file, body, root) {
  const value = { ...body, signature: createHmac('sha256', await key(root))
    .update(canonical(body)).digest('hex') }
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  await mkdir(path.dirname(file), { recursive: true })
  try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST'
      || !(await readFile(file)).equals(bytes))
      fail(`existing ${path.basename(file)} differs`)
  }
  return { value, sha256: sha(bytes) }
}

async function queryV3Ledger(requestKey, root, query) {
  let db
  if (!query) {
    db = new pg.Client({ connectionString: process.env.DATABASE_URL
      ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
    await db.connect()
    query = db.query.bind(db)
  }
  try {
    const rows = (await query(`SELECT id,channel,workflow_id,node_id,
      model_id,capability,provider,status,request_data,response_data
      FROM model_execution_records WHERE request_data->>'requestKey'=$1
      ORDER BY created_at`, [requestKey])).rows
    if (rows.length !== 1) fail('v3 uncertain review ledger is not unique')
    return rows[0]
  } finally { if (db) await db.end() }
}

/** The old signed attempt is a narrow prerequisite, never an acceptance. */
export function assertFreshA8B6V3MarkerUncertaintyForV4({ evidence,
  evidenceSha256, intent, intentSha256, submit, submitSha256, row }) {
  const pinned = B3_FRAME_V4_RECOVERY
  if (evidenceSha256 !== pinned.v3EvidenceSha256
    || intentSha256 !== pinned.v3IntentSha256
    || submitSha256 !== pinned.v3SubmitSha256
    || evidence.planId !== pinned.planId
    || evidence.phase !== 'B'
    || evidence.videoSha256 !== pinned.videoSha256
    || intent.version !== 'staged-a8b6-fresh-frame-model-intent-v3'
    || intent.planId !== pinned.planId || intent.phase !== 'B'
    || intent.videoSha256 !== pinned.videoSha256
    || intent.evidenceSha256 !== evidenceSha256
    || intent.promptSha256 !== sha(freshA8B6FrameReviewPromptV3(
      'B', evidence))
    || intent.modelId !== 'codex-local-vision'
    || submit.version !== 'staged-a8b6-fresh-frame-model-submit-v3'
    || submit.planId !== pinned.planId || submit.phase !== 'B'
    || submit.intentSha256 !== intentSha256
    || submit.requestKey !== intent.requestKey
    || row?.id !== pinned.v3ExecutionId)
    fail('v3 source attempt does not match the signed B3 recovery')
  const checked = assertFreshA8B6FrameModelLedgerV3(row, 'B',
    evidence, intent)
  const checks = checked.report.checks
  if (checked.ledgerSha256 !== pinned.v3LedgerSha256
    || checked.accepted || checked.report.decision !== 'uncertain'
    || checks?.acceptedATailMatchesBFrame0 !== true
    || checks.stitchedBFrame1VisuallyContinuous !== true
    || checks.frontWristKnotVisibleInAllSamples !== true
    || checks.zhangAtStopMarkByFrame120Sample !== false
    || checks.finalSamplePoseConsistent !== true
    || checked.report.issues.length !== 1
    || !/停步标记|stop\s*mark/i.test(checked.report.issues[0])
    || !/未定义|无法|undefined|unobservable/i.test(
      checked.report.issues[0]))
    fail('v3 model did not have only the undefined-marker ambiguity')
  return { executionId: row.id, ledgerSha256: checked.ledgerSha256,
    intentSha256, submitSha256, evidenceSha256,
    reportSha256: sha(canonical(checked.report)) }
}

async function readPriorV3(planId, root, query) {
  assertB3(planId, 'B')
  const { evidence, evidenceSha256, media, native } =
    await readFreshA8B6ReviewEvidenceV3(planId, 'B', root)
  const { value: intent, sha256: intentSha256 } = await signedFile(
    filename(planId, 'frame-model-intent-v3', root), root)
  const { value: submit, sha256: submitSha256 } = await signedFile(
    filename(planId, 'frame-model-submit-v3', root), root)
  const row = await queryV3Ledger(intent.requestKey, root, query)
  const priorV3 = assertFreshA8B6V3MarkerUncertaintyForV4({ evidence,
    evidenceSha256, intent, intentSha256, submit, submitSha256, row })
  const acceptanceFile = filename(planId, 'acceptance', root)
  if (existsSync(acceptanceFile)) {
    const { value } = await signedFile(acceptanceFile, root)
    if (value.version !== 'staged-a8b6-fresh-native-acceptance-v4')
      fail('B3 already has an incompatible signed acceptance')
  }
  return { evidence, evidenceSha256, media, native, priorV3 }
}

export function buildFreshA8B6ReviewEvidenceV4(source, priorV3) {
  if (source?.planId !== B3_FRAME_V4_RECOVERY.planId
    || source.phase !== 'B'
    || source.videoSha256 !== B3_FRAME_V4_RECOVERY.videoSha256
    || priorV3?.evidenceSha256
      !== B3_FRAME_V4_RECOVERY.v3EvidenceSha256
    || priorV3.ledgerSha256
      !== B3_FRAME_V4_RECOVERY.v3LedgerSha256)
    fail('v4 evidence lost the prior B3 source')
  const frames = FRAME_INDICES.map(index => source.frames?.find(frame =>
    frame.phase === 'B' && frame.frameIndex === index))
  if (frames.some(frame => !frame
    || frame.kind !== 'provider-native-frame'
    || frame.sourceVideoSha256 !== source.videoSha256
    || !/^\/generated\/[\w.-]+\.jpg$/.test(frame.url)
    || !SHA.test(String(frame.sha256))))
    fail('v4 clarification requires exact five native JPEG samples')
  return { version: 'staged-a8b6-fresh-native-review-evidence-v4',
    planId: source.planId, phase: 'B', taskId: source.taskId,
    videoSha256: source.videoSha256, mediaSha256: source.mediaSha256,
    nativeFrameDigestSha256: source.nativeFrameDigestSha256,
    priorV3, frames, reviewImages: frames.map(frame => frame.url) }
}

export async function saveFreshA8B6ReviewEvidenceV4(planId, phase,
  root = process.cwd()) {
  assertB3(planId, phase)
  const { evidence, priorV3 } = await readPriorV3(planId, root)
  const body = buildFreshA8B6ReviewEvidenceV4(evidence, priorV3)
  return signOnce(filename(planId, 'review-evidence-v4', root), body, root)
}

export async function readFreshA8B6ReviewEvidenceV4(planId, phase,
  root = process.cwd()) {
  assertB3(planId, phase)
  const prior = await readPriorV3(planId, root)
  const expected = buildFreshA8B6ReviewEvidenceV4(
    prior.evidence, prior.priorV3)
  const { value: evidence, sha256: evidenceSha256 } = await signedFile(
    filename(planId, 'review-evidence-v4', root), root)
  if (canonical(evidence) !== canonical({ ...expected,
    signature: evidence.signature }))
    fail('signed v4 evidence changed')
  for (const frame of evidence.frames) {
    const bytes = await readFile(freshA8B6GeneratedFile(
      frame.url, 'image', root))
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8
      || sha(bytes) !== frame.sha256)
      fail(`v4 native JPEG f${frame.frameIndex} changed`)
  }
  return { evidence, evidenceSha256, media: prior.media,
    native: prior.native, priorV3: prior.priorV3 }
}

export function freshA8B6FrameChecksV4() { return [...CHECKS] }

export function freshA8B6FrameReviewPromptV4(evidence) {
  if (evidence?.version !== 'staged-a8b6-fresh-native-review-evidence-v4'
    || evidence.phase !== 'B'
    || canonical(evidence.frames?.map(frame => frame.frameIndex))
      !== canonical(FRAME_INDICES))
    fail('v4 prompt requires the signed five-frame B3 evidence')
  const checks = Object.fromEntries(CHECKS.map(name => [name, false]))
  return `你是 B3 原生 JPEG 抽帧事实审核员。本次仅复核先前审核中“未定义停步标记”的歧义；先前同一视频的 A→B 首帧、接缝、腕前绳结和尾部样本一致性已有独立模型记录。只看附件 B:f84、f108、f120、f132、f144，不假设画面存在地面标线或预设停步坐标。判断 f120 时张飞是否已到严颜左侧近处并面向严颜、双脚是否着地；再比较 f120/f132/f144 的可见站位、脚步和手臂姿态是否基本一致。静态样本不能证明全程运动、1×连续停步或完整末秒稳定，这些由独立原速播放审核。不能看清就给 uncertain，观察到不符合就给 revise，不要凭目标导帧或想象补充事实。计划=${evidence.planId}；视频SHA256=${evidence.videoSha256}；v3原始证据SHA256=${evidence.priorV3.evidenceSha256}；本次附件=${evidence.frames.map(frame => `B:f${frame.frameIndex}:${frame.sha256}`).join('；')}。observations 必须分别描述这五帧的直接可见事实，不得重复或虚构帧。只返回JSON：{"version":"staged-a8b6-fresh-frame-clarification-v4","phase":"B","videoSha256":"${evidence.videoSha256}","decision":"accept|revise|uncertain","checks":${JSON.stringify(checks)},"observations":[{"phase":"B","frameIndex":84,"description":"可见事实"}],"issues":[]}。`
}

export async function saveFreshA8B6FrameReviewIntentV4(planId, phase,
  modelId, requestKey, root = process.cwd()) {
  const { evidence, evidenceSha256, priorV3 } =
    await readFreshA8B6ReviewEvidenceV4(planId, phase, root)
  if (!/^[\w-]{3,128}$/.test(String(modelId))
    || !String(requestKey).startsWith(
      `staged-a8b6-fresh-frame-v4:${planId}:B:${evidence.videoSha256}:`))
    fail('v4 model identity or request key invalid')
  return signOnce(filename(planId, 'frame-model-intent-v4', root), {
    version: 'staged-a8b6-fresh-frame-model-intent-v4',
    planId, phase: 'B', videoSha256: evidence.videoSha256,
    evidenceSha256, priorV3, modelId,
    promptSha256: sha(freshA8B6FrameReviewPromptV4(evidence)),
    requestKey, createdAt: new Date().toISOString(),
  }, root)
}

export async function readFreshA8B6FrameReviewIntentV4(planId, phase,
  root = process.cwd()) {
  const { evidence, evidenceSha256, priorV3 } =
    await readFreshA8B6ReviewEvidenceV4(planId, phase, root)
  const { value: intent, sha256: intentSha256 } = await signedFile(
    filename(planId, 'frame-model-intent-v4', root), root)
  if (intent.version !== 'staged-a8b6-fresh-frame-model-intent-v4'
    || intent.planId !== planId || intent.phase !== 'B'
    || intent.videoSha256 !== evidence.videoSha256
    || intent.evidenceSha256 !== evidenceSha256
    || canonical(intent.priorV3) !== canonical(priorV3)
    || intent.promptSha256 !== sha(freshA8B6FrameReviewPromptV4(evidence))
    || !/^[\w-]{3,128}$/.test(String(intent.modelId))
    || !String(intent.requestKey ?? '').startsWith(
      `staged-a8b6-fresh-frame-v4:${planId}:B:${evidence.videoSha256}:`)
    || !Number.isFinite(Date.parse(intent.createdAt)))
    fail('signed v4 model intent changed')
  return { intent, intentSha256, evidence, evidenceSha256, priorV3 }
}

export async function saveFreshA8B6FrameReviewSubmitV4(planId, phase,
  root = process.cwd()) {
  const { intent, intentSha256 } = await readFreshA8B6FrameReviewIntentV4(
    planId, phase, root)
  return signOnce(filename(planId, 'frame-model-submit-v4', root), {
    version: 'staged-a8b6-fresh-frame-model-submit-v4',
    planId, phase: 'B', intentSha256,
    requestKey: intent.requestKey, createdAt: new Date().toISOString(),
  }, root)
}

export async function readFreshA8B6FrameReviewSubmitV4(planId, phase,
  root = process.cwd()) {
  const { intent, intentSha256 } = await readFreshA8B6FrameReviewIntentV4(
    planId, phase, root)
  const { value: submit, sha256: submitSha256 } = await signedFile(
    filename(planId, 'frame-model-submit-v4', root), root)
  if (submit.version !== 'staged-a8b6-fresh-frame-model-submit-v4'
    || submit.planId !== planId || submit.phase !== 'B'
    || submit.intentSha256 !== intentSha256
    || submit.requestKey !== intent.requestKey
    || !Number.isFinite(Date.parse(submit.createdAt)))
    fail('signed v4 one-shot submission changed')
  return { submit, submitSha256, intent, intentSha256 }
}

export function assertFreshA8B6FrameModelLedgerV4(row, phase,
  evidence, intent) {
  assertB3(evidence?.planId, phase)
  const request = row?.request_data
  if (!MODEL_ID.test(String(row?.id)) || row.channel !== 'workflow'
    || row.workflow_id !== 'wf-sanguo-history-drama'
    || row.node_id !== 'staged-a8b6-fresh-frame-review-v4'
    || row.model_id !== intent.modelId
    || row.capability !== 'text' || row.provider !== 'Codex'
    || row.status !== 'succeeded'
    || request?.operation !== 'history.media-review'
    || request.requestKey !== intent.requestKey
    || request.prompt !== freshA8B6FrameReviewPromptV4(evidence)
    || canonical(request.params?.reviewImages)
      !== canonical(evidence.reviewImages)
    || request.reviewImageHashes?.length !== evidence.frames.length)
    fail('v4 model ledger did not see exact five signed B3 JPEGs')
  for (const [index, frame] of evidence.frames.entries())
    if (request.reviewImageHashes[index]?.url !== frame.url
      || request.reviewImageHashes[index]?.sha256 !== frame.sha256)
      fail(`v4 model attachment ${index} changed`)
  let report
  try { report = parseStructuredJson(extractTextResponse(row.response_data)) }
  catch { fail('v4 model output is not structured JSON') }
  const observed = new Set()
  if (report?.version !== 'staged-a8b6-fresh-frame-clarification-v4'
    || report.phase !== 'B'
    || report.videoSha256 !== evidence.videoSha256
    || !['accept', 'revise', 'uncertain'].includes(report.decision)
    || CHECKS.some(name => typeof report.checks?.[name] !== 'boolean')
    || Object.keys(report.checks ?? {}).some(name => !CHECKS.includes(name))
    || !Array.isArray(report.observations)
    || report.observations.length !== FRAME_INDICES.length
    || report.observations.some(item => {
      if (item.phase !== 'B' || !FRAME_INDICES.includes(item.frameIndex)
        || observed.has(item.frameIndex)
        || typeof item.description !== 'string'
        || item.description.trim().length < 12) return true
      observed.add(item.frameIndex)
      return false
    })
    || observed.size !== FRAME_INDICES.length
    || !Array.isArray(report.issues))
    fail('v4 output must report only five observable B3 samples')
  const accepted = report.decision === 'accept'
    && CHECKS.every(name => report.checks[name] === true)
    && report.issues.length === 0
  return { row, report, accepted, ledgerSha256: sha(canonical(row)),
    promptSha256: sha(request.prompt), requestKey: request.requestKey }
}

export async function verifyFreshA8B6FrameModelLedgerV4(planId, phase,
  executionId, root = process.cwd(), query) {
  assertB3(planId, phase)
  if (!MODEL_ID.test(String(executionId))) fail('v4 model execution ID invalid')
  const { intent, evidence, evidenceSha256, priorV3 } =
    await readFreshA8B6FrameReviewIntentV4(planId, phase, root)
  await readFreshA8B6FrameReviewSubmitV4(planId, phase, root)
  let db
  if (!query) {
    db = new pg.Client({ connectionString: process.env.DATABASE_URL
      ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
    await db.connect()
    query = db.query.bind(db)
  }
  let rows
  try {
    rows = (await query(`SELECT id,channel,workflow_id,node_id,model_id,
      capability,provider,status,request_data,response_data
      FROM model_execution_records WHERE request_data->>'requestKey'=$1
      ORDER BY created_at`, [intent.requestKey])).rows
  } finally { if (db) await db.end() }
  if (rows.length !== 1 || rows[0].id !== executionId)
    fail('v4 one-shot model ledger missing or duplicated')
  const checked = assertFreshA8B6FrameModelLedgerV4(rows[0], phase,
    evidence, intent)
  if (!checked.accepted) fail('v4 observable B3 frame facts not accepted')
  return { ...checked, evidenceSha256, priorV3 }
}
