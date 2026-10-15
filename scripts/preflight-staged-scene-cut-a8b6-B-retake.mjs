#!/usr/bin/env node
/** Read-only B-only child preview or write-once signed child manifest. */
import { planFreshA8B6PhaseBRetake } from
  '../server/staged-scene-cut-a8b6-B-retake-plan.mjs'
import { saveFreshA8B6PhaseAPlan } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { withV9VerifiedSource } from
  '../server/staged-scene-cut-a8b6-v9-verification-scope.mjs'

const fail = reason => { throw Error(`A8B6_B_RETAKE_PREFLIGHT_INVALID: ${reason}`) }
const args = process.argv.slice(2), opts = { save: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--save-plan') {
    if (opts.save) fail('duplicate --save-plan')
    opts.save = true
    continue
  }
  const key = { '--parent-plan-id': 'parentPlanId',
    '--expected-plan-id': 'planId',
    '--expected-B-request-sha256': 'requestSha256',
    '--expected-parent-B-rejection-sha256': 'rejectionSha256',
    '--expected-target-source-sha256': 'sourceSha256',
    '--expected-target-review-sha256': 'reviewSha256' }[args[i]]
  if (!key || opts[key] || !/^[a-f0-9]{64}$/.test(args[i + 1] ?? ''))
    fail(`invalid ${args[i]}`)
  opts[key] = args[++i]
}
if (!/^[a-f0-9]{64}$/.test(opts.parentPlanId ?? ''))
  fail('rejected parent B plan required')
if (opts.save && [opts.planId, opts.requestSha256,
  opts.rejectionSha256, opts.sourceSha256,
  opts.reviewSha256].some(value => !value))
  fail('saving child requires reviewed plan, request, rejection and guide locks')
await withV9VerifiedSource(process.cwd(), async () => {
const plan = await planFreshA8B6PhaseBRetake(opts.parentPlanId)
if (opts.planId && opts.planId !== plan.planId
  || opts.requestSha256 && opts.requestSha256
    !== plan.bRetake.newBRequestSha256
  || opts.rejectionSha256 && opts.rejectionSha256
    !== plan.bRetake.parentBRejectionSha256
  || opts.sourceSha256 && opts.sourceSha256
    !== plan.bRetake.targetSourceSha256
  || opts.reviewSha256 && opts.reviewSha256
    !== plan.bRetake.targetReviewSha256)
  fail('reviewed B-only ancestry or request changed')
const saved = opts.save ? await saveFreshA8B6PhaseAPlan(plan) : undefined
console.log(JSON.stringify({ mode: opts.save
    ? 'signed-B-only-retake-child-plan' : 'read-only-B-only-retake-preview',
  planId: plan.planId, bRetake: plan.bRetake,
  phaseBRetake: plan.phaseBRetake,
  phaseBRetakePreview: plan.phaseBRetakePreview,
  providerLock: plan.providerLock,
  ...(saved ? { manifestSha256: saved.manifestSha256,
    manifestPath: saved.manifestPath } : {}),
  providerCalls: 0, modelCalls: 0,
}, null, 2))
})
