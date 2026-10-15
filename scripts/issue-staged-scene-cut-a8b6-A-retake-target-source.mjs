#!/usr/bin/env node
/** Read-only source proof by default; --apply signs a write-once target guide. */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareA8B6ARetakeTargetSource,
  issueA8B6ARetakeTargetSource } from
  '../server/staged-scene-cut-a8b6-A-retake-target.mjs'

const fail = reason => { throw Error(`A8B6_A_RETAKE_SOURCE_CLI_INVALID: ${reason}`) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opts = { apply: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') {
    if (opts.apply) fail('duplicate --apply')
    opts.apply = true
    continue
  }
  const key = { '--expected-video-sha256': 'videoSha256',
    '--expected-tail-sha256': 'tailSha256',
    '--expected-raw-sha256': 'rawSha256',
    '--expected-target-sha256': 'targetSha256' }[args[i]]
  if (!key || opts[key] || !args[i + 1]
    || !/^[a-f0-9]{64}$/.test(args[i + 1])) fail(`invalid ${args[i]}`)
  opts[key] = args[++i]
}
if (opts.apply && [opts.videoSha256, opts.tailSha256,
  opts.rawSha256, opts.targetSha256].some(value => !value))
  fail('--apply requires exact video, tail, raw and target SHA locks')
const prepared = await prepareA8B6ARetakeTargetSource(root)
if (opts.videoSha256 && opts.videoSha256 !== prepared.rejectedVideo.sha256
  || opts.tailSha256 && opts.tailSha256 !== prepared.nativeEditTarget.sha256
  || opts.rawSha256 && opts.rawSha256 !== prepared.imageEdit.rawSha256
  || opts.targetSha256 && opts.targetSha256 !== prepared.output.sha256)
  fail('reviewed source bytes changed')
const signed = opts.apply ? await issueA8B6ARetakeTargetSource(root) : undefined
console.log(JSON.stringify({ mode: opts.apply ? 'signed-retake-target-source'
  : 'read-only-retake-target-source-preview',
  ...prepared,
  ...(signed ? { sourceReceiptSha256: signed.receiptSha256 } : {}),
  sourceReceiptPath: path.join(root,
    '.runtime/staged-scene-cut-a8b6-A-retake/target-source.json'),
  sourceAncestrySha256: createHash('sha256')
    .update(`${prepared.rejectedVideo.sha256}:${prepared.nativeEditTarget.sha256}:${prepared.imageEdit.rawSha256}:${prepared.output.sha256}`)
    .digest('hex'),
  independentReviewApproved: false,
  providerCalls: 0, databaseWrites: 0 }, null, 2))
