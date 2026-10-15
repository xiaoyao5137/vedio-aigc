import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  STAGED_SHOT1_DELIVERED_FRAMES, STAGED_SHOT1_PHASES,
  inspectStagedNativeVideo, stagedShot1FrameMapping,
  stagePrompt, stageReviewPrompt, validateStagedShot1Timeline, readStageAcceptance,
  verifyStagedSceneCutCompositeReceiptSync,
} from '../server/staged-scene-cut.mjs'

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string

test('8+6 provider seconds map to exactly 313 delivered native frames with one seam', () => {
  assert.equal(validateStagedShot1Timeline(), true)
  assert.equal(STAGED_SHOT1_DELIVERED_FRAMES, 313)
  assert.deepEqual(stagedShot1FrameMapping(0), { phase: 'A', sourceFrameIndex: 0, outputFrameIndex: 0 })
  assert.deepEqual(stagedShot1FrameMapping(180), { phase: 'A', sourceFrameIndex: 180, outputFrameIndex: 180 })
  assert.deepEqual(stagedShot1FrameMapping(181), { phase: 'B', sourceFrameIndex: 1, outputFrameIndex: 181 })
  assert.deepEqual(stagedShot1FrameMapping(228), { phase: 'B', sourceFrameIndex: 48, outputFrameIndex: 228 })
  assert.deepEqual(stagedShot1FrameMapping(312), { phase: 'B', sourceFrameIndex: 132, outputFrameIndex: 312 })
  assert.throws(() => stagedShot1FrameMapping(313), /STAGED_SCENE_CUT_INVALID/)
  assert.throws(() => validateStagedShot1Timeline([
    { ...STAGED_SHOT1_PHASES[0], acceptedSeconds: 7 }, STAGED_SHOT1_PHASES[1],
  ]), /timeline was changed/)
})

test('stage prompts place binding and stop before approved narration boundaries', () => {
  assert.match(stagePrompt('A'), /7\.5秒前双腕已明确缚住/)
  assert.match(stagePrompt('A'), /张飞此时仍未迈步/)
  assert.match(stagePrompt('B'), /第2秒前完全停稳/)
  assert.match(stagePrompt('B'), /第2–6秒张飞持续停/)
  assert.match(stagePrompt('A', 'early-binding-v2'), /到5\.8秒绳结固定/)
  assert.match(stagePrompt('A', 'early-binding-v2'), /四只手全部离开严颜手腕与绳索/)
  assert.match(stagePrompt('A', 'early-binding-v2'), /第180帧前至少已保持1\.2秒/)
  assert.match(stagePrompt('B', 'early-binding-v2'), /1\.3–1\.5秒前完全停稳/)
  const evidence = { phase: 'A', videoSha256: 'a'.repeat(64), frames: [
    { phase: 'A', frameIndex: 180, sha256: 'b'.repeat(64) },
  ] }
  assert.match(stageReviewPrompt('A', evidence), /目标参考图不算完成证据/)
  assert.throws(() => stageReviewPrompt('B', evidence), /phase\/evidence mismatch/)
})

test('native inspector rejects wrong frame count instead of accepting container duration', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'staged-scene-cut-test-'))
  try {
    const filename = path.join(directory, 'native.mp4')
    const rendered = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i',
      'color=c=black:s=1280x720:r=24:d=1.041666667', '-frames:v', '25',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', filename], { encoding: 'utf8' })
    assert.equal(rendered.status, 0, rendered.stderr)
    const native = await inspectStagedNativeVideo(filename, 25, 1)
    assert.equal(native.count, 25)
    assert.equal(native.hashes.length, 25)
    await assert.rejects(inspectStagedNativeVideo(filename, 24, 23 / 24), /not 24 native/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('synchronous composite read fails closed without key and creates no key', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'staged-scene-cut-signature-'))
  try {
    assert.throws(() => verifyStagedSceneCutCompositeReceiptSync('a'.repeat(64), directory), /staging key missing/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('explicit rejection blocks reading a later acceptance before any task lookup', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'staged-scene-cut-reject-'))
  const planId = 'a'.repeat(64)
  try {
    const receipts = path.join(directory, '.runtime/staged-scene-cut', planId)
    mkdirSync(receipts, { recursive: true })
    writeFileSync(path.join(receipts, 'phase-A-rejection.json'), '{}')
    await assert.rejects(readStageAcceptance(planId, 'A', directory), /explicitly rejected/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
