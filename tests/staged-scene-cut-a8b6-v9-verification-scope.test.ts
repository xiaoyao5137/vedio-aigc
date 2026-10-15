import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createV9VerificationScope } from
  '../server/staged-scene-cut-a8b6-v9-verification-scope.mjs'

test('a V9 entry verifies once while nested approval and candidate checks share its proof', async () => {
  let asyncChecks = 0, syncChecks = 0
  const scope = createV9VerificationScope(async root => ({
    root, sequence: ++asyncChecks }), root => ({ root,
    sequence: ++syncChecks }))
  const root = path.resolve('/tmp/v9-verification-scope')
  await scope.withVerifiedSource(root, async () => {
    const source = await scope.getVerifiedSource(root)
    assert.deepEqual(scope.getVerifiedSourceSync(root), source)
    await scope.withVerifiedSource(path.join(root, '.'), async () => {
      assert.equal(await scope.getVerifiedSource(root), source)
      assert.equal(scope.getVerifiedSourceSync(root), source)
    })
  })
  assert.equal(asyncChecks, 1)
  assert.equal(syncChecks, 0)
  await scope.withVerifiedSource(root, async () => {
    assert.equal((await scope.getVerifiedSource(root)).sequence, 2)
  })
  assert.equal(asyncChecks, 2, 'a later entry checks the source again')
  assert.equal(scope.getVerifiedSourceSync(root).sequence, 1)
  assert.equal(syncChecks, 1, 'a standalone sync entry checks the source')
})

test('V9 scopes do not share proof across roots, concurrent entries or failures', async () => {
  let checks = 0
  const scope = createV9VerificationScope(async root => ({
    root, sequence: ++checks }), root => ({ root, sequence: ++checks }))
  const root = path.resolve('/tmp/v9-verification-scope')
  const other = path.resolve('/tmp/v9-verification-scope-other')
  await scope.withVerifiedSource(root, async () => {
    const first = await scope.getVerifiedSource(root)
    await scope.withVerifiedSource(other, async () => {
      const second = await scope.getVerifiedSource(other)
      assert.notEqual(second, first)
      assert.equal(second.root, other)
    })
    assert.equal(await scope.getVerifiedSource(root), first)
  })
  assert.equal(checks, 2)
  const sequences = await Promise.all(Array.from({ length: 2 }, () =>
    scope.withVerifiedSource(root, async () =>
      (await scope.getVerifiedSource(root)).sequence)))
  assert.equal(new Set(sequences).size, 2)
  assert.equal(checks, 4)
  await assert.rejects(scope.withVerifiedSource(root, () => {
    throw Error('entry failed')
  }), /entry failed/)
  await scope.withVerifiedSource(root, async () => {
    assert.equal((await scope.getVerifiedSource(root)).sequence, 6)
  })
  assert.equal(checks, 6)
})

test('a B preview/save entry shares one V9 proof but a later entry rejects changed source', async () => {
  let sourceSha = 'a'.repeat(64)
  let checks = 0
  const scope = createV9VerificationScope(async () => {
    checks++
    if (sourceSha !== 'a'.repeat(64)) throw Error('source hash changed')
    return { sourceSha }
  }, () => { throw Error('unexpected sync verification') })
  const root = path.resolve('/tmp/v9-B-plan-entry')
  const readAPlan = () => scope.withVerifiedSource(root,
    () => scope.getVerifiedSource(root))
  await scope.withVerifiedSource(root, async () => {
    const previewSource = await readAPlan()
    const signedSource = await readAPlan()
    assert.equal(previewSource, signedSource)
    assert.equal(checks, 1)
  })
  sourceSha = 'b'.repeat(64)
  await assert.rejects(scope.withVerifiedSource(root, readAPlan),
    /source hash changed/)
  assert.equal(checks, 2, 'new CLI entry must run source verification again')
})
