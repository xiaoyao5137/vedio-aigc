import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { sharedHistoricalAppearanceEvidence } from '../src/character-biography-view.ts'
import { enrichCharactersWithHistoricalPortraits, executeBuiltinNode } from '../server/builtin-nodes.ts'

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const workflowId = 'wf-sanguo-history-drama'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
try {
  const snapshot = async () => {
    const [assets, executions, models] = await Promise.all([
      db.query(`select id,uri,metadata from character_assets where workflow_id=$1 and character_name=$2 order by id`, [workflowId, '张飞']),
      db.query(`select count(*)::int as count from execution_records where workflow_id=$1`, [workflowId]),
      db.query(`select count(*)::int as count from model_execution_records`),
    ])
    return { assetCount: assets.rows.length, assetsHash: digest(assets.rows), executionCount: executions.rows[0].count, modelExecutionCount: models.rows[0].count }
  }
  const before = await snapshot()
  const workflow = (await db.query(`select schema_version,nodes from workflow_configs where id=$1`, [workflowId])).rows[0]
  const node = id => workflow.nodes.find(item => item.id === id)
  assert.ok(workflow.schema_version >= 155)
  assert.equal(node('sanguo-character-portrait').runIf, undefined)
  assert.equal(node('sanguo-character-portrait').params.find(param => param.englishName === 'historicalSources')?.value, '${historical_sources}')
  assert.deepEqual(node('sanguo-character-image').runIf, { path: 'character_lookup.shouldGenerate', equals: true })
  assert.equal(node('sanguo-character-archive').operation, 'character.archive')
  const saved = (await db.query(`select biography from character_biographies where workflow_id=$1 and character_name=$2`, [workflowId, '张飞'])).rows[0].biography
  assert.match(saved, /張飛字益德/)
  assert.match(saved, /飛雄壯威猛/)
  assert.match(sharedHistoricalAppearanceEvidence(saved) ?? '', /飛雄壯威猛/)
  const execution = (await db.query(`select result from execution_records where id=$1`, ['record-610-tail-adopt-20260928-v1'])).rows[0]
  const source = decodeExecutionState(execution.result).nodeRuns
    .map(run => run.context?.historical_sources)
    .find(value => value?.citations?.some(citation => citation.title === '三國志/卷36#張飛'))
  assert.ok(source)
  let networkCalls = 0
  const replay = await enrichCharactersWithHistoricalPortraits([{ name: '张飞' }], async () => {
    networkCalls += 1
    throw Error('remote retrieval forbidden in this verification')
  }, {}, { knownSources: [source] })
  assert.equal(networkCalls, 0)
  assert.equal(replay.characters[0].historicalPortrait.status, 'found')
  assert.match(replay.characters[0].biography ?? '', /飛雄壯威猛/)
  const existing = await executeBuiltinNode(db, { operation: 'character.historical-portrait',
    params: { workflowId, readOnly: true, characters: [], allCharacters: [{ name: '张飞' }], historicalSources: source } })
  assert.equal(existing.characters.length, 0)
  assert.deepEqual(existing.biographyUpdates, [])
  const after = await snapshot()
  assert.deepEqual(after, before)
  console.log(JSON.stringify({ passed: true, workflowSchema: workflow.schema_version,
    portraitRunsForExistingAssets: node('sanguo-character-portrait').runIf === undefined,
    imageGateRemainsMissingOnly: true, archiveRouteUnchanged: true,
    sourceUrl: source.citations.find(citation => citation.title === '三國志/卷36#張飛').url,
    remoteCalls: networkCalls, biographyLength: saved.length, before, after }, null, 2))
} finally {
  await db.end()
}
