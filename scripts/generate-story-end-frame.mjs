#!/usr/bin/env node
// Generate one separately ledgered target image without editing the source run.
// Preview by default; --apply permits one request, with no automatic retries.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { modelRequestFingerprint } from '../server/model-request-key.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const generatedRoot = path.join(root, 'public/generated')
const schemaVersion = 'story-target-end-frame-manifest-v1'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw Error(`STORY_TARGET_END_FRAME_INVALID: ${message}`) }
const urlOf = value => typeof value === 'string' ? value : value?.url
const usage = 'node scripts/generate-story-end-frame.mjs --source record-ID --shot 1 --prompt-file FILE --version V --app http://127.0.0.1:5177 --out SUMMARY.json [--apply]'

export function parseArguments(args) {
  const options = { apply: false, app: 'http://127.0.0.1:5177' }
  const seen = new Set()
  if (args.length === 1 && args[0] === '--help') return { help: true }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (seen.has(flag)) fail(`duplicate argument ${flag}`)
    seen.add(flag)
    if (flag === '--apply') { options.apply = true; continue }
    const key = { '--source': 'sourceId', '--shot': 'shot', '--prompt-file': 'promptFile',
      '--version': 'version', '--app': 'app', '--out': 'out' }[flag]
    if (!key || !args[index + 1] || args[index + 1].startsWith('--')) fail(`unknown or incomplete argument ${flag}`)
    options[key] = args[++index]
  }
  if (!/^record-[\w-]+$/.test(options.sourceId ?? '')) fail('--source must be a record ID')
  if (!/^[1-9]\d*$/.test(options.shot ?? '') || !Number.isSafeInteger(Number(options.shot))) fail('--shot must be a positive, one-based integer')
  options.shot = Number(options.shot)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.version ?? '')) fail('--version must be a short, explicit candidate version')
  if (!options.promptFile || !options.out) fail('--prompt-file and --out are required')
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(options.app)
    || Number(new URL(options.app).port) > 65535) fail('--app must be a local loopback HTTP server')
  options.promptFile = path.resolve(options.promptFile)
  options.out = path.resolve(options.out)
  if (options.out === options.promptFile) fail('summary must not overwrite the prompt file')
  return options
}

async function localImage(url) {
  if (!/^\/generated\/[A-Za-z0-9._-]+\.(?:png|jpg|jpeg|webp)$/.test(url ?? '')) fail('image URL is not a local generated image')
  const base = await realpath(generatedRoot)
  const filename = await realpath(path.join(base, path.basename(url)))
  if (!filename.startsWith(base + path.sep) || !(await stat(filename)).isFile()) fail('image escapes generated directory')
  const bytes = await readFile(filename)
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) fail('image is empty or oversized')
  const raster = sharp(bytes, { failOn: 'error', limitInputPixels: 30_000_000 })
  const metadata = await raster.metadata()
  await raster.raw().toBuffer()
  if (!metadata.width || !metadata.height) fail('image has no decoded dimensions')
  return { url, bytes, sha256: sha256(bytes), width: metadata.width, height: metadata.height }
}

export function selectSource(state, shot) {
  const runs = Array.isArray(state?.nodeRuns) ? state.nodeRuns : []
  const candidates = runs.filter(run => run.node?.id === 'node-image' && run.loopIndex === shot - 1)
  // A later failed take must not be hidden by an earlier successful result.
  if (candidates.length !== 1 || candidates[0].status !== 'success') fail('shot must have exactly one current, successful image run')
  const image = candidates[0]
  const modelId = typeof image.output?.model === 'string' ? image.output.model : image.node.modelId
  if (!modelId || image.node.modelId !== modelId) fail('source image model identity is missing or inconsistent')
  const refs = image.output?.params?.referenceImages
  if (!Array.isArray(refs) || refs.length !== 4) fail('the successful source image must retain its four submitted identity references')
  return { image, modelId, refs: refs.map(urlOf) }
}

async function prepare(db, options, prompt) {
  const row = (await db.query('SELECT workflow_id,result,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [options.sourceId])).rows[0]
  if (!row || row.workflow_id !== 'wf-story') fail('source story execution is missing')
  const source = selectSource(decodeExecutionState(row.result), options.shot)
  const opening = await localImage(source.image.output?.url)
  const firstJpeg = await sharp(opening.bytes, { failOn: 'error' }).jpeg({ quality: 94 }).toBuffer()
  if (firstJpeg.length > 5 * 1024 * 1024) fail('opening-frame JPEG exceeds provider limit')
  const references = [`data:image/jpeg;base64,${firstJpeg.toString('base64')}`]
  const referenceSha256 = [sha256(firstJpeg)]
  for (const url of source.refs) {
    if (typeof url !== 'string' || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) fail('source identity reference is not an embedded image')
    const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) fail('identity reference is empty or oversized')
    await sharp(bytes, { failOn: 'error', limitInputPixels: 30_000_000 }).raw().toBuffer()
    references.push(url)
    referenceSha256.push(sha256(bytes))
  }
  const model = (await db.query('SELECT id,name,provider,capability,settings FROM model_configs WHERE id=$1', [source.modelId])).rows[0]
  if (!model || model.capability !== 'image' || !model.settings) fail('the successful source image model is unavailable')
  const requestKey = `${options.sourceId}:shot${options.shot}:target-end-frame-${options.version}:${opening.sha256.slice(0, 12)}`
  const request = { model, prompt,
    params: { referenceImages: references, size: `${opening.width}x${opening.height}`, singleFrame: true },
    operation: 'story.target-end-frame', executionContext: { requestKey, workflowId: 'wf-story',
      workflowName: '打工猫短视频', nodeId: `node-target-end-frame-shot${options.shot}`, nodeName: `第${options.shot}镜目标尾帧` } }
  const fingerprint = modelRequestFingerprint(request)
  const summary = { schemaVersion, sourceRecordId: options.sourceId, sourceResultMd5: row.result_md5,
    sourceRunId: source.image.id, shot: options.shot, version: options.version,
    sourceFirstFrameUrl: opening.url, sourceFirstFrameSha256: opening.sha256,
    referenceCount: references.length, referenceSha256, modelId: model.id,
    requestKey, requestFingerprint: fingerprint, promptSha256: sha256(Buffer.from(prompt)),
    width: opening.width, height: opening.height, endpoint: `${options.app}/api/node-run` }
  return { request, summary }
}

async function readManifest(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

export function validateManifest(previous, summary) {
  if (previous && (previous.schemaVersion !== schemaVersion || previous.requestKey !== summary.requestKey
    || previous.requestFingerprint !== summary.requestFingerprint)) fail('summary path already belongs to different inputs; use a new version and output path')
}

async function saveManifest(filename, summary) {
  await mkdir(path.dirname(filename), { recursive: true })
  const temp = `${filename}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  await rename(temp, filename)
}

function outputUrl(body) {
  const url = body?.data?.[0]?.url
  return typeof url === 'string' && /^\/generated\/[A-Za-z0-9._-]+\.(?:png|jpg|jpeg|webp)$/.test(url) ? url : ''
}

async function verifiedOutput(saved, summary, expectedUrl) {
  const url = outputUrl(saved.response_data)
  if (!url || expectedUrl && url !== expectedUrl) fail('successful ledger does not match the returned local image')
  const output = await localImage(url)
  if (output.width !== summary.width || output.height !== summary.height) fail('target dimensions differ from the source frame')
  return { ledgerId: saved.id, outputUrl: url, outputSha256: output.sha256, width: output.width, height: output.height }
}

export async function run(options) {
  const prompt = (await readFile(options.promptFile, 'utf8')).trim()
  if (!prompt || Buffer.byteLength(prompt) > 40_000) fail('prompt file must contain 1–40000 bytes of text')
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  let submitted
  try {
    const { request, summary } = await prepare(db, options, prompt)
    // Previews also write manifests, so serialize them with paid submissions.
    const locked = (await db.query('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked',
      ['story-target-end-frame', summary.requestKey])).rows[0]?.locked
    if (!locked) fail('the same target-frame request is already in progress')
    const manifestLocked = (await db.query('SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked',
      ['story-target-end-frame-manifest', options.out])).rows[0]?.locked
    if (!manifestLocked) fail('the output manifest is in use by another request')
    const previous = await readManifest(options.out)
    validateManifest(previous, summary)
    const history = (await db.query(`SELECT id,status,response_data,request_data->>'fingerprint' AS fingerprint
      FROM model_execution_records WHERE request_data->>'requestKey'=$1 ORDER BY created_at DESC`, [summary.requestKey])).rows
    if (history.some(saved => saved.fingerprint !== summary.requestFingerprint)) fail('request key belongs to different inputs; use a new version')
    const completed = history.find(saved => saved.status === 'succeeded')
    if (completed) {
      const result = { ...summary, mode: 'reuse', willSubmit: false, modelCalls: 0,
        ...await verifiedOutput(completed, summary), savedAt: new Date().toISOString() }
      await saveManifest(options.out, result)
      return result
    }
    if (history.length) fail(`request key already has a ${history[0].status} ledger entry; inspect it before another candidate`)
    if (previous?.requestAttempted) fail('manifest records an earlier submission without success; inspect its ledger before another candidate')
    if (!options.apply) {
      const result = { ...summary, mode: 'preview', willSubmit: false, modelCalls: 0, savedAt: new Date().toISOString() }
      await saveManifest(options.out, result)
      return result
    }
    const latest = await prepare(db, options, prompt)
    if (latest.summary.requestKey !== summary.requestKey || latest.summary.requestFingerprint !== summary.requestFingerprint
      || latest.summary.sourceRunId !== summary.sourceRunId) fail('source inputs changed before submission')
    submitted = { ...summary, mode: 'submitted', requestAttempted: true, willSubmit: true,
      submittedAt: new Date().toISOString() }
    // Persist the request identity before any provider call, including timeouts.
    await saveManifest(options.out, submitted)
    const response = await fetch(summary.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(660_000) })
    const result = await response.json()
    if (!response.ok || result?.status !== 200) fail(`image request ended with HTTP ${response.status}, model status ${String(result?.status)}`)
    const url = outputUrl(result.body)
    if (!url) fail('image request returned no local saved image')
    const saved = (await db.query(`SELECT id,response_data FROM model_execution_records WHERE request_data->>'requestKey'=$1
      AND request_data->>'fingerprint'=$2 AND status='succeeded' ORDER BY created_at DESC LIMIT 1`,
      [summary.requestKey, summary.requestFingerprint])).rows[0]
    if (!saved) fail('target image returned but its model ledger did not save success')
    const final = { ...submitted, mode: 'generated', modelCalls: 1,
      ...await verifiedOutput(saved, summary, url), completedAt: new Date().toISOString() }
    await saveManifest(options.out, final)
    return final
  } catch (error) {
    if (submitted) await saveManifest(options.out, { ...submitted, mode: 'incomplete',
      stoppedAt: new Date().toISOString(), needsLedgerInspection: true })
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve().then(async () => {
    const options = parseArguments(process.argv.slice(2))
    if (options.help) { console.log(usage); return }
    console.log(JSON.stringify(await run(options), null, 2))
  }).catch(error => {
    console.error(`Target-frame request stopped: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
