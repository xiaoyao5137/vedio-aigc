import test from 'node:test'
import assert from 'node:assert/strict'
import { A8B6_LOCAL_V6_REJECTED_V5,
  assertA8B6LocalV6RejectedV5State,
  verifyA8B6LocalV6RejectedV5Ancestry } from
  '../server/staged-scene-cut-a8b6-local-v6-rejected-ancestry.mjs'

test('V6 cannot treat a rejected V5 frame as approved', () => {
  const state = { id: A8B6_LOCAL_V6_REJECTED_V5.executionId,
    nodeRuns: Array.from({ length: 51 }, () => ({ status: 'idle' })) }
  state.nodeRuns[49] = { status: 'success', output: { passed: true } }
  state.nodeRuns[50] = { status: 'success', output: { passed: true } }
  assert.throws(() => assertA8B6LocalV6RejectedV5State(state,
    A8B6_LOCAL_V6_REJECTED_V5.resultMd5, {}, '', {}, [], []),
  /A8B6_LOCAL_V6_ANCESTRY_INVALID/)
})

test('V6 verifies V5 signed source, real model rejection and no image payment',
  { skip: !process.env.A8B6_LIVE_ANCESTRY_TEST }, async () => {
    const actual = await verifyA8B6LocalV6RejectedV5Ancestry(process.cwd())
    assert.deepEqual(actual.rejected, A8B6_LOCAL_V6_REJECTED_V5)
    assert.equal(actual.sourceReceiptSha256,
      A8B6_LOCAL_V6_REJECTED_V5.sourceReceiptSha256)
    assert.equal(actual.rejectedImageSha256,
      '46009d665c617828d2cd87542ee5032a337c4f7b0b14e1291766f8533fe24c95')
  })
