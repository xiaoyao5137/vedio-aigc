#!/usr/bin/env node
// Read-only by default. Rendering stays in /tmp. --save-plan only writes a
// byte-bound local derivative and manifest after exact reviewed hashes match.
import os from 'node:os'
import path from 'node:path'
import { planSalvageA, saveSalvagePlan } from '../server/staged-scene-cut-salvage.mjs'

const fail = message => { throw Error(`STAGED_SALVAGE_PREFLIGHT_INVALID: ${message}`) }
const options = { savePlan: false }
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--save-plan') { options.savePlan = true; continue }
  const key = { '--source-plan-id': 'sourcePlanId', '--expected-plan-id': 'expectedPlanId',
    '--expected-source-video-sha256': 'expectedSourceVideoSha256',
    '--expected-rejection-sha256': 'expectedRejectionSha256',
    '--expected-derived-video-sha256': 'expectedDerivedVideoSha256' }[args[index]]
  if (!key || !args[index + 1] || options[key]) fail(`invalid or repeated ${args[index]}`)
  options[key] = args[++index]
}
const sha = /^[a-f0-9]{64}$/
if (!sha.test(options.sourcePlanId ?? '')) fail('signed rejected v2 source plan ID required')
if (options.savePlan && [options.expectedPlanId, options.expectedSourceVideoSha256,
  options.expectedRejectionSha256, options.expectedDerivedVideoSha256]
  .some(value => !sha.test(value ?? '')))
  fail('--save-plan requires all four reviewed hashes')
const root = process.cwd()
const outputPath = path.join(os.tmpdir(), `staged-salvage-${options.sourcePlanId.slice(0, 16)}`,
  'a-frame-drop-lossless.mp4')
const plan = await planSalvageA(options.sourcePlanId, outputPath, root)
const { source, derivedA, transform } = plan.salvage
for (const [actual, expected, label] of [
  [plan.planId, options.expectedPlanId, 'plan ID'],
  [source.videoSha256, options.expectedSourceVideoSha256, 'source video'],
  [source.parentRejectionSha256, options.expectedRejectionSha256, 'signed rejection'],
  [derivedA.sha256, options.expectedDerivedVideoSha256, 'derived video'],
]) if (expected && actual !== expected) fail(`${label} changed since review`)
const summary = { mode: options.savePlan ? 'saved-local-salvage-plan' : 'read-only-salvage-preflight',
  planId: plan.planId, sourceRecordId: plan.sourceRecordId, sourceResultMd5: plan.sourceResultMd5,
  approvedShotSha256: plan.approvedShotSha256, approvalSha256: plan.approvalSha256,
  source, transform, derivedA, temporaryVideoPath: outputPath,
  narration: plan.narrationTracks.map(track => ({ beatId: track.beatId,
    start: track.start, end: track.end, sha256: track.sha256 })),
  phaseB: { providerSeconds: 6, acceptedSeconds: 5.5,
    firstFrame: 'exact derived A frame 180, which is decoded-pixel identical to paid source frame 192',
    stopBeforeGlobalSeconds: 9.5, requestAllowedAfter: 'independent model and direct accepted A review' },
  providerCalls: 0, databaseReads: 0, databaseWrites: 0, stageAcceptanceWritten: false }
if (options.savePlan) summary.saved = await saveSalvagePlan(plan, root)
console.log(JSON.stringify(summary, null, 2))
