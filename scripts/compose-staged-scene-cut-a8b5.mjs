#!/usr/bin/env node
// Native A0–192 + B1–120, mute all provider sound, restore original three TTS
// tracks. Requires B independent/direct native and seam acceptance first.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { composeA8B5SceneCut, readA8B5BAcceptance,
  readA8B5Plan } from '../server/staged-scene-cut-a8b5.mjs'

const INVALID = message => { throw Error(`STAGED_A8B5_COMPOSE_INVALID: ${message}`) }
const args = process.argv.slice(2), options = { apply: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') {
    if (options.apply) INVALID('duplicate --apply')
    options.apply = true
    continue
  }
  const field = { '--plan-id': 'planId',
    '--expected-B-acceptance-sha256': 'expectedAcceptanceSha256' }[args[index]]
  if (!field || options[field] || !args[index + 1] || args[index + 1].startsWith('--'))
    INVALID(`unknown, repeated, or incomplete ${args[index]}`)
  options[field] = args[++index]
}
if (!/^[a-f0-9]{64}$/.test(options.planId ?? '')) INVALID('signed plan ID required')
if (options.apply && !/^[a-f0-9]{64}$/.test(options.expectedAcceptanceSha256 ?? ''))
  INVALID('--apply requires reviewed signed B acceptance SHA-256')
const root = process.cwd(), manifest = await readA8B5Plan(options.planId, root)
const B = await readA8B5BAcceptance(options.planId, root)
const acceptanceFile = path.join(root, '.runtime/staged-scene-cut-a8b5',
  options.planId, 'phase-B-acceptance.json')
const acceptanceSha256 = createHash('sha256').update(await readFile(acceptanceFile)).digest('hex')
if (options.expectedAcceptanceSha256 && options.expectedAcceptanceSha256 !== acceptanceSha256)
  INVALID('B native acceptance changed since review')
if (!options.apply) {
  console.log(JSON.stringify({ mode: 'read-only-composite-preflight', planId: options.planId,
    sourceAVideoSha256: manifest.source.videoSha256, phaseBVideoSha256: B.videoSha256,
    AEndFrame: 192, BSourceFrames: [1, 120], deliveredFrames: 313,
    sourceAudioPolicy: 'full mute', narrationTrackSha256s: manifest.narrationTracks.map(track => track.sha256),
    acceptanceSha256, providerCalls: 0, databaseWrites: 0, compositeWrites: 0 }, null, 2))
  process.exit(0)
}
const { receipt, receiptSha256 } = await composeA8B5SceneCut(options.planId, root)
console.log(JSON.stringify({ mode: 'source-bound-A8B5-composed', planId: options.planId,
  receiptSha256, picture: receipt.picture, output: receipt.output,
  fullShotReview: receipt.review.wholeShot,
  next: 'fork original workflow and run whole-shot node58, then regenerate/review scene-02' }, null, 2))
