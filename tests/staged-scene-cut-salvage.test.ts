import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { inspectStagedNativeVideo, previewStageARequest,
  stagePrompt, stageReviewPrompt } from '../server/staged-scene-cut.mjs'
import { SALVAGE_DROP_INDICES, SALVAGE_FILTER, salvageCommandTemplate,
  salvageSourceFrame, salvageAReviewPrompt } from '../server/staged-scene-cut-salvage.mjs'

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string

test('source-bound frame selector preserves endpoints and skips exactly 12 frames', () => {
  const selected = Array.from({ length: 181 }, (_, index) => salvageSourceFrame(index))
  assert.equal(selected[0], 0)
  assert.equal(selected[180], 192)
  assert.equal(new Set(selected).size, 181)
  assert.deepEqual(Array.from({ length: 193 }, (_, index) => index)
    .filter(index => !selected.includes(index)), [...SALVAGE_DROP_INDICES])
  assert.deepEqual(SALVAGE_DROP_INDICES, [8, 24, 40, 56, 72, 88, 104, 120, 136, 152, 168, 184])
  assert.throws(() => salvageSourceFrame(181), /output frame index invalid/)
})

test('pinned native-frame-drop command makes exactly 181 frames at 24fps', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'staged-salvage-test-'))
  try {
    const source = path.join(temp, 'source.mp4'), output = path.join(temp, 'output.mp4')
    const generated = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i',
      'testsrc2=s=1280x720:r=24:d=8.041666667', '-frames:v', '193', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-qp', '0', source], { encoding: 'utf8' })
    assert.equal(generated.status, 0, generated.stderr)
    const args = salvageCommandTemplate().map(value => value === '%SOURCE%' ? source
      : value === '%OUTPUT%' ? output : value)
    assert.ok(args.includes(SALVAGE_FILTER))
    const rendered = spawnSync(ffmpeg, args, { encoding: 'utf8' })
    assert.equal(rendered.status, 0, rendered.stderr)
    const original = await inspectStagedNativeVideo(source, 193, 8)
    const derived = await inspectStagedNativeVideo(output, 181, 7.5)
    for (let frame = 0; frame <= 180; frame++)
      assert.equal(derived.hashes[frame], original.hashes[salvageSourceFrame(frame)])
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('salvage review and B prompts bind derivative seam and approved 9.5-second stop', () => {
  const a = salvageAReviewPrompt({ version: 'staged-salvage-review-evidence-v1', phase: 'A',
    videoSha256: 'a'.repeat(64), frames: [{ kind: 'derived', frameIndex: 180, sha256: 'b'.repeat(64) }] })
  assert.match(a, /不能称衍生帧为provider-native/)
  assert.match(a, /第180帧两军士已离开双腕/)
  assert.match(a, /第81–84、96–99、172–174帧/)
  assert.match(stagePrompt('B', 'salvage-a-frame-drop-v1'), /最晚本段1\.5秒完全停稳/)
  const b = stageReviewPrompt('B', { phase: 'B', videoSha256: 'a'.repeat(64), frames: [] },
    'salvage-a-frame-drop-v1')
  assert.match(b, /衍生A段第180帧/)
  assert.match(b, /全镜9\.5秒/)
  assert.match(b, /A第180帧与B第1帧是否跳变/)
})

test('the paid A request path refuses a derived salvage plan before any provider work', async () => {
  await assert.rejects(previewStageARequest({ version: 'staged-scene-cut-salvage-v1' }),
    /no provider A request is permitted/)
})
