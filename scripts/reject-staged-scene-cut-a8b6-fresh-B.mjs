#!/usr/bin/env node
/** Preview, then write once the failed paid B continuity decision. */
import { prepareFreshA8B6PhaseBRejection,
  saveFreshA8B6PhaseBRejection, REJECTED_B_PLAN_ID } from
  '../server/staged-scene-cut-a8b6-fresh-B-rejection.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_B_REJECT_CLI_INVALID: ${reason}`) }
const args = process.argv.slice(2)
const options = { apply: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') {
    if (options.apply) fail('duplicate --apply')
    options.apply = true
    continue
  }
  const field = {
    '--plan-id': 'planId', '--report-file': 'reportFile',
    '--expected-report-sha256': 'reportSha256',
    '--expected-media-sha256': 'mediaSha256',
    '--expected-phase-B-plan-sha256': 'phaseBPlanSha256',
    '--expected-audio-isolation-sha256': 'audioIsolationSha256',
    '--expected-audio-probe-sha256': 'audioProbeSha256',
    '--expected-video-sha256': 'videoSha256',
  }[args[index]]
  if (!field || options[field] || !args[index + 1]
    || args[index + 1].startsWith('--'))
    fail(`invalid, repeated or incomplete ${args[index]}`)
  options[field] = args[++index]
}
if (!/^[a-f0-9]{64}$/.test(options.planId ?? '')
  || !/^qa\/staged-scene-cut\/[\w.-]+\.json$/.test(options.reportFile ?? ''))
  fail('failed B plan and repository QA report required')
if (options.apply && [options.reportSha256, options.mediaSha256,
  options.phaseBPlanSha256, options.videoSha256,
  options.planId === REJECTED_B_PLAN_ID
    ? options.audioIsolationSha256 : options.audioProbeSha256]
  .some(item => !/^[a-f0-9]{64}$/.test(item ?? '')))
  fail('--apply requires exact preview hashes')
const input = { planId: options.planId, reportFile: options.reportFile }
if (!options.apply) {
  const prepared = await prepareFreshA8B6PhaseBRejection(input)
  console.log(JSON.stringify({ mode: 'read-only-native-B-rejection-preview',
    planId: input.planId, taskId: prepared.body.taskId,
    videoSha256: prepared.body.videoSha256,
    reportSha256: prepared.reportSha256,
    mediaSha256: prepared.mediaSha256,
    phaseBPlanSha256: prepared.phaseBPlanSha256,
    audioIsolationSha256: prepared.audioIsolationSha256 ?? null,
    audioProbeSha256: prepared.audioProbeSha256 ?? null,
    audioProbeStatus: prepared.body.audioProbe?.status ?? null,
    failedChecks: prepared.body.failedChecks,
    observedNativeFrames: prepared.body.nativeFrames.map(item => item.frameIndex),
    originalSpeedWatchPerformed: true,
    providerCalls: 0, modelCalls: 0, databaseWrites: 0,
    rejectionWritten: false }, null, 2))
} else {
  const signed = await saveFreshA8B6PhaseBRejection(input, {
    reportSha256: options.reportSha256,
    mediaSha256: options.mediaSha256,
    phaseBPlanSha256: options.phaseBPlanSha256,
    ...(options.planId === REJECTED_B_PLAN_ID
      ? { audioIsolationSha256: options.audioIsolationSha256 }
      : { audioProbeSha256: options.audioProbeSha256 }),
    videoSha256: options.videoSha256 })
  console.log(JSON.stringify({ mode: 'signed-native-B-rejection',
    planId: input.planId, taskId: signed.rejection.taskId,
    videoSha256: signed.rejection.videoSha256,
    rejectionSha256: signed.rejectionSha256,
    failedChecks: signed.rejection.failedChecks,
    nextPaidPhaseBlocked: true,
    providerCalls: 0, modelCalls: 0, databaseWrites: 0 }, null, 2))
}
