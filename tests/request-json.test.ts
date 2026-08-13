import test from 'node:test'
import assert from 'node:assert/strict'
import { parseJsonChunks } from '../server/request-json.ts'

test('JSON request decoding preserves a Chinese character split across transport chunks', () => {
  const source = { prompt: '电视剧叙事、短视频节奏与竖屏分镜' }
  const body = Buffer.from(JSON.stringify(source), 'utf8')
  const character = Buffer.from('叙', 'utf8')
  const characterStart = body.indexOf(character)

  assert.notEqual(characterStart, -1)
  const chunks = [
    body.subarray(0, characterStart + 1),
    body.subarray(characterStart + 1, characterStart + 2),
    body.subarray(characterStart + 2),
  ]

  assert.deepEqual(parseJsonChunks(chunks), source)
})
