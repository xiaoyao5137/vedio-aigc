#!/usr/bin/env node
// Bind a separately authored direct viewing report and an actual independent
// model ledger. Neither this script nor the model prompt invents an accept.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readSalvagePlan, readSalvageAReviewEvidence, verifySalvageAModelLedger,
  saveSalvageAManualReview, saveSalvageAAcceptance } from '../server/staged-scene-cut-salvage.mjs'

const fail = message => { throw Error(`STAGED_SALVAGE_ACCEPT_INVALID: ${message}`) }
const options = { apply: false }, args = process.argv.slice(2)
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') { options.apply = true; continue }
  const key = { '--plan-id': 'planId', '--report-file': 'reportFile',
    '--model-execution-id': 'modelExecutionId', '--expected-report-sha256': 'expectedReportSha256',
    '--expected-video-sha256': 'expectedVideoSha256',
    '--expected-ledger-sha256': 'expectedLedgerSha256' }[args[index]]
  if (!key || !args[index + 1] || options[key]) fail(`invalid or repeated ${args[index]}`)
  options[key] = args[++index]
}
const SHA = /^[a-f0-9]{64}$/
if (!SHA.test(options.planId ?? '') || !/^model-run-[\w-]+$/.test(options.modelExecutionId ?? '')
  || !/^qa\/[\w./-]+\.json$/.test(options.reportFile ?? '')
  || options.reportFile.includes('..')) fail('signed plan, real model execution and qa report required')
if (options.apply && [options.expectedReportSha256, options.expectedVideoSha256,
  options.expectedLedgerSha256].some(value => !SHA.test(value ?? '')))
  fail('--apply requires reviewed report, derivative video and model ledger SHA-256')
const root = process.cwd()
const reportBytes = await readFile(path.join(root, options.reportFile))
const reportSha256 = createHash('sha256').update(reportBytes).digest('hex')
if (options.expectedReportSha256 && options.expectedReportSha256 !== reportSha256)
  fail('direct visual report changed since approval')
const report = JSON.parse(reportBytes.toString('utf8'))
const manifest = await readSalvagePlan(options.planId, root)
const videoSha256 = manifest.salvage.derivedA.sha256
if (options.expectedVideoSha256 && options.expectedVideoSha256 !== videoSha256)
  fail('derived video changed since approval')
const { sha256: nativeEvidenceSha256 } = await readSalvageAReviewEvidence(options.planId, root)
const model = await verifySalvageAModelLedger(options.planId, options.modelExecutionId, root)
if (options.expectedLedgerSha256 && options.expectedLedgerSha256 !== model.ledgerSha256)
  fail('independent model ledger changed since approval')
if (report.planId !== options.planId || report.phase !== 'A'
  || report.videoSha256 !== videoSha256 || report.nativeEvidenceSha256 !== nativeEvidenceSha256)
  fail('direct report is not bound to current derivative frames')
if (!options.apply) {
  console.log(JSON.stringify({ mode: 'read-only-salvage-A-acceptance-preflight', planId: options.planId,
    reportFile: options.reportFile, reportSha256, reportVerdict: report.verdict,
    videoSha256, nativeEvidenceSha256, modelExecutionId: options.modelExecutionId,
    ledgerSha256: model.ledgerSha256, modelDecision: model.report.decision,
    stageAcceptanceWrites: 0 }, null, 2))
  process.exit(0)
}
const manual = await saveSalvageAManualReview(options.planId, report, root)
const accepted = await saveSalvageAAcceptance(options.planId, {
  executionId: options.modelExecutionId, videoSha256, nativeEvidenceSha256,
  ledgerSha256: model.ledgerSha256, manualReviewSha256: manual.sha256 }, root)
console.log(JSON.stringify({ mode: 'salvage-A-accepted-as-derived-source', planId: options.planId,
  videoSha256, sourceRejectedVideoSha256: manifest.salvage.source.videoSha256,
  sourceRejectionSha256: manifest.salvage.source.parentRejectionSha256,
  modelExecutionId: options.modelExecutionId, ledgerSha256: model.ledgerSha256,
  directReportSha256: manual.sha256, acceptedFrameIndex: accepted.acceptedFrameIndex,
  acceptedFrameSha256: accepted.acceptedFrameSha256,
  next: 'phase B provider request may now be prepared and separately reviewed' }, null, 2))
