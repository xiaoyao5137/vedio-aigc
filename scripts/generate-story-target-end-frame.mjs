#!/usr/bin/env node
// One-off, traceable target frame for the breakfast shot. Dry-run by default.
// --apply performs exactly one Codex image request. A saved request with the
// same identity is reused; a failed or changed request requires a new version.
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { modelRequestFingerprint } from '../server/model-request-key.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const generatedRoot = path.join(root, 'public/generated')
const recordId = 'record-story-duration-recovery-v1'
const version = 'v1'
const server = 'http://127.0.0.1:5174'
const apply = process.argv.includes('--apply')
if (process.argv.slice(2).some(arg => arg !== '--apply')) {
  throw new Error('Usage: node scripts/generate-story-target-end-frame.mjs [--apply]')
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const localImagePath = async url => {
  if (!/^\/generated\/[A-Za-z0-9._-]+\.(?:png|jpg|jpeg|webp)$/.test(url)) throw Error('source image URL is not a local generated image')
  const filename = await realpath(path.join(generatedRoot, path.basename(url)))
  const base = await realpath(generatedRoot)
  if (!filename.startsWith(base + path.sep) || !(await stat(filename)).isFile()) throw Error('source image escapes generated directory')
  return filename
}

const targetPrompt = `以附件1为同一镜头的开场原图，生成这支早餐短视频动作全部完成后的单幅目标尾帧。附件2至5只用来锁定同一只灰蓝短腿圆脸猫和同一只黄白柴犬的外观身份，不复制参考图的背景和排版。
保持附件1的 9:16 固定平视机位、清晨暖光、厨房背景、木桌、左猫右犬、毛色和身体比例。每只动物只出现一次。时间点是两次道具交接均已完成并静止：唯一一枚银色硬币已经从猫爪前移到柴犬靠画面中间的前爪旁，紧贴狗爪可触及的位置，并与狗爪处在同一桌面纵深；硬币绝不能留在靠镜头的桌面前景中央。唯一一个敞口棕色纸袋已从柴犬爪边移到蓝猫两只前爪正前方、猫爪可触及的位置，袋内一只白色褶顶包子清晰可见。硬币和纸袋彼此分开，不要遮挡各自与动物前爪的位置关系。
只改道具位置及必要的自然前爪姿态；保留同一连续场景、同一两只动物和相同机位。画面应一眼看清“硬币在柴犬前爪旁、包子袋在蓝猫前爪旁”。不要文字、字幕、额外道具、额外肢体、拼图或分镜格。写实摄影，单幅完整画面。`

function outputUrl(body) {
  const url = body?.data?.[0]?.url
  return typeof url === 'string' && /^\/generated\/[A-Za-z0-9._-]+\.png$/.test(url) ? url : ''
}

async function main() {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    const row = (await db.query('select workflow_id,result from execution_records where id=$1', [recordId])).rows[0]
    if (!row || row.workflow_id !== 'wf-story') throw Error('source story execution is missing')
    const runs = decodeExecutionState(row.result).nodeRuns
    const firstRun = runs.find(run => run.node?.id === 'node-image' && run.loopIndex === 0 && run.status === 'success')
    const refsRun = runs.find(run => run.node?.id === 'node-model-images' && run.status === 'success')
    const firstUrl = firstRun?.output?.url
    const sourceRefs = refsRun?.output?.items
    if (typeof firstUrl !== 'string' || !Array.isArray(sourceRefs) || sourceRefs.length !== 4) {
      throw Error('the succeeded first frame and four source identity references are required')
    }
    const firstBytes = await readFile(await localImagePath(firstUrl))
    const firstJpeg = await sharp(firstBytes, { failOn: 'error' }).jpeg({ quality: 94 }).toBuffer()
    const firstMeta = await sharp(firstJpeg, { failOn: 'error' }).metadata()
    if (firstMeta.width !== 576 || firstMeta.height !== 1024 || firstJpeg.length > 5 * 1024 * 1024) {
      throw Error('first-frame JPEG has unexpected dimensions or size')
    }
    const references = [`data:image/jpeg;base64,${firstJpeg.toString('base64')}`]
    const referenceHashes = [sha256(firstJpeg)]
    for (const item of sourceRefs) {
      const url = item?.url
      if (typeof url !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) {
        throw Error('source character reference is not a JPEG data URL')
      }
      const bytes = Buffer.from(url.slice('data:image/jpeg;base64,'.length), 'base64')
      if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw Error('source character reference is empty or oversized')
      references.push(url)
      referenceHashes.push(sha256(bytes))
    }
    const model = (await db.query('select id,name,provider,capability,settings from model_configs where id=$1', ['codex-gpt-image-2'])).rows[0]
    if (!model || model.provider !== 'Codex' || model.capability !== 'image') throw Error('configured Codex GPT Image model is unavailable')
    const requestKey = `${recordId}:shot1:target-end-frame-${version}:${sha256(firstBytes).slice(0, 12)}`
    const request = { model, prompt: targetPrompt, params: { referenceImages: references, size: '576x1024', singleFrame: true },
      operation: 'story.target-end-frame', executionContext: { requestKey, workflowId: 'wf-story', workflowName: '打工猫短视频',
        nodeId: 'node-target-end-frame-shot1', nodeName: '早餐到爪目标尾帧' } }
    const fingerprint = modelRequestFingerprint(request)
    const summary = { recordId, sourceFirstFrameUrl: firstUrl, sourceFirstFrameSha256: sha256(firstBytes),
      referenceSha256: referenceHashes, referenceCount: references.length, modelId: model.id,
      requestKey, requestFingerprint: fingerprint, promptSha256: sha256(Buffer.from(targetPrompt)),
      endpoint: `${server}/api/node-run` }

    if (apply) {
      const lock = (await db.query('select pg_try_advisory_lock(hashtext($1),hashtext($2)) as locked',
        ['story-target-end-frame', requestKey])).rows[0]?.locked
      if (!lock) throw Error('the same target-frame request is already in progress')
    }
    const history = (await db.query(`select id,status,http_status,response_data,request_data->>'fingerprint' as fingerprint
      from model_execution_records where request_data->>'requestKey'=$1 order by created_at desc`, [requestKey])).rows
    if (history.some(saved => saved.fingerprint !== fingerprint)) throw Error('request key already belongs to different inputs; bump script version')
    const completed = history.find(saved => saved.status === 'succeeded')
    if (completed) {
      const url = outputUrl(completed.response_data)
      if (!url) throw Error('saved successful result has no local PNG URL')
      await localImagePath(url)
      console.log(JSON.stringify({ ...summary, mode: 'reuse', ledgerId: completed.id, outputUrl: url }, null, 2))
      return
    }
    if (history.length) throw Error(`request key already has a ${history[0].status} ledger entry; inspect it before a new candidate`)
    if (!apply) {
      console.log(JSON.stringify({ ...summary, mode: 'dry-run', willSubmit: false }, null, 2))
      return
    }
    const response = await fetch(`${server}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(660_000) })
    const result = await response.json()
    if (!response.ok || result?.status !== 200) throw Error(`image request ended with HTTP ${response.status}, model status ${String(result?.status)}`)
    const url = outputUrl(result.body)
    if (!url) throw Error('image request returned no saved local PNG')
    const filename = await localImagePath(url)
    const bytes = await readFile(filename)
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
    if (metadata.width !== 576 || metadata.height !== 1024) throw Error('saved target image has unexpected dimensions')
    const saved = (await db.query(`select id from model_execution_records where request_data->>'requestKey'=$1
      and request_data->>'fingerprint'=$2 and status='succeeded' order by created_at desc limit 1`, [requestKey, fingerprint])).rows[0]
    if (!saved) throw Error('target image exists but the execution ledger did not save success')
    console.log(JSON.stringify({ ...summary, mode: 'generated', ledgerId: saved.id, outputUrl: url,
      outputSha256: sha256(bytes), width: metadata.width, height: metadata.height }, null, 2))
  } finally { await db.end() }
}

main().catch(error => { console.error(`Target-frame request stopped: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
