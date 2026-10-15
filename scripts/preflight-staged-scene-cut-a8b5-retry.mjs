#!/usr/bin/env node
// Read-only by default; --save-plan writes only a signed retry manifest.
import { planA8B5Retry, saveA8B5RetryPlan } from '../server/staged-scene-cut-a8b5-retry.mjs'

const INVALID = message => { throw Error(`STAGED_A8B5_RETRY_PREFLIGHT_INVALID: ${message}`) }
const SHA = /^[a-f0-9]{64}$/
const args = process.argv.slice(2), options = { save: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--save-plan') {
    if (options.save) INVALID('duplicate --save-plan')
    options.save = true
    continue
  }
  const field = { '--previous-plan-id': 'previousPlanId',
    '--expected-plan-id': 'expectedPlanId',
    '--expected-request-sha256': 'expectedRequestSha256',
    '--expected-previous-B-video-sha256': 'expectedPreviousBVideoSha256',
    '--expected-previous-B-rejection-sha256': 'expectedPreviousBRejectionSha256' }[args[index]]
  if (!field || options[field] || !args[index + 1] || args[index + 1].startsWith('--'))
    INVALID(`unknown, repeated, or incomplete ${args[index]}`)
  options[field] = args[++index]
}
if (!SHA.test(options.previousPlanId ?? '')) INVALID('previous signed plan required')
for (const key of ['expectedPlanId', 'expectedRequestSha256',
  'expectedPreviousBVideoSha256', 'expectedPreviousBRejectionSha256'])
  if (options[key] && !SHA.test(options[key])) INVALID(`${key} invalid`)
if (options.save && (!options.expectedPlanId || !options.expectedRequestSha256
  || !options.expectedPreviousBVideoSha256 || !options.expectedPreviousBRejectionSha256))
  INVALID('--save-plan requires exact plan, request, previous B video and rejection hashes')
const plan = await planA8B5Retry(options.previousPlanId)
if (options.expectedPlanId && plan.planId !== options.expectedPlanId
  || options.expectedRequestSha256 && plan.phaseBPreview.requestSha256 !== options.expectedRequestSha256
  || options.expectedPreviousBVideoSha256
    && plan.source.previousBVideoSha256 !== options.expectedPreviousBVideoSha256
  || options.expectedPreviousBRejectionSha256
    && plan.source.previousBRejectionSha256 !== options.expectedPreviousBRejectionSha256)
  INVALID('reviewed retry identity or rejected source changed')
const saved = options.save ? await saveA8B5RetryPlan(plan) : undefined
console.log(JSON.stringify({ mode: saved ? 'signed-retry-plan-no-provider' : 'read-only-retry-preflight',
  planId: plan.planId, source: plan.source,
  sourceAFrame: plan.sourceAFrame, identityTransport: plan.identityTransport,
  endGuide: plan.endGuide, providerLock: plan.providerLock,
  timeline: plan.timeline, retryStrategy: plan.retryStrategy,
  narrationTracks: plan.narrationTracks.map(track => ({ beatId: track.beatId,
    start: track.start, end: track.end, url: track.url, sha256: track.sha256 })),
  phaseBPreview: plan.phaseBPreview, acceptanceState: plan.acceptanceState,
  ...(saved ? { manifestPath: saved.manifestPath } : {}),
  providerCalls: 0, databaseReads: 0, databaseWrites: 0 }, null, 2))
