#!/usr/bin/env node
/** Sign the exact rejected-v4 layout reference for the next image edit. */
import { createHmac } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareA8B6FreshV5EditReference,
  verifyA8B6FreshV5EditReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v5.mjs'

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
if (argv.length > 1 || argv.length === 1 && argv[0] !== '--apply')
  throw Error('A8B6_FRESH_V5_EDIT_INVALID: only --apply is supported')
const apply = argv.length === 1
const prepared = await prepareA8B6FreshV5EditReference(root)
const summary = { sourceImageExecutionId: prepared.body.sourceImageExecutionId,
  sourceReviewExecutionId: prepared.body.sourceReviewExecutionId,
  rejectedImageSha256: prepared.body.sourceImageSha256,
  rejectedReviewSha256: prepared.body.failedReviewSha256,
  referenceOrder: prepared.body.referenceOrder,
  targetExecutionId: prepared.body.targetExecutionId,
  providerCalls: 0, databaseWrites: 0 }
if (!apply) {
  console.log(JSON.stringify({ mode: 'read-only-v5-edit-reference-preview',
    ...summary, artifactWrites: 0 }, null, 2))
} else {
  const key = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32)
    throw Error('A8B6_FRESH_V5_EDIT_INVALID: signing key invalid')
  const receipt = { ...prepared.body, signature: createHmac('sha256', key)
    .update(canonical(prepared.body)).digest('hex') }
  const file = path.join(root,
    '.runtime/staged-scene-cut-a8b6-fresh-edit-v5/reference.json')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  const verified = await verifyA8B6FreshV5EditReceipt(root)
  console.log(JSON.stringify({ mode: 'signed-v5-edit-reference', ...summary,
    path: file, receiptSha256: verified.receiptSha256,
    artifactWrites: 1 }, null, 2))
}
