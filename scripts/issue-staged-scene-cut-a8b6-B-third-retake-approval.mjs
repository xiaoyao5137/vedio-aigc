#!/usr/bin/env node
/** Separately approve one new B-only request after two rejected B takes. */
import { prepareFreshA8B6BThirdRetakeApproval,
  issueFreshA8B6BThirdRetakeApproval } from
  '../server/staged-scene-cut-a8b6-B-retake-approval.mjs'
import { withV9VerifiedSource } from
  '../server/staged-scene-cut-a8b6-v9-verification-scope.mjs'

const fail = reason => { throw Error(`A8B6_B_THIRD_RETAKE_APPROVAL_CLI_INVALID: ${reason}`) }
const args = process.argv.slice(2), opts = { apply: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') {
    if (opts.apply) fail('duplicate --apply')
    opts.apply = true
    continue
  }
  const field = { '--previous-child-plan-id': 'previousChildPlanId',
    '--expected-plan-id': 'planId',
    '--expected-B-request-sha256': 'requestSha256' }[args[i]]
  if (!field || opts[field] || !/^[a-f0-9]{64}$/.test(args[i + 1] ?? ''))
    fail(`invalid or repeated ${args[i]}`)
  opts[field] = args[++i]
}
if (!/^[a-f0-9]{64}$/.test(opts.previousChildPlanId ?? ''))
  fail('signed rejected previous B child required')
if (opts.apply && (!opts.planId || !opts.requestSha256))
  fail('approval signing requires reviewed new child and B request')
await withV9VerifiedSource(process.cwd(), async () => {
  const prepared = await prepareFreshA8B6BThirdRetakeApproval(
    opts.previousChildPlanId)
  if (opts.planId && opts.planId !== prepared.plan.planId
    || opts.requestSha256 && opts.requestSha256
      !== prepared.plan.bRetake.newBRequestSha256)
    fail('reviewed third B-only request changed')
  const signed = opts.apply
    ? await issueFreshA8B6BThirdRetakeApproval(
      opts.previousChildPlanId, opts.planId, opts.requestSha256)
    : undefined
  console.log(JSON.stringify({ mode: opts.apply
    ? 'signed-third-B-only-approval'
    : 'read-only-third-B-only-approval-preview',
  planId: prepared.plan.planId,
  requestSha256: prepared.plan.bRetake.newBRequestSha256,
  previousChild: prepared.plan.bRetake.previousChild,
  targetSourceSha256: prepared.plan.bRetake.targetSourceSha256,
  targetReviewSha256: prepared.plan.bRetake.targetReviewSha256,
  approvalSha256: signed?.approvalSha256 ?? null,
  providerCalls: 0, modelCalls: 0 }, null, 2))
})
