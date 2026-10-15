/** Independent visual review of the edited A end guide. This verdict covers
 * the guide image only. It says nothing about a future provider video's tail. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { extractTextResponse, parseStructuredJson } from
  '../src/workflow-core.ts'
import { verifyA8B6ARetakeTargetSourceSync } from
  './staged-scene-cut-a8b6-A-retake-target.mjs'
import { verifyA8B6ARetakeTargetReviewEvidenceSync } from
  './staged-scene-cut-a8b6-A-retake-target-review-evidence.mjs'

const fail = reason => { throw Error(`A8B6_A_RETAKE_TARGET_REVIEW_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const outputFile = root => path.join(root,
  '.runtime/staged-scene-cut-a8b6-A-retake/target-review.json')
const key = root => {
  const bytes = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (bytes.length !== 32) fail('signing key invalid')
  return bytes
}
const sign = (body, secret) => createHmac('sha256', secret)
  .update(canonical(body)).digest('hex')
export const A8B6_A_RETAKE_TARGET_CHECKS = Object.freeze([
  'bothWristsTogetherInFront', 'singleRopeBindsBothWrists',
  'completedKnotBetweenWristsVisible', 'fingersVisible',
  'noWaistOrUpperArmRope', 'guardsHandsReleased',
  'zhangRemainsAtLeftStation', 'sameFourPeopleAndStreet',
  'noSpeechMouthShapeOrText',
])

export function freshA8B6ARetakeTargetReviewPrompt(source,
  sourceReceiptSha256, evidence) {
  return [
    '你是独立静帧视觉审核员。四张图依次是已批准 V9 首帧、被拒收 A 视频真实第192帧、基于该尾帧的 ImageGen 候选目标尾帧全图、候选图腕部细节裁剪。只评价真实可见像素，忽略编辑提示词；无法确认则判 uncertain。目标图不是已生成视频的真实尾帧。',
    `来源签证SHA256=${sourceReceiptSha256}。旧尾帧SHA256=${source.nativeEditTarget.sha256}；候选图SHA256=${source.output.sha256}。`,
    `四附件签证SHA256=${evidence.evidenceSha256}；附件顺序与原PNG/传输JPEG像素哈希：${evidence.receipt.imageOrder.map(item => `${item.role}:${item.sourceSha256}/${item.sha256}`).join('；')}。`,
    '逐项核对：严颜双腕是否在腹前并拢；同一根绳是否同时束住两腕；两腕之间是否有清晰已完成的结；手指是否可见；是否没有腰绳、上臂绳圈和垂绳；两名守卫手是否离开严颜；张飞是否留在左侧原位；四个人及街景身份、机位是否连续；有无语言口型、字幕或可读文字。额外手指、畸形手、伪造多人或明显画面拼接也应列为问题。',
    `只返回JSON：{"version":"staged-a8b6-A-retake-target-review-v1","targetSha256":"${source.output.sha256}","decision":"accept|revise|uncertain","checks":${JSON.stringify(Object.fromEntries(A8B6_A_RETAKE_TARGET_CHECKS.map(name => [name, null])))},"observations":[{"image":"approved-V9-first-frame","description":"可见事实"},{"image":"rejected-A-native-tail-frame192","description":"可见事实"},{"image":"edited-target-full","description":"可见事实"},{"image":"edited-target-wrist-detail","description":"可见事实"}],"issues":[] }。`,
  ].join('\n')
}

export async function verifyA8B6ARetakeTargetReviewModelLedger(executionId,
  root = process.cwd(), query) {
  if (!/^model-run-[\w-]+$/.test(String(executionId)))
    fail('independent model execution ID invalid')
  const { receipt: source, receiptSha256 } =
    verifyA8B6ARetakeTargetSourceSync(root)
  const evidence = verifyA8B6ARetakeTargetReviewEvidenceSync(root)
  const prompt = freshA8B6ARetakeTargetReviewPrompt(source,
    receiptSha256, evidence)
  const images = evidence.receipt.imageOrder.map(item => item.url)
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
  const request = row?.request_data
  if (row?.channel !== 'workflow'
    || row.workflow_id !== 'wf-sanguo-history-drama'
    || row.node_id !== 'staged-a8b6-A-retake-target-review'
    || row.capability !== 'text' || row.provider !== 'Codex'
    || row.status !== 'succeeded'
    || request?.operation !== 'history.media-review'
    || !String(request.requestKey ?? '').startsWith(
      `staged-a8b6-A-retake-target:${receiptSha256}:`)
    || request.prompt !== prompt
    || canonical(request.params?.reviewImages) !== canonical(images)
    || request.reviewImageHashes?.length !== 4
    || evidence.receipt.imageOrder.some((item, index) =>
      request.reviewImageHashes[index]?.url !== item.url
      || request.reviewImageHashes[index]?.sha256 !== item.sha256))
    fail('model ledger did not review exact source and target images')
  let report
  try { report = parseStructuredJson(extractTextResponse(row.response_data)) }
  catch { fail('model review output is not structured JSON') }
  if (report?.version !== 'staged-a8b6-A-retake-target-review-v1'
    || report.targetSha256 !== source.output.sha256
    || report.decision !== 'accept'
    || A8B6_A_RETAKE_TARGET_CHECKS.some(name => report.checks?.[name] !== true)
    || !Array.isArray(report.issues) || report.issues.length !== 0
    || !Array.isArray(report.observations)
    || report.observations.length !== 4
    || report.observations.some((item, index) =>
      item.image !== evidence.receipt.imageOrder[index].role
      || typeof item.description !== 'string'
      || item.description.length < 12))
    fail('independent target image review did not accept all required details')
  return { report, ledgerSha256: sha(canonical(row)),
    reportSha256: sha(canonical(report)), promptSha256: sha(prompt),
    sourceReceiptSha256: receiptSha256,
    reviewEvidenceSha256: evidence.evidenceSha256, executionId }
}

export function verifyA8B6ARetakeTargetReviewSync(root = process.cwd()) {
  const bytes = readFileSync(outputFile(root))
  const review = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = review
  const expected = sign(body, key(root))
  const source = verifyA8B6ARetakeTargetSourceSync(root)
  const evidence = verifyA8B6ARetakeTargetReviewEvidenceSync(root)
  if (!/^[a-f0-9]{64}$/.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || review.version !== 'staged-a8b6-A-retake-target-review-certificate-v1'
    || review.decision !== 'accept-target-guide-only'
    || review.sourceReceiptSha256 !== source.receiptSha256
    || review.reviewEvidenceSha256 !== evidence.evidenceSha256
    || review.targetSha256 !== source.receipt.output.sha256
    || !/^model-run-[\w-]+$/.test(String(review.modelExecutionId))
    || !/^[a-f0-9]{64}$/.test(String(review.modelLedgerSha256))
    || !/^[a-f0-9]{64}$/.test(String(review.reportSha256))
    || review.promptSha256 !== sha(freshA8B6ARetakeTargetReviewPrompt(
      source.receipt, source.receiptSha256, evidence))
    || review.nativeTailAccepted !== false)
    fail('signed independent target review changed')
  return { review, reviewSha256: sha(bytes) }
}

export async function issueA8B6ARetakeTargetReview(executionId,
  root = process.cwd()) {
  const verified = await verifyA8B6ARetakeTargetReviewModelLedger(
    executionId, root)
  const source = verifyA8B6ARetakeTargetSourceSync(root)
  const evidence = verifyA8B6ARetakeTargetReviewEvidenceSync(root)
  const body = {
    version: 'staged-a8b6-A-retake-target-review-certificate-v1',
    decision: 'accept-target-guide-only',
    sourceReceiptSha256: source.receiptSha256,
    reviewEvidenceSha256: evidence.evidenceSha256,
    targetSha256: source.receipt.output.sha256,
    modelExecutionId: executionId,
    modelLedgerSha256: verified.ledgerSha256,
    reportSha256: verified.reportSha256,
    promptSha256: verified.promptSha256,
    nativeTailAccepted: false,
  }
  const review = { ...body, signature: sign(body, key(root)) }
  const filename = outputFile(root)
  await mkdir(path.dirname(filename), { recursive: true })
  const bytes = Buffer.from(JSON.stringify(review, null, 2) + '\n')
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(bytes))
      fail('existing target review differs')
  }
  return verifyA8B6ARetakeTargetReviewSync(root)
}
