import { durationContentHash } from './duration-policy.ts'

export const STRUCTURAL_JSON_HASH_ALGORITHM = 'merkle-json-sha256-v1' as const

/** A JSON structural commitment using SHA-256 at every node. Domain-separated
 * descriptors commit to each object field and array position; references are
 * only a computation cache and do not change the content hash. This avoids
 * expanding shared execution snapshots into a single multi-gigabyte string.
 * Undefined object fields are omitted and undefined array entries become null,
 * matching canonical JSON semantics used for persisted execution evidence.
 * Non-finite numbers also become null. Other non-JSON values are rejected.
 * Each top-level call uses a fresh cache, so later edits are hashed afresh. */
export function createStructuralJsonHasher() {
  return (snapshot: unknown): string => {
    const cache = new WeakMap<object, string>()
    const visiting = new WeakSet<object>()
    const digest = (value: unknown): string => {
      if (['function', 'symbol', 'bigint'].includes(typeof value)) throw Error('STRUCTURAL_JSON_HASH_INVALID: unsupported non-JSON value')
      if (!value || typeof value !== 'object') return durationContentHash({ domain: STRUCTURAL_JSON_HASH_ALGORITHM, type: 'scalar',
        value: value == null || typeof value === 'number' && !Number.isFinite(value) ? null : value })
      if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Object.getOwnPropertySymbols(value).length) throw Error('STRUCTURAL_JSON_HASH_INVALID: only plain JSON objects and arrays are allowed')
      const known = cache.get(value)
      if (known) return known
      if (visiting.has(value)) throw Error('STRUCTURAL_JSON_HASH_INVALID: cyclic execution evidence')
      visiting.add(value)
      const result = Array.isArray(value)
        ? durationContentHash({ domain: STRUCTURAL_JSON_HASH_ALGORITHM, type: 'array', values: Array.from(value, item => digest(item ?? null)) })
        : durationContentHash({ domain: STRUCTURAL_JSON_HASH_ALGORITHM, type: 'object', entries: Object.keys(value).sort()
          .filter(key => (value as Record<string, unknown>)[key] !== undefined)
          .map(key => [key, digest((value as Record<string, unknown>)[key])]) })
      visiting.delete(value)
      cache.set(value, result)
      return result
    }
    return digest(snapshot)
  }
}

export function structuralJsonSha256(value: unknown) { return createStructuralJsonHasher()(value) }
