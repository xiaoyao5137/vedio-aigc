#!/usr/bin/env node
// Fork a stopped execution after one successful image run. Dry-run by default.
// The replacement must already be a reviewed, server-visible local image.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState, encodeExecutionState } from '../src/execution-storage.ts'
import { invalidateRunExecution } from '../src/run-invalidation.ts'
import { applyNodeOutputToContext } from '../src/workflow-core.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const own = (value, key) => Object.hasOwn(value, key) && value[key] !== undefined
const fail = message => { throw Error(`REVIEWED_IMAGE_FORK_INVALID: ${message}`) }
const outputDigest = (run, hash) => hash({ present: own(run, 'output'), ...(own(run, 'output') ? { output: run.output } : {}) })
const hex64 = /^[a-f\d]{64}$/i
const hex32 = /^[a-f\d]{32}$/i

/** Read and fully decode the exact bytes that the local server will serve. */
export async function inspectReplacementImage(imagePath, root = projectRoot) {
  if (!nonempty(imagePath)) fail('--image is required')
  const generated = await realpath(path.join(root, 'public/generated')).catch(() => fail('public/generated does not exist'))
  const resolved = await realpath(imagePath).catch(() => fail('replacement image was not found'))
  if (path.dirname(resolved) !== generated || !/^[\w.-]+\.(?:png|jpe?g|webp)$/i.test(path.basename(resolved))) {
    fail('replacement must be a PNG, JPEG or WebP file directly under public/generated, without symlinks leaving that directory')
  }
  const bytes = await readFile(resolved)
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) fail('replacement image must be 1B to 20MB')
  let metadata
  try {
    const image = sharp(bytes, { failOn: 'error' })
    metadata = await image.metadata()
    await image.clone().resize(1, 1).raw().toBuffer()
  } catch { fail('replacement image does not fully decode') }
  const format = metadata.format === 'jpeg' ? 'jpg' : metadata.format
  if (!['png', 'jpg', 'webp'].includes(format) || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)
    || metadata.width < 1 || metadata.height < 1) fail('replacement image has an unsupported format or dimensions')
  const extension = path.extname(resolved).slice(1).toLowerCase()
  if (extension !== format && !(format === 'jpg' && extension === 'jpeg')) fail('replacement file extension differs from decoded format')
  return { path: resolved, url: `/generated/${path.basename(resolved)}`, sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length, width: metadata.width, height: metadata.height, format }
}

function validateSingleImageOutput(output) {
  if (!object(output) || !nonempty(output.url)) fail('successful image run has no canonical output.url')
  if (output.urls !== undefined && (!Array.isArray(output.urls) || output.urls.length !== 1 || output.urls[0] !== output.url)) fail('image output has multiple or inconsistent URLs')
  if (output.items !== undefined && (!Array.isArray(output.items) || output.items.length !== 1 || !object(output.items[0]) || output.items[0].url !== output.url)) fail('image output has multiple or inconsistent items')
  // These are the single-image fields emitted by the runner. Extra semantic
  // fields might feed later code; guessing how to transplant them is unsafe.
  const standard = new Set(['url', 'urls', 'items', 'raw', 'prompt', 'params', 'model', 'qualityDisposition', 'qualityWarnings', 'manualImageAdoption'])
  const extra = Object.keys(output).filter(key => !standard.has(key))
  if (extra.length) fail(`image output has unsupported live fields: ${extra.join(', ')}`)
  if (own(output, 'manualImageAdoption') && !object(output.manualImageAdoption)) fail('prior manual-image provenance is malformed')
  return output.url
}

/** Pure preparation. All source runs before the image stay byte-for-byte
 * identical; only the selected image is adopted and the idle suffix reset. */
export function prepareReviewedImageFork(source, replacement, options = {}) {
  if (!object(source) || !nonempty(source.id) || !nonempty(source.workflow_id) || !object(source.result)) fail('source record/result is missing')
  const id = options.id ?? `record-reviewed-image-${randomUUID()}`
  const createdAt = options.createdAt ?? new Date().toISOString()
  if (!nonempty(id) || id === source.id || !Number.isFinite(Date.parse(createdAt))) fail('a NEW record ID and valid timestamp are required')
  if (!nonempty(options.nodeId) || !nonempty(options.reason) || !nonempty(options.reviewReference)) fail('node ID, concrete reason and review reference are required')
  if (options.loop !== undefined && (!Number.isSafeInteger(options.loop) || options.loop < 1)) fail('loop must be a one-based positive integer')
  if (!object(replacement) || !/^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(replacement.url)
    || !hex64.test(replacement.sha256) || !Number.isSafeInteger(replacement.bytes) || replacement.bytes < 1
    || !Number.isSafeInteger(replacement.width) || replacement.width < 1
    || !Number.isSafeInteger(replacement.height) || replacement.height < 1
    || !['png', 'jpg', 'webp'].includes(replacement.format)) fail('replacement image descriptor is invalid')
  const hash = createJsonHasher(), sourceResultHash = hash(source.result)
  const state = decodeExecutionState(source.result)
  if (!object(state) || state.id !== source.id || state.workflowId !== source.workflow_id || !Array.isArray(state.nodeRuns) || !state.nodeRuns.length) fail('source execution identity or run array is invalid')
  if (!object(state.context) || !Array.isArray(state.logs) || state.logs.some(line => typeof line !== 'string')
    || state.branchHistory !== undefined && !Array.isArray(state.branchHistory)
    || state.manualImageAdoptionHistory !== undefined && !Array.isArray(state.manualImageAdoptionHistory)
    || state.persistenceError) fail('source execution snapshots are invalid or unsaved')
  const ids = new Set()
  for (const [index, run] of state.nodeRuns.entries()) {
    if (!object(run) || !nonempty(run.id) || !object(run.node) || !nonempty(run.node.id) || !nonempty(run.node.kind) || !nonempty(run.node.resultVar)
      || ids.has(run.id) || !['success', 'skipped', 'idle', 'failed'].includes(run.status)) fail(`run ${index} has invalid identity or active status`)
    ids.add(run.id)
    if (run.attempts !== undefined && !Array.isArray(run.attempts)) fail(`run ${index} has invalid historical attempts`)
    if (run.revision !== undefined && (!Number.isSafeInteger(run.revision) || run.revision < 0)) fail(`run ${index} has invalid revision`)
  }
  const matches = state.nodeRuns.flatMap((run, index) => run.node.id === options.nodeId && run.node.kind === 'image' && run.status === 'success'
    && (options.loop === undefined || run.loopIndex === options.loop - 1) ? [index] : [])
  if (matches.length !== 1) fail(`target must identify exactly one successful image instance; found ${matches.length}`)
  const targetIndex = matches[0], target = state.nodeRuns[targetIndex]
  if (state.nodeRuns.slice(0, targetIndex).some(run => !['success', 'skipped'].includes(run.status))) fail('target is not in the completed prefix')
  if (!state.nodeRuns.slice(targetIndex + 1).length || state.nodeRuns.slice(targetIndex + 1).some(run => run.status !== 'idle')) fail('all downstream instances must still be idle; paid or failed downstream work cannot be discarded')
  if (!object(target.inputContext) || !object(target.context) || !own(target.context, target.node.resultVar)) fail('image run lacks a complete input/output context')
  const oldUrl = validateSingleImageOutput(target.output)
  if (hash(target.context[target.node.resultVar]) !== hash(target.output)) fail('image context does not match the successful output')
  if (hash(state.context) !== hash(target.context)) fail('root context has advanced beyond the selected image')
  if (oldUrl === replacement.url) fail('replacement URL is identical to the source image')
  const metadata = { format: 'reviewed-image-adoption-v1', createdAt, sourceRecordId: source.id,
    sourceResultMd5: source.result_md5 ?? null, sourceResultHash, sourceRunId: target.id,
    sourceNodeId: target.node.id, sourceOutputHash: outputDigest(target, hash), sourceImageUrl: oldUrl,
    replacementUrl: replacement.url, replacementSha256: replacement.sha256.toLowerCase(),
    replacementBytes: replacement.bytes, width: replacement.width, height: replacement.height,
    imageFormat: replacement.format, reason: options.reason, reviewReference: options.reviewReference,
    ...(target.loopGroupId !== undefined ? { loopGroupId: target.loopGroupId } : {}),
    ...(target.loopIndex !== undefined ? { loopIndex: target.loopIndex } : {}),
  }
  // The provider raw response and any quality judgement remain in the archived
  // attempt. The live result carries only the new image and its exact lineage.
  const output = { url: replacement.url, urls: [replacement.url], items: [{ url: replacement.url }],
    ...(own(target.output, 'prompt') ? { prompt: target.output.prompt } : {}),
    ...(own(target.output, 'params') ? { params: target.output.params } : {}),
    ...(own(target.output, 'model') ? { model: target.output.model } : {}),
    manualImageAdoption: metadata }
  const snapshot = { ...target }
  delete snapshot.attempts
  const targetContext = applyNodeOutputToContext(target.inputContext, target.node.resultVar, output)
  const nodeRuns = state.nodeRuns.map((run, index) => {
    if (index < targetIndex) return run
    if (index === targetIndex) return { ...run, output, context: targetContext,
      revision: (run.revision ?? 0) + 1, attempts: [...(run.attempts ?? []), snapshot], manualImageAdoption: metadata }
    return { ...invalidateRunExecution(run), loopPrevious: undefined,
      attempt: 1, errorAttempt: 1, revision: (run.revision ?? 0) + 1 }
  })
  const fork = { ...state, id, parentExecutionId: source.id, requestScopeId: state.requestScopeId ?? state.id,
    generationScopeId: id, mode: 'step', historical: false, nodeRuns, context: targetContext,
    selectedNodeId: state.nodeRuns[targetIndex + 1].node.id,
    manualImageAdoption: metadata,
    manualImageAdoptionHistory: [...(state.manualImageAdoptionHistory ?? []), metadata],
    logs: [...state.logs, `从 ${source.id} 采用已复核本地图片 ${replacement.url} 作为 ${target.node.id} 的输出；之前结果保留，后续节点等待重新执行。`] }
  const prefixHash = hash(state.nodeRuns.slice(0, targetIndex))
  if (hash(fork.nodeRuns.slice(0, targetIndex)) !== prefixHash) fail('completed prefix changed')
  const prefixOutputHashes = state.nodeRuns.slice(0, targetIndex).map((run, index) => ({ index, runId: run.id, kind: run.node.kind, hash: outputDigest(run, hash) }))
  if (!prefixOutputHashes.every(item => item.hash === outputDigest(fork.nodeRuns[item.index], hash))) fail('prior output changed')
  if (fork.nodeRuns[targetIndex].status !== 'success' || fork.nodeRuns.slice(targetIndex + 1).some(run => run.status !== 'idle' || own(run, 'output') && run.output !== undefined)) fail('fork cursor is not a successful image followed by idle nodes')
  const encoded = encodeExecutionState(fork)
  const roundTrip = decodeExecutionState(JSON.parse(JSON.stringify(encoded)))
  if (hash(roundTrip) !== hash(fork)) fail('serialization changed the prepared fork')
  if (hash(source.result) !== sourceResultHash) fail('preparation mutated source record')
  return { state: fork, encoded, proof: { format: 'reviewed-image-fork-proof-v1', sourceRecordId: source.id,
    sourceResultMd5: source.result_md5 ?? null, sourceResultHash, newRecordId: id,
    targetIndex, targetRunId: target.id, targetNodeId: target.node.id,
    loopGroupId: target.loopGroupId ?? null, loopIndex: target.loopIndex ?? null,
    replacementUrl: replacement.url, replacementSha256: replacement.sha256.toLowerCase(),
    replacementBytes: replacement.bytes, width: replacement.width, height: replacement.height,
    originalOutputHash: metadata.sourceOutputHash, adoptedOutputHash: outputDigest(fork.nodeRuns[targetIndex], hash),
    preservedPrefixCount: targetIndex, preservedPrefixHash: prefixHash, priorOutputHashes: prefixOutputHashes,
    idleSuffixCount: state.nodeRuns.length - targetIndex - 1,
    requestScopeIdPreserved: fork.requestScopeId === (state.requestScopeId ?? state.id), generationScopeId: id,
    reviewReference: options.reviewReference, reason: options.reason,
    sourceUnchanged: true, roundTripVerified: true, providerRequests: 0 } }
}

export function parseArguments(args) {
  const options = { apply: false }
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--apply') { if (options.apply) fail('duplicate --apply'); options.apply = true; continue }
    if (flag === '--help') { options.help = true; continue }
    const key = { '--source': 'sourceId', '--node': 'nodeId', '--loop': 'loop', '--image': 'imagePath',
      '--reason': 'reason', '--review-reference': 'reviewReference', '--id': 'id', '--proof': 'proofPath',
      '--expected-source-md5': 'expectedMd5', '--expected-image-sha256': 'expectedSha256' }[flag]
    if (!key || options[key] !== undefined || !nonempty(args[index + 1]) || args[index + 1].startsWith('--')) fail(`unknown, duplicate or incomplete argument ${flag}`)
    options[key] = args[++index]
  }
  if (options.help) return options
  if (![options.sourceId, options.nodeId, options.imagePath, options.reason, options.reviewReference].every(nonempty)) fail('--source, --node, --image, --reason and --review-reference are required')
  if (options.loop !== undefined && (!/^\d+$/.test(options.loop) || Number(options.loop) < 1)) fail('--loop must be one-based')
  if (options.expectedMd5 !== undefined && !hex32.test(options.expectedMd5)) fail('--expected-source-md5 must be 32 hex digits')
  if (options.expectedSha256 !== undefined && !hex64.test(options.expectedSha256)) fail('--expected-image-sha256 must be 64 hex digits')
  if (options.apply && (!options.expectedMd5 || !options.expectedSha256)) fail('--apply requires both expected source MD5 and expected image SHA256 from a reviewed dry-run')
  return { ...options, ...(options.loop !== undefined ? { loop: Number(options.loop) } : {}) }
}

export async function forkReviewedImage(client, options, root = projectRoot) {
  if (!nonempty(options?.sourceId) || options.apply !== undefined && typeof options.apply !== 'boolean') fail('invalid source/apply options')
  const apply = options.apply === true
  if (apply && (!hex32.test(options.expectedMd5 ?? '') || !hex64.test(options.expectedSha256 ?? ''))) fail('apply requires reviewed source MD5 and image SHA256')
  const replacement = await inspectReplacementImage(options.imagePath, root)
  if (options.expectedSha256 && replacement.sha256 !== options.expectedSha256.toLowerCase()) fail('replacement SHA256 differs from the reviewed file')
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  try {
    const source = (await client.query(`SELECT *, md5(result::text) AS result_md5 FROM execution_records WHERE id=$1${apply ? ' FOR SHARE' : ''}`, [options.sourceId])).rows[0]
    if (!source) fail('source record was not found')
    if (options.expectedMd5 && source.result_md5 !== options.expectedMd5.toLowerCase()) fail('source MD5 differs from the reviewed checkpoint')
    const prepared = prepareReviewedImageFork(source, replacement, options)
    if ((await client.query('SELECT id FROM execution_records WHERE id=$1', [prepared.state.id])).rows.length) fail('new record ID already exists')
    if (apply) {
      const { state, encoded } = prepared
      await client.query(`INSERT INTO execution_records
        (id, workflow_id, workflow_name, mode, title, runtime_inputs, result, succeeded_count, failed_count, total_count)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`, [
        state.id, source.workflow_id, source.workflow_name, 'step', `人工图片接续 · ${source.id}`,
        JSON.stringify(source.runtime_inputs ?? {}), JSON.stringify(encoded),
        state.nodeRuns.filter(run => run.status === 'success').length, 0, state.nodeRuns.length,
      ])
      const inserted = (await client.query('SELECT result FROM execution_records WHERE id=$1', [state.id])).rows[0]
      if (!inserted || createJsonHasher()(decodeExecutionState(inserted.result)) !== createJsonHasher()(state)) fail('inserted fork does not match prepared state')
    }
    const sourceAfter = (await client.query('SELECT md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [source.id])).rows[0]?.result_md5
    if (sourceAfter !== source.result_md5) fail('source changed during fork')
    if ((await inspectReplacementImage(options.imagePath, root)).sha256 !== replacement.sha256) fail('replacement image changed during fork')
    await client.query('COMMIT')
    return { ...prepared.proof, applied: apply, sourceResultMd5After: sourceAfter, sourceUnchanged: true }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log('node scripts/fork-reviewed-image.mjs --source RECORD --node NODE [--loop ONE_BASED] --image public/generated/FILE.png --reason TEXT --review-reference REF [--id NEW_RECORD] [--proof FILE] [--expected-source-md5 MD5] [--expected-image-sha256 SHA256] [--apply]\nDefault is a read-only preview. Apply requires both reviewed hashes. The CLI inserts one stopped fork and never executes nodes or updates the source.')
    return
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  try {
    const client = await pool.connect()
    let proof
    try { proof = await forkReviewedImage(client, options) } finally { client.release() }
    if (options.proofPath) await writeFile(options.proofPath, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
    const { priorOutputHashes, ...summary } = proof
    console.log(JSON.stringify({ ...summary, priorOutputHashCount: priorOutputHashes.length,
      ...(options.proofPath ? { proofPath: options.proofPath } : {}) }, null, 2))
  } finally { await pool.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
