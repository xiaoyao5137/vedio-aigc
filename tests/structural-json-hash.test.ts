import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { structuralJsonSha256, createStructuralJsonHasher, STRUCTURAL_JSON_HASH_ALGORITHM } from '../src/structural-json-hash.ts'

const canonical = (value: unknown): string => Array.isArray(value) ? '[' + Array.from(value, item => canonical(item ?? null)).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
    .map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}' : JSON.stringify(value ?? null)
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const reference = (value: unknown): string => value && typeof value === 'object'
  ? Array.isArray(value) ? sha({ domain: STRUCTURAL_JSON_HASH_ALGORITHM, type: 'array', values: Array.from(value, item => reference(item ?? null)) })
    : sha({ domain: STRUCTURAL_JSON_HASH_ALGORITHM, type: 'object', entries: Object.keys(value).sort()
      .filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => [key, reference((value as Record<string, unknown>)[key])]) })
  : sha({ domain: STRUCTURAL_JSON_HASH_ALGORITHM, type: 'scalar', value: value ?? null })

test('browser structural SHA matches an independent node crypto reference with domain-separated types and all ordered fields', () => {
  const snapshot = [{ status: 'success', output: { url: '/generated/原片.mp4', decoded: true, duration: 8.04 }, context: { source: [1, null, '古今'] } }]
  assert.equal(structuralJsonSha256(snapshot), reference(snapshot))
  assert.equal(structuralJsonSha256({ b: 2, a: 1 }), structuralJsonSha256({ a: 1, b: 2 }))
  assert.notEqual(structuralJsonSha256([1, 2]), structuralJsonSha256([2, 1]))
  assert.notEqual(structuralJsonSha256({ a: 1 }), structuralJsonSha256({ b: 1 }))
  assert.notEqual(structuralJsonSha256(['a']), structuralJsonSha256({ '0': 'a' }))
  assert.notEqual(structuralJsonSha256(1), structuralJsonSha256('1'))
  const changed = structuredClone(snapshot)
  changed[0].context.source[2] = 'changed nested evidence'
  assert.notEqual(structuralJsonSha256(snapshot), structuralJsonSha256(changed))
})

test('JSON undefined and sparse-array semantics remain stable while actual saved fields are committed', () => {
  assert.equal(structuralJsonSha256({ a: undefined }), structuralJsonSha256({}))
  assert.equal(structuralJsonSha256([undefined]), structuralJsonSha256([null]))
  assert.equal(structuralJsonSha256(Array(2)), structuralJsonSha256([null, null]))
  assert.notEqual(structuralJsonSha256({ a: null }), structuralJsonSha256({}))
  assert.notEqual(structuralJsonSha256([]), structuralJsonSha256([null]))
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(structuralJsonSha256(value), structuralJsonSha256(null))
  assert.equal(structuralJsonSha256(Object.assign(Object.create(null), { a: 1 })), structuralJsonSha256({ a: 1 }))
})

test('unsupported values cannot collide with an empty JSON object or be silently dropped as a saved field', () => {
  for (const value of [() => {}, Symbol('source'), 1n, new Date(), new Map(), new Set(), /pattern/,
    Object.assign(Object.create({ inherited: true }), { evidence: 'unknown prototype' })]) {
    assert.throws(() => structuralJsonSha256(value), /STRUCTURAL_JSON_HASH_INVALID/)
    assert.throws(() => structuralJsonSha256({ nested: value }), /STRUCTURAL_JSON_HASH_INVALID/)
    assert.throws(() => structuralJsonSha256([value]), /STRUCTURAL_JSON_HASH_INVALID/)
  }
  assert.throws(() => structuralJsonSha256({ [Symbol('hidden-source')]: 'unpersistable' }), /STRUCTURAL_JSON_HASH_INVALID/)
})

test('a reused hasher observes subsequent deep mutations while retaining DAG memoization within each call', () => {
  const hash = createStructuralJsonHasher(), leaf = { source: { url: '/generated/first.mp4' } }
  const snapshot = [leaf, leaf], before = hash(snapshot)
  leaf.source.url = '/generated/changed.mp4'
  assert.notEqual(hash(snapshot), before)
  assert.equal(hash(snapshot), structuralJsonSha256(snapshot))
})

test('shared execution graphs hash completely without expanding a trillion repeated leaves or depending on reference identity', () => {
  let shared: unknown = { raw: 'same retained supplier body', nested: { accepted: true } }
  for (let i = 0; i < 40; i += 1) shared = { left: shared, right: shared }
  assert.match(structuralJsonSha256(shared), /^[a-f0-9]{64}$/)
  assert.equal(structuralJsonSha256(shared), structuralJsonSha256(structuredClone(shared)))
  const reused = { allFields: [1, 'two', { deep: 'three' }] }
  assert.equal(structuralJsonSha256([reused, reused]), structuralJsonSha256([structuredClone(reused), structuredClone(reused)]))
  const hash = createStructuralJsonHasher()
  assert.equal(hash(shared), hash(shared))
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  assert.throws(() => structuralJsonSha256(cyclic), /cyclic execution evidence/)
})
