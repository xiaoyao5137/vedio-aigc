#!/usr/bin/env node
/** Preview, then sign a B target guide and its separate direct review. */
import { createHash } from 'node:crypto'
import { prepareFreshA8B6BRetakeTargetSource,
  issueFreshA8B6BRetakeTargetSource,
  issueFreshA8B6BRetakeTargetReview,
  verifyFreshA8B6BRetakeTargetSource,
  verifyFreshA8B6BRetakeTargetReview } from
  '../server/staged-scene-cut-a8b6-B-retake-target.mjs'

const fail = reason => { throw Error(`A8B6_B_RETAKE_TARGET_CLI_INVALID: ${reason}`) }
const args = process.argv.slice(2), opts = { mode: 'preview' }
for (let i = 0; i < args.length; i++) {
  if (['--save-source', '--save-review'].includes(args[i])) {
    if (opts.mode !== 'preview') fail('choose one write mode')
    opts.mode = args[i] === '--save-source' ? 'save-source' : 'save-review'
    continue
  }
  const key = { '--parent-plan-id': 'parentPlanId',
    '--expected-guide-sha256': 'guideSha256',
    '--expected-source-sha256': 'sourceSha256' }[args[i]]
  if (!key || opts[key] || !args[i + 1])
    fail(`invalid or repeated ${args[i]}`)
  opts[key] = args[++i]
}
if (!/^[a-f0-9]{64}$/.test(opts.parentPlanId ?? ''))
  fail('parent plan ID required')
if (opts.mode !== 'preview'
  && !/^[a-f0-9]{64}$/.test(opts.guideSha256 ?? ''))
  fail('write requires reviewed target guide SHA')
if (opts.mode === 'save-review'
  && !/^[a-f0-9]{64}$/.test(opts.sourceSha256 ?? ''))
  fail('review signing requires source receipt SHA')
const source = await prepareFreshA8B6BRetakeTargetSource(opts.parentPlanId)
if (opts.guideSha256 && opts.guideSha256 !== source.output.sha256)
  fail('target guide changed')
const result = opts.mode === 'save-source'
  ? await issueFreshA8B6BRetakeTargetSource(opts.parentPlanId)
  : opts.mode === 'save-review'
    ? await issueFreshA8B6BRetakeTargetReview(opts.parentPlanId)
    : undefined
if (opts.mode === 'save-review' && result.review.sourceReceiptSha256
  !== opts.sourceSha256) fail('review source receipt changed')
const signedSource = opts.mode === 'save-review'
  ? await verifyFreshA8B6BRetakeTargetSource(opts.parentPlanId)
  : opts.mode === 'save-source' ? result : undefined
const signedReview = opts.mode === 'save-review'
  ? await verifyFreshA8B6BRetakeTargetReview(opts.parentPlanId)
  : undefined
console.log(JSON.stringify({ mode: opts.mode,
  parentPlanId: opts.parentPlanId,
  acceptedA: source.acceptedA, failedB: source.failedB,
  guide: source.output,
  promptSha256: source.imageEdit.promptSha256,
  sourceBodySha256: createHash('sha256').update(JSON.stringify(source))
    .digest('hex'),
  sourceReceiptSha256: signedSource?.receiptSha256,
  targetReviewSha256: signedReview?.reviewSha256,
  providerCalls: 0, modelCalls: 0,
}, null, 2))
