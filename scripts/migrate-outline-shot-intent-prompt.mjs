#!/usr/bin/env node
// One-clause persisted prompt correction. Dry-run writes a full guarded backup;
// --apply requires that exact row/version and changes no other workflow field.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { SCENE_OUTLINE_CAST_CONTRACT, SCENE_OUTLINE_CAST_CONTRACT_WITH_SHOT_INTENT,
  refreshSceneOutlineShotIntentPrompt } from '../src/scene-outline-prompt.ts'

const id = 'wf-sanguo-history-drama'
const directory = path.resolve('logs/dramatic-expression/live-20260928/outline-shot-intent-migration')
const backupPath = path.join(directory, 'workflow-schema150-before.json')
const proofPath = path.join(directory, 'dry-run.json')
const apply = process.argv.includes('--apply')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

try {
  const row = (await pool.query('SELECT *, xmin::text AS row_version FROM workflow_configs WHERE id=$1', [id])).rows[0]
  if (!row || row.schema_version !== 150) throw Error('Expected the saved schema150 Sanguo workflow')
  const matches = row.nodes.filter(node => node.id === 'sanguo-scene-outline')
  const writer = matches[0]
  if (matches.length !== 1 || writer.kind !== 'text') throw Error('Exactly one text outline writer is required')
  if (writer.prompt.split(SCENE_OUTLINE_CAST_CONTRACT_WITH_SHOT_INTENT).length !== 2
    || writer.prompt.includes(SCENE_OUTLINE_CAST_CONTRACT)) throw Error('Saved managed clause is absent, duplicated, or already changed')
  const updatedPrompt = refreshSceneOutlineShotIntentPrompt(writer.prompt)
  if (updatedPrompt === writer.prompt || updatedPrompt.split(SCENE_OUTLINE_CAST_CONTRACT).length !== 2
    || updatedPrompt.includes('shotIntent')) throw Error('Refreshed outline prompt has an unexpected contract')
  const nodes = row.nodes.map(node => node === writer ? { ...node, prompt: updatedPrompt } : node)
  const restored = nodes.map(node => node.id === writer.id
    ? { ...node, prompt: node.prompt.replace(SCENE_OUTLINE_CAST_CONTRACT, SCENE_OUTLINE_CAST_CONTRACT_WITH_SHOT_INTENT) }
    : node)
  if (hash(restored) !== hash(row.nodes)) throw Error('Diff exceeds the single managed cast clause')
  const proof = { id, schemaVersion: row.schema_version, rowVersion: row.row_version,
    changedNodes: [{ id: writer.id, changedKeys: ['prompt'] }],
    changedClause: { before: SCENE_OUTLINE_CAST_CONTRACT_WITH_SHOT_INTENT, after: SCENE_OUTLINE_CAST_CONTRACT },
    beforeNodesSha256: hash(row.nodes), afterNodesSha256: hash(nodes),
    beforeEdgesSha256: hash(row.edges), afterEdgesSha256: hash(row.edges),
    preexistingEpisodeBoundary: writer.prompt.includes('episode_boundary'),
    preexistingArtisticIdentity: writer.prompt.includes('${characterArtisticIdentityCatalog}'),
    modelIdUnchanged: true, topologyUnchanged: true, noModelCalls: true }
  if (!proof.preexistingEpisodeBoundary || !proof.preexistingArtisticIdentity) throw Error('Saved schema150 protections are missing')
  if (!apply) {
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(backupPath, JSON.stringify({ row, hash: hash(row) }, null, 2), { flag: 'wx', mode: 0o600 })
    await fs.writeFile(proofPath, JSON.stringify(proof, null, 2), { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ mode: 'dry-run', backupPath, proofPath,
      rowVersion: proof.rowVersion, changedNodes: proof.changedNodes, beforeNodesSha256: proof.beforeNodesSha256,
      afterNodesSha256: proof.afterNodesSha256 }))
  } else {
    const backup = JSON.parse(await fs.readFile(backupPath, 'utf8'))
    const dryRun = JSON.parse(await fs.readFile(proofPath, 'utf8'))
    if (hash(backup.row) !== backup.hash || hash(backup.row.nodes) !== hash(row.nodes)
      || backup.row.row_version !== row.row_version || dryRun.beforeNodesSha256 !== hash(row.nodes)
      || dryRun.afterNodesSha256 !== hash(nodes)) throw Error('Saved workflow differs from guarded dry-run; refuse overwrite')
    const result = await pool.query('UPDATE workflow_configs SET nodes=$2::jsonb, updated_at=now() WHERE id=$1 AND xmin::text=$3 RETURNING id',
      [id, JSON.stringify(nodes), row.row_version])
    if (result.rowCount !== 1) throw Error('Workflow changed concurrently; refuse overwrite')
    console.log(JSON.stringify({ mode: 'applied', id, schemaVersion: 150, changedNodes: proof.changedNodes,
      beforeNodesSha256: proof.beforeNodesSha256, afterNodesSha256: proof.afterNodesSha256 }))
  }
} finally { await pool.end() }
