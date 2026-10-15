#!/usr/bin/env node
/** Preview or sign B3 after v4 frame clarification and a full 1x watch. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { withV9VerifiedSource } from
  '../server/staged-scene-cut-a8b6-v9-verification-scope.mjs'
import { readFreshA8B6PhaseAPlan } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { readFreshA8B6MediaReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-phases.mjs'
import { readFreshA8B6AudioIsolationV3 } from
  '../server/staged-scene-cut-a8b6-fresh-audio-v3.mjs'
import { B3_FRAME_V4_RECOVERY,
  readFreshA8B6ReviewEvidenceV4,
  verifyFreshA8B6FrameModelLedgerV4 } from
  '../server/staged-scene-cut-a8b6-fresh-review-v4.mjs'
import { assertFreshA8B6PlaybackReportV4,
  saveFreshA8B6PlaybackReviewV4,
  saveFreshA8B6AcceptanceV4 } from
  '../server/staged-scene-cut-a8b6-fresh-acceptance-v4.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_ACCEPT_V4_INVALID: ${reason}`) }
const args = process.argv.slice(2), opts = { apply: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') {
    if (opts.apply) fail('duplicate --apply')
    opts.apply = true
    continue
  }
  const field = { '--plan-id': 'planId', '--phase': 'phase',
    '--report-file': 'reportFile',
    '--frame-model-execution-id': 'modelExecutionId',
    '--accepted-frame-index': 'acceptedFrameIndex',
    '--expected-report-sha256': 'reportSha256',
    '--expected-video-sha256': 'videoSha256',
    '--expected-frame-ledger-sha256': 'ledgerSha256',
    '--expected-audio-isolation-sha256': 'audioIsolationSha256' }[args[index]]
  if (!field || opts[field] || !args[index + 1]
    || args[index + 1].startsWith('--'))
    fail(`invalid or repeated ${args[index]}`)
  opts[field] = args[++index]
}
if (opts.planId !== B3_FRAME_V4_RECOVERY.planId
  || opts.phase !== 'B'
  || !/^qa\/[\w./-]+\.json$/.test(opts.reportFile ?? '')
  || opts.reportFile.includes('..')
  || !/^model-run-[\w-]+$/.test(opts.modelExecutionId ?? '')
  || !/^(0|[1-9]\d*)$/.test(opts.acceptedFrameIndex ?? ''))
  fail('exact B3 plan, direct playback report, v4 model ID and native tail required')
if (opts.apply && [opts.reportSha256, opts.videoSha256,
  opts.ledgerSha256, opts.audioIsolationSha256].some(value =>
  !/^[a-f0-9]{64}$/.test(value ?? '')))
  fail('--apply requires exact report, video, v4 model and audio hashes')

const root = process.cwd()
await withV9VerifiedSource(root, async () => {
  const { manifest } = await readFreshA8B6PhaseAPlan(opts.planId, root)
  if (manifest.version !== 'staged-a8b6-fresh-A-plan-v3'
    || manifest.bRetake?.previousChild?.planId
      !== '543e965c1e3998946788fd1321890e590590537ae5805e0bc4bd9d842dfb3c0b')
    fail('v4 acceptance requires the signed B3-only ancestry')
  const reportBytes = await readFile(path.join(root, opts.reportFile))
  const report = JSON.parse(reportBytes.toString('utf8'))
  const reportSha256 = createHash('sha256')
    .update(reportBytes).digest('hex')
  const { media, mediaSha256, native } = await readFreshA8B6MediaReceipt(
    opts.planId, 'B', root)
  if (Number(opts.acceptedFrameIndex) !== native.lastFrameIndex
    || media.videoSha256 !== B3_FRAME_V4_RECOVERY.videoSha256)
    fail('accepted frame must be the exact B3 video native last frame')
  const { evidenceSha256 } = await readFreshA8B6ReviewEvidenceV4(
    opts.planId, 'B', root)
  const model = await verifyFreshA8B6FrameModelLedgerV4(opts.planId,
    'B', opts.modelExecutionId, root)
  const audio = await readFreshA8B6AudioIsolationV3(opts.planId,
    'B', root)
  if (model.evidenceSha256 !== evidenceSha256
    || audio.receipt.videoSha256 !== media.videoSha256
    || audio.receipt.mediaSha256 !== mediaSha256)
    fail('v4 model or v3 audio proof differs from this B3 media')
  const context = { planId: opts.planId, phase: 'B',
    media, mediaSha256, native, evidenceSha256, model,
    audioIsolationSha256: audio.receiptSha256 }
  assertFreshA8B6PlaybackReportV4(report, context)
  if (opts.reportSha256 && opts.reportSha256 !== reportSha256
    || opts.videoSha256 && opts.videoSha256 !== media.videoSha256
    || opts.ledgerSha256 && opts.ledgerSha256 !== model.ledgerSha256
    || opts.audioIsolationSha256
      && opts.audioIsolationSha256 !== audio.receiptSha256)
    fail('direct report or independently verified source hash changed')
  if (!opts.apply) {
    console.log(JSON.stringify({ mode: 'v4-B3-direct-playback-preview',
      planId: opts.planId, phase: 'B',
      videoSha256: media.videoSha256, evidenceSha256,
      priorV3LedgerSha256: model.priorV3.ledgerSha256,
      reportFile: opts.reportFile, reportSha256,
      playbackSurface: report.playback.surface,
      playbackRate: report.playback.rate,
      modelExecutionId: model.row.id,
      frameLedgerSha256: model.ledgerSha256,
      audioIsolationSha256: audio.receiptSha256,
      acceptedFrameIndex: native.lastFrameIndex,
      nativeFrameDigestSha256: native.frameDigestSha256,
      acceptanceWrites: 0, videoProviderCalls: 0 }, null, 2))
    return
  }
  const manual = await saveFreshA8B6PlaybackReviewV4(opts.planId,
    'B', report, root)
  const accepted = await saveFreshA8B6AcceptanceV4(opts.planId,
    'B', { frameModelExecutionId: opts.modelExecutionId,
      reportSha256: manual.sha256,
      acceptedFrameIndex: native.lastFrameIndex }, root)
  console.log(JSON.stringify({ mode: 'signed-v4-B3-native-acceptance',
    planId: opts.planId, phase: 'B',
    videoSha256: media.videoSha256,
    directReportSha256: manual.sha256,
    frameModelExecutionId: model.row.id,
    priorV3LedgerSha256: model.priorV3.ledgerSha256,
    audioIsolationSha256: audio.receiptSha256,
    acceptedFrameIndex: accepted.value.acceptedFrameIndex,
    acceptedFrameSha256: accepted.value.acceptedFrameSha256,
    acceptanceSha256: accepted.sha256,
    next: 'compose silent original-speed picture and independent narration' },
  null, 2))
})
