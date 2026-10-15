import assert from 'node:assert/strict'
import test from 'node:test'
import { preservePrefixBeforeOpening } from '../scripts/fork-original-shot1-opening-retry.mjs'

const node = (id: string, prompt = '') => ({ id, prompt })
const run = (id: string, status: string, prompt = '', extra = {}) => ({
  id: `${id}-${status}`, node: node(id, prompt), loopIndex: 0, loopGroupId: 'g1',
  status, ...extra,
})

test('opening retry preserves exactly the completed prefix and takes an idle current-graph suffix', () => {
  const old = [run('approved', 'success', 'original', { output: { exact: 'approved' } }),
    run('image', 'success', 'old', { output: { url: 'paid-old.png' } }),
    run('review', 'success', 'old', { output: { passed: false } })]
  const fresh = [run('approved', 'success', 'original'), run('image', 'idle', 'new'),
    run('review', 'idle', 'new')]
  const result = preservePrefixBeforeOpening(old, fresh, 1)
  assert.equal(result[0], old[0])
  assert.deepEqual(result[0].output, { exact: 'approved' })
  assert.equal(result[1], fresh[1])
  assert.equal(result[2], fresh[2])
  assert.equal(result.findIndex(item => item.status === 'idle'), 1)
  assert.equal(old[1].output.url, 'paid-old.png')
})

test('opening retry rejects prefix drift, reordered topology, active prefix and non-idle suffix', () => {
  const old = [run('approved', 'success', 'original'), run('image', 'success', 'old')]
  const fresh = [run('approved', 'success', 'original'), run('image', 'idle', 'new')]
  assert.throws(() => preservePrefixBeforeOpening(old, [run('approved', 'success', 'changed'), fresh[1]], 1), /prefix.*snapshot/)
  assert.throws(() => preservePrefixBeforeOpening(old, [fresh[1], fresh[0]], 1), /topology differs/)
  assert.throws(() => preservePrefixBeforeOpening([run('approved', 'running'), old[1]], fresh, 1), /completed prefix/)
  assert.throws(() => preservePrefixBeforeOpening(old, [fresh[0], run('image', 'success', 'new')], 1), /suffix is not idle/)
})
