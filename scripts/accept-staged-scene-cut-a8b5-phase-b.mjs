#!/usr/bin/env node
// Bind a separately authored direct native/normal-speed report to independent
// model evidence. Cannot accept B unless both reviews and exact seam pass.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readA8B5Plan, readA8B5BMedia, readA8B5BReviewEvidence,
  saveA8B5BManualReview, saveA8B5BAcceptance,
  verifyA8B5BModelReviewLedger } from '../server/staged-scene-cut-a8b5.mjs'

const INVALID = message => { throw Error(`STAGED_A8B5_B_ACCEPT_INVALID: ${message}`) }
const args = process.argv.slice(2), options = { apply: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') {
    if (options.apply) INVALID('duplicate --apply')
    options.apply = true
    continue
  }
  const field = { '--plan-id': 'planId', '--report-file': 'reportFile',
    '--model-execution-id': 'executionId',
    '--expected-report-sha256': 'expectedReportSha256',
    '--expected-video-sha256': 'expectedVideoSha256',
    '--expected-ledger-sha256': 'expectedLedgerSha256' }[args[index]]
  if (!field || options[field] || !args[index + 1] || args[index + 1].startsWith('--'))
    INVALID(`unknown, repeated, or incomplete ${args[index]}`)
  options[field] = args[++index]
}
if (!/^[a-f0-9]{64}$/.test(options.planId ?? '')
  || !/^model-run-[\w-]+$/.test(options.executionId ?? ''))
  INVALID('signed plan and independent model execution ID required')
if (!/^qa\/[\w./-]+\.json$/.test(options.reportFile ?? '')
  || options.reportFile.includes('..'))
  INVALID('direct visual report must be an existing qa/*.json')
if (options.apply && [options.expectedReportSha256, options.expectedVideoSha256,
  options.expectedLedgerSha256].some(value => !/^[a-f0-9]{64}$/.test(value ?? '')))
  INVALID('--apply requires reviewed direct report, B media, and model ledger hashes')

const root = process.cwd()
const reportBytes = await readFile(path.join(root, options.reportFile))
const reportSha256 = createHash('sha256').update(reportBytes).digest('hex')
if (options.expectedReportSha256 && options.expectedReportSha256 !== reportSha256)
  INVALID('direct report changed since review')
const report = JSON.parse(reportBytes.toString('utf8'))
const manifest = await readA8B5Plan(options.planId, root)
const media = await readA8B5BMedia(options.planId, root)
const { evidence, sha256: nativeEvidenceSha256 } =
  await readA8B5BReviewEvidence(options.planId, root)
const model = await verifyA8B5BModelReviewLedger(options.planId, options.executionId, root)
if (options.expectedVideoSha256 && options.expectedVideoSha256 !== media.videoSha256
  || options.expectedLedgerSha256 && options.expectedLedgerSha256 !== model.ledgerSha256
  || report.planId !== options.planId || report.phase !== 'B'
  || report.videoSha256 !== media.videoSha256
  || report.nativeEvidenceSha256 !== nativeEvidenceSha256)
  INVALID('direct B report does not match archived native media/model ledger')
if (!options.apply) {
  console.log(JSON.stringify({ mode: 'read-only-B-acceptance-preflight', planId: options.planId,
    reportFile: options.reportFile, reportSha256, reportVerdict: report.verdict,
    videoSha256: media.videoSha256, nativeEvidenceSha256,
    modelExecutionId: options.executionId, ledgerSha256: model.ledgerSha256,
    modelDecision: model.report.decision, BAcceptanceWrites: 0 }, null, 2))
  process.exit(0)
}
const direct = await saveA8B5BManualReview(options.planId, report, root)
const frame = index => evidence.frames.find(item => item.phase === 'B' && item.index === index)
const last = frame(120), first = frame(0), stitchedFirst = frame(1)
if (!last || !first || !stitchedFirst) INVALID('B0/B1/B120 actual native frames missing')
const review = { verdict: 'accept', manualVerdict: 'accept',
  executionId: options.executionId, ledgerSha256: model.ledgerSha256,
  requestKey: model.requestKey, promptSha256: model.promptSha256,
  manualReviewSha256: direct.sha256 }
const seamReview = { verdict: 'accept', manualVerdict: 'accept',
  ledgerSha256: model.ledgerSha256, manualReviewSha256: direct.sha256,
  phaseAFrameSha256: manifest.sourceAFrame.sha256,
  phaseBFrameSha256: first.sha256,
  phaseBStitchedFirstFrameSha256: stitchedFirst.sha256 }
const acceptance = await saveA8B5BAcceptance(options.planId, {
  version: 'staged-a8b5-B-acceptance-input-v1', planId: options.planId, phase: 'B',
  taskId: media.taskId, videoSha256: media.videoSha256,
  nativeEvidenceSha256, acceptedFrameIndex: 120,
  acceptedFrameSha256: last.sha256, firstFrameSha256: first.sha256,
  stitchedFirstFrameSha256: stitchedFirst.sha256,
  review, checks: report.checks, seamReview }, root)
console.log(JSON.stringify({ mode: 'B-native-seam-accepted', planId: options.planId,
  videoSha256: media.videoSha256, modelExecutionId: options.executionId,
  directReportSha256: direct.sha256,
  acceptedFrameIndex: acceptance.acceptedFrameIndex,
  acceptedFrameSha256: acceptance.acceptedFrameSha256,
  next: '313-frame silent picture and original TTS may now be composed; whole-shot and scene-02 remain pending' }, null, 2))
