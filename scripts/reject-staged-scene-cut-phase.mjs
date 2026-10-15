#!/usr/bin/env node
// Record a source-bound failure without issuing acceptance or another paid task.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readStageMediaReceipt, saveStageRejection } from '../server/staged-scene-cut.mjs'

const fail = message => { throw Error(`STAGED_PHASE_REJECT_INVALID: ${message}`) }
const args = process.argv.slice(2), options = { apply: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') { options.apply = true; continue }
  const key = { '--plan-id': 'planId', '--phase': 'phase', '--report-file': 'reportFile',
    '--expected-report-sha256': 'expectedReportSha256',
    '--expected-video-sha256': 'expectedVideoSha256' }[args[i]]
  if (!key || !args[i + 1] || options[key]) fail(`invalid or repeated ${args[i]}`)
  options[key] = args[++i]
}
if (!/^[a-f0-9]{64}$/.test(options.planId ?? '') || !['A', 'B'].includes(options.phase)
  || !/^qa\/[\w./-]+\.json$/.test(options.reportFile ?? '')
  || options.reportFile.includes('..')) fail('signed plan, phase and qa report required')
if (options.apply && (!/^[a-f0-9]{64}$/.test(options.expectedReportSha256 ?? '')
  || !/^[a-f0-9]{64}$/.test(options.expectedVideoSha256 ?? '')))
  fail('--apply requires exact reviewed report and video SHA-256')
const root = process.cwd(), media = await readStageMediaReceipt(options.planId, options.phase, root)
const bytes = await readFile(path.join(root, options.reportFile))
const reportSha256 = createHash('sha256').update(bytes).digest('hex')
if (options.expectedReportSha256 && options.expectedReportSha256 !== reportSha256
  || options.expectedVideoSha256 && options.expectedVideoSha256 !== media.videoSha256)
  fail('report or paid video changed')
const report = JSON.parse(bytes.toString('utf8'))
if (report.planId !== options.planId || report.phase !== options.phase
  || report.videoSha256 !== media.videoSha256 || report.verdict !== 'reject')
  fail('rejection report does not bind this paid native clip')
if (!options.apply) {
  console.log(JSON.stringify({ mode: 'read-only-rejection-preflight', planId: options.planId,
    phase: options.phase, videoSha256: media.videoSha256,
    reportFile: options.reportFile, reportSha256, reason: report.reason,
    acceptanceWritten: false, providerCalls: 0, databaseWrites: 0 }, null, 2))
  process.exit(0)
}
const rejection = await saveStageRejection(options.planId, options.phase, report, root)
console.log(JSON.stringify({ mode: 'signed-stage-rejection', planId: options.planId,
  phase: options.phase, videoSha256: media.videoSha256, reportSha256,
  rejectionSignature: rejection.signature, nextPaidPhaseBlocked: true,
  paidClipPreserved: true }, null, 2))
