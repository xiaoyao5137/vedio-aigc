#!/usr/bin/env node
/** Add a signed correction without changing the original selection receipt. */
import { createHmac } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { A8B6_V7_SELECTION_CLARIFICATION,
  verifyA8B6V7DualOutputRecoveryReceiptAsync,
  verifyA8B6V7DualOutputClarification } from
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
const source = await verifyA8B6V7DualOutputRecoveryReceiptAsync(root)
const body = {
  version: 'a8b6-v7-dual-output-selection-clarification-v1',
  sourceReceiptSha256: source.receiptSha256,
  selectedSourceSha256: source.receipt.selectedSourceSha256,
  unselectedSourceSha256: source.receipt.unselectedSourceSha256,
  statement: A8B6_V7_SELECTION_CLARIFICATION,
  completionOrderKnown: false,
  requiredForWorkflowAdmission: true,
}
if (!args.length) {
  console.log(JSON.stringify({ mode: 'read-only-clarification-preview',
    ...body, artifactWrites: 0, providerCalls: 0 }, null, 2))
} else {
  const key = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) throw Error('A8B6_V7_DUAL_OUTPUT_INVALID: signing key invalid')
  const clarification = { ...body, signature: createHmac('sha256', key)
    .update(canonical(body)).digest('hex') }
  const file = path.join(root,
    '.runtime/staged-scene-cut-a8b6-v7-dual-output/clarification.json')
  await writeFile(file, JSON.stringify(clarification, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  const verified = verifyA8B6V7DualOutputClarification(root)
  console.log(JSON.stringify({ mode: 'signed-additive-clarification',
    sourceReceiptSha256: source.receiptSha256,
    clarificationSha256: verified.clarificationSha256,
    file, artifactWrites: 1, databaseWrites: 0,
    providerCalls: 0 }, null, 2))
}
