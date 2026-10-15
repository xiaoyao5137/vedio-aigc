#!/usr/bin/env node
/** One source-bound model adjudication for conflicting hem verdicts on identical pixels. */
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'

const SOURCE = 'record-4x5m31-original-repair-tail-guide-v2'
const FAILED = 'record-4x5m31-a8b6-frame-reuse-v1'
const CURRENT = 'record-4x5m31-a8b6-frame-reuse-v3'
const CURRENT_MD5 = '01146ea0d4a7c0d6664f65d5eb9bc54e'
const PLAN = 'edd1d9d046a5ed5eb7cd8dc1a0bde1de276f819fb04279297b2cf4d89208f016'
const IMAGE_SHA = '1d400ca2ab2b74b93fae1dd100d5aa1a274aa1875c25c940ab8efa85ac2dde2d'
const fail = message => { throw Error(`A8B6_FRAME_CONFLICT_INVALID: ${message}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const apply = process.argv.length === 3 && process.argv[2] === '--apply'
const sign = process.argv.length === 3 && process.argv[2] === '--sign'
if (process.argv.length !== (apply || sign ? 3 : 2))
  fail('only --apply or --sign is supported')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)

const root = process.cwd()
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  const rows = (await db.query(`SELECT id,md5(result::text) AS result_md5,result
    FROM execution_records WHERE id = ANY($1)`, [[SOURCE, FAILED, CURRENT]])).rows
  const records = new Map(rows.map(row => [row.id, row]))
  if (records.size !== 3 || records.get(CURRENT)?.result_md5 !== CURRENT_MD5)
    fail('source records or current rejected checkpoint changed')
  const runs = id => decodeExecutionState(records.get(id).result).nodeRuns
  const old = runs(SOURCE), first = runs(FAILED), newest = runs(CURRENT)
  const review = run => run?.output
  const oldReview = review(old[49]), firstReview = review(first[49])
  const latestReview = review(newest[49])
  const originalUrl = old[45]?.output?.url
  const currentUrl = newest[45]?.output?.url
  const asset = newest[41]?.output?.referenceBindings?.find(item => item.characterName === '严颜')
  const candidateReference = newest[48]?.output?.items?.[0]?.referenceImage
  const identityReference = newest[48]?.output?.items?.find(item => item.url === asset?.url)?.referenceImage
  if (oldReview?.passed !== true || oldReview.wardrobeHemCheck?.matches !== true
    || firstReview?.passed !== false || latestReview?.passed !== false
    || latestReview.issues?.length !== 1
    || latestReview.issues[0]?.code !== 'wardrobe_hem_proportion_mismatch'
    || originalUrl !== currentUrl
    || originalUrl !== '/generated/image-1d400ca2ab2b74b93fae1dd100d5aa1a.png'
    || newest[49]?.status !== 'success' || newest[50]?.status !== 'idle'
    || !candidateReference || !identityReference)
    fail('signed source pass/new rejections or same-image evidence is absent')
  const imageBytes = await readFile(path.join(root, 'public', originalUrl.slice(1)))
  if (sha(imageBytes) !== IMAGE_SHA) fail('paid source image changed')
  const identityBytes = await readFile(path.join(root, 'public', identityReference.slice(1)))
  const candidateBytes = await readFile(path.join(root, 'public', candidateReference.slice(1)))
  const comparisonPath = path.join(root, 'qa/staged-scene-cut/yan-t0-vs-identity.jpg')
  const comparisonBytes = await readFile(comparisonPath)
  const comparisonSha = sha(comparisonBytes)
  const comparisonUrl = `/generated/a8b6-first-frame-comparison-${comparisonSha.slice(0, 24)}.jpg`
  const evidence = { sourceRecordId: SOURCE, firstRejectedRecordId: FAILED,
    currentRecordId: CURRENT, currentResultMd5: CURRENT_MD5, qaPlanId: PLAN,
    candidateImageUrl: originalUrl, candidateImageSha256: IMAGE_SHA,
    candidateReference, candidateReferenceSha256: sha(candidateBytes),
    identityReference, identityReferenceSha256: sha(identityBytes),
    comparisonPath: 'qa/staged-scene-cut/yan-t0-vs-identity.jpg',
    comparisonUrl, comparisonSha256: comparisonSha,
    oldReview: { passed: oldReview.passed, wardrobeHemCheck: oldReview.wardrobeHemCheck,
      issues: oldReview.issues },
    firstRejectedReview: { passed: firstReview.passed,
      wardrobeHemCheck: firstReview.wardrobeHemCheck,
      issues: firstReview.issues },
    currentReview: { passed: latestReview.passed,
      wardrobeHemCheck: latestReview.wardrobeHemCheck,
      issues: latestReview.issues } }
  const prompt = `你是一次独立、冲突知情的古装连续性审核。请直接看附图中的候选首帧、冻结严颜正面身份图，以及由这两张原像素等高裁出的并排图。并排图仅便于定位，不替代原图。候选 PNG 与三次记录中的首帧是完全相同的字节；身份图也完全相同。\n\n请判断严颜灰褐外袍、黑色连续内摆、露靴比例差异是否达到必须拒绝同一人物身份的“清楚且显著改变”，还是正常视角、衣褶与站姿引起的轻微偏差；若无法判断则 uncertain。不要因为已有 pass 或 reject 数量而投票，也不要为了推进流程放宽标准。只依据原像素和以下现行统一条款：\n1. src/scene-cut-staging-workflow.ts 的规则允许正常站姿、衣褶、透视造成的小变化；只有衣层缺失、可见内摆面积或下摆/露靴比例有清楚且显著改变，才判不匹配。\n2. src/scene-cut-action-start-workflow.ts 的 v9 强制拒绝例是同一人的外摆、内摆都向鞋底明显偏移且露靴高度显著改变。\n\n原旧审批认为：${JSON.stringify(evidence.oldReview.wardrobeHemCheck)}\n第一次新拒绝认为：${JSON.stringify(evidence.firstRejectedReview.wardrobeHemCheck)}\n第二次新拒绝认为：${JSON.stringify(evidence.currentReview.wardrobeHemCheck)}\n\n注意各审查都约认为原内摆0.84-0.86、候选0.87-0.90，外摆约0.69-0.72基本稳定。你必须说明这些同样数字为何达到或未达到“清楚且显著”，不能忽略候选黑内摆更低、露靴更少，也不能把整体裁切变化当作解释。请输出单个 JSON 对象：{"version":"a8b6-frame-conflict-adjudication-v1","decision":"accept|reject|uncertain","outerHemStable":boolean,"innerHemDifferenceVisible":boolean,"normalizedLandmarks":"具体相对地标","significanceReason":"为何达到或未达到显著阈值","pixelEvidence":"原图具体证据","priorConflictResolved":boolean}。decision=accept 仅表示衣装比例可接受，不代替新14秒首帧全部动作审核或 node50。`
  const auditDir = path.join(root, '.runtime/staged-scene-cut-a8b6-approval', PLAN)
  const intentPath = path.join(auditDir, 'frame-conflict-adjudication-intent.json')
  let intent
  try { intent = JSON.parse(await readFile(intentPath, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!apply && !sign) {
    console.log(JSON.stringify({ evidence, promptSha256: sha(prompt),
      existingIntent: intent?.requestKey ?? null, modelCalls: 0, providerVideoCalls: 0,
      databaseWrites: 0 }, null, 2))
    process.exit(0)
  }
  const model = (await db.query(`SELECT id,name,provider,capability,settings
    FROM model_configs WHERE id='codex-local-vision'`)).rows[0]
  if (model?.provider !== 'Codex' || model.capability !== 'text')
    fail('approved independent vision model changed')
  if (intent && (intent.version !== 'a8b6-frame-conflict-intent-v1'
    || intent.qaPlanId !== PLAN || intent.currentResultMd5 !== CURRENT_MD5
    || intent.candidateImageSha256 !== IMAGE_SHA
    || intent.comparisonSha256 !== comparisonSha
    || intent.promptSha256 !== sha(prompt) || intent.modelId !== model.id))
    fail('existing one-call intent differs from immutable evidence')
  if (!intent && sign) fail('adjudication model was not run')
  if (!intent) {
    await mkdir(auditDir, { recursive: true })
    const target = path.join(root, 'public', comparisonUrl.slice(1))
    try { await copyFile(comparisonPath, target, constants.COPYFILE_EXCL) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    if (sha(await readFile(target)) !== comparisonSha) fail('comparison bytes changed')
    intent = { version: 'a8b6-frame-conflict-intent-v1', qaPlanId: PLAN,
      currentRecordId: CURRENT, currentResultMd5: CURRENT_MD5,
      candidateImageSha256: IMAGE_SHA, comparisonSha256: comparisonSha,
      promptSha256: sha(prompt), modelId: model.id,
      requestKey: `a8b6-frame-conflict:${PLAN}:${randomUUID()}`,
      createdAt: new Date().toISOString() }
    await writeFile(intentPath, JSON.stringify(intent, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
    const response = await fetch('http://127.0.0.1:5173/api/node-run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, operation: 'history.media-review',
        params: { reviewImages: [candidateReference, identityReference, comparisonUrl],
          promptInputMode: 'normalized-results', temperature: 0 },
        executionContext: { workflowId: 'wf-sanguo-history-drama',
          workflowName: '三国原著史料短剧（分步生成）',
          nodeId: 'a8b6-frame-conflict-adjudication', nodeName: 'A8B6 首帧衣摆冲突裁定',
          requestKey: intent.requestKey } }), signal: AbortSignal.timeout(900000) })
    const envelope = await response.json()
    if (!response.ok || envelope.status !== 200)
      fail(`model HTTP ${response.status}; one-call intent retained for ledger audit`)
  }
  const ledger = (await db.query(`SELECT id,status,request_data,response_data
    FROM model_execution_records WHERE request_data->>'requestKey'=$1
    ORDER BY created_at`, [intent.requestKey])).rows
  const succeeded = ledger.find(row => row.status === 'succeeded')
  if (!succeeded || ledger.filter(row => row.status === 'succeeded').length !== 1)
    fail('no unique successful model ledger; do not repeat provider call')
  const report = parseStructuredJson(extractTextResponse(succeeded.response_data))
  if (report?.version !== 'a8b6-frame-conflict-adjudication-v1'
    || !['accept', 'reject', 'uncertain'].includes(report.decision)
    || typeof report.normalizedLandmarks !== 'string'
    || typeof report.significanceReason !== 'string'
    || typeof report.pixelEvidence !== 'string'
    || typeof report.outerHemStable !== 'boolean'
    || typeof report.innerHemDifferenceVisible !== 'boolean'
    || typeof report.priorConflictResolved !== 'boolean')
    fail('adjudication JSON incomplete; preserve ledger, no automatic rerun')
  if (sign) {
    if (report.decision !== 'accept' || report.priorConflictResolved !== true
      || report.outerHemStable !== true || report.innerHemDifferenceVisible !== true)
      fail('independent conflict adjudication did not accept the observed difference')
    const key = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
    if (key.length !== 32) fail('source signing key invalid')
    const actualPrompt = succeeded.request_data?.prompt
    const logged = succeeded.request_data?.reviewImageHashes
    if (succeeded.request_data?.requestKey !== intent.requestKey
      || succeeded.request_data?.params?.reviewImages?.join('|') !==
        [candidateReference, identityReference, comparisonUrl].join('|')
      || actualPrompt !== prompt || !Array.isArray(logged) || logged.length !== 3
      || logged[0]?.sha256 !== sha(candidateBytes)
      || logged[1]?.sha256 !== sha(identityBytes)
      || logged[2]?.sha256 !== comparisonSha)
      fail('adjudication ledger did not view the locked images and prompt')
    const body = { version: 'a8b6-frame-conflict-adjudication-receipt-v1',
      qaPlanId: PLAN, sourceExecutionId: SOURCE,
      firstRejectedExecutionId: FAILED, rejectedExecutionId: CURRENT,
      rejectedResultMd5: CURRENT_MD5,
      sourceImageUrl: originalUrl, sourceImageSha256: IMAGE_SHA,
      sourceIdentityUrl: identityReference,
      sourceIdentitySha256: sha(identityBytes),
      comparisonUrl, comparisonSha256: comparisonSha,
      oldReviewSha256: sha(canonical(oldReview)),
      firstRejectedReviewSha256: sha(canonical(firstReview)),
      rejectedReviewSha256: sha(canonical(latestReview)),
      modelExecutionId: succeeded.id, modelRequestKey: intent.requestKey,
      modelId: model.id, modelPromptSha256: intent.promptSha256,
      modelResponseSha256: sha(canonical(succeeded.response_data)),
      decision: report.decision, report }
    const receipt = { ...body, signature: createHmac('sha256', key)
      .update(canonical(body)).digest('hex') }
    const receiptPath = path.join(auditDir, 'frame-conflict-adjudication.json')
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ receiptPath, receiptSha256: sha(await readFile(receiptPath)),
      modelExecutionId: succeeded.id, decision: report.decision,
      providerCalls: 0, databaseWrites: 0 }, null, 2))
    process.exit(0)
  }
  console.log(JSON.stringify({ ledgerId: succeeded.id, requestKey: intent.requestKey,
    evidenceSha256: sha(JSON.stringify(evidence)), report,
    next: report.decision === 'accept'
      ? 'source-bound new node49 review still required before node50'
      : 'keep node50 blocked; resolve image/video source mismatch before proceeding',
    providerVideoCalls: 0 }, null, 2))
} finally { await db.end() }
