#!/usr/bin/env node
/** Source-bound third B guide preview, then separate write-once signatures. */
import { prepareFreshA8B6BThirdRetakeTargetSource,
  issueFreshA8B6BThirdRetakeTargetSource,
  issueFreshA8B6BThirdRetakeTargetReview,
  verifyFreshA8B6BThirdRetakeTargetSource } from
  '../server/staged-scene-cut-a8b6-B-third-retake-target.mjs'

const fail = reason => { throw Error(`A8B6_B_THIRD_RETAKE_TARGET_CLI_INVALID: ${reason}`) }
const args = process.argv.slice(2), opts = { mode: 'preview' }
for (let i = 0; i < args.length; i++) {
  if (['--save-source', '--save-review'].includes(args[i])) {
    if (opts.mode !== 'preview') fail('choose one write mode')
    opts.mode = args[i] === '--save-source' ? 'save-source' : 'save-review'
    continue
  }
  const field = { '--previous-child-plan-id': 'previousChildPlanId',
    '--expected-guide-sha256': 'guideSha256',
    '--expected-source-sha256': 'sourceSha256' }[args[i]]
  if (!field || opts[field] || !args[i + 1]
    || args[i + 1].startsWith('--'))
    fail(`invalid or repeated ${args[i]}`)
  opts[field] = args[++i]
}
if (!/^[a-f0-9]{64}$/.test(opts.previousChildPlanId ?? ''))
  fail('previous rejected B-only child ID required')
if (opts.mode !== 'preview'
  && !/^[a-f0-9]{64}$/.test(opts.guideSha256 ?? ''))
  fail('write requires exact reviewed guide SHA')
if (opts.mode === 'save-review'
  && !/^[a-f0-9]{64}$/.test(opts.sourceSha256 ?? ''))
  fail('review signing requires exact source receipt SHA')
const source = await prepareFreshA8B6BThirdRetakeTargetSource(
  opts.previousChildPlanId)
if (opts.guideSha256 && opts.guideSha256 !== source.output.sha256)
  fail('third target guide bytes changed')
let signedSource, signedReview
if (opts.mode === 'save-review') {
  signedSource = await verifyFreshA8B6BThirdRetakeTargetSource(
    opts.previousChildPlanId)
  if (signedSource.receiptSha256 !== opts.sourceSha256)
    fail('third guide source receipt changed')
  signedReview = await issueFreshA8B6BThirdRetakeTargetReview(
    opts.previousChildPlanId)
} else if (opts.mode === 'save-source') {
  signedSource = await issueFreshA8B6BThirdRetakeTargetSource(
    opts.previousChildPlanId)
}
console.log(JSON.stringify({ mode: opts.mode,
  parentPlanId: source.parentPlanId,
  previousChildPlanId: source.previousChildPlanId,
  previousChildRejectionSha256: source.previousChildRejectionSha256,
  acceptedAAcceptanceSha256: source.parentAAcceptanceSha256,
  guide: source.output,
  promptSha256: source.imageEdit.promptSha256,
  sourceReceiptSha256: signedSource?.receiptSha256 ?? null,
  targetReviewSha256: signedReview?.reviewSha256 ?? null,
  providerCalls: 0, modelCalls: 0 }, null, 2))
