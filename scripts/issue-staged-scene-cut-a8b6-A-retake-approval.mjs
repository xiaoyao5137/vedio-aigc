#!/usr/bin/env node
/** Sign the reviewed V9 A retake request, never the rejected old A request. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareA8B6FreshARetakeApproval,
  issueA8B6FreshARetakeApproval } from
  '../server/staged-scene-cut-a8b6-A-retake-approval.mjs'

const fail = reason => { throw Error(`A8B6_A_RETAKE_APPROVAL_CLI_INVALID: ${reason}`) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2), opts = { apply: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') {
    if (opts.apply) fail('duplicate --apply')
    opts.apply = true
    continue
  }
  const key = { '--plan': 'planId',
    '--expected-request-sha256': 'requestSha256',
    '--expected-rejection-sha256': 'rejectionSha256',
    '--expected-target-review-sha256': 'targetReviewSha256',
    '--expected-target-amendment-sha256': 'targetAmendmentSha256' }[args[i]]
  if (!key || opts[key] || !/^[a-f0-9]{64}$/.test(args[i + 1] ?? ''))
    fail(`invalid ${args[i]}`)
  opts[key] = args[++i]
}
if (!opts.planId || opts.apply && [opts.requestSha256,
  opts.rejectionSha256, opts.targetReviewSha256,
  opts.targetAmendmentSha256].some(value => !value))
  fail('plan ID and reviewed hashes required to issue')
const prepared = await prepareA8B6FreshARetakeApproval(opts.planId, root)
if (opts.requestSha256 && opts.requestSha256
    !== prepared.body.phaseARequestSha256
  || opts.rejectionSha256 && opts.rejectionSha256
    !== prepared.body.parentRejectionSha256
  || opts.targetReviewSha256 && opts.targetReviewSha256
    !== prepared.body.targetReviewSha256
  || opts.targetAmendmentSha256 && opts.targetAmendmentSha256
    !== prepared.body.targetPromptAmendmentSha256)
  fail('reviewed retake approval inputs changed')
const signed = opts.apply ? await issueA8B6FreshARetakeApproval(
  opts.planId, opts.requestSha256, root) : undefined
console.log(JSON.stringify({ mode: opts.apply ? 'signed-A-retake-v2-approval'
  : 'read-only-A-retake-v2-approval-preview',
  planId: opts.planId,
  parentPlanId: prepared.body.parentPlanId,
  parentRejectionSha256: prepared.body.parentRejectionSha256,
  targetReviewSha256: prepared.body.targetReviewSha256,
  targetPromptAmendmentSha256:
    prepared.body.targetPromptAmendmentSha256,
  phaseARequestSha256: prepared.body.phaseARequestSha256,
  ...(signed ? { approvalSha256: signed.approvalSha256 } : {}),
  providerCalls: 0, databaseWrites: 0 }, null, 2))
