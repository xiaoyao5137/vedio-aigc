#!/usr/bin/env node
/** A separately authored direct original-speed report is mandatory. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readFreshA8B6MediaReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-phases.mjs'
import { readFreshA8B6PhaseAPlan } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { readFreshA8B6ReviewEvidence,
  verifyFreshA8B6ModelReviewLedger,
  saveFreshA8B6ManualReview, saveFreshA8B6Acceptance } from
  '../server/staged-scene-cut-a8b6-fresh-review.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_ACCEPT_INVALID: ${reason}`) }
const args = process.argv.slice(2), opts = { apply: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') {
    if (opts.apply) fail('duplicate --apply')
    opts.apply = true
    continue
  }
  const key = { '--plan-id': 'planId', '--phase': 'phase',
    '--report-file': 'reportFile', '--model-execution-id': 'modelExecutionId',
    '--accepted-frame-index': 'acceptedFrameIndex',
    '--expected-report-sha256': 'reportSha256',
    '--expected-video-sha256': 'videoSha256',
    '--expected-ledger-sha256': 'ledgerSha256' }[args[i]]
  if (!key || opts[key] || !args[i + 1] || args[i + 1].startsWith('--'))
    fail(`invalid or repeated ${args[i]}`)
  opts[key] = args[++i]
}
if (!/^[a-f0-9]{64}$/.test(opts.planId ?? '')
  || !['A', 'B'].includes(opts.phase)
  || !/^qa\/[\w./-]+\.json$/.test(opts.reportFile ?? '')
  || opts.reportFile.includes('..')
  || !/^model-run-[\w-]+$/.test(opts.modelExecutionId ?? '')
  || !/^(0|[1-9]\d*)$/.test(opts.acceptedFrameIndex ?? ''))
  fail('signed plan, native report, model ID and accepted frame index required')
if (opts.apply && [opts.reportSha256, opts.videoSha256,
  opts.ledgerSha256].some(value => !/^[a-f0-9]{64}$/.test(value ?? '')))
  fail('--apply requires reviewed report/video/model-ledger hashes')
const root = process.cwd(), bytes = await readFile(path.join(root,
  opts.reportFile)), reportSha256 = createHash('sha256').update(bytes)
    .digest('hex'), report = JSON.parse(bytes.toString('utf8'))
const APlan = await readFreshA8B6PhaseAPlan(opts.planId, root)
if (APlan.manifest.version === 'staged-a8b6-fresh-A-plan-v2')
  fail('retake A/B requires v3 frame, real-speed playback and audio acceptance')
const { media, native } = await readFreshA8B6MediaReceipt(opts.planId,
  opts.phase, root)
if (Number(opts.acceptedFrameIndex) !== native.lastFrameIndex
  || media.nativeLastFrameIndex !== native.lastFrameIndex)
  fail('accepted frame must be the actual provider-native last frame; an A end guide is generation input only')
const { evidenceSha256 } = await readFreshA8B6ReviewEvidence(opts.planId,
  opts.phase, root)
const model = await verifyFreshA8B6ModelReviewLedger(opts.planId,
  opts.phase, opts.modelExecutionId, root)
if (opts.reportSha256 && opts.reportSha256 !== reportSha256
  || opts.videoSha256 && opts.videoSha256 !== media.videoSha256
  || opts.ledgerSha256 && opts.ledgerSha256 !== model.ledgerSha256
  || report.planId !== opts.planId || report.phase !== opts.phase
  || report.videoSha256 !== media.videoSha256
  || report.evidenceSha256 !== evidenceSha256)
  fail('direct review source or expected hashes changed')
if (!opts.apply) {
  console.log(JSON.stringify({ mode: 'read-only-direct-acceptance-preflight',
    planId: opts.planId, phase: opts.phase,
    videoSha256: media.videoSha256, evidenceSha256,
    reportFile: opts.reportFile, reportSha256,
    reportVerdict: report.verdict,
    acceptedFrameIndex: Number(opts.acceptedFrameIndex),
    nativeLastFrameIndex: native.lastFrameIndex,
    nativeFrameDigestSha256: native.frameDigestSha256,
    modelExecutionId: opts.modelExecutionId,
    ledgerSha256: model.ledgerSha256,
    acceptanceWrites: 0 }, null, 2))
  process.exit(0)
}
const direct = await saveFreshA8B6ManualReview(opts.planId, opts.phase,
  report, root)
const accepted = await saveFreshA8B6Acceptance(opts.planId, opts.phase,
  { modelExecutionId: opts.modelExecutionId,
    reportSha256: direct.sha256,
    acceptedFrameIndex: Number(opts.acceptedFrameIndex) }, root)
console.log(JSON.stringify({ mode: 'signed-new-native-phase-acceptance',
  planId: opts.planId, phase: opts.phase,
  videoSha256: media.videoSha256,
  modelExecutionId: opts.modelExecutionId,
  directReportSha256: direct.sha256,
  acceptanceSha256: accepted.sha256,
  acceptedFrameIndex: accepted.value.acceptedFrameIndex,
  acceptedFrameSha256: accepted.value.acceptedFrameSha256,
  next: opts.phase === 'A' ? 'prepare B from accepted actual native A tail'
    : 'compose original-speed A+B picture and original three TTS tracks' }, null, 2))
