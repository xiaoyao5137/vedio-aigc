#!/usr/bin/env node
/** V9 A retake preview. A saved plan requires old A rejection, independent
 * target review, and a separately signed approval for the exact four images. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planFreshA8B6PhaseARetake,
  saveFreshA8B6PhaseAPlan } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { withV9VerifiedSource } from
  '../server/staged-scene-cut-a8b6-v9-verification-scope.mjs'

const fail = reason => { throw Error(`A8B6_A_RETAKE_PREFLIGHT_INVALID: ${reason}`) }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2), opts = { save: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--save-plan') {
    if (opts.save) fail('duplicate --save-plan')
    opts.save = true
    continue
  }
  const key = { '--expected-plan-id': 'planId',
    '--expected-request-sha256': 'requestSha256',
    '--expected-parent-rejection-sha256': 'rejectionSha256',
    '--expected-target-review-sha256': 'targetReviewSha256',
    '--expected-target-amendment-sha256': 'targetAmendmentSha256',
    '--expected-end-frame-sha256': 'endFrameSha256' }[args[i]]
  if (!key || opts[key] || !/^[a-f0-9]{64}$/.test(args[i + 1] ?? ''))
    fail(`invalid ${args[i]}`)
  opts[key] = args[++i]
}
if (opts.save && [opts.planId, opts.requestSha256,
  opts.rejectionSha256, opts.targetReviewSha256,
  opts.targetAmendmentSha256,
  opts.endFrameSha256].some(value => !value))
  fail('--save-plan requires all reviewed source, review and request locks')
await withV9VerifiedSource(root, async () => {
const plan = await planFreshA8B6PhaseARetake(root)
if (opts.planId && opts.planId !== plan.planId
  || opts.requestSha256 && opts.requestSha256
    !== plan.phaseAPreview.requestSha256
  || opts.rejectionSha256 && opts.rejectionSha256
    !== plan.retake.parentRejectionSha256
  || opts.targetReviewSha256 && opts.targetReviewSha256
    !== plan.retake.targetReviewSha256
  || opts.targetAmendmentSha256 && opts.targetAmendmentSha256
    !== plan.retake.targetPromptAmendmentSha256
  || opts.endFrameSha256 && opts.endFrameSha256
    !== plan.phaseA.endFrame.sha256)
  fail('reviewed retake request or ancestry changed')
const saved = opts.save ? await saveFreshA8B6PhaseAPlan(plan, root) : undefined
console.log(JSON.stringify({ mode: opts.save ? 'signed-A-retake-v2-plan'
  : 'read-only-A-retake-v2-request-preview',
  planId: plan.planId, parentPlanId: plan.retake.parentPlanId,
  parentTaskId: plan.retake.parentTaskId,
  parentVideoSha256: plan.retake.parentVideoSha256,
  parentRejectionSha256: plan.retake.parentRejectionSha256,
  targetSourceReceiptSha256: plan.retake.targetSourceReceiptSha256,
  targetReviewSha256: plan.retake.targetReviewSha256,
  targetPromptAmendmentSha256: plan.retake.targetPromptAmendmentSha256,
  endFrame: plan.phaseA.endFrame,
  phaseAPreview: plan.phaseAPreview,
  providerLock: plan.providerLock,
  compactTransport: { totalBytes: plan.compactTransport.totalBytes,
    entries: plan.compactTransport.entries.map(entry => ({
      role: entry.role, sourceSha256: entry.source.sha256,
      transportSha256: entry.transport.sha256,
      bytes: entry.transport.byteLength })) },
  ...(saved ? { manifestSha256: saved.manifestSha256,
    manifestPath: saved.manifestPath } : {}),
  providerCalls: 0, databaseWrites: 0 }, null, 2))
})
