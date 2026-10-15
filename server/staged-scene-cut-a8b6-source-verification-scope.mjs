/** Coalesce repeated parent-source proofs inside one verification call tree.
 * Each independent entry gets a fresh scope: signed bytes, pixels, and DB
 * ancestry are checked again on the next call. */
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'

const active = new AsyncLocalStorage()

export function verifySourceInCallTree(version, root, verify) {
  if (!/^v[4-9]$/.test(version) || typeof root !== 'string'
    || typeof verify !== 'function')
    throw Error('A8B6_SOURCE_VERIFICATION_SCOPE_INVALID')
  const check = scope => {
    const key = `${version}:${path.resolve(root)}`
    const existing = scope.get(key)
    if (existing) return existing
    const pending = Promise.resolve().then(verify)
    scope.set(key, pending)
    return pending
  }
  const scope = active.getStore()
  if (scope) return check(scope)
  const fresh = new Map()
  return active.run(fresh, () => check(fresh))
}
