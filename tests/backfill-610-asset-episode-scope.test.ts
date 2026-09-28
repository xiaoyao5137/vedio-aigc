import assert from 'node:assert/strict'
import test from 'node:test'
import { validateAssetRows, verifyExecutionRecord } from '../scripts/backfill-610-asset-episode-scope.mjs'

const assets = [
  { id: 'character-070b25d71205797c', name: '张飞', lookKey: 'zhangfei_jiangzhou_campaign', rowVersion: '25511',
    uriSha256: '77ba662b63c9f7c1b66d52c48b29c398afbe0a2becc3414c4c0ba72a6f1fef2f',
    requestSignature: 'a355a0cbab5049af0dc15605ab83ea5fa9069e2beef34f9c9e1b31b75375d182' },
  { id: 'character-41953008cc8dfd45', name: '严颜', lookKey: 'yanyan_jiangzhou_campaign', rowVersion: '25634',
    uriSha256: 'e2709803627766be1a82b7eff2a8cc1fff5c9e221f46386386771ac4b950a3d8',
    requestSignature: 'bdb587e8705ff823477c2afa9218ee67d784a2caddc6a408384c0010d773e435' },
]

function fixture() {
  const proven = assets.map((target, index) => ({ ...target, uri: `https://example.test/${index}.png` }))
  const rows = proven.map(target => ({
    id: target.id, workflow_id: 'wf-sanguo-history-drama', character_name: target.name,
    asset_type: 'three-view', version: 1, uri: target.uri, row_version: target.rowVersion,
    metadata: { generatedBy: 'workflow-image-node', archivedFromNodeId: 'sanguo-character-archive',
      visualContextImageFingerprint: target.uriSha256,
      visualContextRequestSignature: target.requestSignature,
      visualContext: { age: { stage: 'mature', basis: 'artistic' }, look: { key: target.lookKey } } },
  }))
  return { proven, rows }
}

test('only the two exact 610 assets pass the database guards', () => {
  const { proven, rows } = fixture()
  assert.equal(validateAssetRows(rows, { proven }).length, 2)
})

test('a prior scope, changed URI, or changed row version prevents backfill', () => {
  for (const mutate of [
    (rows: ReturnType<typeof fixture>['rows']) => { rows[0].metadata.episodeScope = { episodes: [637] } },
    (rows: ReturnType<typeof fixture>['rows']) => { rows[0].uri = 'https://example.test/replaced.png' },
    (rows: ReturnType<typeof fixture>['rows']) => { rows[0].row_version = '99999' },
  ]) {
    const { proven, rows } = fixture()
    mutate(rows)
    assert.throws(() => validateAssetRows(rows, { proven }))
  }
})

test('a different source episode is rejected before inspecting media', () => {
  assert.throws(() => verifyExecutionRecord({ id: 'record-610-tail-adopt-20260928-v1',
    workflowId: 'wf-sanguo-history-drama', runtimeInputs: { input: { episode_number: 637 } } }),
  /637|610|Expected values to be strictly equal/)
})
