import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyScene2BeforePaidVideo } from '../scripts/verify-staged-scene2-image-gate.mjs'

const originalMd5 = '74e5e2f8afcf8f829694aef350629950'
const firstMd5 = 'a'.repeat(32)

function fixture() {
  const runs = Array.from({ length: 464 }, () => ({ node: { id: 'idle' }, status: 'idle' }))
  for (let i = 65; i < 108; i++) runs[i] = { node: { id: 'skipped' }, status: 'skipped' }
  runs[67] = { node: { id: 'sanguo-shot-script-accept' }, status: 'success', output: {} }
  runs[80] = { node: { id: 'sanguo-character-archive' }, status: 'success',
    output: { voiceAssets: [{ characterName: '张飞', videoBinding: { modelId: 'keling3',
      voiceId: '933124714380816393' } }] } }
  runs[106] = { node: { id: 'sanguo-scene-cut-approval' }, status: 'success', output: {} }
  runs[108] = { node: { id: 'sanguo-video' }, status: 'idle' }
  const first = { id: 'record-first', result_md5: firstMd5,
    workflow_id: 'wf-sanguo-history-drama', result: {} }
  const second = { id: 'record-second', result_md5: 'b'.repeat(32),
    workflow_id: first.workflow_id, result: { parentExecutionId: first.id,
      secondShotReplayRecovery: { sourceExecutionId: first.id,
        sourceResultMd5: firstMd5, originalExecutionId: 'record-4x5m31',
        originalResultMd5: originalMd5 }, nodeRuns: runs } }
  const prepared = { status: 'ready-for-new-image-review-only', scene2Accepted: false,
    plan: { source: { approvedScene2ShotSha256: 'c'.repeat(64) },
      audio: { fixedVoiceId: '933124714380816393' } } }
  return { first, second, prepared }
}

test('second-shot image preflight rejects a different first-shot source or an already paid second video', () => {
  const { first, second, prepared } = fixture()
  second.result.secondShotReplayRecovery.sourceResultMd5 = 'd'.repeat(32)
  assert.throws(() => verifyScene2BeforePaidVideo(prepared, first, second),
    /lineage or stop-before-payment/)
  second.result.secondShotReplayRecovery.sourceResultMd5 = firstMd5
  second.result.nodeRuns[108].status = 'success'
  assert.throws(() => verifyScene2BeforePaidVideo(prepared, first, second),
    /lineage or stop-before-payment/)
})

test('second-shot image preflight cannot turn a checkpoint into payment authority without a signed still', () => {
  const { first, second, prepared } = fixture()
  assert.throws(() => verifyScene2BeforePaidVideo(prepared, first, second),
    /PREFLIGHT_INVALID|FRAME_APPROVAL_INVALID/)
})

test('second-shot image preflight preserves the approved Zhang Fei voice binding', () => {
  const { first, second, prepared } = fixture()
  second.result.nodeRuns[80].output.voiceAssets[0].videoBinding.voiceId = 'different'
  assert.throws(() => verifyScene2BeforePaidVideo(prepared, first, second),
    /original approved Kling voice/)
})
