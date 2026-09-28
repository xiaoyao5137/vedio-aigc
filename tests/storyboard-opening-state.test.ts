import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateCinematicShot } from '../src/history-cinema.ts'
import { generateHistoricalStoryboard, storyboardContinuityContext } from '../src/storyboard-runtime.ts'
import { SANGUO_CINEMATIC_STORYBOARD_PROMPT } from '../src/storyboard-prompt.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { DEFAULT_DURATION_POLICY } from '../src/duration-policy.ts'

const fixture = () => {
  const value = JSON.parse(readFileSync(new URL('./fixtures/storyboard-opening-state-failure.json', import.meta.url), 'utf8'))
  value.candidate.pacing.timingPolicy = DEFAULT_DURATION_POLICY
  return value
}

test('the actual principle continuation renders its canonical unknown JSON instead of a nonexistent media field', () => {
  const data = fixture(), before = structuredClone(data)
  const context = storyboardContinuityContext(data.inputContext) as typeof data.inputContext
  const previous = context.loop.previous
  assert.equal(previous.video_shot.worldState, undefined)
  assert.equal(previous.video_shot.visualReview.worldState, undefined)
  const state = previous.shot_script.worldState
  assert.deepEqual(state.characters[0], { name: '房植门生', position: { status: 'unknown' }, heldProps: { status: 'unknown' }, pendingAction: { status: 'unknown' } })
  const prompt = renderWorkflowTemplate(SANGUO_CINEMATIC_STORYBOARD_PROMPT, context)
  assert.ok(prompt.includes('上一镜开场继承用的可信世界状态（unknown不是已采证事实）：' + JSON.stringify(state)))
  assert.match(prompt, /不得凭附件图片、尾帧描述或拟拍动作升级为observed/)
  assert.doesNotMatch(SANGUO_CINEMATIC_STORYBOARD_PROMPT, /video_shot\.worldState/)
  assert.deepEqual(data, before, 'rendering preserves the saved original input and all author candidates')
})

test('saved failed nodes receive the canonical state and deterministic local repair on the first execution', async () => {
  const data = fixture(), before = structuredClone(data)
  const context = storyboardContinuityContext(data.inputContext) as typeof data.inputContext
  const previous = context.loop.previous.shot_script, state = previous.worldState
  const oldSavedPrompt = renderWorkflowTemplate('保存的旧节点。上一镜已采证世界状态：${loop.previous.video_shot.worldState}', context)
  assert.equal(oldSavedPrompt, '保存的旧节点。上一镜已采证世界状态：')
  const prompts: string[] = []
  const result = await generateHistoricalStoryboard({ prompt: oldSavedPrompt,
    expected: { qualityMode: 'principle-v1', maxGenerationAttempts: 2, pacingVersion: 'duration-v2',
      scene: context.scene, previousShot: previous, requireContinuityContract: true, requireDynamicPacing: true, requireNarrativeClosure: true, requireDramaContract: true },
    generate: async prompt => {
      prompts.push(prompt)
      assert.ok(prompt.includes('【权威开场继承状态】以下JSON与本次校验使用同一份前镜可信投影：' + JSON.stringify(state)))
      assert.match(prompt, /unknown字段按该JSON原样继承.*\{"status":"unknown"\}.*不得从附件图像、尾帧文字描述或本镜拟拍动作升级为observed/)
      assert.match(prompt, /【原则模式实际尾帧续拍】.*visualPrompt可追加与实际尾帧一致的场景及机位说明/)
      assert.ok(prompt.indexOf('【权威开场继承状态】') > prompt.indexOf('【本次分镜覆盖范围】'))
      return structuredClone(data.candidate)
    },
  })
  assert.equal(prompts.length, 1)
  assert.deepEqual(result.worldState, state)
  assert.deepEqual(data, before)
})

test('all four actual author states remain rejected and identify the exact inherited and supplied field values', () => {
  const data = fixture(), before = structuredClone(data)
  const context = storyboardContinuityContext(data.inputContext) as typeof data.inputContext
  const previous = context.loop.previous.shot_script
  for (const state of data.candidateWorldStates) {
    assert.throws(() => validateCinematicShot({ ...data.candidate, worldState: state }, context.scene, previous), error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /field=worldState.房植门生.position；expected=\{"status":"unknown"\}/)
      assert.ok(error.message.includes('candidate=' + JSON.stringify(state.characters[0].position)))
      return true
    })
  }
  assert.deepEqual(data, before, 'diagnostics do not erase the conflicting author observations')
})

test('known positions, props and actions cannot move, lose evidence or be downgraded to unknown', () => {
  const data = fixture(), context = storyboardContinuityContext(data.inputContext) as typeof data.inputContext
  const previous = structuredClone(context.loop.previous.shot_script)
  for (const field of ['position', 'heldProps', 'pendingAction']) {
    const known = { status: 'observed', value: '街道中央，与摊位相邻', evidence: '实际尾帧已确认的原证据' }
    previous.worldState.characters[0][field] = known
    const current = { ...data.candidate, worldState: structuredClone(previous.worldState) }
    assert.doesNotThrow(() => validateCinematicShot(current, context.scene, previous))
    for (const conflict of [{ ...known, value: '远处院门内' }, { ...known, evidence: '自行重述的证据' }, { status: 'unknown' }]) {
      current.worldState.characters[0][field] = conflict
      assert.throws(() => validateCinematicShot(current, context.scene, previous), error => {
        assert.ok(error instanceof Error)
        assert.ok(error.message.includes(`field=worldState.房植门生.${field}；expected=${JSON.stringify(known)}；candidate=${JSON.stringify(conflict)}`))
        return true
      })
    }
  }
})

test('the real cinematic tail candidate may append scene and camera prose only with explicit principle policy and trusted actual-tail projection', () => {
  const data = fixture(), context = storyboardContinuityContext(data.inputContext) as typeof data.inputContext
  const previous = context.loop.previous.shot_script
  // A hypothetical author repair changes only the incorrect metadata. The
  // actual visual/action prose and all source obligations remain untouched.
  const candidate = { ...structuredClone(data.candidate), worldState: structuredClone(previous.worldState) }
  const before = structuredClone(candidate)
  const expected = { qualityMode: 'principle-v1', pacingVersion: 'duration-v2', scene: context.scene, previousShot: previous,
    requireContinuityContract: true, requireDynamicPacing: true, requireNarrativeClosure: true, requireDramaContract: true }
  assert.ok(candidate.visualPrompt.startsWith(previous.lastFramePrompt))
  assert.notEqual(candidate.visualPrompt, previous.lastFramePrompt)
  const accepted = validateHistoricalStructuredOutput('history.storyboard', candidate, expected) as typeof candidate
  assert.equal(accepted.visualPrompt, candidate.visualPrompt)
  assert.deepEqual(accepted.worldState, candidate.worldState)
  assert.deepEqual(candidate, before, 'the boundary validates without rewriting author prose or opening state')
  for (const mode of [undefined, 'strict', 'principle-v2']) {
    assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', candidate, { ...expected, qualityMode: mode }), /visualPrompt 必须原样复制/)
  }
  for (const evidence of [undefined, { method: 'actual-tail-image', frame: previous.worldStateEvidence.frame },
    { ...previous.worldStateEvidence, method: 'planned-tail' }, { ...previous.worldStateEvidence, frame: '/planned-tail.jpg' }]) {
    assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', candidate, { ...expected,
      previousShot: { ...previous, worldStateEvidence: evidence } }), /visualPrompt 必须原样复制/)
  }
  for (const [change, error] of [
    [{ continuity: { ...candidate.continuity, previousShotId: 'wrong-shot' } }, /连续模式必须指向前镜|previousShotId/],
    [{ continuity: { ...candidate.continuity, bridgeType: 'cut' } }, /bridgeType 必须为 same_frame/],
    [{ worldState: { ...candidate.worldState, settingId: 'another-location' } }, /settingId/],
    [{ initialCharacters: [] }, /initialCharacters|未声明为初始人物/],
    [{ presentCharacters: [] }, /presentCharacters|在场人物/],
    [{ worldState: data.candidate.worldState }, /开场状态改变或冒充已观察/],
  ] as Array<[Record<string, unknown>, RegExp]>) {
    assert.throws(() => validateHistoricalStructuredOutput('history.storyboard', { ...candidate, ...change }, expected), error)
  }
})
