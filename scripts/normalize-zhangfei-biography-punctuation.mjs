import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

const workflowId = 'wf-sanguo-history-drama'
const characterName = '张飞'
const priorBackfillHash = '1ac9400963345d8d553891befb9d6b8523306c7989158ae194d776f659d9b4f8'
const args = process.argv.slice(2)
const apply = args.includes('--apply')
const expectedCurrentHash = args.find(value => value.startsWith('--expected-current-sha256='))?.split('=')[1]
if (apply && !/^[a-f0-9]{64}$/.test(expectedCurrentHash ?? '')) throw Error('Apply requires a preview current SHA-256')
const digest = value => createHash('sha256').update(value).digest('hex')
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const client = await db.connect()
let result
try {
  await client.query('begin')
  const row = (await client.query(`select biography from character_biographies
    where workflow_id=$1 and character_name=$2 for update`, [workflowId, characterName])).rows[0]
  assert.ok(row, 'Zhang Fei biography missing')
  const before = row.biography
  const currentHash = digest(before)
  const designStart = before.indexOf('【当前剧作外观设定】')
  const pairs = [...before.matchAll(/。。/g)].map(match => match.index)
  if (!pairs.length) {
    result = { status: 'already_normalized', currentHash, biographyLength: before.length }
  } else {
    assert.equal(currentHash, priorBackfillHash, 'biography changed since the sourced backfill')
    assert.equal(pairs.length, 2, 'expected exactly two repeated punctuation marks')
    assert.ok(pairs.every(index => index > designStart), 'punctuation edits must stay in the artistic design section')
    const after = before.replaceAll('。。', '。')
    const afterHash = digest(after)
    if (apply) {
      assert.equal(expectedCurrentHash, currentHash, 'biography changed since preview')
      const directory = path.resolve('logs/character-biography-punctuation-20260928')
      await mkdir(directory, { recursive: true })
      const backupPath = path.join(directory, `before-${Date.now()}.json`)
      await writeFile(backupPath, JSON.stringify({ capturedAt: new Date().toISOString(), workflowId, characterName,
        oldHash: currentHash, newHash: afterHash, biography: before }, null, 2) + '\n', { flag: 'wx' })
      const update = await client.query(`update character_biographies set biography=$3,updated_at=now()
        where workflow_id=$1 and character_name=$2 and biography=$4 returning biography`,
      [workflowId, characterName, after, before])
      assert.equal(update.rowCount, 1, 'compare-and-swap update failed')
      result = { status: 'updated', oldHash: currentHash, newHash: afterHash, oldLength: before.length,
        newLength: after.length, changedPositions: pairs, backupPath }
    } else result = { status: 'preview', oldHash: currentHash, newHash: afterHash, oldLength: before.length,
      newLength: after.length, changedPositions: pairs }
  }
  await client.query(apply ? 'commit' : 'rollback')
} catch (error) {
  await client.query('rollback').catch(() => {})
  throw error
} finally {
  client.release()
}
try {
  if (apply) {
    const fresh = (await db.query('select biography from character_biographies where workflow_id=$1 and character_name=$2',
      [workflowId, characterName])).rows[0].biography
    assert.equal(digest(fresh), result.newHash ?? result.currentHash)
    const response = await fetch(`http://localhost:5173/api/character-people?workflowId=${encodeURIComponent(workflowId)}`)
    assert.equal(response.status, 200)
    const person = (await response.json()).people.find(item => item.characterName === characterName && item.workflowId === workflowId)
    assert.equal(person?.biography, fresh)
    assert.match(fresh, /張飛字益德/)
    assert.match(fresh, /飛雄壯威猛/)
    assert.doesNotMatch(fresh, /。。/)
    result.apiReadback = true
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  await db.end()
}
