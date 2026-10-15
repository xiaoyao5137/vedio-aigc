#!/usr/bin/env node
/** Sign one reviewed B-only child request before saving its manifest. */
import { prepareFreshA8B6BRetakeApproval,
  issueFreshA8B6BRetakeApproval } from
  '../server/staged-scene-cut-a8b6-B-retake-approval.mjs'
import { withV9VerifiedSource } from
  '../server/staged-scene-cut-a8b6-v9-verification-scope.mjs'

const fail = reason => { throw Error(`A8B6_B_RETAKE_APPROVAL_CLI_INVALID: ${reason}`) }
const args = process.argv.slice(2), opts = { apply: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') {
    if (opts.apply) fail('duplicate --apply')
    opts.apply = true
    continue
  }
  const key = { '--parent-plan-id': 'parentPlanId',
    '--expected-plan-id': 'planId',
    '--expected-B-request-sha256': 'requestSha256' }[args[i]]
  if (!key || opts[key] || !/^[a-f0-9]{64}$/.test(args[i + 1] ?? ''))
    fail(`invalid ${args[i]}`)
  opts[key] = args[++i]
}
if (!/^[a-f0-9]{64}$/.test(opts.parentPlanId ?? ''))
  fail('parent rejected B plan required')
if (opts.apply && (!opts.planId || !opts.requestSha256))
  fail('approval signing requires reviewed child plan and B request')
await withV9VerifiedSource(process.cwd(), async () => {
const prepared = await prepareFreshA8B6BRetakeApproval(opts.parentPlanId)
if (opts.planId && opts.planId !== prepared.plan.planId
  || opts.requestSha256 && opts.requestSha256
    !== prepared.plan.bRetake.newBRequestSha256)
  fail('reviewed B-only request changed')
const signed = opts.apply
  ? await issueFreshA8B6BRetakeApproval(opts.parentPlanId,
    opts.planId, opts.requestSha256) : undefined
console.log(JSON.stringify({ mode: opts.apply ? 'signed-B-only-approval'
    : 'read-only-B-only-approval-preview',
  planId: prepared.plan.planId,
  requestSha256: prepared.plan.bRetake.newBRequestSha256,
  parentBRejectionSha256: prepared.plan.bRetake.parentBRejectionSha256,
  targetSourceSha256: prepared.plan.bRetake.targetSourceSha256,
  targetReviewSha256: prepared.plan.bRetake.targetReviewSha256,
  ...(signed ? { approvalSha256: signed.approvalSha256 } : {}),
  providerCalls: 0, modelCalls: 0 }, null, 2))
})
