#!/usr/bin/env node
/** Inspect then sign the original paid A rejection. Never submits media. */
import { prepareFreshA8B6PhaseARejection,
  saveFreshA8B6PhaseARejection } from
  '../server/staged-scene-cut-a8b6-fresh-A-rejection.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_A_REJECT_CLI_INVALID: ${reason}`) }
const args = process.argv.slice(2), options = { apply: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') {
    if (options.apply) fail('duplicate --apply')
    options.apply = true
    continue
  }
  const field = {
    '--plan-id': 'planId', '--report-file': 'reportFile',
    '--model-execution-id': 'modelExecutionId',
    '--expected-report-sha256': 'reportSha256',
    '--expected-evidence-sha256': 'evidenceSha256',
    '--expected-model-ledger-sha256': 'modelLedgerSha256',
    '--expected-video-sha256': 'videoSha256',
  }[args[index]]
  if (!field || options[field] || !args[index + 1]
    || args[index + 1].startsWith('--'))
    fail(`invalid, repeated or incomplete ${args[index]}`)
  options[field] = args[++index]
}
if (!/^[a-f0-9]{64}$/.test(options.planId ?? '')
  || !/^qa\/[\w./-]+\.json$/.test(options.reportFile ?? '')
  || options.reportFile.includes('..')
  || !/^model-run-[\w-]+$/.test(options.modelExecutionId ?? ''))
  fail('old A plan, repository QA report and independent model run required')
if (options.apply && [options.reportSha256, options.evidenceSha256,
  options.modelLedgerSha256, options.videoSha256].some(value =>
  !/^[a-f0-9]{64}$/.test(value ?? '')))
  fail('--apply requires exact preview report, evidence, model and video hashes')
const input = { planId: options.planId,
  reportFile: options.reportFile,
  modelExecutionId: options.modelExecutionId }
if (!options.apply) {
  const prepared = await prepareFreshA8B6PhaseARejection(input)
  console.log(JSON.stringify({ mode: 'read-only-native-A-rejection-preview',
    planId: options.planId, taskId: prepared.body.taskId,
    videoSha256: prepared.body.videoSha256,
    reportSha256: prepared.reportSha256,
    evidenceSha256: prepared.evidenceSha256,
    modelLedgerSha256: prepared.modelLedgerSha256,
    modelDecision: prepared.body.modelReview.decision,
    reviewEvidenceVariant: prepared.body.reviewEvidenceVariant,
    priorV1EvidenceSha256: prepared.body.priorV1EvidenceSha256 ?? null,
    failedChecks: prepared.body.failedChecks,
    observedNativeFrames: prepared.body.directReview.frameIndices,
    originalSpeedWatchPerformed: false,
    providerCalls: 0, databaseWrites: 0, rejectionWritten: false }, null, 2))
} else {
  const signed = await saveFreshA8B6PhaseARejection(input, {
    reportSha256: options.reportSha256,
    evidenceSha256: options.evidenceSha256,
    modelLedgerSha256: options.modelLedgerSha256,
    videoSha256: options.videoSha256,
  })
  console.log(JSON.stringify({ mode: 'signed-native-A-rejection',
    planId: options.planId, taskId: signed.rejection.taskId,
    videoSha256: signed.rejection.videoSha256,
    rejectionSha256: signed.rejectionSha256,
    modelDecision: signed.rejection.modelReview.decision,
    reviewEvidenceVariant: signed.rejection.reviewEvidenceVariant ?? 'v1',
    failedChecks: signed.rejection.failedChecks,
    nextPaidPhaseBlocked: true,
    originalSpeedWatchPerformed: false,
    providerCalls: 0, databaseWrites: 0 }, null, 2))
}
