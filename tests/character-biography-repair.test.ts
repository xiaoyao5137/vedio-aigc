import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { executeBuiltinNode, enrichCharactersWithHistoricalPortraits } from '../server/builtin-nodes.ts'
import { biographyNeedsEvidenceCompletion, buildCharacterBiography, extractCharacterBiographicalEvidence, mergeCharacterBiographyEvidence } from '../src/character-biography.ts'
import { sharedHistoricalAppearanceEvidence } from '../src/character-biography-view.ts'
import { upgradeCharacterBiographyWorkflow } from '../src/character-biography-workflow.ts'
import { characterBiographySchema } from '../server/character-assets.ts'

const url = 'https://zh.wikisource.org/wiki/%E4%B8%89%E5%9C%8B%E5%BF%97/%E5%8D%B736#%E5%BC%B5%E9%A3%9B'
const source = {
  query: '張飛', sourceDetail: '三國志 卷三十六', count: 1,
  citations: [{ index: 1, id: 'sgz36-zhangfei', title: '三國志/卷36#張飛', source: '維基文庫', edition: '', url,
    fetchedAt: '2026-09-28T00:00:00.000Z', retrieval: 'internet' as const,
    content: [
      '張飛字益德，涿郡人也，少與關羽俱事先主。',
      '飛據水斷橋，瞋目橫矛曰：「身是張益德也，可來共決死！',
      '」敵皆無敢近者，故遂得免。',
      '初，飛雄壯威猛，亞於關羽。',
      '飛營都督表報先主。',
    ].join('\n') }],
  text: '', sourceMode: 'internet' as const, fetchedAt: '2026-09-28T00:00:00.000Z',
  attemptedUrls: [], failures: [],
}

test('named primary section yields Zhang Fei life, build and event expression without inventing features', async () => {
  const life = extractCharacterBiographicalEvidence('张飞', [source]).map(item => item.quote)
  assert.ok(life.some(quote => quote.includes('張飛字益德')))
  assert.ok(life.some(quote => quote.includes('飛據水斷橋，瞋目橫矛') && quote.includes('！」')))
  assert.ok(life.some(quote => quote.includes('飛雄壯威猛')))
  assert.ok(life.every(quote => !quote.includes('飛營都督')))
  let remoteCalls = 0
  const enriched = await enrichCharactersWithHistoricalPortraits([{ name: '张飞' }], async () => {
    remoteCalls += 1
    throw Error('should reuse the sourced section')
  }, {}, { knownSources: [source] })
  assert.equal(remoteCalls, 0)
  assert.equal(enriched.characters[0].historicalPortrait.status, 'found')
  const biography = enriched.characters[0].biography ?? ''
  assert.match(biography, /【正史生平原文】[\s\S]*張飛字益德/)
  assert.match(biography, /【正史体貌记载】[\s\S]*飛雄壯威猛/)
  assert.match(biography, /瞋目橫矛/)
  assert.match(biography, /不能据此推定具体身高、脸型、肤色及须发/)
  assert.doesNotMatch(biography, /豹头环眼|身長九尺|面如重棗/)
  assert.match(sharedHistoricalAppearanceEvidence(biography) ?? '', /飛雄壯威猛/)
  assert.equal(sharedHistoricalAppearanceEvidence(buildCharacterBiography({ name: '张飞' }, [])), undefined)
})

test('a whole volume does not attribute isolated given-name lines to Zhang Fei', () => {
  const unscoped = { ...source, citations: [{ ...source.citations[0], title: '三國志/卷36', url: url.split('#')[0] }] }
  const life = extractCharacterBiographicalEvidence('张飞', [unscoped]).map(item => item.quote)
  assert.deepEqual(life, ['張飛字益德，涿郡人也，少與關羽俱事先主。'])
})

test('conflicting citation title and URL sections cannot attribute a short-name quote', () => {
  const conflicting = { ...source, citations: [{ ...source.citations[0], title: '三國志/卷32#劉備', content: '飛雄壯威猛。' }] }
  assert.deepEqual(extractCharacterBiographicalEvidence('张飞', [conflicting]), [])
})

test('a focused named section recognizes an opening given-name shorthand', async () => {
  const shorthand = { ...source, citations: [{ ...source.citations[0], content: source.citations[0].content.replace('張飛字益德', '飛字益德') }] }
  let calls = 0
  const result = await enrichCharactersWithHistoricalPortraits([{ name: '张飞' }], async () => {
    calls += 1
    throw Error('unexpected retrieval')
  }, {}, { knownSources: [shorthand] })
  assert.equal(calls, 0)
  assert.match(result.characters[0].biography ?? '', /飛字益德/)
  assert.match(result.characters[0].biography ?? '', /飛雄壯威猛/)
})

test('remote failures remain retrieval failures and never become a no-history biography', async () => {
  const queries: string[] = []
  const result = await enrichCharactersWithHistoricalPortraits([{ name: '张飞' }], async input => {
    queries.push(input.query)
    throw Error('HTTP 429')
  })
  assert.deepEqual(queries, ['張飛', '張飛'])
  assert.equal(result.characters[0].historicalPortrait.status, 'retrieval_failed')
  assert.equal(result.characters[0].biography, undefined)
  const irrelevant = { ...source, citations: [{ ...source.citations[0], title: '三國志/卷32#劉備',
    url: 'https://zh.wikisource.org/wiki/三國志/卷32#劉備', content: '先主姓劉，諱備，字玄德，涿郡涿縣人。' }] }
  const partial = await enrichCharactersWithHistoricalPortraits([{ name: '张飞' }], async () => {
    throw Error('HTTP 429')
  }, {}, { knownSources: [irrelevant] })
  assert.equal(partial.characters[0].historicalPortrait.status, 'retrieval_failed')
  assert.equal(partial.characters[0].biography, undefined)
})

test('known life without appearance still searches and reports appearance retrieval failure', async () => {
  for (const withFragment of [true, false]) {
    const partial = { ...source, citations: [{ ...source.citations[0],
      title: withFragment ? '三國志/卷36#張飛' : '三國志/卷36',
      url: withFragment ? url : url.split('#')[0],
      content: '張飛字益德，涿郡人也。',
    }] }
    let calls = 0
    const result = await enrichCharactersWithHistoricalPortraits([{ name: '张飞' }], async () => {
      calls += 1
      throw Error('HTTP 429')
    }, {}, { knownSources: [partial] })
    assert.equal(calls, 2)
    assert.equal(result.characters[0].historicalPortrait.status, 'retrieval_failed')
    assert.equal(result.characters[0].historicalPortrait.failures.length, 2)
    assert.match(result.characters[0].biography ?? '', /張飛字益德/)
    assert.match(result.characters[0].biography ?? '', /本次正史体貌检索失败，暂不能判定有无相关记载/)
    assert.doesNotMatch(result.characters[0].biography ?? '', /暂无可靠正史体貌记载/)
  }
})

test('partial source result failures prevent a false no-appearance conclusion', async () => {
  const lifeOnly = { ...source, citations: [{ ...source.citations[0], content: '張飛字益德，涿郡人也。' }] }
  let calls = 0
  const result = await enrichCharactersWithHistoricalPortraits([{ name: '张飞' }], async () => {
    calls += 1
    return { ...lifeOnly, failures: calls === 1 ? [{ url: 'https://zh.wikisource.org/wiki/三國志/卷36', error: 'HTTP 429' }] : [] }
  })
  assert.equal(calls, 2)
  assert.equal(result.characters[0].historicalPortrait.status, 'retrieval_failed')
  assert.match(result.characters[0].historicalPortrait.failures[0], /HTTP 429/)
  assert.match(result.characters[0].biography ?? '', /張飛字益德/)
  assert.match(result.characters[0].biography ?? '', /本次正史体貌检索失败/)
})

test('failed appearance lookup upgrades an old no-evidence placeholder and remains retryable', async () => {
  const old = buildCharacterBiography({ name: '张飞' }, [])
    .replace('本次已有检索结果中暂无可靠正史体貌记载。',
      '本次已有检索结果中暂无可靠正史体貌记载。\n人工核定：保留待补注释。')
  const partial = { ...source, citations: [{ ...source.citations[0], content: '張飛字益德，涿郡人也。' }] }
  const failed = await enrichCharactersWithHistoricalPortraits([{ name: '张飞', biography: old }], async () => {
    throw Error('HTTP 429')
  }, {}, { knownSources: [partial] })
  const failedBiography = failed.characters[0].biography ?? ''
  assert.match(failedBiography, /張飛字益德/)
  assert.match(failedBiography, /本次正史体貌检索失败，暂不能判定有无相关记载/)
  assert.doesNotMatch(failedBiography, /暂无可靠正史体貌记载/)
  assert.match(failedBiography, /人工核定：保留待补注释/)
  assert.equal(biographyNeedsEvidenceCompletion(failedBiography), true)
  const complete = await enrichCharactersWithHistoricalPortraits([{ name: '张飞', biography: failedBiography }], async () => {
    throw Error('unexpected retrieval')
  }, {}, { knownSources: [source] })
  assert.match(complete.characters[0].biography ?? '', /飛雄壯威猛/)
  assert.doesNotMatch(complete.characters[0].biography ?? '', /本次正史体貌检索失败/)
  assert.match(complete.characters[0].biography ?? '', /人工核定：保留待补注释/)
})

test('only generated empty sections are replaced; manual design, notes and explicit clearing survive', async () => {
  const old = buildCharacterBiography({ name: '张飞', description: '我确认的白净英俊造型' }, []) + '\n人工补充：请保留。'
  const sourced = (await enrichCharactersWithHistoricalPortraits([{ name: '张飞' }], async () => {
    throw Error('no network')
  }, {}, { knownSources: [source] })).characters[0].biography ?? ''
  assert.equal(biographyNeedsEvidenceCompletion(old), true)
  const merged = mergeCharacterBiographyEvidence(old, sourced) ?? ''
  assert.match(merged, /張飛字益德/)
  assert.match(merged, /飛雄壯威猛/)
  assert.match(merged, /我确认的白净英俊造型/)
  assert.match(merged, /人工补充：请保留。/)
  assert.equal(biographyNeedsEvidenceCompletion(merged), false)
  const annotated = old.replace('本次已有检索结果中暂无可明确归属于该人物的可靠生平原文；不据其他人物的记载推写。',
    '本次已有检索结果中暂无可明确归属于该人物的可靠生平原文；不据其他人物的记载推写。\n人工核定：保留此段注释。')
  const annotatedMerged = mergeCharacterBiographyEvidence(annotated, sourced) ?? ''
  assert.match(annotatedMerged, /張飛字益德/)
  assert.match(annotatedMerged, /人工核定：保留此段注释。/)
  assert.equal(mergeCharacterBiographyEvidence('', sourced), undefined)
  assert.equal(mergeCharacterBiographyEvidence('人工写下的自传。', sourced), undefined)
  const enrichedOld = await enrichCharactersWithHistoricalPortraits([{ name: '张飞', biography: old }], async () => {
    throw Error('no network')
  }, {}, { knownSources: [source] })
  assert.equal(enrichedOld.characters[0].biography, merged)
  const explicitlyEmpty = await enrichCharactersWithHistoricalPortraits([{ name: '张飞', biography: '' }], async () => {
    throw Error('no network')
  }, {}, { knownSources: [source] })
  assert.equal(explicitlyEmpty.characters[0].biography, '')
})

test('existing portrait biography can backfill without image generation and respects compare-and-swap', async () => {
  const old = buildCharacterBiography({ name: '张飞', description: '人工保留造型' }, [])
  const calls: Array<{ sql: string; args: unknown[] | undefined }> = []
  const pool = { async query(sql: string, args?: unknown[]) {
    calls.push({ sql, args })
    if (sql.includes('select character_name,biography')) return { rows: [{ character_name: '张飞', biography: old }] }
    if (sql.includes('update character_biographies')) return { rows: [{ character_name: '张飞' }], rowCount: 1 }
    throw Error(`unexpected SQL: ${sql}`)
  } }
  const result = await executeBuiltinNode(pool as never, { operation: 'character.historical-portrait',
    params: { workflowId: 'wf-sanguo-history-drama', characters: [], allCharacters: [{ name: '张飞' }], historicalSources: source } },
    async () => { throw Error('no paid media') })
  assert.equal(result.characters.length, 0)
  assert.equal(result.biographyUpdates[0].status, 'updated')
  assert.equal(calls.length, 2)
  assert.ok(calls[1].sql.includes('biography=$4'))
  assert.equal(calls[1].args?.[3], old)
  assert.match(String(calls[1].args?.[2]), /飛雄壯威猛/)
})

test('workflow upgrade runs source enrichment for existing actors while keeping image and archive gates', () => {
  const gate = { path: 'character_lookup.shouldGenerate', equals: true }
  const workflow = { id: 'wf-sanguo-history-drama', schemaVersion: 154, nodes: [
    { id: 'sanguo-character-portrait', operation: 'character.historical-portrait', prompt: 'old', runIf: gate, params: [] },
    { id: 'sanguo-character-image', operation: 'character.ensure', prompt: 'image', runIf: gate, params: [] },
    { id: 'sanguo-character-archive', operation: 'character.archive', prompt: 'archive', runIf: gate, params: [] },
  ] }
  const upgraded = upgradeCharacterBiographyWorkflow(workflow)
  assert.equal(upgraded.schemaVersion, 155)
  assert.equal(upgraded.nodes[0].runIf, undefined)
  assert.equal(upgraded.nodes[0].params?.[0].englishName, 'historicalSources')
  assert.deepEqual(upgraded.nodes.slice(1), workflow.nodes.slice(1))
  assert.strictEqual(upgradeCharacterBiographyWorkflow(upgraded), upgraded)
})

const databaseUrl = process.env.CHARACTER_TEST_DATABASE_URL
test('existing portrait profile is repaired in an isolated real database without altering its image row', { skip: !databaseUrl }, async () => {
  const schema = `biography_repair_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: databaseUrl })
  await admin.query(`create schema ${schema}`)
  const db = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  try {
    await db.query(characterBiographySchema)
    await db.query(`create table character_assets(id text primary key, workflow_id text, character_name text, metadata jsonb)`)
    const old = buildCharacterBiography({ name: '张飞', description: '人工确认的造型设定' }, [])
    await db.query(`insert into character_biographies(workflow_id,character_name,biography) values($1,$2,$3)`, ['wf', '张飞', old])
    await db.query(`insert into character_assets(id,workflow_id,character_name,metadata) values($1,$2,$3,$4::jsonb)`,
      ['existing-zhangfei', 'wf', '张飞', JSON.stringify({ original: 'preserved' })])
    const first = await executeBuiltinNode(db, { operation: 'character.historical-portrait',
      params: { workflowId: 'wf', characters: [], allCharacters: [{ name: '张飞' }], historicalSources: source } })
    assert.equal(first.biographyUpdates[0].status, 'updated')
    const repaired = (await db.query(`select biography from character_biographies where workflow_id=$1 and character_name=$2`, ['wf', '张飞'])).rows[0].biography
    assert.match(repaired, /飛雄壯威猛/)
    assert.match(repaired, /人工确认的造型设定/)
    assert.deepEqual((await db.query(`select * from character_assets`)).rows, [{ id: 'existing-zhangfei', workflow_id: 'wf', character_name: '张飞', metadata: { original: 'preserved' } }])
    const again = await executeBuiltinNode(db, { operation: 'character.historical-portrait',
      params: { workflowId: 'wf', characters: [], allCharacters: [{ name: '张飞' }], historicalSources: source } })
    assert.deepEqual(again.biographyUpdates, [])
    assert.equal((await db.query(`select biography from character_biographies where workflow_id=$1 and character_name=$2`, ['wf', '张飞'])).rows[0].biography, repaired)
  } finally {
    await db.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
})
