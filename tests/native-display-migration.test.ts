import test from 'node:test'
import assert from 'node:assert/strict'
import { upgradeNativeDisplayEvidenceScope, REQUIREMENT_REVIEW_METRICS_CODE, INDEPENDENT_MEDIA_REVIEW_VIEW_CODE,
  ADAPTIVE_MEDIA_REVIEW_GUARD_CODE, COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE, NATIVE_MEDIA_OBSERVATION_GUARD_CODE } from '../src/quality-node-presets.ts'
import { REQUIREMENT_MEDIA_REVIEW_PROMPT } from '../src/media-requirement-review.ts'
import { SANGUO_CINEMATIC_STORYBOARD_PROMPT, SANGUO_STORYBOARD_PROMPT_BEFORE_AUDIO_LINE_BINDING, SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE } from '../src/storyboard-prompt.ts'
import { SANGUO_STORYBOARD_PROMPT_BEFORE_DISPLAY_TIMING } from '../src/legacy-storyboard-timing-prompt.ts'

const node = (id: string, kind = 'code') => ({ id, kind, prompt: '', code: '', resultVar: id, modelId: 'saved-model',
  params: [{ id: 'user', name: 'user', englishName: 'user', value: 'retain', type: 'text', required: false }],
  uploads: [], position: { x: 1, y: 2 }, loop: { enabled: false, sourcePath: '', fallbackCount: 1, itemVar: 'item' } })
const fixture = () => ({ id: 'wf-sanguo-history-drama', schemaVersion: 110, nodes: [
  { ...node('sanguo-media-metrics'), code: '// before-metrics\n' + REQUIREMENT_REVIEW_METRICS_CODE + '\n// after-metrics' },
  { ...node('sanguo-media-accept'), code: '// before-gate\n' + INDEPENDENT_MEDIA_REVIEW_VIEW_CODE + '\n'
    + ADAPTIVE_MEDIA_REVIEW_GUARD_CODE + '\n' + COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE + '\n'
    + NATIVE_MEDIA_OBSERVATION_GUARD_CODE + '\n// after-gate' },
  { ...node('sanguo-requirement-review', 'text'), prompt: '用户前缀\n' + REQUIREMENT_MEDIA_REVIEW_PROMPT + '\n用户后缀' },
  { ...node('sanguo-video', 'video'), prompt: '已保存生成参数与原文' },
  { ...node('sanguo-media-review', 'text'), prompt: '已保存综合审核参数与原文' },
  { ...node('sanguo-shot-script', 'text'), prompt: '导演用户前缀\n' + SANGUO_STORYBOARD_PROMPT_BEFORE_DISPLAY_TIMING + '\n导演用户后缀' },
], edges: [{ id: 'keep', from: 'sanguo-video', to: 'sanguo-media-accept' }] })

test('display-scope migration updates all managed consumers together without changing paid or policy configuration', () => {
  const source = fixture(), before = structuredClone(source), next = upgradeNativeDisplayEvidenceScope(source)
  assert.equal(next.schemaVersion, 111)
  assert.deepEqual(source, before)
  assert.equal(next.edges, source.edges)
  assert.equal(upgradeNativeDisplayEvidenceScope(next), next)
  for (const [index, original] of source.nodes.entries()) {
    assert.equal(next.nodes[index].params, original.params)
    assert.equal(next.nodes[index].modelId, original.modelId)
  }
  assert.equal(next.nodes[3], source.nodes[3])
  assert.equal(next.nodes[4], source.nodes[4])
  assert.ok(next.nodes[0].code.startsWith('// before-metrics\n'))
  assert.ok(next.nodes[0].code.endsWith('// after-metrics'))
  assert.ok(next.nodes[1].code.startsWith('// before-gate\n'))
  assert.ok(next.nodes[1].code.endsWith('// after-gate'))
  assert.equal(next.nodes[2].prompt, '用户前缀\n' + REQUIREMENT_MEDIA_REVIEW_PROMPT + '\n用户后缀')
  assert.equal(next.nodes[5].prompt, '导演用户前缀\n' + SANGUO_CINEMATIC_STORYBOARD_PROMPT + '\n导演用户后缀')
  assert.match(next.nodes[0].code, /const resolveNativeFrameDisplayInterval =/)
  assert.equal((next.nodes[1].code.match(/const resolveNativeFrameDisplayInterval =/g) ?? []).length, 3)
})

test('display-scope migration refuses missing or duplicate managed blocks and other workflow identities', () => {
  for (const [index, text] of [[0, REQUIREMENT_REVIEW_METRICS_CODE], [1, INDEPENDENT_MEDIA_REVIEW_VIEW_CODE],
    [1, ADAPTIVE_MEDIA_REVIEW_GUARD_CODE], [1, COMPLETE_MEDIA_DEFECT_EVIDENCE_CODE]] as const) {
    for (const duplicate of [false, true]) {
      const source = fixture()
      source.nodes[index].code = duplicate ? source.nodes[index].code + '\n' + text : source.nodes[index].code.replace(text, '// user-owned')
      assert.equal(upgradeNativeDisplayEvidenceScope(source), source)
    }
  }
  for (const schemaVersion of [109, 111, 112]) {
    const source = { ...fixture(), schemaVersion }
    assert.equal(upgradeNativeDisplayEvidenceScope(source), source)
  }
  const other = { ...fixture(), id: 'custom-workflow' }
  assert.equal(upgradeNativeDisplayEvidenceScope(other), other)
})

test('writer timing migration requires one exact managed body and retains user-owned edits', () => {
  for (const prompt of ['用户自定义分镜提示', SANGUO_STORYBOARD_PROMPT_BEFORE_DISPLAY_TIMING + SANGUO_STORYBOARD_PROMPT_BEFORE_DISPLAY_TIMING,
    SANGUO_STORYBOARD_PROMPT_BEFORE_DISPLAY_TIMING.replace('时间与声音：', '用户自定义时间合约：')]) {
    const source = fixture(); source.nodes[5].prompt = prompt
    assert.equal(upgradeNativeDisplayEvidenceScope(source), source)
  }
  const current = fixture(); current.nodes[5].prompt = SANGUO_CINEMATIC_STORYBOARD_PROMPT
  assert.equal(upgradeNativeDisplayEvidenceScope(current).schemaVersion, 111)
})


test('schema111 recognizes the deployed 5994-character writer before the later audio-clause migration', () => {
  const source = fixture()
  source.nodes[5].prompt = '导演前缀\n' + SANGUO_STORYBOARD_PROMPT_BEFORE_AUDIO_LINE_BINDING + '\n导演后缀'
  const next = upgradeNativeDisplayEvidenceScope(source)
  assert.equal(next.schemaVersion, 111)
  assert.equal(next.nodes[5].prompt, source.nodes[5].prompt)
  const duplicate = fixture()
  duplicate.nodes[5].prompt = SANGUO_STORYBOARD_PROMPT_BEFORE_AUDIO_LINE_BINDING + SANGUO_CINEMATIC_STORYBOARD_PROMPT
  assert.equal(upgradeNativeDisplayEvidenceScope(duplicate), duplicate)
})

test('schema111 also recognizes the frozen deployed audio-bound writer while preserving its original state clauses', () => {
  const source = fixture()
  source.nodes[5].prompt = '导演前缀\n' + SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE + '\n导演后缀'
  const next = upgradeNativeDisplayEvidenceScope(source)
  assert.equal(next.schemaVersion, 111)
  assert.equal(next.nodes[5].prompt, source.nodes[5].prompt)
  const duplicate = fixture()
  duplicate.nodes[5].prompt = source.nodes[5].prompt + SANGUO_CINEMATIC_STORYBOARD_PROMPT
  assert.equal(upgradeNativeDisplayEvidenceScope(duplicate), duplicate)
})
