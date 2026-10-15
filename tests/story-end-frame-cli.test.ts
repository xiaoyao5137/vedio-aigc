import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArguments, selectSource, validateManifest } from '../scripts/generate-story-end-frame.mjs'

const args = ['--source', 'record-example', '--shot', '1', '--prompt-file', 'target.txt',
  '--version', 'v1', '--out', 'target-summary.json']

test('target-frame tool previews by default and requires explicit, bounded candidate arguments', () => {
  const options = parseArguments(args)
  assert.equal(options.apply, false)
  assert.equal(options.shot, 1)
  assert.equal(options.app, 'http://127.0.0.1:5177')
  assert.equal(parseArguments([...args, '--apply']).apply, true)
  for (const extra of [['--shot', '2'], ['--apply', '--apply'], ['--app', 'https://example.com']]) {
    assert.throws(() => parseArguments([...args, ...extra]))
  }
  assert.throws(() => parseArguments(args.map(value => value === '1' ? '0' : value)))
  assert.throws(() => parseArguments(args.map(value => value === 'target-summary.json' ? 'target.txt' : value)))
})

test('target-frame source binds the successful take and its actually submitted four references', () => {
  const image = { id: 'image-1', node: { id: 'node-image', modelId: 'image-model' }, loopIndex: 0,
    status: 'success', output: { model: 'image-model', params: { referenceImages: ['a', 'b', 'c', 'd'] } } }
  assert.deepEqual(selectSource({ nodeRuns: [image] }, 1).refs, ['a', 'b', 'c', 'd'])
  assert.throws(() => selectSource({ nodeRuns: [image, { ...image, status: 'failed' }] }, 1))
  assert.throws(() => selectSource({ nodeRuns: [{ ...image, status: 'idle' }] }, 1))
  assert.throws(() => selectSource({ nodeRuns: [{ ...image, output: { ...image.output, model: 'other-model' } }] }, 1))
  assert.throws(() => selectSource({ nodeRuns: [{ ...image, output: { model: 'image-model' } }] }, 1))
  assert.throws(() => selectSource({ nodeRuns: [image] }, 2))
})

test('target-frame manifest cannot be silently reused for changed paid inputs', () => {
  const summary = { schemaVersion: 'story-target-end-frame-manifest-v1', requestKey: 'key', requestFingerprint: 'same' }
  assert.doesNotThrow(() => validateManifest(undefined, summary))
  assert.doesNotThrow(() => validateManifest(summary, summary))
  assert.throws(() => validateManifest({ ...summary, requestFingerprint: 'changed' }, summary))
  assert.throws(() => validateManifest({ ...summary, requestKey: 'another-version' }, summary))
  assert.throws(() => validateManifest({ unrelatedFile: true }, summary))
})
