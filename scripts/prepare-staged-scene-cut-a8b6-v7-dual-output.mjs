#!/usr/bin/env node
/** Sign both actual CLI outputs and archive one explicit review candidate. */
import { createHmac } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareA8B6V7DualOutputRecovery,
  verifyA8B6V7DualOutputRecoveryReceiptAsync } from
  '../server/staged-scene-cut-a8b6-v7-dual-output.mjs'

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length > 1 || args.length === 1 && args[0] !== '--apply')
  throw Error('A8B6_V7_DUAL_OUTPUT_INVALID: only --apply is supported')
const apply = args.length === 1
const prepared = await prepareA8B6V7DualOutputRecovery(root)
if (!apply) {
  console.log(JSON.stringify({ mode: 'read-only-dual-output-preview',
    selectedSourceSha256: prepared.body.selectedSourceSha256,
    unselectedSourceSha256: prepared.body.unselectedSourceSha256,
    normalizedImageSha256: prepared.body.normalizedImageSha256,
    imageUrl: prepared.body.imageUrl, outputSize: prepared.body.outputSize,
    artifactWrites: 0, databaseWrites: 0, providerCalls: 0 }, null, 2))
} else {
  const key = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) throw Error('A8B6_V7_DUAL_OUTPUT_INVALID: signing key invalid')
  const receipt = { ...prepared.body, signature: createHmac('sha256', key)
    .update(canonical(prepared.body)).digest('hex') }
  const file = path.join(root,
    '.runtime/staged-scene-cut-a8b6-v7-dual-output/receipt.json')
  const imageFile = path.join(root, 'public', prepared.body.imageUrl.slice(1))
  await mkdir(path.dirname(file), { recursive: true })
  await mkdir(path.dirname(imageFile), { recursive: true })
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  await writeFile(imageFile, prepared.normalized, { flag: 'wx' })
  const verified = await verifyA8B6V7DualOutputRecoveryReceiptAsync(root)
  console.log(JSON.stringify({ mode: 'signed-dual-output-selection',
    receiptFile: file, receiptSha256: verified.receiptSha256,
    selectedSourceSha256: receipt.selectedSourceSha256,
    unselectedSourceSha256: receipt.unselectedSourceSha256,
    normalizedImageSha256: receipt.normalizedImageSha256,
    imageUrl: receipt.imageUrl, artifactWrites: 2,
    databaseWrites: 0, providerCalls: 0 }, null, 2))
}
