import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'

const imageModel = { id: 'image-model', provider: 'Kling', capability: 'image', settings: {} }
const readableSquare = async () => 'data:image/png;base64,' + (await sharp({ create: { width: 256, height: 256, channels: 3, background: '#777777' } }).png().toBuffer()).toString('base64')
const params = { workflowId: 'wf-history', characters: ['张角'], qualityDisposition: 'manual-review-v1', validateThreeView: true, maxGenerationAttempts: 5, deferArchive: true }

test('manual character generation buys one readable image and retains the rejected layout as advice', async () => {
  const url = await readableSquare(), queries: string[] = []
  let calls = 0
  const pool = { async query(sql: string) { queries.push(sql); return { rows: [] } } }
  const result = await executeBuiltinNode(pool as never, { operation: 'character.ensure', model: imageModel, params, executionContext: { requestKey: 'manual-new-take' } }, async () => {
    calls++; return { status: 200, body: { images: [{ url }] } }
  }) as { generatedCount: number; items: Array<{ url: string; metadata: { quality: { decoded: boolean; status: string; warnings: string[]; appearanceVerified: boolean } } }> }
  assert.equal(calls, 1)
  assert.equal(result.generatedCount, 1)
  assert.equal(result.items[0].url, url)
  assert.equal(result.items[0].metadata.quality.decoded, true)
  assert.equal(result.items[0].metadata.quality.status, 'needs_attention')
  assert.equal(result.items[0].metadata.quality.appearanceVerified, false)
  assert.ok(result.items[0].metadata.quality.warnings.some(warning => warning.includes('单行水平')))
  assert.ok(queries.every(query => !query.includes('qualityRejected')))
})

test('manual lookup and ensure reuse readable non-three-view assets instead of silently purchasing a replacement', async () => {
  const url = await readableSquare()
  const row = { id: 'existing', workflow_id: 'wf-history', character_name: '张角', asset_type: 'three-view', uri: url, prompt: '实际人物遮挡面部', version: 1, metadata: { continuityKey: '张角-eastern-han-v1' } }
  const pool = { async query(sql: string) { return { rows: sql.includes('from character_assets') ? [row] : [] } } }
  const lookup = await executeBuiltinNode(pool as never, { operation: 'character.lookup', params: { ...params, includeVoices: true } }) as { missingCount: number; items: Array<{ url: string }> }
  assert.equal(lookup.missingCount, 0)
  assert.equal(lookup.items[0].url, url)
  let calls = 0
  const result = await executeBuiltinNode(pool as never, { operation: 'character.ensure', model: imageModel, params }, async () => {
    calls++; throw Error('should not purchase')
  }) as { cachedCount: number; generatedCount: number }
  assert.equal(calls, 0)
  assert.equal(result.cachedCount, 1)
  assert.equal(result.generatedCount, 0)
})

test('manual asset generation still rejects missing URLs or undecodable pixels without buying a second candidate', async () => {
  for (const body of [{ images: [] }, { images: [{ url: 'data:image/png;base64,YmFk' }] }]) {
    const pool = { async query() { return { rows: [] } } }
    let calls = 0
    await assert.rejects(() => executeBuiltinNode(pool as never, { operation: 'character.ensure', model: imageModel, params }, async () => {
      calls++; return { status: 200, body }
    }))
    assert.equal(calls, 1)
  }
})
