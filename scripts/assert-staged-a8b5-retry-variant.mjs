// Cheap CLI variant selection. The imported action must reverify the full
// signed manifest, source receipts and media before any request or write.
import { readFileSync } from 'node:fs'
import path from 'node:path'

export function assertRetryVariantArgs(args, root = process.cwd()) {
  const index = args.indexOf('--plan-id')
  if (index < 0 || index === args.length - 1 || args.indexOf('--plan-id', index + 1) >= 0
    || !/^[a-f0-9]{64}$/.test(args[index + 1]))
    throw Error('STAGED_A8B5_RETRY_INVALID: one signed retry --plan-id required')
  const planId = args[index + 1]
  const filename = path.join(root, '.runtime/staged-scene-cut-a8b5', planId, 'manifest.json')
  const manifest = JSON.parse(readFileSync(filename, 'utf8'))
  if (manifest.version !== 'staged-scene-cut-a8b5-retry-b-v1' || manifest.planId !== planId)
    throw Error('STAGED_A8B5_RETRY_INVALID: retry variant required')
  return planId
}
