import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectExperienceResponse } from '../src/model-experience.ts'

test('recognizes a submitted Kling task before media is available', () => {
  const result = inspectExperienceResponse({ data: { task_id: 'task-123', task_status: 'submitted' } }, 'video')
  assert.equal(result.taskId, 'task-123')
  assert.equal(result.pending, true)
  assert.equal(result.succeeded, false)
  assert.deepEqual(result.media, [])
})

test('extracts playable and downloadable Kling video results', () => {
  const result = inspectExperienceResponse({
    data: {
      task_id: 'task-123',
      task_status: 'succeed',
      task_result: { videos: [{ url: 'https://cdn.example.com/output/video.mp4?token=secret' }] },
    },
  }, 'video')
  assert.equal(result.succeeded, true)
  assert.equal(result.pending, false)
  assert.deepEqual(result.media, [{
    kind: 'video',
    url: 'https://cdn.example.com/output/video.mp4?token=secret',
    filename: 'video.mp4',
  }])
})

test('ignores callback, cover, and tail-frame URLs when rendering a video result', () => {
  const result = inspectExperienceResponse({
    callback_url: 'https://example.com/callback',
    data: {
      task_status: 'succeed',
      task_result: {
        videos: [{
          url: 'https://cdn.example.com/generated-output',
          cover_image_url: 'https://cdn.example.com/generated-cover',
          tail_frame_url: 'https://cdn.example.com/generated-tail',
        }],
      },
    },
  }, 'video')
  assert.deepEqual(result.media.map((item) => item.url), ['https://cdn.example.com/generated-output'])
})

test('extracts data URL image and audio responses for other models', () => {
  assert.equal(inspectExperienceResponse({ data: [{ url: 'data:image/png;base64,abc' }] }, 'image').media[0]?.kind, 'image')
  assert.equal(inspectExperienceResponse({ url: 'data:audio/mpeg;base64,abc' }, 'audio').media[0]?.kind, 'audio')
})
