import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { characterPersonId, readCharacterEquipment, readCharacterPeople } from '../server/character-assets.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'

const workflowId = 'wf-sanguo-history-drama'
const characterName = '张飞'
const personId = characterPersonId(workflowId, characterName)
const executionId = 'record-hlq05n'
const portraitIds = { 518: 'character-mukn7n7k-xzu2tb', 610: 'character-2adc61b636f93ba0' }
const equipmentId = 'equipment-zhangfei-changban-long-spear-v1'
const sourceUrl = 'https://zh.wikisource.org/wiki/%E4%B8%89%E5%9C%8B%E5%BF%97/%E5%8D%B736#%E5%BC%B5%E9%A3%9B'
const desired = {
  id: equipmentId,
  personId,
  workflowId,
  characterName,
  name: '长矛',
  kind: 'weapon',
  description: `第518集《张飞据水》已批准场景使用的长矛。《三国志·张飞传》仅记“飛據水斷橋，瞋目橫矛”；长度、矛头形制与装饰属于本剧道具设计，不将“丈八蛇矛”称谓冒充正史。史料：${sourceUrl}`,
  imageUrl: '',
  aliases: [],
  applicability: { ageStages: ['mature'] },
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const expectedPlanHash = args.find(arg => arg.startsWith('--expected-plan-sha256='))?.split('=')[1]
if (apply && !/^[a-f0-9]{64}$/.test(expectedPlanHash ?? '')) {
  throw Error('Apply requires --expected-plan-sha256=<64 hex chars> from a fresh preview')
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })

function exactExisting(row) {
  return row.id === desired.id && row.person_id === desired.personId && row.workflow_id === desired.workflowId
    && row.character_name === desired.characterName && row.name === desired.name && row.kind === desired.kind
    && row.description === desired.description && row.image_url === desired.imageUrl
    && JSON.stringify(row.aliases) === JSON.stringify(desired.aliases)
    && JSON.stringify(row.applicability) === JSON.stringify(desired.applicability)
}

async function preview(client) {
  const record = (await client.query('select result from execution_records where id=$1 and workflow_id=$2', [executionId, workflowId])).rows[0]
  assert.ok(record, 'approved execution missing')
  const runs = decodeExecutionState(record.result).nodeRuns
  const knowledge = runs.find(run => run.id.startsWith('sanguo-knowledge-') && run.status === 'success')
  const citation = knowledge?.output?.citations?.find(item => item.content?.includes('飛據水斷橋，瞋目橫矛'))
  assert.ok(citation && citation.title.includes('三國志/卷36'), 'original source lacks the spear passage')
  const review = runs.find(run => run.id.startsWith('sanguo-scene-outline-review-') && run.status === 'success')
  const accepted = runs.find(run => run.id.startsWith('sanguo-scene-outline-accept-') && !run.id.includes('branch') && run.status === 'success')
  assert.equal(review?.output?.decision, 'pass', 'outline review did not pass')
  assert.equal(accepted?.output?.passed, true, 'scene outline was not approved')
  assert.equal(accepted?.output?.episodeTitle, '张飞据水')
  const scene = accepted.output.scenes.find(item => item.title === '横矛决死')
  assert.ok(scene?.requiredBeats?.some(beat => beat.mustShow?.some(text => text.includes('张飞将长矛横在身前'))),
    'approved scene does not require Zhang Fei to hold a long spear')
  assert.match(scene.historicalBasis, /瞋目横矛/)
  const portraits = (await client.query(`select id,metadata from character_assets
    where id=any($1::text[]) and workflow_id=$2 and character_name=$3 and asset_type='three-view'`,
  [Object.values(portraitIds), workflowId, characterName])).rows
  const visualContexts = {}
  for (const episodeNumber of [518, 610]) {
    const matching = portraits.find(row => row.id === portraitIds[episodeNumber])
    assert.ok(matching, `current ${episodeNumber} portrait missing`)
    const visualContext = matching.metadata?.visualContext
    assert.equal(visualContext?.age?.stage, 'mature')
    assert.equal(visualContext?.look?.key, episodeNumber === 518 ? 'changban-campaign-robe-cloak' : 'zhangfei_jiangzhou_campaign')
    assert.deepEqual(matching.metadata?.episodeScope?.episodes, [episodeNumber])
    assert.notEqual(matching.metadata?.portraitLifecycle?.status, 'superseded')
    assert.notEqual(matching.metadata?.portraitLifecycle?.status, 'pending-review')
    assert.notEqual(matching.metadata?.identityConsistency?.status, 'needs_manual_review')
    visualContexts[episodeNumber] = visualContext
  }
  const existing = (await client.query('select * from character_equipment where person_id=$1 order by id for update', [personId])).rows
  const source = { executionId, title: accepted.output.episodeTitle, review: review.output.decision,
    scene: scene.title, required: '张飞将长矛横在身前', original: '飛據水斷橋，瞋目橫矛',
    citationTitle: citation.title, citationUrl: citation.url, canonicalUrl: sourceUrl }
  const plan = { personId, desired, source, sourceHash: hash({ citation: citation.content, scene }) }
  return { plan, planHash: hash(plan), existing, visualContexts }
}

async function verifyAfterCommit(snapshot) {
  const equipment = await readCharacterEquipment(db, workflowId, [characterName])
  assert.equal(equipment.length, 1)
  assert.equal(equipment[0].id, equipmentId)
  const people = await readCharacterPeople(db, workflowId)
  const person = people.find(item => item.id === personId)
  assert.ok(person)
  assert.equal(person.equipment.length, 1)
  assert.equal(person.equipment[0].name, '长矛')
  const lookups = {}
  for (const episodeNumber of [518, 610]) {
    const lookup = await executeBuiltinNode(db, { operation: 'character.lookup', params: {
      workflowId, episodeNumber, characters: [{ name: characterName,
        visualContext: snapshot.visualContexts[episodeNumber], equipmentNames: ['长矛'] }],
    } })
    assert.equal(lookup.equipmentBindings?.[0]?.id, equipmentId)
    assert.equal(lookup.equipmentBindings?.[0]?.matchReason, 'exact-name')
    assert.equal(lookup.equipmentBindings?.[0]?.imageUrl, '')
    lookups[episodeNumber] = { equipmentId: lookup.equipmentBindings[0].id, foundCount: lookup.foundCount }
  }
  const noRequirement = await executeBuiltinNode(db, { operation: 'character.lookup', params: {
    workflowId, episodeNumber: 610, characters: [{ name: characterName, visualContext: snapshot.visualContexts[610] }],
  } })
  assert.deepEqual(noRequirement.equipmentBindings ?? [], [], 'equipment must not be inferred for scene 610')
  const response = await fetch(`http://localhost:5173/api/character-people?workflowId=${encodeURIComponent(workflowId)}`)
  assert.equal(response.status, 200, 'character-people API unavailable')
  const payload = await response.json()
  const fromApi = payload.people?.find(item => item.id === personId)
  assert.equal(fromApi?.equipment?.length, 1)
  assert.equal(fromApi?.equipment?.[0]?.id, equipmentId)
  return { dbReadback: true, apiReadback: true, lookups, scene610WithoutRequirement: true }
}

const client = await db.connect()
let snapshot
let status = 'preview'
let backupPath
try {
  await client.query('begin')
  if (apply) await client.query('select pg_advisory_xact_lock(hashtext($1)::bigint)', [personId])
  snapshot = await preview(client)
  if (apply && snapshot.planHash !== expectedPlanHash) throw Error('Plan hash changed since preview; run preview again')
  if (snapshot.existing.length === 1 && exactExisting(snapshot.existing[0])) {
    status = 'already_applied'
  } else if (snapshot.existing.length) {
    throw Error('Character already has equipment; preserve manual rows and review a new plan')
  } else if (apply) {
    const directory = path.resolve('logs/zhangfei-equipment-backfill-20260928')
    await mkdir(directory, { recursive: true })
    backupPath = path.join(directory, `before-${Date.now()}.json`)
    await writeFile(backupPath, JSON.stringify({ capturedAt: new Date().toISOString(), planHash: snapshot.planHash,
      personId, source: snapshot.plan.source, existing: snapshot.existing }, null, 2) + '\n', { flag: 'wx' })
    await client.query(`insert into character_equipment
      (id,person_id,workflow_id,character_name,name,kind,description,image_url,aliases,applicability)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
    [desired.id, desired.personId, desired.workflowId, desired.characterName, desired.name, desired.kind,
      desired.description, desired.imageUrl, JSON.stringify(desired.aliases), JSON.stringify(desired.applicability)])
    status = 'inserted'
  }
  await client.query(apply ? 'commit' : 'rollback')
} catch (error) {
  await client.query('rollback').catch(() => {})
  throw error
} finally {
  client.release()
}
try {
  const verification = apply ? await verifyAfterCommit(snapshot) : undefined
  console.log(JSON.stringify({ status, planHash: snapshot.planHash, existingCount: snapshot.existing.length,
    desired, source: snapshot.plan.source, ...(backupPath ? { backupPath } : {}),
    ...(verification ? { verification } : {}) }, null, 2))
} finally {
  await db.end()
}
