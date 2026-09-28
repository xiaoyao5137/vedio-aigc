import test from 'node:test'
import assert from 'node:assert/strict'
import { mapNodeInputs, MapInputItemError, type MapInput } from '../src/node-map.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

test('default mapping remains serial with isolated contexts and original request indices', async () => {
  let active = 0
  const seen: number[] = []
  const source = { frames: ['first', 'last'], keep: 1 }
  const result = await mapNodeInputs({ sourcePath: 'frames', itemVar: 'frame' }, source, async (context, index) => {
    assert.equal(active++, 0)
    seen.push(index)
    await Promise.resolve()
    active--
    return { value: context.frame, keep: context.keep, index }
  })
  assert.deepEqual(seen, [0, 1])
  assert.deepEqual(result, { items: [{ value: 'first', keep: 1, index: 0 }, { value: 'last', keep: 1, index: 1 }], count: 2 })
  assert.equal('frame' in source, false)
})

test('bounded concurrency retains input, output and item request identity despite out-of-order completion', async () => {
  const pending = Array.from({ length: 7 }, () => deferred<string>())
  const source = { nested: { frames: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }, keep: 1 }
  const originalInputs = [...source.nested.frames]
  const starts: Array<{ key: string; input: unknown }> = []
  let active = 0
  let peak = 0
  const resultPromise = mapNodeInputs({ sourcePath: 'nested.frames', itemVar: 'frame', concurrency: 4 }, source, async (context, index) => {
    active++
    peak = Math.max(peak, active)
    starts.push({ key: `existing-execution:item-${index}`, input: context.frame })
    context.keep = 'only this item context'
    try { return await pending[index].promise } finally { active-- }
  })
  assert.equal(starts.length, 4)
  source.nested.frames[4] = 'changed after start'
  for (const index of [3, 1, 4, 0, 6, 5, 2]) {
    pending[index].resolve(`output-${index}`)
    await flush()
  }
  assert.deepEqual(await resultPromise, { items: pending.map((_, index) => `output-${index}`), count: 7 })
  assert.deepEqual(starts, originalInputs.map((input, index) => ({ key: `existing-execution:item-${index}`, input })))
  assert.equal(peak, 4)
  assert.equal(active, 0)
  assert.equal(source.keep, 1)
})

test('a failure stops new item submissions, waits for all started requests, and retains failing item and cause', async () => {
  const pending = Array.from({ length: 6 }, () => deferred<string>())
  const starts: number[] = []
  const cause = new Error('MODEL_TRANSPORT_EXHAUSTED: original failure')
  const result = mapNodeInputs({ sourcePath: 'frames', itemVar: 'frame', concurrency: 3 }, { frames: [0, 1, 2, 3, 4, 5] }, async (_, index) => {
    starts.push(index)
    return pending[index].promise
  })
  let settled = false
  const outcome = result.then(value => ({ value }), error => { settled = true; return { error } })
  assert.deepEqual(starts, [0, 1, 2])
  pending[1].reject(cause)
  await flush()
  assert.equal(settled, false)
  pending[0].resolve('already-paid-output')
  await flush()
  assert.deepEqual(starts, [0, 1, 2])
  assert.equal(settled, false)
  pending[2].reject(new Error('later already-started failure'))
  const finished = await outcome
  assert.ok('error' in finished)
  assert.ok(finished.error instanceof MapInputItemError)
  assert.equal(finished.error.itemIndex, 1)
  assert.equal(finished.error.sourcePath, 'frames')
  assert.equal(finished.error.cause, cause)
  assert.match(finished.error.message, /frames\[1\].*MODEL_TRANSPORT_EXHAUSTED/)
  assert.deepEqual(starts, [0, 1, 2])
})

test('synchronous item failures prevent any subsequent item from starting', async () => {
  const starts: number[] = []
  await assert.rejects(mapNodeInputs({ sourcePath: 'frames', itemVar: 'frame', concurrency: 4 }, { frames: [0, 1, 2, 3] }, (_, index) => {
    starts.push(index)
    throw new Error('sync failure')
  }), error => error instanceof MapInputItemError && error.itemIndex === 0)
  assert.deepEqual(starts, [0])
})

test('empty and short arrays preserve result shape without creating surplus work', async () => {
  let calls = 0
  assert.deepEqual(await mapNodeInputs({ sourcePath: 'frames', itemVar: 'frame', concurrency: 4 }, { frames: [] }, async () => { calls++; return 'unused' }), { items: [], count: 0 })
  assert.equal(calls, 0)
  assert.deepEqual(await mapNodeInputs({ sourcePath: 'frames', itemVar: 'frame', concurrency: 4 }, { frames: ['only'] }, async (context, index) => { calls++; assert.equal(index, 0); return context.frame }), { items: ['only'], count: 1 })
  assert.equal(calls, 1)
})

test('invalid concurrency and mapping bounds fail before any item is submitted', async () => {
  let calls = 0
  const execute = async () => { calls++; return null }
  for (const concurrency of [0, -1, 5, 1.5, NaN, Infinity, '2', null]) {
    await assert.rejects(mapNodeInputs({ sourcePath: 'frames', itemVar: 'frame', concurrency } as MapInput, { frames: [0] }, execute), /MAP_CONFIG_INVALID/)
  }
  for (const config of [
    { sourcePath: 'notArray', itemVar: 'frame' },
    { sourcePath: 'frames', itemVar: '__proto__' },
    { sourcePath: 'frames', itemVar: 'frame', maxItems: 1 },
    { sourcePath: 'frames', itemVar: 'frame', maxItems: 101 },
  ]) await assert.rejects(mapNodeInputs(config, { frames: [0, 1] }, execute), /MAP_CONFIG_INVALID/)
  assert.equal(calls, 0)
})
