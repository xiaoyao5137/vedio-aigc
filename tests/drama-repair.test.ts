import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { applyScopedDramaRepair, attachDramaRepairProvenance, dramaRepairProvenance } from '../src/drama-repair.ts'
import { validateHistoricalStructuredOutput } from '../src/workflow-core.ts'

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/cinematic-drama-outline.json', import.meta.url), 'utf8'))
test('local drama repair retains unrelated scenes, historical locks and approved sound/image obligations', () => {
  const original = fixture(), candidate = fixture()
  candidate.scenes[0].purpose = '追问未被回应，继续等待对方明确态度'
  candidate.scenes.at(-1).purpose = '模型试图改写另一场戏'
  candidate.historicalLocks = []
  const feedback = { scope: 'scene', previousCandidate: original, issues: [{ itemId: original.scenes[0].id }] }
  const result = applyScopedDramaRepair(candidate, feedback, { approved_scene_outline: original }) as ReturnType<typeof JSON.parse>
  assert.equal(result.scenes[0].purpose, candidate.scenes[0].purpose)
  assert.equal(result.scenes.at(-1).purpose, original.scenes.at(-1).purpose)
  assert.deepEqual(result.historicalLocks, original.historicalLocks)
  assert.deepEqual(original, fixture())
  candidate.scenes[0].requiredBeats[0].observable = { visual: [], audio: [] }
  assert.throws(() => applyScopedDramaRepair(candidate, feedback, { approved_scene_outline: original }), /声画义务/)
})
test('episode repair has an executor-owned one-rewrite budget and stable version lineage', () => {
  const first = attachDramaRepairProvenance(fixture(), undefined) as ReturnType<typeof JSON.parse>
  assert.equal(first.repairProvenance.candidateVersion, 1)
  const feedback = { scope: 'episode', previousCandidate: first, episodeRewriteCount: 1, candidateVersion: 2, parentCandidateVersion: 1 }
  const fixed = applyScopedDramaRepair(fixture(), feedback)
  const second = attachDramaRepairProvenance(fixed, feedback) as ReturnType<typeof JSON.parse>
  assert.equal(second.repairProvenance.candidateVersion, 2)
  assert.equal(second.repairProvenance.parentCandidateVersion, 1)
  assert.equal(second.repairProvenance.episodeRewriteCount, 1)
  assert.throws(() => dramaRepairProvenance({ ...feedback, episodeRewriteCount: 2 }), /DRAMA_REPAIR_LIMIT/)
  assert.throws(() => applyScopedDramaRepair({ ...fixture(), historicalLocks: [] }, feedback, { approved_scene_outline: fixture() }), /不得改写已锁定史实/)
  assert.throws(() => applyScopedDramaRepair(fixture(), feedback, { video_take: { url: 'existing.mp4' } }), /已有媒体/)
  const injected = { ...fixture(), repairProvenance: { episodeRewriteCount: 0 } }
  assert.throws(() => validateHistoricalStructuredOutput('history.scene-outline', injected, { requireDramaContract: true }), /repairProvenance/)
})

test('unapproved factual mistakes can be corrected locally without preserving the rejected action as an obligation', () => {
  const original = fixture(), candidate = fixture()
  original.scenes[0].requiredBeats[0].description = '周福召集宾客结交朋徒'
  original.scenes[0].requiredBeats[0].observable.visual = ['周福召集宾客结交朋徒']
  original.historicalLocks[1].fact = '周福授意宾客各树朋徒。'
  original.characterDramas[0].goal = '遵从周福授意结党'
  const unrelatedLock = { id: 'fact-unrelated', fact: '另一州的边界治理另有独立史事。', sourceRefs: ['[史料1]'] }
  original.historicalLocks.push(unrelatedLock)
  candidate.historicalLocks.push({ ...unrelatedLock, fact: '模型顺便改写无关史事' })
  candidate.scenes.at(-1).purpose = '偷偷把无关后果场改成密谋'
  candidate.dramaticScenes.at(-1).tactics = '偷偷重写后果戏'
  const feedback = { scope: 'scene', previousCandidate: original, issues: [{ itemId: original.scenes[0].id,
    problem: '宾客互相讥揣不能改成周福授意', repair: '恢复宾客自主行动' }] }
  const result = applyScopedDramaRepair(candidate, feedback) as ReturnType<typeof JSON.parse>
  assert.deepEqual(result.scenes[0].requiredBeats, fixture().scenes[0].requiredBeats)
  assert.deepEqual(result.scenes.at(-1), original.scenes.at(-1))
  assert.equal(result.dramaticScenes.at(-1).tactics, original.dramaticScenes.at(-1).tactics)
  assert.equal(result.historicalLocks[1].fact, fixture().historicalLocks[1].fact)
  assert.deepEqual(result.historicalLocks.find((lock: { id: string }) => lock.id === 'fact-unrelated'), unrelatedLock)
  assert.equal(result.characterDramas[0].goal, fixture().characterDramas[0].goal)
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.scene-outline', result, { requireDramaContract: true, requireBeatCoverage: true, requireNarrativeClosure: true }))
  assert.equal(original.historicalLocks[1].fact, '周福授意宾客各树朋徒。', 'the rejected draft remains immutable evidence')
})

test('corrected inherited knowledge propagates through later states while their scenes, actions and unrelated characters remain unchanged', () => {
  const original = fixture(), candidate = fixture()
  const extra = { ...structuredClone(original.characterDramas[1]), name: '史官', goal: '整理已核实的事实' }
  original.characterDramas.push(extra)
  candidate.characterDramas.push({ ...extra, goal: '模型擅自改写无关人物' })
  original.characterDramas[0].initialState.knowledge = ['周福授意结党']
  for (const drama of original.dramaticScenes) for (const key of ['before', 'after']) {
    drama.characterStates[0][key].knowledge = drama.characterStates[0][key].knowledge.map((fact: string) => fact === '周福曾为帝师' ? '周福授意结党' : fact)
  }
  candidate.scenes[3].requiredBeats[0].observable.visual = ['模型擅自重写后果动作']
  const feedback = { scope: 'scene', previousCandidate: original, issues: [{ itemId: 'scene-01', problem: '人物不应知道从未发生的授意', repair: '恢复有依据的既有知识' }] }
  const result = applyScopedDramaRepair(candidate, feedback) as ReturnType<typeof JSON.parse>
  assert.deepEqual(result.scenes[3], original.scenes[3])
  assert.deepEqual(result.characterDramas.find((person: { name: string }) => person.name === '史官'), extra)
  assert.deepEqual(result.dramaticScenes[1].characterStates[0], fixture().dramaticScenes[1].characterStates[0])
  assert.deepEqual(result.dramaticScenes[1].characterStates[1], original.dramaticScenes[1].characterStates[1])
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.scene-outline', result, { requireDramaContract: true }))
})

test("a repair may echo the user's boundary with its own punctuation but cannot rewrite it", () => {
  const original = fixture(), candidate = fixture()
  // Same words, different glyphs and key order: what an outline writer actually returns.
  candidate.adaptationSpace = {
    sourceLevel: `${original.adaptationSpace.sourceLevel}。`,
    forbidden: [...original.adaptationSpace.forbidden, '不得新增史料之外的具名人物'],
    allowed: [...original.adaptationSpace.allowed, '宾客在街市相遇的具体地点'],
    policy: `${String(original.adaptationSpace.policy).replace('，', ',')}.`,
  }
  const feedback = { scope: 'scene', previousCandidate: original, issues: [{ itemId: original.scenes[0].id }] }
  const local = applyScopedDramaRepair(candidate, feedback, { approved_scene_outline: original }) as ReturnType<typeof JSON.parse>
  assert.deepEqual(local.adaptationSpace, original.adaptationSpace, '局部修复保留已批准边界')
  const episode = applyScopedDramaRepair(candidate, { ...feedback, scope: 'episode' }) as ReturnType<typeof JSON.parse>
  assert.equal(episode.adaptationSpace.policy, original.adaptationSpace.policy, '书写形式回声以可信输入修正')
  assert.deepEqual(episode.adaptationSpace.forbidden, candidate.adaptationSpace.forbidden, '审稿要求补充的禁止项不得被丢弃')
})

test('episode corrections before approval may fix false locks but cannot change user policy or spend a second rewrite', () => {
  const original = fixture(), corrected = fixture()
  original.historicalLocks[1].fact = '周福授意宾客组织党争'
  const feedback = { scope: 'episode', previousCandidate: original, episodeRewriteCount: 1 }
  const result = applyScopedDramaRepair(corrected, feedback) as ReturnType<typeof JSON.parse>
  assert.equal(result.historicalLocks[1].fact, corrected.historicalLocks[1].fact)
  assert.throws(() => applyScopedDramaRepair({ ...corrected, adaptationSpace: { ...corrected.adaptationSpace, policy: '允许改编核心政治动机' } }, feedback), /用户改编边界/)
  assert.throws(() => applyScopedDramaRepair(corrected, { ...feedback, episodeRewriteCount: 2 }), /DRAMA_REPAIR_LIMIT/)
})

test('after approval a rejected shot may be repaired but cannot drop the approved beat', () => {
  const outline = fixture(), scene = outline.scenes[0]
  const original = { id: scene.id, contentContractVersion: 'cinematic-v1', dramaticSceneId: scene.dramaticSceneId,
    beatDramaturgy: scene.requiredBeats.map((beat: ReturnType<typeof JSON.parse>) => ({ beatId: beat.id, ...beat.observable })) }
  const feedback = { scope: 'scene', previousCandidate: original, issues: [{ itemId: original.id }] }
  assert.doesNotThrow(() => applyScopedDramaRepair({ ...original, videoPrompt: '修正前版的错误动作' }, feedback, { approved_scene_outline: outline, scene }))
  assert.throws(() => applyScopedDramaRepair({ ...original, beatDramaturgy: [] }, feedback, { approved_scene_outline: outline, scene }), /已批准节拍/)
})

test('a local repair missing a required character state names the broader scope instead of retrying the same impossible merge', () => {
  const original = fixture(), candidate = fixture()
  candidate.dramaticScenes[0].characterStates[0].name = '没有小传的新角色'
  assert.throws(() => applyScopedDramaRepair(candidate, { scope: 'scene', previousCandidate: original, issues: [{ itemId: 'scene-01' }] }), /HISTORY_REPAIR_SCOPE_REQUIRED:.*episode/)
})
