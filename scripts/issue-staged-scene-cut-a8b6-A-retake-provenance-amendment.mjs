#!/usr/bin/env node
/** Correct the original ImageGen prompt/extraction metadata write-once. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareA8B6ARetakeTargetProvenanceAmendment,
  issueA8B6ARetakeTargetProvenanceAmendment } from
  '../server/staged-scene-cut-a8b6-A-retake-target-provenance-amendment.mjs'

const fail = reason => { throw Error(`A8B6_A_RETAKE_AMENDMENT_CLI_INVALID: ${reason}`) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2), opts = { apply: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') {
    if (opts.apply) fail('duplicate --apply')
    opts.apply = true
    continue
  }
  const key = { '--expected-source-receipt-sha256': 'sourceReceiptSha256',
    '--expected-target-review-sha256': 'targetReviewSha256',
    '--expected-exact-prompt-sha256': 'exactPromptSha256',
    '--expected-raw-sha256': 'rawSha256' }[args[i]]
  if (!key || opts[key] || !/^[a-f0-9]{64}$/.test(args[i + 1] ?? ''))
    fail(`invalid ${args[i]}`)
  opts[key] = args[++i]
}
if (opts.apply && [opts.sourceReceiptSha256, opts.targetReviewSha256,
  opts.exactPromptSha256, opts.rawSha256].some(value => !value))
  fail('--apply requires all reviewed source and exact prompt hashes')
const prepared = await prepareA8B6ARetakeTargetProvenanceAmendment(root)
if (opts.sourceReceiptSha256 && opts.sourceReceiptSha256
    !== prepared.sourceReceiptSha256
  || opts.targetReviewSha256 && opts.targetReviewSha256
    !== prepared.targetReviewSha256
  || opts.exactPromptSha256 && opts.exactPromptSha256
    !== prepared.imageGen.exactPromptSha256
  || opts.rawSha256 && opts.rawSha256
    !== prepared.imageGen.toolOutputRawSha256)
  fail('provenance metadata or pixels changed')
const signed = opts.apply
  ? await issueA8B6ARetakeTargetProvenanceAmendment(root) : undefined
console.log(JSON.stringify({ mode: opts.apply
  ? 'signed-exact-prompt-provenance-amendment'
  : 'read-only-exact-prompt-provenance-preview',
  sourceReceiptSha256: prepared.sourceReceiptSha256,
  targetReviewSha256: prepared.targetReviewSha256,
  priorSummaryPromptSha256:
    prepared.priorSourceFieldClarification.summarizedPromptSha256,
  exactPromptSha256: prepared.imageGen.exactPromptSha256,
  rawSha256: prepared.imageGen.toolOutputRawSha256,
  targetSha256: prepared.imageGen.resizedCandidateSha256,
  originalExtraction: prepared.actualNativeTailExtraction,
  ...(signed ? { amendmentSha256: signed.amendmentSha256 } : {}),
  providerCalls: 0, databaseWrites: 0 }, null, 2))
