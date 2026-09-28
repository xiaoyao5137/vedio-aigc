import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mergeOutlineContentRepairs, validateHistoricalAgency, validateHistoricalProductionPlan } from '../src/history-content-guards.ts'
import { normalizeDramaOutline } from '../src/history-drama.ts'
import { validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { executeCodeNode } from '../server/code-node.ts'
import { PRINCIPLE_TEXT_ACCEPT_CODE } from '../src/principle-text-quality.ts'
import { upgradePrincipleQuality } from '../src/principle-workflow.ts'
const sources = [{ content: '二家賓客，互相譏揣，遂各樹朋徒，漸成尤隙。' }]
test('real cinematic candidate cannot turn patrons into organizers through an alternate source glyph', () => {
  const actualSources = [{ content: '二家宾客互相譥揣,遂各树朋徒' }]
  for (const principal of ['周福', '房植']) {
    assert.throws(() => validateHistoricalAgency({ scenes: [{ id: 'scene-05', purpose: `${principal}决定联络同道应对` }] }, actualSources), /改变了史料行动主体/)
    assert.throws(() => validateHistoricalAgency({ scenes: [{ id: 'scene-05', purpose: `${principal}默许门客联络同道` }] }, actualSources), /间接授权/)
    assert.doesNotThrow(() => validateHistoricalAgency({ scenes: [{ id: 'scene-05', purpose: `${principal}门客决定联络同道应对` }] }, actualSources))
  }
  assert.throws(() => validateHistoricalAgency({ scenes: [{ id: 'scene-03', requiredBeats: [{ description: '宾客反问：朝廷还需科举取士作甚？' }] }] }, actualSources), /制度年代不符/)
  assert.throws(() => validateHistoricalAgency({ scenes: [{ id: 'scene-05', title: '周福默许', requiredBeats: [{ description: '周福：你们自行处置。宾客退下。' }] }] }, [{ content: '二家賓客，互相譏揣 〈 初委反 〉 ，遂各樹朋徒' }]), /间接授权/)
  assert.doesNotThrow(() => validateHistoricalAgency({ scenes: [{ id: 'scene-01', requiredBeats: [{ function: '揭示房植宾客对周福获官的不满' }] }] }, actualSources))
  assert.throws(() => validateHistoricalAgency({ scenes: [{ id: 'scene-01', requiredBeats: [{ observable: { audio: ['建宁元年，桓帝即位'] } }] }] }, actualSources), /年代不符/)
})
test('rejects the real outline falsely approved by model critic', () => {
  for (const purpose of ['周福在自家府邸召集门生故吏，双方阵营渐成', '房植在自家府邸同样召集门生故吏，两股势力同时壮大']) {
    assert.throws(() => validateHistoricalAgency({ scenes: [{ id: 's1', purpose }] }, sources), /改变了史料行动主体/)
  }
})
test('preserves the recorded agency and ordinary character actions', () => {
  for (const purpose of ['周福宾客在自家府邸召集同道，双方阵营渐成', '房植的门生号令同伴离去，朋徒各自聚集', '周福接过尚书印信，门生在外等候']) {
    assert.doesNotThrow(() => validateHistoricalAgency({ scenes: [{ id: 's1', purpose }] }, sources))
  }
})

test('does not attribute the guests dispute to undocumented jealousy of their patrons', () => {
  assert.throws(() => validateHistoricalAgency({ id: 's2', purpose: '周福擢升尚书，引发房植的不满情绪' }, sources), /政治动机/)
  assert.throws(() => validateHistoricalAgency({ id: 's4', purpose: '房植门客报告民谣，房植面露不悦' }, sources), /政治动机/)
  assert.doesNotThrow(() => validateHistoricalAgency({ id: 's4', purpose: '房植门客听到民谣，面露不悦' }, sources))
})

// Reduced from the real wf-sanguo-history-drama run: scene-03 function
// “展现门客对歌谣暗示周福因师恩得官的理解与不满”. 周福 is only the subject of the embedded
// 歌谣暗示 clause; 不满 is the guests' nominalized reaction (门客对…的理解与不满). The old span
// reached from 周福 across 因师恩得官的理解与 to 不满 and, triggered by 谣, falsely blocked the
// outline for a whole generation. A patron who is himself the resenting subject must still fire.
test('a ballad the guests resent is never read as the patron own resentment', () => {
  const actualSources = [{ content: '二家宾客互相譥揣,遂各树朋徒' }]
  assert.doesNotThrow(() => validateHistoricalAgency({ scenes: [{ id: 'scene-03', requiredBeats: [{ function: '展现门客对歌谣暗示周福因师恩得官的理解与不满' }] }] }, actualSources))
  assert.throws(() => validateHistoricalAgency({ scenes: [{ id: 'scene-03', requiredBeats: [{ function: '歌谣传开后周福面露不悦' }] }] }, actualSources), /政治动机/)
  assert.throws(() => validateHistoricalAgency({ scenes: [{ id: 'scene-03', purpose: '周福听闻乡人传唱的歌谣，心生嫉妒' }] }, actualSources), /政治动机/)
})

// Reduced from the real wf-sanguo-history-drama run record-h2eeyr: the writer kept the guests as the
// action subject, but referred to a patron's retainer group as 门下 (a synonym of 门客/门生). The old
// exclusion list covered 宾客/门客/门生 only, so 房植门下 was read as 房植 himself, and the resentment /
// leadership span also reached across a second patron (擢升周福…引出房植门下的不满 anchored on 周福).
// Both false positives blocked the scene outline for three generations and never reached the loop.
test('a patron retainer group written as 门下/门徒 is never read as the patron himself', () => {
  const actualSources = [{ content: '二家宾客互相譥揣,遂各树朋徒' }]
  // scene-01: the retainer voices the grievance; 房植 stays silent. 不满 belongs to 房植门下, not 房植.
  assert.doesNotThrow(() => validateHistoricalAgency({ scenes: [{ id: 'scene-01', cast: ['房植门客', '房植'],
    purpose: '建立桓帝擢升周福为尚书的背景,引出房植门下的不满情绪,为后续宾客争论做铺垫',
    requiredBeats: [{ id: 'b2', description: '房植听闻后沉默片刻,微微点头,未作回应' }] }] }, actualSources))
  // scene-05/07: the retainers decide to 联络同道; the rival patron's 门下 is only the object of 应对.
  assert.doesNotThrow(() => validateHistoricalAgency({ scenes: [{ id: 'scene-05', cast: ['周福门客'],
    purpose: '周福门客之间商议如何应对房植门下的讥讽,决定联络同道' }] }, actualSources))
  assert.doesNotThrow(() => validateHistoricalAgency({ scenes: [{ id: 'scene-07', cast: ['房植门客'],
    purpose: '房植门客之间商议如何应对周福门下的行动,决定联络同道' }] }, actualSources))
  // 门徒 is the same retainer-group sense and must stay excluded too.
  assert.doesNotThrow(() => validateHistoricalAgency({ scenes: [{ id: 'scene-05', purpose: '周福门徒决定联络同道应对' }] }, actualSources))
  // The genuine violation is untouched: the patron himself still decides / convenes.
  assert.throws(() => validateHistoricalAgency({ scenes: [{ id: 'scene-05', purpose: '周福本人决定联络同道应对' }] }, actualSources), /改变了史料行动主体/)
})

test('real ua0iyt retainers reporting their patrons merits remain the speakers of their own complaints', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/history-agency-reported-principal.json', import.meta.url), 'utf8'))
  const before = structuredClone(fixture)
  assert.equal(fixture.recordId, 'record-ua0iyt')
  for (const { candidate } of fixture.candidates) {
    assert.doesNotThrow(() => validateHistoricalAgency(candidate, fixture.citations))
    assert.deepEqual(candidate.scenes[1].cast, ['房植门生', '甘陵士人'])
    assert.deepEqual(candidate.scenes[2].cast, ['周福门生', '甘陵士人'])
  }
  assert.deepEqual(fixture, before, 'subject attribution never rewrites the original provider candidates or sources')
})

test('concrete reported merits do not excuse the principal own resentment in the same scene or statement', () => {
  for (const name of ['房植', '周福']) {
    for (const purpose of [`${name}本人对歌谣不满`, `${name}听闻歌谣，面露不悦`,
      `门生陈述${name}本人对歌谣的不满`, `门生陈述${name}功绩及其对歌谣的不满`,
      `门生陈述${name}功绩，${name}对歌谣不满`]) {
      assert.throws(() => validateHistoricalAgency({ id: 's1', purpose }, sources), /政治动机/, purpose)
    }
    for (const description of [`${name}面露不悦`, `${name}本人心生嫉妒`]) {
      const candidate = { id: 's1', purpose: '展现门客对歌谣暗示周福因师恩得官的理解与不满', requiredBeats: [{ description }] }
      const message = messageOf(() => validateHistoricalAgency(candidate, sources))
      assert.match(message, /政治动机/)
      assert.match(message, /requiredBeats\[0\]\.description/)
      assert.doesNotMatch(message, /触发原文：purpose/)
    }
  }
})

test('serialized and already-current managed gates refresh the same real subject-attribution fix', async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/history-agency-reported-principal.json', import.meta.url), 'utf8'))
  const candidate = fixture.candidates[0].candidate, review = { version: 'principle-review-v1', decision: 'pass', issues: [] }
  const suffix = '\nreturn { legacy: params.legacy };'
  const staleCode = '// PRINCIPLE_POLICY_START\nif(params.qualityMode === "principle-v1") throw Error("stale subject matching");\n// PRINCIPLE_POLICY_END' + suffix
  const workflow = { id: 'wf-sanguo-history-drama', schemaVersion: 117, nodes: [{ id: 'sanguo-scene-outline-accept', kind: 'code', prompt: '', params: [], code: staleCode }] }
  const before = structuredClone(workflow), migrated = upgradePrincipleQuality(workflow)
  assert.deepEqual(workflow, before)
  assert.equal(migrated.schemaVersion, 117, 'managed policy replacement already refreshes current saved gates')
  assert.ok(migrated.nodes[0].code.endsWith(suffix))
  for (const code of [PRINCIPLE_TEXT_ACCEPT_CODE, migrated.nodes[0].code]) {
    const result = await executeCodeNode({ code, params: { candidate, review, sources: fixture.citations, qualityMode: 'principle-v1' } })
    assert.equal(result.passed, true)
    assert.deepEqual(result.scenes, candidate.scenes)
    const wrong = structuredClone(candidate)
    wrong.scenes[1].requiredBeats[0].function += '。房植本人对歌谣不满。'
    const blocked = await executeCodeNode({ code, params: { candidate: wrong, review, sources: fixture.citations, qualityMode: 'principle-v1' } })
    assert.equal(blocked.passed, false)
    assert.ok(blocked.issues.some(issue => issue.code === 'historical_agency'))
  }
})

const messageOf = (run: () => void) => { try { run(); return '' } catch (error) { return (error as Error).message } }

// Reduced from the real wf-sanguo-history-drama run record-o1oj1l: generation 1 was rejected for a
// scene-01 chronology defect, generation 2 for a scene-05 agency defect, and the writer's shared
// three-generation budget ran out before any generation could fix the second one. The run then
// reported DRAMA_GENERATION_LIMIT and hid both defects. One pass must now name every scene.
test('one writer generation reports every historical defect across scenes instead of one per round', () => {
  const candidate = { scenes: [
    { id: 'scene-01', requiredBeats: [{ observable: { audio: ['建宁元年，桓帝即位'] } }] },
    { id: 'scene-05', purpose: '周福决定联络同道应对' },
  ] }
  const message = messageOf(() => validateHistoricalAgency(candidate, sources))
  const lines = message.split('\n')
  assert.equal(lines.length, 2, '两个场景的缺陷必须在同一次校验里全部报出')
  assert.match(lines[0], /^HISTORY_CONTENT_REJECTED: scene-01 .*年代不符/)
  assert.match(lines[1], /^HISTORY_CONTENT_REJECTED: scene-05 .*改变了史料行动主体/)
  // Callers match this prefix to extract scene ids and to locate the scene a gate must repair.
  assert.deepEqual([...message.matchAll(/HISTORY_CONTENT_REJECTED:\s+(\S+)/g)].map(match => match[1]), ['scene-01', 'scene-05'])
  assert.ok(message.startsWith('HISTORY_CONTENT_REJECTED:'), '聚合后仍须保留可路由的错误前缀')
  assert.ok(message.includes(': scene-01 ') && message.includes(': scene-05 '), '验收门靠 ": <sceneId> " 定位待修场景')
})

// record-vrwgoy: the guard also scans purpose, beat function and stateChange, but its message quoted
// none of them, so the writer resubmitted the identical requiredBeats[2].function in all four paid
// outline generations - it had no way to learn which field had to be rewritten.
test('a historical-subject rejection quotes the exact field and sentence the writer has to rewrite', () => {
  const message = messageOf(() => validateHistoricalAgency({ scenes: [{ id: 'scene-01',
    requiredBeats: [{ id: 'beat-03', description: '房家宾客自行议论歌谣', function: '呈现房植的矜持和内心波动,暗示其默许宾客行动' }] }] }, sources))
  assert.equal(message.split('\n').length, 1)
  assert.match(message, /^HISTORY_CONTENT_REJECTED: scene-01 以主人默许/)
  assert.ok(message.includes('触发原文：requiredBeats[0].function「呈现房植的矜持和内心波动,暗示其默许宾客行动」'), message)
  assert.ok(message.includes('只改写被点名句子里的行动主体'), message)
  // The rule itself is unchanged: the same candidate without any tacit-authorship phrasing still passes.
  assert.doesNotThrow(() => validateHistoricalAgency({ scenes: [{ id: 'scene-01',
    requiredBeats: [{ id: 'beat-03', description: '房家宾客自行议论歌谣', function: '呈现宾客自行解读歌谣并相互结交' }] }] }, sources))
})

test('a single historical defect keeps the exact message a lone violation produced before', () => {
  const message = messageOf(() => validateHistoricalAgency({ scenes: [{ id: 'scene-01', requiredBeats: [{ observable: { audio: ['建宁元年，桓帝即位'] } }] }] }, sources))
  assert.equal(message.split('\n').length, 1)
  assert.equal(message.startsWith('HISTORY_CONTENT_REJECTED: scene-01 把桓帝即位写入建宁年间，年代不符。'), true)
})

test('every over-capacity scene is listed in one pass instead of costing one round each', () => {
  const message = messageOf(() => validateHistoricalProductionPlan({ scenes: [{ id: 's1', cast: ['甲', '乙', '丙'] }, { id: 's2', cast: [] }] }))
  assert.deepEqual(message.split('\n').map(line => line.slice(0, 'HISTORY_PLAN_CAST_OVERFLOW: s1'.length)),
    ['HISTORY_PLAN_CAST_OVERFLOW: s1', 'HISTORY_PLAN_CAST_OVERFLOW: s2'])
})

test('an environment-only live-action context bridge does not invent a cast member', () => {
  const bridge = { id: 'scene-05', editorialRole: 'context_bridge', visualTreatment: 'live_action', cast: [] }
  assert.doesNotThrow(() => validateHistoricalProductionPlan({ scenes: [bridge] }))
  assert.throws(() => validateHistoricalProductionPlan({ scenes: [{ ...bridge, editorialRole: 'story' }] }), /CAST_OVERFLOW/)
})

test('record-9ildu8 actorless environment and historical-map payoff do not invent cast', () => {
  const scenes = [
    { id: 'scene-17', editorialRole: 'story', visualTreatment: 'live_action', cast: [],
      requiredBeats: [{ description: '空荡殿堂无人值守', mustShow: ['空荡殿堂'], observable: { visual: ['空荡殿堂无人值守'] } }] },
    { id: 'scene-18', editorialRole: 'payoff', visualTreatment: 'animated', animationStyle: 'historical_map', cast: [],
      requiredBeats: [{ description: '历史地图标注八州连结成网状', observable: { visual: ['历史地图八州连结成网状'] } }] },
  ]
  assert.doesNotThrow(() => validateHistoricalProductionPlan({ scenes }))
  assert.throws(() => validateHistoricalProductionPlan({ scenes: [{ ...scenes[0], requiredBeats: [{ description: '张角走入殿堂' }] }] }), /CAST_OVERFLOW/)
})

test('outline normalization derives a missing cast from one or two named visible obligations', () => {
  const visibleName = '张角'
  const outline = { contentContractVersion: 'cinematic-v1', characterDramas: [{ name: visibleName }], dramaticScenes: [{ id: 'drama-01', characters: [] }],
    scenes: [{ id: 'scene-01', dramaticSceneId: 'drama-01', visualTreatment: 'live_action', editorialRole: 'story', cast: [],
      requiredBeats: [{ id: 'beat-01', observable: { visual: [`${visibleName}站在门前`] }, mustShow: [`${visibleName}站在门前`] }] }] }
  const normalized = normalizeDramaOutline(outline, { requireDramaContract: true })
  assert.deepEqual((normalized.scenes as Array<{ cast: string[] }>)[0].cast, [visibleName])
  assert.doesNotThrow(() => validateHistoricalProductionPlan(normalized))
})

test('outline normalization restores one blank context narration from its sole approved audio obligation', () => {
  const outline = { contentContractVersion: 'cinematic-v1', characterDramas: [], dramaticScenes: [{ id: 'drama-01', characters: [] }],
    scenes: [{ id: 'scene-01', dramaticSceneId: 'drama-01', editorialRole: 'context_bridge', visualTreatment: 'animated',
      animationStyle: 'time_montage', animationAesthetic: 'cinematic_gongbi', cast: [],
      contextPayload: { timePlace: '冀州', geographicFocus: ['冀州'], historicalBackground: '灾疫流行', narration: ' ' },
      requiredBeats: [{ id: 'beat-01', observable: { visual: ['地图上冀州亮起'], audio: ['冀州灾疫流行。'] }, mustShow: ['地图上冀州亮起'] }] }] }
  const normalized = normalizeDramaOutline(outline, { requireDramaContract: true }) as { scenes: Array<{ contextPayload: { narration: string } }> }
  assert.equal(normalized.scenes[0].contextPayload.narration, '冀州灾疫流行。')

  const ambiguous = structuredClone(outline)
  ambiguous.scenes[0].requiredBeats[0].observable.audio.push('百姓流离。')
  assert.equal((normalizeDramaOutline(ambiguous, { requireDramaContract: true }).scenes as Array<{ contextPayload: { narration: string } }>)[0].contextPayload.narration, ' ')
})

test('the real provider outline passes both production and structural schemas without a cast repair loop', () => {
  const candidate = JSON.parse(fs.readFileSync(new URL('./fixtures/history-outline-production.json', import.meta.url), 'utf8'))
  validateHistoricalProductionPlan(candidate)
  const validated = validateHistoricalStructuredOutput('history.scene-outline', candidate, { requireBeatCoverage: true }) as { scenes: Array<{ cast: string[] }> }
  assert.equal(validated.scenes.length, candidate.scenes.length)
  assert.deepEqual(validated.scenes[0].cast, candidate.scenes[0].cast)
  assert.throws(() => validateHistoricalProductionPlan({ scenes: [{ id: 's1', cast: ['甲', '乙', '丙'] }] }), /CAST_OVERFLOW/)
})

test('content repair preserves unflagged scenes and cannot remove their plot', () => {
  const original = { scenes: [{ id: 's1', cast: ['中书令'], purpose: '授予印信' }, { id: 's2', cast: ['宾客甲'], purpose: '原剧情' }] }
  const repaired = { scenes: [{ id: 's1', cast: ['谒者'], purpose: '授予印信' }, { id: 's2', cast: ['新角色'], purpose: '任意重写' }, { id: 's3', purpose: '额外场景' }] }
  const result = mergeOutlineContentRepairs(original, repaired, '[{"itemId":"s1","problem":"职官不符"}]')
  assert.deepEqual(result.scenes, [repaired.scenes[0], original.scenes[1]])
  assert.throws(() => mergeOutlineContentRepairs(original, { scenes: [] }, '[{"itemId":"s1"}]'), /禁止删剧情/)
})


test('flagged overloaded scenes can expand without losing beats or changing neighbors', () => {
  const original = { scenes: [{ id: 's1', requiredBeats: [{ id: 'b1' }, { id: 'b2' }] }, { id: 's2', purpose: '保留' }] }
  const repaired = { scenes: [{ id: 's1', requiredBeats: [{ id: 'b1' }] }, { id: 's1-part-2', requiredBeats: [{ id: 'b2' }] }, { id: 's2', purpose: '不能改' }] }
  const result = mergeOutlineContentRepairs(original, repaired, '[{"itemId":"s1"}]')
  assert.deepEqual(result.scenes.map(s => s.id), ['s1', 's1-part-2', 's2'])
  assert.equal(result.scenes[2].purpose, '保留')
  assert.throws(() => mergeOutlineContentRepairs(original, { scenes: [repaired.scenes[0], { id: 's1-part-2', requiredBeats: [] }] }, '[{"itemId":"s1"}]'), /遗漏b2/)
})
