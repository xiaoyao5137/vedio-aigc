#!/usr/bin/env node
// Keep the paid original and its history, but remove an identity-drifted
// portrait from automatic character recall. Run without --apply to preview.
// Example: node scripts/mark-portrait-superseded.mjs --workflow wf-example
//   --person '张飞' --replacement old-id:new-id --reason identity-drift --apply
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const args = process.argv.slice(2)
const option = name => {
  const at = args.indexOf(name)
  return at < 0 ? '' : args[at + 1] || ''
}
const values = name => args.flatMap((arg, index) => arg === name ? [args[index + 1] || ''] : [])
const workflowId = option('--workflow').trim()
const characterName = option('--person').trim()
const reason = option('--reason').trim()
const apply = args.includes('--apply')
const replacements = values('--replacement').map(value => {
  const separator = value.indexOf(':')
  assert.ok(separator > 0 && separator < value.length - 1, 'Each --replacement must be old-id:new-id')
  return { oldId: value.slice(0, separator), replacementId: value.slice(separator + 1) }
})
assert.ok(workflowId && characterName && replacements.length, 'Specify --workflow, --person, and --replacement')
assert.ok(reason && reason.length <= 120, 'Specify a short --reason')
assert.equal(new Set(replacements.map(row => row.oldId)).size, replacements.length, 'Duplicate old portrait ID')
assert.ok(replacements.every(row => row.oldId !== row.replacementId), 'A portrait cannot replace itself')
assert.ok(replacements.every(row => !replacements.some(other => other.oldId === row.replacementId)),
  'A replacement cannot also be superseded in the same migration')
const outputDir = path.resolve(option('--out') || '.runtime/portrait-supersession')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ids = [...new Set(replacements.flatMap(row => [row.oldId, row.replacementId]))]

try {
  const db = await pool.connect()
  try {
    await db.query('begin')
    const rows = (await db.query(`select id,workflow_id,character_name,asset_type,uri,prompt,version,metadata,
        created_at,updated_at,xmin::text as row_version
      from character_assets where id=any($1::text[]) for update`, [ids])).rows
    assert.equal(rows.length, ids.length, 'One or more portraits do not exist')
    const byId = new Map(rows.map(row => [row.id, row]))
    for (const { oldId, replacementId } of replacements) {
      const old = byId.get(oldId), replacement = byId.get(replacementId)
      for (const row of [old, replacement]) {
        assert.equal(row.workflow_id, workflowId, `Wrong workflow for ${row.id}`)
        assert.equal(row.character_name, characterName, `Wrong person for ${row.id}`)
        assert.equal(row.asset_type, 'three-view', `Wrong asset type for ${row.id}`)
      }
      assert.notEqual(old.metadata?.artisticIdentity?.active, true, `Active identity ${oldId} cannot be superseded`)
      assert.notEqual(replacement.metadata?.portraitLifecycle?.status, 'superseded', `Replacement ${replacementId} is superseded`)
      const previous = old.metadata?.portraitLifecycle
      assert.ok(!previous || previous.status === 'superseded' && previous.replacedByAssetId === replacementId,
        `Portrait ${oldId} has a conflicting lifecycle`)
    }
    const planned = replacements.map(({ oldId, replacementId }) => ({ oldId, replacementId,
      alreadySuperseded: byId.get(oldId).metadata?.portraitLifecycle?.status === 'superseded',
      oldImageSha256: hash(byId.get(oldId).uri), replacementImageSha256: hash(byId.get(replacementId).uri) }))
    let backupFile = null
    if (apply && planned.some(row => !row.alreadySuperseded)) {
      await fs.mkdir(outputDir, { recursive: true })
      backupFile = path.join(outputDir, `portraits-before-${Date.now()}.json`)
      await fs.writeFile(backupFile, JSON.stringify({ workflowId, characterName, rows }, null, 2), { flag: 'wx', mode: 0o600 })
      const at = new Date().toISOString()
      for (const { oldId, replacementId } of planned.filter(row => !row.alreadySuperseded)) {
        const old = byId.get(oldId)
        const lifecycle = { status: 'superseded', replacedByAssetId: replacementId, reason, at }
        const result = await db.query(`update character_assets
          set metadata=jsonb_set(metadata,'{portraitLifecycle}',$2::jsonb,true)
          where id=$1 and xmin::text=$3 returning id,uri,prompt,version,created_at,updated_at`,
        [oldId, JSON.stringify(lifecycle), old.row_version])
        assert.equal(result.rowCount, 1, `Concurrent portrait edit: ${oldId}`)
        const saved = result.rows[0]
        assert.equal(saved.uri, old.uri)
        assert.equal(saved.prompt, old.prompt)
        assert.equal(saved.version, old.version)
        assert.equal(String(saved.created_at), String(old.created_at))
        assert.equal(String(saved.updated_at), String(old.updated_at))
      }
    }
    if (apply) await db.query('commit')
    else await db.query('rollback')
    console.log(JSON.stringify({ mode: apply ? 'applied' : 'preview', workflowId, characterName,
      replacements: planned, backupFile }, null, 2))
  } catch (error) {
    await db.query('rollback')
    throw error
  } finally { db.release() }
} finally { await pool.end() }
