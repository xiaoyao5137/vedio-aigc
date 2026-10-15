/** One V9 source verification per entry, with no cross-entry cache. */
import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { verifyA8B6LocalCompositeSourceReceiptV9,
  verifyA8B6LocalCompositeSourceReceiptV9Sync } from
  './staged-scene-cut-a8b6-local-composite-admission-v9.mjs'

export function createV9VerificationScope(verifyAsync, verifySync) {
  const storage = new AsyncLocalStorage()
  const current = root => {
    const scope = storage.getStore()
    return scope?.active && scope.root === path.resolve(root)
      ? scope : undefined
  }
  async function withVerifiedSource(root, operation) {
    const absoluteRoot = path.resolve(root)
    const existing = current(absoluteRoot)
    if (existing) return operation()
    const signed = await verifyAsync(absoluteRoot)
    const scope = { active: true, root: absoluteRoot, signed }
    return storage.run(scope, async () => {
      try { return await operation() }
      finally { scope.active = false }
    })
  }
  const getVerifiedSource = root => current(root)?.signed
    ?? verifyAsync(path.resolve(root))
  const getVerifiedSourceSync = root => current(root)?.signed
    ?? verifySync(path.resolve(root))
  return { withVerifiedSource, getVerifiedSource, getVerifiedSourceSync }
}

const live = createV9VerificationScope(
  verifyA8B6LocalCompositeSourceReceiptV9,
  verifyA8B6LocalCompositeSourceReceiptV9Sync)

export const withV9VerifiedSource = live.withVerifiedSource
export const getV9VerifiedSource = live.getVerifiedSource
export const getV9VerifiedSourceSync = live.getVerifiedSourceSync
