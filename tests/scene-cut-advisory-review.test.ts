import test from 'node:test'
import assert from 'node:assert/strict'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V186 } from '../src/scene-cut-advisory-review.ts'
import { validateSceneCutT0ImageContract } from '../src/scene-cut-t0-image-contract.ts'

const shot = { visualPrompt: '无可读文字的院落全身镜头', camera: '全身全景',
  pacing: { beats: [], schedule: [] } }
const review = { passed: true, requiredVisualActionChecks: [],
  readableTextCheck: { applicable: true, backgroundInspected: true,
    readableGlyphsPresent: true, actualReadableTextPresent: false,
    pixelEvidence: '墙纹有不可转录的装饰笔画，没有实际可读文字' },
  wardrobeHemCheck: { applicable: true, matches: false,
    originalHemAndFootwear: '长袍及靴', candidateHemAndFootwear: '同层长袍较长及靴' } }

test('visual polish is advisory while readable text remains blocking', () => {
  assert.match(SCENE_CUT_FRAME_REVIEW_PROMPT_V186, /advisoryIssues/)
  assert.match(SCENE_CUT_FRAME_REVIEW_PROMPT_V186, /到目标方向有可见开放路径/)
  assert.throws(() => validateSceneCutT0ImageContract(review, shot), /画面无字/)
  assert.equal(validateSceneCutT0ImageContract(review, shot,
    { visualDetailsAdvisory: true }), true)
  assert.throws(() => validateSceneCutT0ImageContract({ ...review,
    readableTextCheck: { ...review.readableTextCheck, actualReadableTextPresent: true } },
  shot, { visualDetailsAdvisory: true }), /画面无字/)
})
