#!/usr/bin/env node
// Inspect a locally archived paid video. --apply creates a lossless-video,
// audio-level-only derivative and provenance manifest; no model or DB calls.
import { applyAudioLevelRemediation, planAudioLevelRemediation } from '../server/audio-level-remediation.ts'

const args = process.argv.slice(2)
let sourceUrl = '', targetLufs, apply = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--source' && args[i + 1]) sourceUrl = args[++i]
  else if (args[i] === '--target-lufs' && args[i + 1]) targetLufs = Number(args[++i])
  else if (args[i] === '--apply') apply = true
  else throw Error('Usage: node scripts/remediate-video-audio-level.mjs --source /generated/video.mp4 [--target-lufs -23] [--apply]')
}
if (!sourceUrl) throw Error('Missing --source /generated/video.mp4')
const plan = await planAudioLevelRemediation(sourceUrl, { targetLufs })
if (!apply) {
  const { videoFrameHashes: _frameHashes, ...source } = plan.source
  console.log(JSON.stringify({ mode: 'dry-run', sourceUrl, source, targetLufs: plan.targetLufs,
    gainDb: plan.gainDb, predictedMeanDbfs: plan.predictedMeanDbfs,
    predictedTruePeakDbfs: plan.predictedTruePeakDbfs, outputUrl: plan.outputUrl,
    manifestUrl: plan.manifestUrl, modelCalls: 0, databaseWrites: 0 }, null, 2))
} else {
  const result = await applyAudioLevelRemediation(plan)
  console.log(JSON.stringify({ mode: 'applied', ...result, modelCalls: 0, databaseWrites: 0 }, null, 2))
}
