#!/usr/bin/env node
// One-time correction for the two three-view sheets generated in episode 610.
// Dry-run by default. Do not broaden this to other episodes or asset IDs.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import sharp from 'sharp'
import { decodeExecutionState } from '../src/execution-storage.ts'

const workflowId = 'wf-sanguo-history-drama'
const executionId = 'record-610-tail-adopt-20260928-v1'
const originalExecutionId = 'record-7cb4d1'
const episodeNumber = 610
const episodeTitle = '张飞释严颜'
const sceneId = 'scene-02'
const imageNodeId = 'sanguo-character-image'
const archiveNodeId = 'sanguo-character-archive'
const targets = [
  {
    id: 'character-070b25d71205797c', name: '张飞', lookKey: 'zhangfei_jiangzhou_campaign', rowVersion: '25511',
    uriSha256: '77ba662b63c9f7c1b66d52c48b29c398afbe0a2becc3414c4c0ba72a6f1fef2f',
    requestSignature: 'a355a0cbab5049af0dc15605ab83ea5fa9069e2beef34f9c9e1b31b75375d182',
    mediaSha256: 'f90cb22a01d7b2328691806dea653103f842a5880e5be4ed9301e439f4770ab6', bytes: 1036960,
  },
  {
    id: 'character-41953008cc8dfd45', name: '严颜', lookKey: 'yanyan_jiangzhou_campaign', rowVersion: '25634',
    uriSha256: 'e2709803627766be1a82b7eff2a8cc1fff5c9e221f46386386771ac4b950a3d8',
    requestSignature: 'bdb587e8705ff823477c2afa9218ee67d784a2caddc6a408384c0010d773e435',
    mediaSha256: '765ecf7c2ae66474a8d5826f8899a225e8738e35eaff87260e14a016894d148c', bytes: 887433,
  },
]
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const objectSha256 = value => sha256(JSON.stringify(value))

function oneSuccessfulNode(state, nodeId) {
  const matches = state.nodeRuns?.filter(run => run.loopIndex === 1 && run.node?.id === nodeId) ?? []
  assert.equal(matches.length, 1, `Expected one episode 610 loop-2 ${nodeId} run`)
  assert.equal(matches[0].status, 'success', `${nodeId} must have succeeded`)
  return matches[0]
}

export function verifyExecutionRecord(state) {
  assert.equal(state.id, executionId)
  assert.equal(state.workflowId, workflowId)
  assert.equal(state.runtimeInputs?.input?.episode_number, episodeNumber)
  assert.equal(state.context?.input?.episode_number, episodeNumber)
  assert.equal(state.context?.input?.episode_title, episodeTitle)
  assert.equal(state.breakpointRollback?.sourceExecutionId, originalExecutionId)
  const imageRun = oneSuccessfulNode(state, imageNodeId)
  const archiveRun = oneSuccessfulNode(state, archiveNodeId)
  for (const run of [imageRun, archiveRun]) {
    assert.equal(run.inputContext?.episode_context?.fields?.episode_number, episodeNumber)
    assert.equal(run.inputContext?.episode_context?.fields?.episode_title, episodeTitle)
    assert.equal(run.inputContext?.scene?.id, sceneId)
    assert.equal(run.inputContext?.scene?.sequence, 2)
  }
  assert.equal(imageRun.output?.generatedCount, targets.length)
  assert.equal(archiveRun.output?.archivedCount, targets.length)
  assert.equal(imageRun.output?.generated?.length, targets.length)
  assert.equal(archiveRun.output?.items?.length, targets.length)
  const proven = targets.map(target => {
    const generated = imageRun.output.generated.filter(item => item.id === target.id && item.characterName === target.name)
    const archived = archiveRun.output.items.filter(item => item.id === target.id && item.characterName === target.name)
    assert.equal(generated.length, 1, `Missing exact generated asset ${target.id}`)
    assert.equal(archived.length, 1, `Missing exact archived asset ${target.id}`)
    assert.equal(generated[0].url, archived[0].url)
    assert.equal(sha256(generated[0].url), target.uriSha256, `Generated URI changed for ${target.id}`)
    assert.equal(generated[0].metadata?.visualContext?.look?.key, target.lookKey)
    assert.equal(archived[0].metadata?.visualContext?.look?.key, target.lookKey)
    assert.equal(generated[0].metadata?.visualContextRequestSignature, target.requestSignature)
    assert.equal(archived[0].metadata?.visualContextRequestSignature, target.requestSignature)
    return { ...target, uri: generated[0].url }
  })
  return {
    proven,
    imageNodeRunId: imageRun.id,
    archiveNodeRunId: archiveRun.id,
    sourceProofSha256: objectSha256({ input: state.runtimeInputs.input.episode_number,
      episode: imageRun.inputContext.episode_context.fields.episode_number,
      image: imageRun.output.generated.map(item => [item.id, item.characterName, item.url]),
      archive: archiveRun.output.items.map(item => [item.id, item.characterName, item.url]) }),
  }
}

function verifyOriginalSourceRecord(record) {
  assert.equal(record?.id, originalExecutionId)
  assert.equal(record.workflow_id, workflowId)
  const state = decodeExecutionState(record.result)
  assert.equal(state.runtimeInputs?.input?.episode_number, episodeNumber)
  assert.equal(state.context?.input?.episode_number, episodeNumber)
  assert.equal(state.context?.input?.episode_title, episodeTitle)
}

export function validateAssetRows(rows, proof) {
  assert.equal(rows.length, targets.length, 'Expected exactly two target DB assets')
  return proof.proven.map(target => {
    const row = rows.find(item => item.id === target.id)
    assert.ok(row, `Missing DB asset ${target.id}`)
    assert.equal(row.workflow_id, workflowId)
    assert.equal(row.character_name, target.name)
    assert.equal(row.asset_type, 'three-view')
    assert.equal(row.version, 1)
    assert.equal(row.uri, target.uri, `Archived URI changed for ${target.id}`)
    assert.equal(row.row_version, target.rowVersion, `Row changed after provenance audit: ${target.id}`)
    assert.equal(row.metadata?.generatedBy, 'workflow-image-node')
    assert.equal(row.metadata?.archivedFromNodeId, archiveNodeId)
    assert.equal(row.metadata?.visualContextImageFingerprint, target.uriSha256)
    assert.equal(row.metadata?.visualContextRequestSignature, target.requestSignature)
    assert.equal(row.metadata?.visualContext?.look?.key, target.lookKey)
    assert.equal(row.metadata?.visualContext?.age?.stage, 'mature')
    assert.equal(row.metadata?.visualContext?.age?.basis, 'artistic')
    assert.ok(!Object.hasOwn(row.metadata, 'episodeScope'), `Existing episode scope must not be overwritten: ${target.id}`)
    assert.ok(!Object.hasOwn(row.metadata, 'episodeScopeProvenance'), `Existing provenance must not be overwritten: ${target.id}`)
    return row
  })
}

function provenanceFor(target, proof) {
  return { version: 'episode-scope-provenance-v1', sourceExecutionId: executionId,
    originalExecutionId, episodeNumber, episodeTitle, sceneId,
    imageNodeRunId: proof.imageNodeRunId, archiveNodeRunId: proof.archiveNodeRunId,
    sourceProofSha256: proof.sourceProofSha256,
    generatedMediaSha256: target.mediaSha256, generatedMediaBytes: target.bytes,
    generatedUriSha256: target.uriSha256 }
}

async function readRows(client, lock = false) {
  const query = `select id,workflow_id,character_name,asset_type,uri,version,metadata,
    created_at,updated_at,xmin::text as row_version from character_assets
    where id=any($1::text[]) order by id${lock ? ' for update' : ''}`
  return (await client.query(query, [targets.map(target => target.id)])).rows
}

async function verifyMedia(proof) {
  for (const target of proof.proven) {
    const response = await fetch(target.uri, { signal: AbortSignal.timeout(30_000) })
    assert.equal(response.status, 200, `Generated media unavailable: ${target.id}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.length, target.bytes, `Generated media size changed: ${target.id}`)
    assert.equal(sha256(bytes), target.mediaSha256, `Generated media bytes changed: ${target.id}`)
    const decoded = await sharp(bytes).metadata()
    assert.equal(decoded.format, 'png')
    assert.equal(decoded.width, 1360)
    assert.equal(decoded.height, 768)
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const outputIndex = process.argv.indexOf('--out')
  const outputFile = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1])
    : path.resolve(`logs/dramatic-expression/live-20260928/episode610-asset-scope-${apply ? 'applied' : 'dry-run'}-${Date.now()}.json`)
  assert.ok(outputFile && !outputFile.endsWith('/undefined'), '--out requires a path')
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await client.connect()
  try {
    await client.query('begin read only')
    const record = (await client.query('select id,workflow_id,result from execution_records where id=$1', [executionId])).rows
    assert.equal(record.length, 1)
    assert.equal(record[0].workflow_id, workflowId)
    const proof = verifyExecutionRecord(decodeExecutionState(record[0].result))
    const sourceRecord = (await client.query('select id,workflow_id,result from execution_records where id=$1', [originalExecutionId])).rows
    assert.equal(sourceRecord.length, 1)
    verifyOriginalSourceRecord(sourceRecord[0])
    const rows = validateAssetRows(await readRows(client), proof)
    await client.query('commit')
    await verifyMedia(proof)
    let applied = false
    let backupFile = null
    if (apply) {
      await client.query('begin')
      try {
        const locked = validateAssetRows(await readRows(client, true), proof)
        backupFile = outputFile.replace(/\.json$/, '-before.json')
        assert.notEqual(backupFile, outputFile, 'Output must end with .json')
        await fs.mkdir(path.dirname(backupFile), { recursive: true })
        await fs.writeFile(backupFile, JSON.stringify({ executionId, rows: locked }, null, 2), { flag: 'wx', mode: 0o600 })
        for (const target of proof.proven) {
          const previous = locked.find(item => item.id === target.id)
          const metadata = { ...previous.metadata, episodeScope: { episodes: [episodeNumber] },
            episodeScopeProvenance: provenanceFor(target, proof) }
          const updated = await client.query(`update character_assets set metadata=$1::jsonb,updated_at=now()
            where id=$2 and workflow_id=$3 and character_name=$4 and asset_type='three-view' and version=1
              and uri=$5 and xmin::text=$6 and metadata->>'generatedBy'='workflow-image-node'
              and metadata->>'archivedFromNodeId'=$7 and metadata->>'visualContextImageFingerprint'=$8
              and metadata->>'visualContextRequestSignature'=$9
              and metadata->'visualContext'->'look'->>'key'=$10
              and not (metadata ? 'episodeScope') and not (metadata ? 'episodeScopeProvenance') returning id`,
          [JSON.stringify(metadata), target.id, workflowId, target.name, target.uri, target.rowVersion, archiveNodeId,
            target.uriSha256, target.requestSignature, target.lookKey])
          assert.equal(updated.rowCount, 1, `Guarded update did not match exactly one asset: ${target.id}`)
        }
        await client.query('commit')
        applied = true
      } catch (error) { await client.query('rollback'); throw error }
    }
    const report = { at: new Date().toISOString(), mode: apply ? 'applied' : 'dry-run', applied,
      sourceExecutionId: executionId, originalExecutionId, episodeNumber, episodeTitle, sceneId,
      imageNodeRunId: proof.imageNodeRunId, archiveNodeRunId: proof.archiveNodeRunId,
      sourceProofSha256: proof.sourceProofSha256, matchedRowCount: rows.length,
      targets: proof.proven.map(target => ({ id: target.id, name: target.name, rowVersion: target.rowVersion,
        lookKey: target.lookKey, uriSha256: target.uriSha256, mediaSha256: target.mediaSha256,
        mediaBytes: target.bytes, episodeScope: { episodes: [episodeNumber] } })),
      mediaVerified: true, executionWrites: 0, workflowWrites: 0, mediaWrites: 0, backupFile }
    await fs.mkdir(path.dirname(outputFile), { recursive: true })
    await fs.writeFile(outputFile, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ ...report, outputFile }, null, 2))
  } finally { await client.end() }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
