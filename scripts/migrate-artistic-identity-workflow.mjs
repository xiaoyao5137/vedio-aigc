#!/usr/bin/env node
// Dry-run saves the exact schema-149 workflow row and a bounded schema-150
// prompt diff. --apply is compare-and-swap and deliberately never restarts Vite.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { upgradeCharacterVisualWorkflow } from '../src/character-visual-workflow.ts'

const id = 'wf-sanguo-history-drama'
const directory = path.resolve('logs/dramatic-expression/live-20260928/artistic-identity-migration')
const backupFile = path.join(directory, 'workflow-schema149-before.json')
const apply = process.argv.includes('--apply')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

try {
  await fs.mkdir(directory, { recursive: true })
  const row = (await pool.query('select *,xmin::text as row_version from workflow_configs where id=$1', [id])).rows[0]
  if (!row || row.schema_version !== 149) throw Error('工作流不是待迁移的 schema149，拒绝覆盖')
  const before = { id: row.id, schemaVersion: row.schema_version, nodes: row.nodes }
  const after = upgradeCharacterVisualWorkflow(before)
  const changed = after.nodes.flatMap((node, index) => JSON.stringify(node) === JSON.stringify(before.nodes[index]) ? []
    : [{ id: node.id, changedKeys: Object.keys(node).filter(key => JSON.stringify(node[key]) !== JSON.stringify(before.nodes[index][key])) }])
  if (after.schemaVersion !== 150 || JSON.stringify(changed) !== JSON.stringify([
    { id: 'sanguo-scene-outline', changedKeys: ['prompt'] },
    { id: 'sanguo-shot-script', changedKeys: ['prompt'] },
  ])) throw Error('提示词差异超出大纲和分镜两节点，拒绝迁移')
  if (!after.nodes.find(node => node.id === 'sanguo-scene-outline')?.prompt.includes('${characterArtisticIdentityCatalog}')
    || !after.nodes.find(node => node.id === 'sanguo-scene-outline')?.prompt.includes('episode_boundary')) {
    throw Error('新大纲提示缺少人物艺术身份或既有分集边界，拒绝迁移')
  }
  const summary = { id, fromSchema: 149, toSchema: 150, changed, beforeNodesHash: sha(before.nodes), afterNodesHash: sha(after.nodes), rowVersion: row.row_version }
  if (!apply) {
    await fs.writeFile(backupFile, JSON.stringify({ row, sha: sha(row) }, null, 2), { flag: 'wx', mode: 0o600 })
    await fs.writeFile(path.join(directory, 'workflow-schema150-dry-run.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ mode: 'backup-and-dry-run', backupFile, summary }))
  } else {
    const backup = JSON.parse(await fs.readFile(backupFile, 'utf8'))
    if (backup.sha !== sha(backup.row) || backup.row.id !== id || backup.row.row_version !== row.row_version
      || sha(backup.row.nodes) !== sha(row.nodes)) throw Error('工作流备份与实时行不一致，拒绝覆盖')
    const result = await pool.query('update workflow_configs set nodes=$2::jsonb,schema_version=$3,updated_at=now() where id=$1 and xmin::text=$4 returning id',
      [id, JSON.stringify(after.nodes), 150, row.row_version])
    if (result.rowCount !== 1) throw Error('工作流并发变化，拒绝覆盖')
    console.log(JSON.stringify({ mode: 'applied', summary, backupFile }))
  }
} finally { await pool.end() }
