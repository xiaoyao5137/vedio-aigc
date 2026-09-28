import test from 'node:test'
import assert from 'node:assert/strict'
import { CANONICAL_MEDIA_REVIEW_PROMPT, isCanonicalMediaReviewPrompt } from '../src/canonical-media-review.ts'
import { refreshCinematicMediaImageReview } from '../src/quality-node-presets.ts'
import { refreshMediaAttributionReviewPrompt, refreshMediaDetailReviewPrompt, refreshIndependentMediaReviewPrompt } from '../src/media-observation.ts'
import { refreshMediaDefectEvidencePrompt, refreshScopedMediaDefectPrompt } from '../src/media-defect-evidence.ts'

test('legacy media prompt refreshers recognize a complete canonical contract without appending their old rules', () => {
  assert.equal(isCanonicalMediaReviewPrompt(CANONICAL_MEDIA_REVIEW_PROMPT), true)
  assert.equal(isCanonicalMediaReviewPrompt('【独立成片验收完整契约 v1】'), false, '未完成标记不应绕过旧刷新')
  for (const refresh of [refreshMediaAttributionReviewPrompt, refreshMediaDetailReviewPrompt, refreshIndependentMediaReviewPrompt, refreshMediaDefectEvidencePrompt, refreshScopedMediaDefectPrompt]) {
    assert.equal(refresh(CANONICAL_MEDIA_REVIEW_PROMPT), CANONICAL_MEDIA_REVIEW_PROMPT)
  }
  assert.notEqual(refreshMediaAttributionReviewPrompt('旧提示词'), '旧提示词')
  assert.notEqual(refreshMediaDetailReviewPrompt('旧提示词'), '旧提示词')
  assert.notEqual(refreshMediaDefectEvidencePrompt('旧提示词'), '旧提示词')
  assert.notEqual(refreshScopedMediaDefectPrompt('旧提示词'), '旧提示词')
  assert.ok(!refreshIndependentMediaReviewPrompt(CANONICAL_MEDIA_REVIEW_PROMPT + '\n旧插槽：${media_observations.items}').includes('${media_observations'),
    '完整契约后误挂观察插槽仍须清除，不能由canonical标记绕过独立证据投影')
})

test('canonical image review remains idempotent and preserves the existing attachment parameter position and custom parameters', () => {
  const parameter = (name: string, value: string, type = 'json') => ({ id: name, name, englishName: name, value, type, required: true })
  const node = { id: 'sanguo-media-review', title: '成片审查', kind: 'text', resultVar: 'media_review', prompt: CANONICAL_MEDIA_REVIEW_PROMPT,
    modelId: 'configured-reviewer', operation: 'history.media-review', params: [parameter('temperature', '0', 'number'),
      parameter('reviewImages', '${video_evidence.frames}'), parameter('customRule', '保留此配置', 'text'), parameter('reviewImageDetail', '{"indices":[0]}')],
    uploads: [], loop: { enabled: false, sourcePath: '', fallbackCount: 1, itemVar: 'item' }, position: { x: 0, y: 0 } }
  const original = structuredClone(node)
  assert.equal(refreshCinematicMediaImageReview(node), node)
  assert.equal(refreshCinematicMediaImageReview(refreshCinematicMediaImageReview(node)), node)
  assert.deepEqual(node, original)
  const missingImages = { ...node, params: node.params.filter(param => param.englishName !== 'reviewImages') }
  const repaired = refreshCinematicMediaImageReview(missingImages)
  assert.equal(repaired.prompt, CANONICAL_MEDIA_REVIEW_PROMPT, '必要图片配置补齐也不重贴旧prompt')
  assert.equal(repaired.params.filter(param => param.englishName === 'reviewImages').length, 1)
  assert.equal(repaired.params.find(param => param.englishName === 'reviewImages')?.value, '${video_evidence.frames}')
  assert.equal(refreshCinematicMediaImageReview(repaired), repaired)
})
