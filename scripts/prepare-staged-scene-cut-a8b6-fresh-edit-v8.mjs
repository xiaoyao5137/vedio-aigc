#!/usr/bin/env node
/** Write the signed five-reference V8 source and its two derived JPEGs once. */
import { createHmac } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareA8B6FreshV8EditReference,
  verifyA8B6FreshV8EditReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v8.mjs'

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length > 1 || args.length === 1 && args[0] !== '--apply')
  throw Error('A8B6_FRESH_V8_EDIT_INVALID: only --apply is supported')
const prepared = await prepareA8B6FreshV8EditReference(root)
const summary = { sourceExecutionId: prepared.body.sourceExecutionId,
  sourceResultMd5: prepared.body.sourceResultMd5,
  referenceOrder: prepared.body.referenceOrder.map(x => ({
    position: x.position, role: x.role,
    sha256: x.sha256 ?? x.jpegSha256,
    identityAuthority: x.identityAuthority })),
  targetExecutionId: prepared.body.targetExecutionId,
  providerCalls: 0, databaseWrites: 0 }
if (!args.length) {
  console.log(JSON.stringify({ mode: 'read-only-v8-source-preview',
    ...summary, artifactWrites: 0 }, null, 2))
} else {
  const key = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32)
    throw Error('A8B6_FRESH_V8_EDIT_INVALID: signing key invalid')
  const file = path.join(root,
    '.runtime/staged-scene-cut-a8b6-fresh-edit-v8/reference.json')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ ...prepared.body,
    signature: createHmac('sha256', key)
      .update(canonical(prepared.body)).digest('hex') }, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 })
  await writeFile(path.join(path.dirname(file), 'face-masked-layout.jpg'),
    prepared.derived.masked, { flag: 'wx' })
  await writeFile(path.join(path.dirname(file), 'v4-face-helper.jpg'),
    prepared.derived.helper, { flag: 'wx' })
  const verified = await verifyA8B6FreshV8EditReceipt(root)
  console.log(JSON.stringify({ mode: 'signed-v8-five-references',
    ...summary, receiptSha256: verified.receiptSha256,
    file, artifactWrites: 3 }, null, 2))
}
