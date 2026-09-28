import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { persistHistoricalMapFrameResponse } from '../server/historical-map-frame-storage.ts'

test('a paid Kling map frame is saved as an immutable local original before visual evidence is collected', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'historical-map-storage-'))
  try {
    const bytes = await sharp({ create: { width: 180, height: 100, channels: 3, background: '#d3bf9a' } })
      .png().toBuffer()
    const remoteUrl = 'https://supplier.example.test/task-result/map.png'
    const calls: string[] = []
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/png' } })
    })
    const response = { code: 0, data: { task_id: 'paid-image-task', task_result: { images: [
      { id: 'frame-1', url: remoteUrl, width: 180, height: 100 }] } }, trace: { status: 'succeeded' } }
    const saved = await persistHistoricalMapFrameResponse(response, root) as typeof response
    const expected = `/generated/historical-map-frame-${createHash('sha256').update(bytes).digest('hex')}.png`
    assert.deepEqual(calls, [remoteUrl])
    assert.deepEqual(saved, { ...response, data: { ...response.data, task_result: { images: [
      { ...response.data.task_result.images[0], url: expected }] } } })
    assert.deepEqual(await readFile(path.join(root, 'public', expected)), bytes)
    assert.deepEqual(response.data.task_result.images[0].url, remoteUrl, 'provider response is not mutated')
    assert.deepEqual(await persistHistoricalMapFrameResponse(saved, root), saved,
      'reusing already saved paid image does not download or repurchase it')
    assert.deepEqual(calls, [remoteUrl])
    await assert.rejects(() => persistHistoricalMapFrameResponse({ images: [{ url: 'http://127.0.0.1/private.png' }] }, root),
      /HISTORICAL_MAP_FRAME_STORAGE_INVALID/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
