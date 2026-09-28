import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCharacterBiography, CHARACTER_BIOGRAPHY_MAX_LENGTH, extractCharacterBiographicalEvidence } from '../src/character-biography.ts'
import type { CharacterBiographySource } from '../src/character-biography.ts'

function source(content: string, title = '三國志/卷32', url = 'https://example.test/sgz/32'): CharacterBiographySource {
  return { citations: [{ title, url, content }] }
}

test('biography preserves Liu Bei historical aliases and traditional original wording', () => {
  const sources = [source('先主姓劉，諱備，字玄德，涿郡涿縣人。少孤，與母販履織席為業。張飛字益德，涿郡人也。少與關羽俱事先主。')]
  const evidence = extractCharacterBiographicalEvidence('刘备', sources)
  assert.equal(evidence.length, 1)
  assert.match(evidence[0].quote, /^先主姓劉，諱備/)
  assert.match(evidence[0].quote, /與母販履織席為業/)
  assert.doesNotMatch(evidence[0].quote, /張飛|少與關羽/)
  const biography = buildCharacterBiography({ name: '劉備' }, sources)
  assert.match(biography, /先主姓劉，諱備/)
  assert.match(biography, /https:\/\/example.test\/sgz\/32/)
})

test('traditional names beyond the old portrait character map match without a remote lookup', () => {
  const evidence = extractCharacterBiographicalEvidence('卢植', [source('盧植字子幹，涿郡涿人也。少與鄭玄俱事馬融。', '後漢書/卷64')])
  assert.equal(evidence.length, 1)
  assert.match(evidence[0].quote, /盧植字子幹/)
  assert.match(evidence[0].quote, /少與鄭玄/)
})

test('historical subject aliases and dated predicates take precedence over temporal prefixes', () => {
  assert.match(extractCharacterBiographicalEvidence('刘禅', [source('後主諱禪，字公嗣。', '三國志/卷33')])[0].quote, /後主諱禪/)
  assert.match(extractCharacterBiographicalEvidence('刘备', [source('劉備卒於章武三年。')])[0].quote, /劉備卒於章武三年/)
})

test('another actor mentioning the target does not supply the target biography', () => {
  const evidence = extractCharacterBiographicalEvidence('刘备', [source('曹操字孟德，沛國譙人也。少與劉備相識。曹操破劉備於沛。劉備奔荊州。')])
  assert.deepEqual(evidence.map(item => item.quote), ['劉備奔荊州。'])
})

test('another actor biography beginning in the same sentence ends the excerpt', () => {
  const evidence = extractCharacterBiographicalEvidence('刘备', [source('劉備字玄德，涿郡人也，曹操字孟德，沛國人也。少好音樂。')])
  assert.deepEqual(evidence.map(item => item.quote), ['劉備字玄德，涿郡人也'])
})

test('other actor appearance in the same sentence does not become target history', () => {
  const evidence = extractCharacterBiographicalEvidence('刘备', [source('先主劉備與關羽會面，關羽身長九尺。')])
  assert.deepEqual(evidence.map(item => item.quote), ['先主劉備與關羽會面'])
  const biography = buildCharacterBiography({ name: '刘备', historicalPortrait: { status: 'found', description: '關羽身長九尺。', citations: [
    { title: '三國志/卷32', url: 'https://example.test/sgz/32', quote: '關羽身長九尺。' },
  ] } }, [source('先主劉備與關羽會面。關羽身長九尺。')])
  assert.doesNotMatch(biography, /身長九尺/)
  assert.match(biography, /暂无可靠正史体貌记载/)
  assert.deepEqual(extractCharacterBiographicalEvidence('刘备', [source('先主劉備與關羽會面，關羽長八尺。')]).map(item => item.quote), ['先主劉備與關羽會面'])
})

test('legacy multi-sentence portrait citations are checked at each subject transition', () => {
  const citation = { title: '三國志/卷32', url: 'https://example.test/sgz/32', quote: '劉備字玄德。關羽身長九尺。身長八尺。' }
  const biography = buildCharacterBiography({ name: '刘备', historicalPortrait: { status: 'found', citations: [citation] } }, [])
  assert.doesNotMatch(biography, /身長九尺|身長八尺/)
  assert.match(biography, /暂无可靠正史体貌记载/)
  const valid = buildCharacterBiography({ name: '刘备', historicalPortrait: { status: 'found', citations: [
    { ...citation, quote: '劉備字玄德。身長七尺五寸。垂手下膝。' },
  ] } }, [])
  assert.match(valid, /身長七尺五寸。垂手下膝。/)
})

test('unknown next subjects are not inherited and documented target clauses can resume', () => {
  const evidence = extractCharacterBiographicalEvidence('张角', [source('張角自稱大賢良師。張寶字某，鉅鹿人也。年二十。張角遣弟子周行四方。', '後漢書/卷71')])
  assert.equal(evidence.length, 2)
  assert.doesNotMatch(evidence.map(item => item.quote).join(''), /張寶|年二十/)
  assert.match(evidence[1].quote, /張角遣弟子/)
})

test('a different actor surname is not confused with a subject-omission marker', () => {
  const evidence = extractCharacterBiographicalEvidence('刘备', [source('劉備奔荊州。常山趙雲從劉備入蜀。任峻募軍。曾某起兵。')])
  assert.deepEqual(evidence.map(item => item.quote), ['劉備奔荊州。'])
})

test('duplicate source passages and portrait quotations appear once', () => {
  const sources = [source('劉備字玄德，涿郡人也。'), source('刘备字玄德，涿郡人也。')]
  const biography = buildCharacterBiography({ name: '刘备', historicalPortrait: { status: 'found', citations: [
    { title: '三國志/卷32', url: 'https://example.test/sgz/32', quote: '身長七尺五寸，垂手下膝。' },
    { title: '三国志/卷32', url: 'https://example.test/sgz/32', quote: '身长七尺五寸，垂手下膝。' },
  ] } }, sources)
  assert.equal(extractCharacterBiographicalEvidence('刘备', sources).length, 1)
  assert.equal((biography.match(/涿郡人也/g) ?? []).length, 1)
  assert.equal((biography.match(/垂手下膝/g) ?? []).length, 1)
  assert.match(biography, /【正史体貌记载】[\s\S]*身長七尺五寸/)
})

test('novel and nonhistorical sources are not represented as authoritative biography', () => {
  const biography = buildCharacterBiography({ name: '关羽' }, [
    source('關羽身長九尺，髯長二尺。', '三國演義/第一回'),
    source('關羽曾獨戰群雄。', '三國志人物小說'),
    source('關羽面如重棗。', '百科人物介紹'),
  ])
  assert.match(biography, /暂无可明确归属于该人物的可靠生平原文/)
  assert.match(biography, /暂无可靠正史体貌记载/)
  assert.doesNotMatch(biography, /身長九尺|面如重棗|獨戰群雄|我是/)
})

test('visual description and stage choices remain separate from the historical quotes', () => {
  const biography = buildCharacterBiography({ name: '刘备', description: '青年刘备，黑发无白发，粗布衣。', visualContext: {
    version: 'character-visual-context-v1', age: { stage: 'young_adult', basis: 'artistic', years: { min: 22, max: 27 }, asOf: '黄巾起事时' },
    look: { key: '乡间行旅', description: '灰色麻布短袍，束发布巾' }, appearanceConstraints: { hair: 'dark', facialHair: 'none' },
  } }, [source('先主字玄德，涿郡涿縣人。')])
  const beforeDesign = biography.split('【当前剧作外观设定】')[0]
  assert.doesNotMatch(beforeDesign, /粗布衣|乡间行旅|22至27/)
  assert.match(biography, /不作为正史体貌记载/)
  assert.match(biography, /艺术年龄设定，并非史实年龄复原/)
  assert.match(biography, /乡间行旅：灰色麻布短袍/)
  assert.match(biography, /面部胡须：不留胡须/)
})

test('unlinked existing portrait text is retained as unverified instead of claimed history', () => {
  const biography = buildCharacterBiography({ name: '关羽', historicalPortrait: { description: '红脸绿袍，长髯。' } }, [])
  assert.match(biography, /缺少可核对的来源，暂不作为史实/)
  assert.match(biography, /红脸绿袍/)
})

test('long retained materials fit storage while every rendered citation keeps a complete source link', () => {
  const urls = Array.from({ length: 12 }, (_, index) => `https://example.test/history/${index}?source=${'x'.repeat(800)}`)
  const sources = urls.map((url, index) => source(`劉備${'行'.repeat(780)}${index}。`, '三國志/卷32', url))
  const biography = buildCharacterBiography({ name: '刘备', description: '外观'.repeat(5_000), historicalPortrait: { citations: urls.map((url, index) => ({
    title: '三國志/卷32', url, quote: `身長七尺五寸${'貌'.repeat(580)}${index}。`,
  })) } }, sources)
  assert.ok(biography.length <= CHARACTER_BIOGRAPHY_MAX_LENGTH)
  const renderedUrls = biography.split('\n').filter(line => line.startsWith('https://'))
  assert.ok(renderedUrls.length > 0)
  for (const url of renderedUrls) assert.ok(urls.includes(url))
  assert.match(biography, /【当前剧作外观设定】/)
})

test('composer is deterministic and does not mutate its already retrieved input', () => {
  const sources = [source('張角自稱大賢良師。', '後漢書/卷71')]
  const character = { name: '张角', description: '道袍与束发' }
  const original = JSON.stringify({ sources, character })
  assert.equal(buildCharacterBiography(character, sources), buildCharacterBiography(character, sources))
  assert.equal(JSON.stringify({ sources, character }), original)
})
