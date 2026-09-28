import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStoryboardRepairSuffix, collectHistoricalStoryboardDiagnostics, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { generateHistoricalStoryboard, storyboardDiagnostics } from '../src/storyboard-runtime.ts'
import { createDramaGenerationBudget } from '../src/drama-generation-budget.ts'

const anchor = '甲将竹简放下'
const scene = { id: 's1', title: '交还竹简', cast: ['甲'], targetDuration: 3, continuityFromPrevious: false,
  contentContractVersion: 'cinematic-v1', dramaticSceneId: 'd1', settingId: 'room', dramaticUnitId: 'u1', closesUnit: true,
  completionCriteria: ['竹简已放下，甲收回手'], historicalBasis: '[史料1] 归还', adaptationBoundary: '动作调度',
  requiredBeats: [{ id: 'b1', description: '交还竹简', setting: '室内', mustShow: [anchor], function: '回应', stateChange: '甲收回手',
    observable: { visual: [anchor], audio: [] } }] }
const shot = { id: 's1', title: '交还竹简', duration: 3, characters: ['甲'], initialCharacters: ['甲'], enteringCharacters: [], endCharacters: ['甲'],
  contentContractVersion: 'cinematic-v1', dramaticSceneId: 'd1', presentCharacters: ['甲'],
  shotIntent: { viewpointCharacter: '甲', purpose: '交还竹简', cameraReason: '看清归还动作' },
  beatDramaturgy: [{ beatId: 'b1', function: '回应', stateChange: '甲收回手', visual: [anchor], audio: [] }], coveredBeatIds: ['b1'],
  worldState: { settingId: 'room', characters: [{ name: '甲', position: { status: 'unknown' }, heldProps: { status: 'unknown' }, pendingAction: { status: 'unknown' } }] },
  continuity: { previousShotId: '', bridgeType: 'opening', bridgeAnchor: '', mode: 'scene_cut' }, firstFrameMode: 'reference',
  visualPrompt: '甲在室内。', lastFramePrompt: '甲双手收回。', videoPrompt: `0-1秒：${anchor}。1-2.7秒：甲收回手。2.7-3秒：衣袖自然落下。`,
  audioType: '环境声', audioText: '', camera: '固定中景', mood: '平静', historicalBasis: '[史料1] 归还', adaptationBoundary: '动作调度',
  pacing: { version: 'dynamic-v1', actionSeconds: 2.2, reactionSeconds: 0.5,
    activityWindows: [{ kind: 'action', startSecond: 0, endSecond: 2.2 }, { kind: 'reaction', startSecond: 2.2, endSecond: 2.7 }] },
  storyProgress: { unitId: 'u1', status: 'complete', actionResult: '竹简放下', response: '收回手', pendingActions: [] } }
const expected = { scene, qualityDisposition: 'strict-v1', maxGenerationAttempts: 5, requireDramaContract: true, requireDynamicPacing: true, requireContinuityContract: true, requireNarrativeClosure: true }
const longLine = '甲：当今天子为蠡吾侯时，曾受学于吾师周公。如今即位，擢吾师为尚书，实乃师恩之报。同郡河南尹房伯武，亦有名当朝。'
const broken = () => ({ ...structuredClone(shot), audioType: '对白', audioText: longLine,
  videoPrompt: '0-1秒：甲抬起手。1-2.7秒：甲收回手。2.7-3秒：衣袖自然落下。',
  worldState: { settingId: 'room', characters: [{ name: '甲', position: { status: 'unknown', value: '计划门前' }, heldProps: { status: 'unknown' }, pendingAction: { status: 'unknown' } }] },
  pacing: { version: 'dynamic-v1', actionSeconds: 2.2, reactionSeconds: 0,
    activityWindows: [{ kind: 'speech', startSecond: 0, endSecond: 1 }, { kind: 'action', startSecond: 0, endSecond: 2.2 }] },
  storyProgress: { unitId: 'u1', status: 'complete', actionResult: '竹简放下', response: '', pendingActions: [] } })

function freeze(value: unknown) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
}

test('one immutable candidate reports drama, world evidence, narrative, scalar/window budget and an unbound long line together', () => {
  const candidate = broken()
  const before = JSON.stringify(candidate)
  freeze(candidate)
  assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', candidate, expected), /HISTORY_DRAMA_INVALID/)
  const errors = collectHistoricalStoryboardDiagnostics(candidate, expected)
  const joined = errors.join('\n')
  for (const issue of [/仅声明完成/, /STORYBOARD_WORLD_STATE_INVALID:.*unknown/, /STORYBOARD_NARRATIVE_INCOMPLETE:/,
    /reactionSeconds.*0.3/, /speech activityWindows.*11.57/, /连续发声 11.57 秒.*6 秒上限/, /未逐字绑定/]) assert.match(joined, issue)
  assert.equal(new Set(errors).size, errors.length)
  assert.equal(JSON.stringify(candidate), before)
  assert.deepEqual(storyboardDiagnostics(candidate, expected), errors)
})

test('full accepted candidates remain accepted with zero companion diagnostics and unchanged input', () => {
  const candidate = structuredClone(shot)
  const before = JSON.stringify(candidate)
  freeze(candidate)
  assert.doesNotThrow(() => validateHistoricalStructuredOutput('history.storyboard', candidate, expected))
  assert.deepEqual(collectHistoricalStoryboardDiagnostics(candidate, expected), [])
  assert.equal(JSON.stringify(candidate), before)
})

test('invalid prerequisites skip dependent checks without TypeErrors or invented speaker/window facts', () => {
  for (const value of [null, [], 'invalid']) assert.ok(collectHistoricalStoryboardDiagnostics(value, expected).length)
  const candidate = { ...broken(), characters: [null], enteringCharacters: [null],
    pacing: { version: 'dynamic-v1', activityWindows: [null], performanceBeats: [null] } }
  const before = JSON.stringify(candidate)
  const errors = collectHistoricalStoryboardDiagnostics(candidate, expected).join('\n')
  assert.match(errors, /characters 必须/)
  assert.match(errors, /连续发声 11.57 秒/)
  assert.match(errors, /合法的 activityWindows/)
  assert.doesNotMatch(errors, /TypeError|未列入 characters|入场前就开始说话|实际声明 NaN/)
  assert.equal(JSON.stringify(candidate), before)
})

test('continuity remains an obligation even when an earlier drama failure masks it', () => {
  const candidate = { ...broken(), endCharacters: ['不存在者'] }
  assert.match(collectHistoricalStoryboardDiagnostics(candidate, expected).join('\n'), /STORYBOARD_CONTINUITY_INVALID: endCharacters/)
})

test('invalid split allocation still reveals independent speech errors without inventing a smaller scene', () => {
  const candidate = { segments: [{ ...broken(), coveredBeatIds: ['unknown'] }, { ...broken(), id: 's2' }] }
  const before = JSON.stringify(candidate)
  const errors = collectHistoricalStoryboardDiagnostics(candidate, expected).join('\n')
  assert.match(errors, /分段 1:.*连续发声 11.57 秒/)
  assert.match(errors, /分段 2:.*连续发声 11.57 秒/)
  assert.doesNotMatch(errors, /分段 [12]: HISTORY_DRAMA_INVALID:.*仅声明完成/)
  assert.equal(JSON.stringify(candidate), before)
})

test('multiple diagnosed classes receive short parallel recipes without adding an unreported requirement', () => {
  const candidate = broken()
  const diagnostics = collectHistoricalStoryboardDiagnostics(candidate, expected).join('\n')
  const suffix = buildStoryboardRepairSuffix(diagnostics, candidate, '一次修复')
  for (const recipe of ['声画锚点：', '世界状态：', '剧情闭合：', '逐行语音：', '时间预算：', '对白绑定：']) assert.ok(suffix.includes(recipe))
  assert.doesNotMatch(suffix, /身份容量：|连续性：/)
  assert.ok(suffix.endsWith(JSON.stringify(candidate)))
  const single = buildStoryboardRepairSuffix('STORYBOARD_PACING_INVALID: reactionSeconds 无效', candidate, '一次修复')
  assert.match(single, /同步重算pacing.actionSeconds/)
  assert.doesNotMatch(single, /世界状态：|声画锚点：/)
})

test('the next actual repair prompt contains independent diagnostics and acceptance still uses the full validator', async () => {
  const candidate = broken()
  const before = JSON.stringify(candidate)
  const prompts: string[] = []
  const result = await generateHistoricalStoryboard({ prompt: '原批准义务', expected, initialCandidate: candidate,
    generate: async prompt => { prompts.push(prompt); return structuredClone(shot) } })
  assert.equal(prompts.length, 1)
  for (const issue of [/WORLD_STATE_INVALID/, /超过单条口型锚点/, /speech activityWindows/, /NARRATIVE_INCOMPLETE/]) assert.match(prompts[0], issue)
  assert.equal(result.id, shot.id)
  assert.equal(JSON.stringify(candidate), before)
  assert.equal((result.scriptValidation as { passed: boolean }).passed, true)
})

test('repeated independent diagnostics consume exactly the configured five attempts without accepting a partial repair', async () => {
  const attempts: number[] = []
  await assert.rejects(generateHistoricalStoryboard({ prompt: '原批准义务', expected,
    generate: async () => broken(), onAttempt: event => attempts.push(event.attempt) }), /已阻止媒体生成/)
  assert.deepEqual(attempts, Array.from({ length: 5 }, (_, i) => i + 1))
})

test('four identical failures can recover on attempt five while preserving the original obligations', async () => {
  let calls = 0
  const output = await generateHistoricalStoryboard({ prompt: '原批准义务', expected,
    generate: async prompt => {
      calls += 1
      if (calls === 5) assert.match(prompt, /相同缺陷已连续出现 4 轮/)
      return calls === 5 ? structuredClone(shot) : broken()
    } })
  assert.equal(calls, 5)
  assert.deepEqual(output.coveredBeatIds, ['b1'])
  assert.equal((output.scriptValidation as { attempts: unknown[] }).attempts.length, 4)
})

test('ordered beat failure preserves parent and child diagnostics within one five-call writer budget', async () => {
  const budget = createDramaGenerationBudget(undefined, 5)
  const fullScene = { ...scene, requiredBeats: [...scene.requiredBeats, { ...scene.requiredBeats[0], id: 'b2', mustShow: ['甲后退一步'] }] }
  await assert.rejects(generateHistoricalStoryboard({ prompt: '全场原批准义务', expected: { ...expected, scene: fullScene },
    canGenerate: budget.canConsume,
    generate: async () => { budget.consume(); return broken() } }), error => {
      assert.match(String(error), /父场景 s1 已校验 3 次/)
      assert.match(String(error), /父子共享 5 次生成预算/)
      assert.match(String(error), /父场景诊断=.*STORYBOARD_COVERAGE_INCOMPLETE/)
      assert.match(String(error), /分段诊断=.*2 次.*WORLD_STATE_INVALID/)
      return true
    })
  assert.equal(budget.used, 5)
})

test('an explicitly smaller writer limit still bounds repeated diagnostics', async () => {
  let calls = 0
  await assert.rejects(generateHistoricalStoryboard({ prompt: '原批准义务', expected: { ...expected, maxGenerationAttempts: 4 },
    generate: async () => { calls += 1; return broken() } }), /4 次/)
  assert.equal(calls, 4)
})
