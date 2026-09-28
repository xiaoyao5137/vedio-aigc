import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { buildSceneOutlineRepairSuffix } from '../src/workflow-core.ts'
import { outlineKnowledgeRepairInstruction } from '../src/outline-repair-diagnostics.ts'

test('the real third ua0iyt outline receives its exact missing inherited sentence without altering the candidate', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/outline-ua0iyt-attempt3-knowledge.json', import.meta.url), 'utf8'))
  const snapshot = JSON.stringify(fixture.candidate), hash = createHash('sha256').update(snapshot).digest('hex')
  const prompt = buildSceneOutlineRepairSuffix('original approved instructions', fixture.validationMessage, fixture.candidate)
  const detail = prompt.split('【已知信息原文继承对照】\n')[1].split('\n')[0]
  assert.deepEqual(JSON.parse(detail), [{
    path: 'dramaticScenes[3].characterStates[1].after.knowledge', dramaticSceneId: 'drama-04', characterName: '甘陵宾客乙',
    missingBeforeKnowledge: ['鄉人传唱褒贬二人的谣谚'],
    existingAfterKnowledge: ['房植为河南尹有名当朝', '周福因曾为桓帝师而得尚书之位', '鄉里传唱褒贬二人的谣谚',
      '周福门下宾客不认同谣谚对房植的评价', '甘陵已分为南北两部'],
  }])
  assert.match(prompt, /逐条恢复列出的原句，并保留本场实际新增知识/)
  assert.match(prompt, /不能删除或改写 before 来消除报错/)
  assert.match(prompt, /未被点名的正文、台词、人物、场景和其他状态保持原样/)
  assert.deepEqual(JSON.parse(prompt.split('【上一版未通过的 JSON】\n').at(-1)!), fixture.candidate)
  assert.equal(createHash('sha256').update(JSON.stringify(fixture.candidate)).digest('hex'), hash)
})

test('knowledge diagnostics enumerate only named fields with exact missing strings and preserve new facts', () => {
  const candidate = { dramaticScenes: [{ id: 'unrelated-drama-id', characterStates: [
    { name: '人物一', before: { knowledge: ['旧事实A', '旧事实B'] }, after: { knowledge: ['旧事实A', '旧事实B的改写', '新事实C'] } },
    { name: '人物二', before: { knowledge: ['旧事实D'] }, after: { knowledge: ['新事实E'] } },
  ] }] }
  const snapshot = structuredClone(candidate)
  const message = 'HISTORY_DRAMA_INVALID: 一.after 不得无故遗忘已知信息（字段 dramaticScenes[0].characterStates[0].after.knowledge）'
  const first = outlineKnowledgeRepairInstruction(message, candidate)
  const detail = JSON.parse(first.split('【已知信息原文继承对照】\n')[1].split('\n')[0])
  assert.equal(detail.length, 1)
  assert.deepEqual(detail[0].missingBeforeKnowledge, ['旧事实B'])
  assert.deepEqual(detail[0].existingAfterKnowledge, ['旧事实A', '旧事实B的改写', '新事实C'])
  const secondMessage = '\n二.after 不得无故遗忘已知信息（字段 dramaticScenes[0].characterStates[1].after.knowledge）'
  const all = outlineKnowledgeRepairInstruction(message + secondMessage + '\n' + message, candidate)
  const allDetails = JSON.parse(all.split('【已知信息原文继承对照】\n')[1].split('\n')[0])
  assert.equal(allDetails.length, 2)
  assert.deepEqual(allDetails[1].missingBeforeKnowledge, ['旧事实D'])
  assert.deepEqual(candidate, snapshot)
})

test('unrelated errors, stale paths and malformed knowledge cannot invent targeted edit instructions', () => {
  const candidate = { dramaticScenes: [{ characterStates: [{ before: { knowledge: ['原句'] }, after: { knowledge: ['原句'] } }] }] }
  const message = '不得无故遗忘已知信息（字段 dramaticScenes[0].characterStates[0].after.knowledge）'
  assert.equal(outlineKnowledgeRepairInstruction(message, candidate), '')
  assert.equal(outlineKnowledgeRepairInstruction(message.replace('[0]', '[99]'), candidate), '')
  assert.equal(outlineKnowledgeRepairInstruction('其他字段缺失', candidate), '')
  assert.equal(outlineKnowledgeRepairInstruction(message, { dramaticScenes: [{ characterStates: [{ before: { knowledge: [1] }, after: { knowledge: [] } }] }] }), '')
  assert.equal(outlineKnowledgeRepairInstruction(message, null), '')
})
