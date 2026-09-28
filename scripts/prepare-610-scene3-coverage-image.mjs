#!/usr/bin/env node
// No provider call. Prepare immutable scene-03 coverage shot and archive actual
// prior video tail plus the two selected identity sheets before image payment.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { prepareWorkflowRunContext } from '../src/workflow-run-context.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { COVERAGE_CUT_PRECHECK_CODE } from '../src/coverage-cut-frame-gate.ts'

const sourceId = 'record-610-scene4-voice-repair-20260928-v1'
const oldCandidate = path.resolve('logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop3-media/scene3-coverage-candidate-20260928-v1/request-private.json')
const out = path.resolve(process.argv[2] || 'logs/dramatic-expression/live-20260928/record-7cb4d1-readonly/loop3-media/scene3-coverage-first-frame-20260928-v1')
const sha = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
try {
  await db.query('begin isolation level repeatable read read only')
  const saved = (await db.query("select id,schema_version,nodes,edges from workflow_configs where id='wf-sanguo-history-drama'")).rows[0]
  assert.equal(saved?.schema_version, 156)
  for (const id of ['sanguo-coverage-precheck', 'sanguo-coverage-source-archive', 'sanguo-coverage-first-frame',
    'sanguo-coverage-evidence', 'sanguo-coverage-review', 'sanguo-coverage-approval']) {
    assert.equal(saved.nodes.filter(node => node.id === id).length, 1, `Missing graph node ${id}`)
  }
  assert.equal(saved.edges.some(edge => edge.from === 'sanguo-first-frame-branch' && edge.to === 'sanguo-video'), false)
  const record = (await db.query('select id,md5(result::text) as md5,result from execution_records where id=$1', [sourceId])).rows[0]
  assert.equal(record?.md5, 'df7ddd75cf661ae5ee5d60656854989c')
  const state = decodeExecutionState(record.result)
  const branch = saved.nodes.find(node => node.id === 'sanguo-first-frame-branch')
  const image = saved.nodes.find(node => node.id === 'sanguo-coverage-first-frame')
  const index = state.nodeRuns.findIndex(run => run.node.id === branch.id && run.loopIndex === 2)
  assert.ok(index > 0)
  const context = prepareWorkflowRunContext(state.nodeRuns, index).inputContext
  const original = context.shot_script
  const frozen = JSON.parse(await readFile(oldCandidate, 'utf8'))
  assert.equal(original.id, 'scene-03')
  assert.equal(original.audioText, frozen.params.audioText)
  assert.equal(original.duration, frozen.params.duration)
  assert.equal(original.continuity.mode, 'tail_continuation')
  assert.equal(frozen.params.continuityMode, 'coverage_cut')
  assert.deepEqual(frozen.params.referenceBindings.map(item => item.assetId),
    ['character-070b25d71205797c', 'character-41953008cc8dfd45'])
  const visualPrompt = frozen.prompt.match(/【场景与开场画面】([^\n]+)/)?.[1]?.trim()
  const camera = frozen.prompt.match(/(?:^|\n)运镜：([^\n]+)/)?.[1]?.trim()
  assert.ok(visualPrompt?.includes('张飞在左、严颜在右') && visualPrompt.includes('双腕始终由同一根绳索一起缚在身前'))
  assert.ok(camera?.includes('coverage_cut'))
  const { raw: _raw, ...approved } = original
  void _raw
  const shot = { ...approved, continuity: { ...original.continuity, mode: 'coverage_cut', bridgeType: 'cut',
    bridgeAnchor: '前镜已解码视频的实际尾帧；同侧轴线新机位，张飞在左，严颜在右，双腕同绳。' },
  firstFrameMode: 'reference', visualPrompt, camera,
  shotIntent: { ...original.shotIntent, cameraReason: '同侧轴线由双人全景切平视中近景，张飞发问、严颜被缚且准备回应均可见。' } }
  assert.equal(shot.audioText, original.audioText)
  assert.equal(sha(shot.pacing), sha(original.pacing))
  assert.equal(shot.duration, 9)
  const branchOutput = await executeCodeNode({ code: branch.code, context: {
    ...context, input: { ...context.input, characterAssetSelections: {} }, shot_script: shot,
  } })
  assert.equal(branchOutput.shouldGenerateCoverageFrame, true)
  assert.equal(branchOutput.shouldReusePreviousTail, false)
  const precheck = await executeCodeNode({ code: COVERAGE_CUT_PRECHECK_CODE, params: {
    previousLastFrame: context.loop.previous.last_frame, previousVideoShot: context.loop.previous.video_shot,
    referenceBindings: branchOutput.referenceRequest.referenceBindings,
    referenceImages: branchOutput.referenceRequest.referenceImages,
  } })
  assert.deepEqual(precheck.referenceBindings.map(item => item.assetId),
    frozen.params.referenceBindings.map(item => item.assetId))
  const tailUrl = precheck.previousTail.url
  const tailBytes = await readFile(path.resolve(`public${tailUrl}`))
  const video = context.loop.previous.video_shot
  const videoEvidence = JSON.parse(await readFile(path.resolve(`public${video.evidenceUrl}`), 'utf8'))
  assert.equal(videoEvidence.sha256, video.sha256)
  assert.equal(videoEvidence.lastFrameUrl, tailUrl)
  assert.equal(videoEvidence.frames.at(-1), tailUrl)
  assert.equal(sha(tailBytes), sha(await readFile(path.resolve(`public${video.lastFrameUrl}`))))
  await db.query('rollback')

  const archiveResponse = await fetch('http://127.0.0.1:5173/api/coverage-cut-source-archive', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(precheck),
  })
  const sources = await archiveResponse.json()
  assert.equal(archiveResponse.status, 200, `Source archive rejected: ${JSON.stringify(sources)}`)
  assert.equal(sources.version, 'coverage-cut-sources-v1')
  assert.equal(sources.previousTail.sourceUrl, tailUrl)
  assert.equal(sources.previousTail.sha256, sha(tailBytes))
  assert.deepEqual(sources.referenceBindings.map(item => item.assetId),
    frozen.params.referenceBindings.map(item => item.assetId))
  for (const item of [sources.previousTail, ...sources.referenceBindings]) {
    assert.match(item.url, /^\/generated\/coverage-source-[a-f0-9]{64}\.(?:png|jpe?g|webp)$/)
    assert.equal(item.sha256, sha(await readFile(path.resolve(`public${item.url}`))))
  }
  const requestKey = `scene3-coverage-first-frame:${randomUUID()}`
  const prompt = renderWorkflowTemplate(image.prompt, { shot_script: shot })
  assert.ok(prompt.includes('同一场、同一轴线侧的新摄影机机位') && prompt.includes(visualPrompt))
  const params = { referenceImage: sources.previousTail.url, coverageSources: sources,
    imageEdit: true, aspectRatio: '16:9', resolution: '1k', n: 1 }
  await mkdir(out, { recursive: false })
  const plan = { format: 'scene3-coverage-first-frame-preflight-v1', sourceId, sourceMd5: record.md5,
    schemaVersion: saved.schema_version, shot, shotSha256: sha(shot), prompt, promptSha256: sha(prompt),
    imageNodeId: image.id, imageModelId: image.modelId, imageOperation: image.operation,
    params, requestKey, originalVideoTaskId: '933484061220827179',
    oldPaidCandidateAccepted: false, newImageTaskSubmitted: false, newVideoTaskSubmitted: false }
  await writeFile(path.join(out, 'plan-private.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const publicProof = { format: plan.format, sourceId, sourceMd5: record.md5,
    schemaVersion: saved.schema_version, shotId: shot.id, shotSha256: plan.shotSha256,
    approvedDialogueSha256: sha(shot.audioText), durationSeconds: shot.duration,
    previousVideoSha256: video.sha256, actualTailSha256: sources.previousTail.sha256,
    selectedAssetIds: sources.referenceBindings.map(item => item.assetId),
    selectedAssetSha256s: sources.referenceBindings.map(item => item.sha256),
    promptSha256: plan.promptSha256, requestKey, paidImageCount: 0, paidVideoCount: 0,
    databaseWrites: 0, sourceExecutionWrites: 0 }
  await writeFile(path.join(out, 'preflight.json'), JSON.stringify(publicProof, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ output: out, ...publicProof }, null, 2))
} catch (error) {
  await db.query('rollback').catch(() => {})
  throw error
} finally { await db.end() }
