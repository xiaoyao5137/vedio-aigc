import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { executeCodeNode } from '../server/code-node.ts'
import { SANGUO_CONTEXT_INIT_CODE } from '../src/code-node-presets.ts'
import { EPISODE_BOUNDARY_PROMPT, parseEpisodeBoundary, refreshEpisodeBoundaryPrompt,
  refreshSanguoContextBoundaryCode, validateEpisodeNarrativeBoundary } from '../src/episode-boundary.ts'

const workbookPath = new URL('../public/data/三国历史短剧1000集策划总表.xlsx', import.meta.url)
const spilled693Path = new URL('./fixtures/episode-693-boundary-spill.json', import.meta.url)
const clean610Path = new URL('./fixtures/episode-610-boundary-clean.json', import.meta.url)
const upload = async () => {
  const bytes = await readFile(workbookPath)
  return { id: 'sanguo-workbook', name: '三国历史短剧1000集策划总表.xlsx',
    dataUrl: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${bytes.toString('base64')}` }
}

test('the real workbook gives the outline adjacent editorial ownership without changing source retrieval', async () => {
  const file = await upload()
  for (const [episode, title, next] of [
    [518, '张飞据水', '断桥疑兵'],
    [610, '张飞释严颜', '马超归降'],
    [693, '张飞治兵', '帐下行刺'],
  ] as const) {
    const result = await executeCodeNode({ code: SANGUO_CONTEXT_INIT_CODE, context: { input: { episode_number: episode } }, files: [file] })
    const boundary = parseEpisodeBoundary(result.fields.episode_boundary, episode, title)
    assert.ok(boundary)
    assert.equal(boundary.next[0].title, next)
    assert.equal(boundary.next[0].number, episode + 1)
    assert.deepEqual(result.contextPatch.input.episode_boundary, boundary)
    assert.equal(result.internetRequest.query.includes(next), false, 'adjacent title must not become a source query')
  }
})

test('saved context code and writer boundary prompt can be refreshed without duplicating their owned section', () => {
  const oldCode = SANGUO_CONTEXT_INIT_CODE.replace(/const neighboringEpisodes = parsed\.rows[\s\S]*?\n}\n/, '')
    .replace("  episode_boundary: episodeBoundary,\n", '')
  assert.equal(refreshSanguoContextBoundaryCode(oldCode), SANGUO_CONTEXT_INIT_CODE)
  assert.equal(refreshSanguoContextBoundaryCode(SANGUO_CONTEXT_INIT_CODE), SANGUO_CONTEXT_INIT_CODE)
  const original = '本集标题：${input.episode_title}\n唯一事实依据（目录、无关篇章不算证据）：\n${historical_sources.citations}'
  const refreshed = refreshEpisodeBoundaryPrompt(original)
  assert.ok(refreshed.includes(EPISODE_BOUNDARY_PROMPT))
  assert.equal(refreshEpisodeBoundaryPrompt(refreshed), refreshed)
  assert.equal(refreshed.split('【策划表分集边界】').length, 2)
})

test('the actual generated 693 scene/beat excerpt is stopped before a paid storyboard because it stages episode 694', async () => {
  const candidate = JSON.parse(await readFile(spilled693Path, 'utf8'))
  const boundary = { version: 'episode-boundary-v1', current: { number: 693, title: '张飞治兵' },
    previous: [{ number: 692, title: '赵云谏征' }],
    next: [{ number: 694, title: '帐下行刺' }, { number: 695, title: '范疆张达' }] }
  assert.throws(() => validateEpisodeNarrativeBoundary(candidate,
    { episode_number: 693, episode_title: '张飞治兵', episode_boundary: boundary }, true),
  /EPISODE_BOUNDARY_SPILL: 第693集《张飞治兵》.*第694集《帐下行刺》/u)
})

test('generated 610 release scene stays in episode 610 and next-row 马超归降 is not conflated with 严颜', async () => {
  const candidate = JSON.parse(await readFile(clean610Path, 'utf8'))
  const boundary = { version: 'episode-boundary-v1', current: { number: 610, title: '张飞释严颜' },
    previous: [{ number: 609, title: '赵云定郡' }], next: [{ number: 611, title: '马超归降' }] }
  assert.doesNotThrow(() => validateEpisodeNarrativeBoundary(candidate,
    { episode_number: 610, episode_title: '张飞释严颜', episode_boundary: boundary }, true))
})

test('a preceding episode can include a source-backed shared setup without enacting a new next-row payoff', () => {
  const boundary = { version: 'episode-boundary-v1', current: { number: 518, title: '张飞据水' },
    previous: [{ number: 517, title: '赵云护主' }], next: [{ number: 519, title: '断桥疑兵' }] }
  const candidate = { characterDramas: [{ name: '张飞' }], scenes: [{ requiredBeats: [{
    description: '张飞据水断桥，持矛喊话；敌军尚在对岸', stateChange: '追兵停在对岸',
    observable: { visual: ['张飞据水断桥'], audio: ['身是张益德也'] },
  }] }] }
  assert.doesNotThrow(() => validateEpisodeNarrativeBoundary(candidate,
    { episode_number: 518, episode_title: '张飞据水', episode_boundary: boundary }, true))
})

test('a historical warning may mention later death, while the current episode only plays its own warning', () => {
  const boundary = { version: 'episode-boundary-v1', current: { number: 693, title: '张飞治兵' },
    previous: [], next: [{ number: 694, title: '帐下行刺' }] }
  const outline = { characterDramas: [{ name: '张飞' }], historicalLocks: [{ fact: '史书还记载张飞遇害' }],
    adaptationSpace: { forbidden: ['不得提前拍张飞遇害'] }, scenes: [{ requiredBeats: [{ description: '刘备劝张飞改变治兵方式',
      stateChange: '张飞听见警告，尚未改变做法', observable: { visual: ['张飞放下鞭子，注视刘备'], audio: ['刘备：你再这样，会被身边人害死。'] } }] }] }
  assert.doesNotThrow(() => validateEpisodeNarrativeBoundary(outline,
    { episode_number: 693, episode_title: '张飞治兵', episode_boundary: boundary }, true))
  assert.throws(() => validateEpisodeNarrativeBoundary(outline, { episode_number: 693, episode_title: '张飞治兵' }, true),
    /EPISODE_BOUNDARY_MISSING/)
  outline.scenes[0].requiredBeats[0].observable.visual.push('张达、范彊在帐中杀死张飞，携首离开')
  assert.throws(() => validateEpisodeNarrativeBoundary(outline,
    { episode_number: 693, episode_title: '张飞治兵', episode_boundary: boundary }, true), /EPISODE_BOUNDARY_SPILL/)
})

test('warning, fear and a conditional future event do not become a staged assassination', () => {
  const input = { episode_number: 693, episode_title: '张飞治兵', episode_boundary: { version: 'episode-boundary-v1',
    current: { number: 693, title: '张飞治兵' }, previous: [], next: [{ number: 694, title: '帐下行刺' }] } }
  const candidate = { characterDramas: [{ name: '张飞' }], episodeDrama: { payoff: { description: '张飞听进警告，但危险尚未消失' } },
    dramaticScenes: [{ result: '刘备担心张飞会遇害，张飞仍须作出选择' }], scenes: [{ requiredBeats: [{
      description: '刘备警告张飞：若继续鞭打又留人在左右，可能遇害。',
      stateChange: '张飞听到有关遇害风险的告诫，尚未答应改变',
      observable: { visual: ['刘备警告张飞不要再这样用人'], audio: ['刘备：我担心你迟早会遇害。'] },
    }] }] }
  assert.doesNotThrow(() => validateEpisodeNarrativeBoundary(candidate, input, true))
  candidate.episodeDrama.payoff.description = '张飞最终被帐下将领杀死，警告应验'
  assert.throws(() => validateEpisodeNarrativeBoundary(candidate, input, true),
    /episodeDrama\.payoff\.description.*第694集《帐下行刺》/u)
})

test('a payoff that explicitly excludes the next event is not treated as performing it', () => {
  const input = { episode_number: 693, episode_title: '张飞治兵', episode_boundary: { version: 'episode-boundary-v1',
    current: { number: 693, title: '张飞治兵' }, previous: [], next: [{ number: 694, title: '帐下行刺' }] } }
  const outline = { characterDramas: [{ name: '张飞' }],
    episodeDrama: { payoff: { description: '刘备说破近身服役的危险，张飞没有立即回应。结尾停在告诫尚未得到明确回答之处，不提前呈现行刺或叛逃。' } },
    scenes: [{ requiredBeats: [{ description: '刘备提醒张飞重罚者仍留身边会招祸',
      stateChange: '张飞听到警告，未答应改变', observable: { visual: ['两人隔案对坐'], audio: ['刘备：这样会招祸。'] } }] }] }
  assert.doesNotThrow(() => validateEpisodeNarrativeBoundary(outline, input, true))
  outline.episodeDrama.payoff.description = '张飞没有立即回应而张达突然行刺，张飞倒下。'
  assert.throws(() => validateEpisodeNarrativeBoundary(outline, input, true),
    /episodeDrama\.payoff\.description.*第694集《帐下行刺》/u)
})

test('a hidden dramatic result or character end state cannot declare the next episode complete', () => {
  const input = { episode_number: 693, episode_title: '张飞治兵', episode_boundary: { version: 'episode-boundary-v1',
    current: { number: 693, title: '张飞治兵' }, previous: [], next: [{ number: 694, title: '帐下行刺' }] } }
  const candidate = { characterDramas: [{ name: '张飞' }], episodeDrama: { payoff: { description: '刘备的警告仍悬而未决' } },
    dramaticScenes: [{ result: '张飞已被帐下将领杀死', characterStates: [{ after: { knowledge: ['张飞仍在治兵'], relationships: [], choices: [] } }] }],
    scenes: [{ requiredBeats: [{ description: '刘备指出危险', stateChange: '张飞听见警告', observable: { visual: ['刘备看着张飞'], audio: [] } }] }] }
  assert.throws(() => validateEpisodeNarrativeBoundary(candidate, input, true), /dramaticScenes\[0\]\.result/)
  candidate.dramaticScenes[0].result = '张飞听见警告，但危险未解'
  candidate.dramaticScenes[0].characterStates[0].after.knowledge[0] = '张飞已经遇害'
  assert.throws(() => validateEpisodeNarrativeBoundary(candidate, input, true),
    /dramaticScenes\[0\]\.characterStates\[0\]\.after\.knowledge\[0\]/)
})
