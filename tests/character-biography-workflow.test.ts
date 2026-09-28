import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import sharp from 'sharp'
import { enrichCharactersWithHistoricalPortraits, executeBuiltinNode } from '../server/builtin-nodes.ts'
import { characterBiographySchema, readCharacterAssets } from '../server/character-assets.ts'
import { voiceSchema } from '../server/character-voices.ts'

const workflowId = 'wf-sanguo-history-drama'
const episodeNumber = 610
const imageModel = { id: 'image-model', provider: 'Kling', capability: 'image', settings: {} }
const sourceContent = '先主姓劉，諱備，字玄德，涿郡涿縣人也。少孤，與母販履織席為業。先主身長七尺五寸，垂手下膝，顧自見其耳。'

async function enrichedLiuBei() {
  const retrievals: string[][] = []
  const result = await enrichCharactersWithHistoricalPortraits([
    { name: '刘备', description: '青年男性，黑发束髻', designPrompt: '东汉青年刘备人物三视图', continuityKey: 'liubei-youth-v1' },
  ], async input => {
    retrievals.push(input.sourceNames ?? [])
    return {
      query: input.query,
      sourceDetail: '',
      count: 1,
      citations: [{ index: 1, id: 'liubei-source', title: '三國志/卷32', source: '维基文库', edition: '',
        url: 'https://example.test/history/liubei', fetchedAt: '2026-09-27T00:00:00.000Z', content: sourceContent, retrieval: 'internet' }],
      text: '', sourceMode: 'internet', fetchedAt: '2026-09-27T00:00:00.000Z', attemptedUrls: [], failures: [],
    }
  })
  return { result, retrievals }
}

const readableImage = async () => 'data:image/png;base64,' + (await sharp({
  create: { width: 256, height: 256, channels: 3, background: '#777777' },
}).png().toBuffer()).toString('base64')

test('existing historical portrait retrieval also retains life and appearance information without extra calls', async () => {
  const { result, retrievals } = await enrichedLiuBei()
  assert.deepEqual(retrievals, [['三國志'], ['後漢書']])
  assert.equal(result.foundCount, 1)
  const biography = String(result.characters[0].biography ?? '')
  assert.match(biography, /涿郡涿縣|涿郡涿县/)
  assert.match(biography, /販履織席|贩履织席/)
  assert.match(biography, /身長七尺五寸|身长七尺五寸/)
  assert.match(biography, /https:\/\/example\.test\/history\/liubei/)
})

test('deferred portrait candidates carry the biography without writing either library table', async () => {
  const { result } = await enrichedLiuBei()
  const sqlCalls: string[] = []
  const pool = { async query(sql: string) { sqlCalls.push(sql); return { rows: [] } } }
  const url = await readableImage()
  let mediaCalls = 0
  const candidate = await executeBuiltinNode(pool as never, {
    operation: 'character.ensure', model: imageModel,
    params: { workflowId, episodeNumber, characters: result.characters, qualityDisposition: 'manual-review-v1', deferArchive: true },
  }, async () => { mediaCalls++; return { status: 200, body: { images: [{ url }] } } })
  assert.equal(mediaCalls, 1)
  assert.equal(candidate.generatedCount, 1)
  assert.equal((candidate.items as Array<{ biography: string }>)[0].biography, result.characters[0].biography)
  assert.equal((candidate.items as Array<{ metadata: { biography: string } }>)[0].metadata.biography, result.characters[0].biography)
  assert.ok(sqlCalls.every(sql => !/insert into character_(?:assets|biographies)/i.test(sql)))
})

const databaseUrl = process.env.CHARACTER_TEST_DATABASE_URL ?? process.env.VOICE_TEST_DATABASE_URL
test('workflow archive and direct ensure persist shared biographies atomically and preserve manual edits', { skip: !databaseUrl }, async t => {
  const schema = `biography_workflow_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: databaseUrl })
  await admin.query(`create schema ${schema}`)
  const db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  try {
    await db.query(voiceSchema)
    await db.query(`create table character_assets (
      id text primary key, workflow_id text, character_name text not null, asset_type text not null,
      uri text not null, prompt text not null default '', version integer not null default 1,
      metadata jsonb not null default '{}', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    )`)
    await db.query(characterBiographySchema)
    const { result } = await enrichedLiuBei()
    const character = result.characters[0]
    const url = await readableImage()
    const queryCount = async (table: string) => (await db.query(`select count(*)::int as count from ${table}`)).rows[0].count
    const biopsy = async (name: string) => (await db.query('select biography from character_biographies where workflow_id=$1 and character_name=$2', [workflowId, name])).rows[0]?.biography
    let mediaCalls = 0
    const generate = async () => { mediaCalls++; return { status: 200, body: { images: [{ url }] } } }

    await t.test('deferred generation waits for archive and archive does not request inference', async () => {
      const candidates = await executeBuiltinNode(db, { operation: 'character.ensure', model: imageModel,
        params: { workflowId, episodeNumber, characters: [character], qualityDisposition: 'manual-review-v1', deferArchive: true } }, generate)
      assert.equal(mediaCalls, 1)
      assert.equal(await queryCount('character_assets'), 0)
      assert.equal(await queryCount('character_biographies'), 0)
      const archived = await executeBuiltinNode(db, { operation: 'character.archive', params: {
        workflowId, episodeNumber, characters: [character], generatedAssets: candidates,
      } }, async () => { throw new Error('Archive must reuse existing data without inference') })
      assert.equal(archived.archivedCount, 1)
      assert.equal(mediaCalls, 1)
      assert.equal(await biopsy('刘备'), character.biography)
      assert.equal((await readCharacterAssets(db, workflowId))[0].biography, character.biography)
    })

    await t.test('generated metadata recovers the biography when archive receives a bare name', async () => {
      await executeBuiltinNode(db, { operation: 'character.archive', params: {
        workflowId, episodeNumber, characters: ['关羽'], generatedAssets: { items: [{ characterName: '关羽', url,
          metadata: { biography: '关羽，河东解人。本次已有资料描述其外貌。' } }] },
      } })
      assert.equal(await biopsy('关羽'), '关羽，河东解人。本次已有资料描述其外貌。')
    })

    await t.test('direct ensure saves its biography with the image using one generation call', async () => {
      const previousCalls = mediaCalls
      const biography = '诸葛亮，字孔明，琅琊阳都人。外貌设计：青年男性，黑发束髻。'
      await executeBuiltinNode(db, { operation: 'character.ensure', model: imageModel, params: {
        workflowId, episodeNumber, characters: [{ name: '诸葛亮', biography }], qualityDisposition: 'manual-review-v1',
      } }, generate)
      assert.equal(mediaCalls - previousCalls, 1)
      assert.equal(await biopsy('诸葛亮'), biography)
      assert.equal((await readCharacterAssets(db, workflowId)).find(asset => asset.characterName === '诸葛亮')?.biography, biography)
    })

    await t.test('automatic retries and new visual versions preserve manual edits and explicit clearing', async () => {
      await db.query('update character_biographies set biography=$3 where workflow_id=$1 and character_name=$2', [workflowId, '刘备', '我保留用户已经确认的自传。'])
      await db.query('insert into character_biographies(workflow_id,character_name,biography) values($1,$2,$3)', [workflowId, '孙权', ''])
      await executeBuiltinNode(db, { operation: 'character.archive', params: { workflowId, episodeNumber,
        characters: [{ ...character, continuityKey: 'liubei-adult-v2', biography: '自动重试的资料' }, { name: '孙权', biography: '自动补充的资料' }],
        generatedAssets: { items: [{ characterName: '刘备', url }, { characterName: '孙权', url }] },
      } })
      await executeBuiltinNode(db, { operation: 'character.ensure', model: imageModel, params: {
        workflowId, episodeNumber, characters: [{ name: '刘备', continuityKey: 'liubei-elder-v3', biography: '自动生成其他年龄版的资料' }], qualityDisposition: 'manual-review-v1',
      } }, generate)
      assert.equal(await biopsy('刘备'), '我保留用户已经确认的自传。')
      assert.equal(await biopsy('孙权'), '')
      const liuBeiVersions = (await readCharacterAssets(db, workflowId)).filter(asset => asset.characterName === '刘备')
      assert.equal(liuBeiVersions.length, 3)
      assert.ok(liuBeiVersions.every(asset => asset.biography === '我保留用户已经确认的自传。'))
    })

    await t.test('a rejected biography write leaves no half-archived portrait in either entry path', async () => {
      await db.query(`create function reject_workflow_biography() returns trigger language plpgsql as $$
        begin if new.character_name='张飞' then raise exception '拒绝自动自传'; end if; return new; end $$;
        create trigger reject_workflow_biography before insert on character_biographies for each row execute function reject_workflow_biography()`)
      const assetCount = await queryCount('character_assets')
      await assert.rejects(executeBuiltinNode(db, { operation: 'character.archive', params: {
        workflowId, episodeNumber, characters: [{ name: '张飞', biography: '张飞已检索到的人物资料' }], generatedAssets: { items: [{ characterName: '张飞', url }] },
      } }), /拒绝自动自传/)
      await assert.rejects(executeBuiltinNode(db, { operation: 'character.ensure', model: imageModel, params: {
        workflowId, episodeNumber, characters: [{ name: '张飞', biography: '张飞已检索到的人物资料' }], qualityDisposition: 'manual-review-v1',
      } }, generate), /拒绝自动自传/)
      assert.equal(await queryCount('character_assets'), assetCount)
      assert.equal(await biopsy('张飞'), undefined)
    })
  } finally {
    await db.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
})
