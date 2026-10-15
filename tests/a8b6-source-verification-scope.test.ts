import assert from 'node:assert/strict'
import test from 'node:test'
import { verifySourceInCallTree } from
  '../server/staged-scene-cut-a8b6-source-verification-scope.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV9 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v9.mjs'

const root = process.cwd()

test('one V9 ancestry tree verifies each shared parent once', async () => {
  const calls = new Map<string, number>()
  const verify = (version: number): Promise<number> =>
    verifySourceInCallTree(`v${version}`, root, async () => {
      calls.set(`v${version}`, (calls.get(`v${version}`) ?? 0) + 1)
      if (version === 4) return 4
      // The source and rejected-ancestry branches both ask for the parent.
      const [source, rejected] = await Promise.all([
        verify(version - 1), verify(version - 1),
      ])
      assert.equal(source, rejected)
      return version
    })
  assert.equal(await verify(9), 9)
  assert.deepEqual(Object.fromEntries(calls), {
    v9: 1, v8: 1, v7: 1, v6: 1, v5: 1, v4: 1,
  })
})

test('a new entry checks the current source and DB state again', async () => {
  let sourceRevision = 1
  let checks = 0
  const verify = () => verifySourceInCallTree('v9', root, async () => {
    checks++
    return verifySourceInCallTree('v8', root, async () => {
      checks++
      return sourceRevision
    })
  })
  assert.equal(await verify(), 1)
  sourceRevision = 2
  assert.equal(await verify(), 2)
  assert.equal(checks, 4)
})

test('a failed parent proof cannot become a successful cached proof', async () => {
  let checks = 0
  const failed = () => verifySourceInCallTree('v8', root, async () => {
    checks++
    throw Error('source signature changed')
  })
  await assert.rejects(verifySourceInCallTree('v9', root, async () => {
    const outcomes = await Promise.allSettled([failed(), failed()])
    assert.equal(checks, 1)
    assert.ok(outcomes.every(item => item.status === 'rejected'))
    throw outcomes[0].reason
  }), /source signature changed/)
  await assert.rejects(failed(), /source signature changed/)
  assert.equal(checks, 2)
})

test('two independent V9 entries each verify the signed image and rejected DB ancestry',
  { skip: !process.env.A8B6_LIVE_ANCESTRY_TEST }, async () => {
    const first = await verifyA8B6LocalCompositeSourceReceiptV9(root)
    const second = await verifyA8B6LocalCompositeSourceReceiptV9(root)
    assert.equal(first.receiptSha256, second.receiptSha256)
    assert.deepEqual(first.pixelProof, second.pixelProof)
    assert.equal(first.receipt.priorLocalV8.frameApprovalStatus, 'idle')
    assert.equal(first.receipt.priorLocalV8.imageLedgerCount, 0)
    assert.equal(first.receipt.priorLocalV8.reviewLedgerCount, 1)
  })
