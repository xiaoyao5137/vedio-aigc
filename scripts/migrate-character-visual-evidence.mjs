#!/usr/bin/env node
// Update only the saved character image reviewer prompt and its acceptance
// runtime. Default dry-run writes a guarded backup/proof; --apply requires the
// exact reviewed row version and node hashes. Execution history is untouched.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { upgradePrincipleQuality } from '../src/principle-workflow.ts'
import { PRINCIPLE_IMAGE_REVIEW_PROMPT } from '../src/principle-media-quality.ts'

const workflowId = 'wf-sanguo-history-drama'
const directory = path.resolve('logs/dramatic-expression/live-20260928/character-evidence-migration')
const backupFile = path.join(directory, 'workflow-before.json')
const proofFile = path.join(directory, 'dry-run.json')
const apply = process.argv.includes('--apply')
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })

try {
  const row = (await pool.query('SELECT *, xmin::text AS row_version FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
  if (!row || row.schema_version < 150) throw Error('Expected schema150+ Sanguo workflow; no changes made')
  const ids = ['sanguo-character-review', 'sanguo-character-accept']
  const existing = new Map(ids.map(id => [id, row.nodes.filter(node => node.id === id)]))
  if (ids.some(id => existing.get(id).length !== 1)) throw Error('Expected one saved node for each character review gate')
  const reviewer = existing.get(ids[0])[0], accept = existing.get(ids[1])[0]
  if (reviewer.kind !== 'text' || !reviewer.prompt.startsWith('【原则人物图质检 v1】')
    || accept.kind !== 'code' || !accept.code?.includes('// PRINCIPLE_POLICY_START')
    || !accept.code.includes('principleMediaQuality.acceptImages(context,params)')) {
    throw Error('Saved character review contract differs from guarded shape; refuse overwrite')
  }
  const upgraded = upgradePrincipleQuality({ id: workflowId, schemaVersion: row.schema_version, nodes: row.nodes })
  const nextById = new Map(upgraded.nodes.filter(node => ids.includes(node.id)).map(node => [node.id, node]))
  const policy = /\/\/ PRINCIPLE_POLICY_START[\s\S]*?\/\/ PRINCIPLE_POLICY_END/
  const oldPolicy = accept.code.match(policy)?.[0], newPolicy = nextById.get(ids[1]).code.match(policy)?.[0]
  if (!oldPolicy || !newPolicy || oldPolicy === newPolicy) throw Error('Expected one stale saved character acceptance policy')
  const nextCode = accept.code.replace(oldPolicy, newPolicy)
  if (nextCode.replace(newPolicy, oldPolicy) !== accept.code) throw Error('Acceptance policy replacement exceeds guarded block')
  const nodes = row.nodes.map(node => node.id === ids[0] ? { ...node, prompt: PRINCIPLE_IMAGE_REVIEW_PROMPT }
    : node.id === ids[1] ? { ...node, code: nextCode } : node)
  const changedKeys = ids.map(id => {
    const before = existing.get(id)[0], after = nodes.find(node => node.id === id)
    const keys = Object.keys(after).filter(key => hash(after[key]) !== hash(before[key]))
    if (id === ids[0] && !['', 'prompt'].includes(keys.join(','))) throw Error('Reviewer change exceeds prompt')
    if (id === ids[1] && keys.join(',') !== 'code') throw Error('Acceptance change exceeds code')
    return { id, keys, beforeSha256: hash(before), afterSha256: hash(after) }
  })
  if (hash(nodes) === hash(row.nodes)) throw Error('Saved workflow already has this character evidence contract')
  const proof = { workflowId, schemaVersion: row.schema_version, rowVersion: row.row_version,
    changedNodes: changedKeys, beforeNodesSha256: hash(row.nodes), afterNodesSha256: hash(nodes),
    edgesSha256: hash(row.edges), executionRecordsChanged: false, providerCalls: 0 }
  if (!apply) {
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(backupFile, JSON.stringify({ row, hash: hash(row) }, null, 2), { flag: 'wx', mode: 0o600 })
    await fs.writeFile(proofFile, JSON.stringify(proof, null, 2), { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ mode: 'dry-run', backupFile, proofFile, ...proof }))
  } else {
    const backup = JSON.parse(await fs.readFile(backupFile, 'utf8'))
    const reviewed = JSON.parse(await fs.readFile(proofFile, 'utf8'))
    if (hash(backup.row) !== backup.hash || backup.row.row_version !== row.row_version
      || hash(backup.row.nodes) !== hash(row.nodes) || reviewed.beforeNodesSha256 !== hash(row.nodes)
      || reviewed.afterNodesSha256 !== hash(nodes) || reviewed.edgesSha256 !== hash(row.edges)) {
      throw Error('Saved workflow differs from reviewed dry-run; refuse overwrite')
    }
    const updated = await pool.query('UPDATE workflow_configs SET nodes=$2::jsonb, updated_at=now() WHERE id=$1 AND xmin::text=$3 RETURNING id',
      [workflowId, JSON.stringify(nodes), row.row_version])
    if (updated.rowCount !== 1) throw Error('Concurrent workflow change; refuse overwrite')
    console.log(JSON.stringify({ mode: 'applied', workflowId, changedNodes: changedKeys,
      beforeNodesSha256: proof.beforeNodesSha256, afterNodesSha256: proof.afterNodesSha256 }))
  }
} finally { await pool.end() }
