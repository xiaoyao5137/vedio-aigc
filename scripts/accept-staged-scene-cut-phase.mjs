#!/usr/bin/env node
// Read and bind a separately authored direct visual report; never invent one.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readStageAcceptance, readStageMediaReceipt, readStageReviewEvidence,
  saveStageManualReview, saveStageAcceptance, verifyStageModelReviewLedger } from '../server/staged-scene-cut.mjs'

const fail = message => { throw Error(`STAGED_PHASE_ACCEPT_INVALID: ${message}`) }
const args = process.argv.slice(2), options = { apply: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') { options.apply = true; continue }
  const key = { '--plan-id': 'planId', '--phase': 'phase', '--report-file': 'reportFile',
    '--model-execution-id': 'modelExecutionId', '--expected-report-sha256': 'expectedReportSha256',
    '--expected-video-sha256': 'expectedVideoSha256',
    '--expected-ledger-sha256': 'expectedLedgerSha256' }[args[index]]
  if (!key || !args[index + 1] || options[key]) fail(`invalid or repeated ${args[index]}`)
  options[key] = args[++index]
}
if (!/^[a-f0-9]{64}$/.test(options.planId ?? '') || !['A', 'B'].includes(options.phase)
  || !/^model-run-[\w-]+$/.test(options.modelExecutionId ?? ''))
  fail('signed plan ID, phase and real model execution ID required')
if (typeof options.reportFile !== 'string' || !/^qa\/[\w./-]+\.json$/.test(options.reportFile)
  || options.reportFile.includes('..')) fail('report file must be an existing qa/*.json')
if (options.apply && [options.expectedReportSha256, options.expectedVideoSha256,
  options.expectedLedgerSha256].some(value => !/^[a-f0-9]{64}$/.test(value ?? '')))
  fail('--apply requires reviewed report, video and model ledger SHA-256')
const root = process.cwd()
const reportBytes = await readFile(path.join(root, options.reportFile))
const reportSha256 = createHash('sha256').update(reportBytes).digest('hex')
if (options.expectedReportSha256 && options.expectedReportSha256 !== reportSha256)
  fail('direct visual report changed since approval')
const report = JSON.parse(reportBytes.toString('utf8'))
const media = await readStageMediaReceipt(options.planId, options.phase, root)
if (options.expectedVideoSha256 && options.expectedVideoSha256 !== media.videoSha256)
  fail('native video changed since approval')
const { evidence, sha256: nativeEvidenceSha256 } = await readStageReviewEvidence(options.planId, options.phase, root)
const model = await verifyStageModelReviewLedger(options.planId, options.phase,
  options.modelExecutionId, root)
if (options.expectedLedgerSha256 && options.expectedLedgerSha256 !== model.ledgerSha256)
  fail('model ledger changed since approval')
if (report.planId !== options.planId || report.phase !== options.phase
  || report.videoSha256 !== media.videoSha256
  || report.nativeEvidenceSha256 !== nativeEvidenceSha256)
  fail('direct report is not bound to current native frames')
if (!options.apply) {
  console.log(JSON.stringify({ mode: 'read-only-acceptance-preflight', planId: options.planId,
    phase: options.phase, reportFile: options.reportFile, reportSha256,
    reportVerdict: report.verdict, videoSha256: media.videoSha256,
    nativeEvidenceSha256, modelExecutionId: options.modelExecutionId,
    ledgerSha256: model.ledgerSha256, modelDecision: model.report.decision,
    stageAcceptanceWrites: 0 }, null, 2))
  process.exit(0)
}
const direct = await saveStageManualReview(options.planId, options.phase, report, root)
const phase = options.phase
const accepted = evidence.frames.find(frame => frame.phase === phase
  && frame.frameIndex === (phase === 'A' ? 180 : 132))
const firstB = phase === 'B' ? evidence.frames.find(frame => frame.phase === 'B' && frame.frameIndex === 0) : null
const stitchedFirstB = phase === 'B' ? evidence.frames.find(frame => frame.phase === 'B' && frame.frameIndex === 1) : null
if (!accepted || phase === 'B' && (!firstB || !stitchedFirstB)) fail('required real native review frames absent')
const review = { verdict: 'accept', manualVerdict: 'accept',
  executionId: options.modelExecutionId, ledgerSha256: model.ledgerSha256,
  requestKey: model.requestKey, promptSha256: model.promptSha256,
  manualReviewSha256: direct.sha256 }
let seamReview
if (phase === 'B') {
  const A = await readStageAcceptance(options.planId, 'A', root)
  seamReview = { verdict: 'accept', manualVerdict: 'accept',
    ledgerSha256: model.ledgerSha256, manualReviewSha256: direct.sha256,
    phaseAFrameSha256: A.acceptedFrameSha256, phaseBFrameSha256: firstB.sha256,
    phaseBStitchedFirstFrameSha256: stitchedFirstB.sha256 }
}
const acceptance = await saveStageAcceptance(options.planId, { phase, taskId: media.taskId,
  videoUrl: media.videoUrl, videoSha256: media.videoSha256,
  nativeEvidenceSha256, acceptedFrameIndex: accepted.frameIndex,
  acceptedFrameSha256: accepted.sha256,
  ...(firstB ? { firstFrameSha256: firstB.sha256,
    stitchedFirstFrameSha256: stitchedFirstB.sha256 } : {}),
  review, checks: report.checks, ...(seamReview ? { seamReview } : {}) }, root)
console.log(JSON.stringify({ mode: 'stage-native-accepted', planId: options.planId, phase,
  videoSha256: media.videoSha256, modelExecutionId: options.modelExecutionId,
  ledgerSha256: model.ledgerSha256, directReportSha256: direct.sha256,
  acceptedFrameIndex: acceptance.acceptedFrameIndex,
  acceptedFrameSha256: acceptance.acceptedFrameSha256,
  next: phase === 'A' ? 'phase B provider request may now be prepared' : '313-frame silent picture and unchanged TTS may now be composed' }, null, 2))
