#!/usr/bin/env node
// Read-only unless --apply binds exact reviewed report and archived paid clip.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readA8B5BMedia, saveA8B5BRejection,
  readA8B5BRejection } from '../server/staged-scene-cut-a8b5.mjs'

const INVALID = message => { throw Error(`STAGED_A8B5_B_REJECT_INVALID: ${message}`) }
const SHA = /^[a-f0-9]{64}$/
const args = process.argv.slice(2), options = { apply: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') {
    if (options.apply) INVALID('duplicate --apply')
    options.apply = true
    continue
  }
  const field = { '--plan-id': 'planId', '--report-file': 'reportFile',
    '--expected-report-sha256': 'expectedReportSha256',
    '--expected-video-sha256': 'expectedVideoSha256' }[args[index]]
  if (!field || options[field] || !args[index + 1] || args[index + 1].startsWith('--'))
    INVALID(`invalid, repeated or incomplete ${args[index]}`)
  options[field] = args[++index]
}
if (!SHA.test(options.planId ?? '') || !/^qa\/[\w./-]+\.json$/.test(options.reportFile ?? '')
  || options.reportFile.includes('..')) INVALID('plan ID and repository qa report required')
if (options.apply && (!SHA.test(options.expectedReportSha256 ?? '')
  || !SHA.test(options.expectedVideoSha256 ?? '')))
  INVALID('--apply requires exact reviewed report and video hashes')
const root = process.cwd(), media = await readA8B5BMedia(options.planId, root)
const bytes = await readFile(path.join(root, options.reportFile))
const reportSha256 = createHash('sha256').update(bytes).digest('hex')
if (options.expectedReportSha256 && options.expectedReportSha256 !== reportSha256
  || options.expectedVideoSha256 && options.expectedVideoSha256 !== media.videoSha256)
  INVALID('report or paid video changed')
const report = JSON.parse(bytes.toString('utf8'))
if (report.planId !== options.planId || report.phase !== 'B'
  || report.videoSha256 !== media.videoSha256 || report.verdict !== 'reject')
  INVALID('report does not bind this B provider result')
if (!options.apply) {
  console.log(JSON.stringify({ mode: 'read-only-B-rejection-preflight',
    planId: options.planId, taskId: media.taskId,
    videoSha256: media.videoSha256, nativeFrameDigestSha256: media.nativeFrameDigestSha256,
    reportFile: options.reportFile, reportSha256,
    frameIndices: report.frames?.map(frame => frame.index), reason: report.reason,
    acceptanceWritten: false, providerCalls: 0, databaseWrites: 0 }, null, 2))
  process.exit(0)
}
await saveA8B5BRejection(options.planId, report, root)
const signed = await readA8B5BRejection(options.planId, root)
console.log(JSON.stringify({ mode: 'signed-B-rejection', planId: options.planId,
  taskId: media.taskId, videoSha256: media.videoSha256, reportSha256,
  signedReceiptSha256: signed.sha256, rejectionSignature: signed.report.signature,
  nextPaidPhaseBlocked: true, providerCalls: 0, databaseWrites: 0 }, null, 2))
