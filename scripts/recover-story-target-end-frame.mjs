#!/usr/bin/env node
// Recover the one PNG produced by a completed Codex CLI image turn whose
// transport diagnostics caused the application to retain a failed ledger.
// Dry-run by default. This never calls a model or changes the failed ledger.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { modelRequestFingerprint } from '../server/model-request-key.ts'
import { normalizeOutputSize } from '../server/codex-image.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const generatedRoot = path.join(root, 'public/generated')
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')
const ledgerId = 'model-run-muljsrpd-b9lqpd2'
const recordId = 'record-story-duration-recovery-v1'
const expectedThreadId = '01a0e928-42b1-7fb1-9632-dcbc061778b0'
const expectedSourceSha256 = 'bdd02b1e5f356b019ee3fe9239c82d5a5190193b89d1c5d48027c7c1e09ce9b8'
const expectedFingerprint = 'e8dce2273a3e81a49f8264cc408527eb92d6394c90de8adf215c6287d4c6817c'
const expectedRequestKey = 'record-story-duration-recovery-v1:shot1:target-end-frame-v1:f9d550085f55'
const manifestName = 'record-story-duration-recovery-v1-shot1-target-end-frame-recovery.json'
const apply = process.argv.includes('--apply')
if (process.argv.slice(2).some(arg => arg !== '--apply')) {
  throw Error('Usage: node scripts/recover-story-target-end-frame.mjs [--apply]')
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const require = (condition, message) => { if (!condition) throw Error(message) }
const imageUrl = (hash) => `/generated/image-${hash.slice(0, 32)}.png`

async function firstFrameAndReferenceHashes(db) {
  const row = (await db.query('select workflow_id,result from execution_records where id=$1', [recordId])).rows[0]
  require(row?.workflow_id === 'wf-story', 'source workflow record is unavailable')
  const runs = decodeExecutionState(row.result).nodeRuns
  const first = runs.find(run => run.node?.id === 'node-image' && run.loopIndex === 0 && run.status === 'success')?.output?.url
  const refs = runs.find(run => run.node?.id === 'node-model-images' && run.status === 'success')?.output?.items
  require(typeof first === 'string' && /^\/generated\/[A-Za-z0-9._-]+\.png$/.test(first), 'source first frame is unavailable')
  require(Array.isArray(refs) && refs.length === 4, 'four source identity images are unavailable')
  const firstPath = await realpath(path.join(generatedRoot, path.basename(first)))
  require(firstPath.startsWith(await realpath(generatedRoot) + path.sep), 'source first frame escaped generated directory')
  const firstBytes = await readFile(firstPath)
  const firstJpeg = await sharp(firstBytes, { failOn: 'error' }).jpeg({ quality: 94 }).toBuffer()
  const urls = [`data:image/jpeg;base64,${firstJpeg.toString('base64')}`]
  for (const item of refs) {
    require(typeof item?.url === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(item.url), 'source identity JPEG is invalid')
    urls.push(item.url)
  }
  return { firstUrl: first, firstSha256: sha256(firstBytes), urls, hashes: urls.map(url => sha256(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))) }
}

async function main() {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    const row = (await db.query('select id,model_id,status,error,created_at,duration_ms,request_data,response_data from model_execution_records where id=$1', [ledgerId])).rows[0]
    require(row && row.model_id === 'codex-gpt-image-2' && row.status === 'failed'
      && /^CODEX_IMAGE_EVENT_FAILED:/.test(String(row.error)), 'exact failed image ledger is unavailable')
    const request = row.request_data, raw = row.response_data?.raw
    require(request?.requestKey === expectedRequestKey && request?.fingerprint === expectedFingerprint
      && request?.operation === 'story.target-end-frame', 'request identity changed')
    require(raw?.threadId === expectedThreadId && raw?.exitCode === 0 && raw?.exitSignal === null
      && raw?.promptSha256 === sha256(Buffer.from(request.prompt ?? '')),
    'CLI thread, exit, or prompt does not bind to failed request')
    require(request?.params?.size === '576x1024' && request.params.singleFrame === true
      && Array.isArray(request.params.referenceImages) && request.params.referenceImages.length === 5,
    'saved image request dimensions or reference count changed')
    require(Array.isArray(raw.eventTypes) && raw.eventTypes.filter(row => row?.[0] === 'thread.started').length === 1
      && raw.eventTypes.filter(row => row?.[0] === 'turn.started').length === 1
      && raw.eventTypes.filter(row => row?.[0] === 'turn.completed').length === 1,
    'CLI turn is not uniquely complete')
    const source = await firstFrameAndReferenceHashes(db)
    require(source.firstSha256.startsWith(expectedRequestKey.split(':').at(-1)), 'source first frame changed')
    require(source.hashes.length === raw.references?.length
      && source.hashes.every((hash, index) => hash === raw.references[index]?.sha256), 'source reference bytes differ from CLI snapshot')
    const model = (await db.query('select id,name,provider,capability,settings from model_configs where id=$1', [row.model_id])).rows[0]
    require(model?.provider === 'Codex' && model?.capability === 'image', 'configured image model changed')
    const fingerprint = modelRequestFingerprint({ model, prompt: request.prompt,
      params: { referenceImages: source.urls, size: '576x1024', singleFrame: true }, operation: request.operation })
    require(fingerprint === expectedFingerprint, 'current source and model config no longer match the submitted request fingerprint')

    const threadFolder = path.join(codexHome, 'generated_images', expectedThreadId)
    const actualFolder = await realpath(threadFolder)
    require(actualFolder.startsWith(await realpath(path.join(codexHome, 'generated_images')) + path.sep), 'CLI generated folder escaped CODEX_HOME')
    const pictures = (await readdir(actualFolder, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith('.png'))
    require(pictures.length === 1, 'CLI thread does not have exactly one saved PNG')
    const filename = path.join(actualFolder, pictures[0].name)
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
    let sourceBytes
    try {
      const info = await handle.stat()
      require(info.isFile() && info.size >= 64 && info.size <= 20 * 1024 * 1024, 'CLI PNG has invalid size')
      const completedAt = new Date(row.created_at).getTime()
      require(info.mtimeMs >= completedAt - Number(row.duration_ms) - 5000 && info.mtimeMs <= completedAt + 5000,
        'CLI PNG timestamp is outside the request window')
      sourceBytes = await handle.readFile()
    } finally { await handle.close() }
    require(sourceBytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      && sha256(sourceBytes) === expectedSourceSha256, 'CLI PNG signature or hash mismatch')
    const metadata = await sharp(sourceBytes, { failOn: 'error', limitInputPixels: 50_000_000 }).metadata()
    await sharp(sourceBytes, { failOn: 'error', limitInputPixels: 50_000_000 }).raw().toBuffer()
    require(metadata.format === 'png' && metadata.width === 941 && metadata.height === 1672, 'CLI PNG dimensions changed')
    const sizing = {}
    const normalized = await normalizeOutputSize(sourceBytes, '576x1024', sizing)
    const normalizedInfo = await sharp(normalized, { failOn: 'error' }).metadata()
    await sharp(normalized, { failOn: 'error' }).raw().toBuffer()
    require(normalizedInfo.width === 576 && normalizedInfo.height === 1024, 'normalized target is not 576x1024')
    const normalizedHash = sha256(normalized)
    const url = imageUrl(normalizedHash)
    const destination = path.join(generatedRoot, path.basename(url))
    const manifestPath = path.join(generatedRoot, manifestName)
    const manifest = { version: 'story-target-end-frame-recovery-v1', recordId, sourceLedgerId: ledgerId,
      sourceLedgerStatus: 'failed', requestKey: expectedRequestKey, requestFingerprint: expectedFingerprint,
      codexThreadId: expectedThreadId, sourceImageName: pictures[0].name, sourceSha256: expectedSourceSha256,
      sourceSize: { width: metadata.width, height: metadata.height }, normalizedSha256: normalizedHash,
      normalizedUrl: url, normalizedSize: { width: normalizedInfo.width, height: normalizedInfo.height },
      normalization: sizing.outputSize, importedWithoutModelCall: true, failedLedgerRetained: true }
    const summary = { mode: apply ? 'import' : 'dry-run', sourceLedgerId: ledgerId, sourceLedgerStatus: row.status,
      sourceThreadId: expectedThreadId, sourceFilename: filename, sourceSha256: expectedSourceSha256,
      sourceSize: manifest.sourceSize, sourceFullyDecoded: true, sourceReferencesMatched: true,
      normalizedUrl: url, normalizedSha256: normalizedHash, normalizedSize: manifest.normalizedSize,
      normalization: sizing.outputSize, manifestPath, modelCalls: 0 }
    if (!apply) { console.log(JSON.stringify(summary, null, 2)); return }
    try {
      const previous = JSON.parse(await readFile(manifestPath, 'utf8'))
      require(previous.sourceLedgerId === ledgerId && previous.sourceSha256 === expectedSourceSha256
        && previous.normalizedSha256 === normalizedHash && previous.normalizedUrl === url, 'existing recovery manifest conflicts')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    let imported = false
    try {
      const saved = await open(destination, 'wx', 0o600)
      try { await saved.writeFile(normalized) } finally { await saved.close() }
      imported = true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      require(sha256(await readFile(destination)) === normalizedHash, 'existing generated PNG has different bytes')
    }
    try {
      const saved = await open(manifestPath, 'wx', 0o600)
      try { await saved.writeFile(JSON.stringify(manifest, null, 2) + '\n') } finally { await saved.close() }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    console.log(JSON.stringify({ ...summary, mode: imported ? 'imported' : 'reused' }, null, 2))
  } finally { await db.end() }
}

main().catch(error => { console.error(`Recovery stopped: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
