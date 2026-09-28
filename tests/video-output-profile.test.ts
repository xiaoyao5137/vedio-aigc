import test from 'node:test'
import assert from 'node:assert/strict'
import { applyVideoOutputProfile, resolveVideoOutputProfile, videoDimensions } from '../src/video-output-profile.ts'

test('formal runs select Omni native 4K while step debugging stays std 720p', () => {
  assert.deepEqual(resolveVideoOutputProfile('step', '16:9'), {
    id: 'debug-720p', executionMode: 'step', resolution: '720p', width: 1280, height: 720,
    fps: 24, audioSampleRate: 48000, klingMode: 'std',
  })
  assert.deepEqual(resolveVideoOutputProfile('run', '16:9'), {
    id: 'production-omni-4k', executionMode: 'run', resolution: '4k', width: 3840, height: 2160,
    fps: 24, audioSampleRate: 48000, klingMode: 'pro', klingModelName: 'kling-v3-omni',
  })
  assert.deepEqual(videoDimensions('4k', '9:16'), [2160, 3840])
})

test('execution profile overrides stale editable mode and resolution values', () => {
  assert.deepEqual(applyVideoOutputProfile({ aspectRatio: '16:9', mode: 'pro', resolution: '4k' }, 'step'), {
    aspectRatio: '16:9', mode: 'std', resolution: '720p', outputProfile: 'debug-720p', executionMode: 'step',
    width: 1280, height: 720, fps: 24, audioSampleRate: 48000,
  })
  const production = applyVideoOutputProfile({ aspectRatio: '9:16', mode: 'std', resolution: '720p' }, 'run')
  assert.equal(production.outputProfile, 'production-omni-4k')
  assert.equal(production.model_name, 'kling-v3-omni')
  assert.equal(production.mode, 'pro')
  assert.equal(production.resolution, '4k')
  assert.equal(production.width, 2160)
  assert.equal(production.height, 3840)
})
