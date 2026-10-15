#!/usr/bin/env node
// Read-only by default. --save-plan writes only a source-bound JPEG and a
// signed provisional manifest; it cannot call a provider or accept a shot.
import { planA8B5Continuation, saveA8B5Plan } from '../server/staged-scene-cut-a8b5.mjs'

const INVALID = message => { throw Error(`STAGED_A8B5_PREFLIGHT_INVALID: ${message}`) }
const args = process.argv.slice(2), options = { save: false }
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--save-plan') {
    if (options.save) INVALID('duplicate --save-plan')
    options.save = true
    continue
  }
  const field = { '--base-plan-id': 'basePlanId', '--expected-plan-id': 'expectedPlanId',
    '--expected-request-sha256': 'expectedRequestSha256',
    '--expected-source-video-sha256': 'expectedVideoSha256' }[arg]
  if (!field || options[field] || !args[index + 1] || args[index + 1].startsWith('--'))
    INVALID(`unknown, repeated, or incomplete ${arg}`)
  options[field] = args[++index]
}
for (const name of ['basePlanId', 'expectedPlanId', 'expectedRequestSha256', 'expectedVideoSha256'])
  if (options[name] && !/^[a-f0-9]{64}$/.test(options[name])) INVALID(`${name} invalid`)
if (!options.basePlanId) INVALID('--base-plan-id required')
if (options.save && (!options.expectedPlanId || !options.expectedRequestSha256 || !options.expectedVideoSha256))
  INVALID('--save-plan requires reviewed plan, request, and source-video hashes')

const plan = await planA8B5Continuation(options.basePlanId)
if (options.expectedPlanId && plan.planId !== options.expectedPlanId) INVALID('signed plan candidate changed')
if (options.expectedRequestSha256 && plan.phaseBPreview.requestSha256 !== options.expectedRequestSha256)
  INVALID('B paid request changed')
if (options.expectedVideoSha256 && plan.source.videoSha256 !== options.expectedVideoSha256)
  INVALID('paid source A media changed')
const saved = options.save ? await saveA8B5Plan(plan) : undefined
console.log(JSON.stringify({ mode: options.save ? 'saved-provisional-plan' : 'read-only-preflight',
  planId: plan.planId, source: plan.source, sourceAFrame: plan.sourceAFrame,
  identityTransport: plan.identityTransport, endGuide: plan.endGuide,
  timeline: plan.timeline, scheduleDeviation: plan.scheduleDeviation,
  narrationTracks: plan.narrationTracks.map(track => ({ beatId: track.beatId,
    start: track.start, end: track.end, url: track.url, sha256: track.sha256 })),
  providerLock: plan.providerLock, phaseBPreview: plan.phaseBPreview,
  acceptanceState: plan.acceptanceState,
  ...(saved ? { manifestPath: saved.manifestPath } : {}),
  providerCalls: 0, databaseReads: 0, databaseWrites: 0 }, null, 2))
