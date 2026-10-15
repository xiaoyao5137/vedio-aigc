#!/usr/bin/env node
// Sign a direct, source-frame-bound provisional A observation. This is never
// an A acceptance and cannot claim the full shot or the two-shot cut passed.
import { readFile } from 'node:fs/promises'
import { readA8B5Plan, saveA8B5ProvisionalReview } from '../server/staged-scene-cut-a8b5.mjs'

const INVALID = message => { throw Error(`STAGED_A8B5_REVIEW_INVALID: ${message}`) }
const args = process.argv.slice(2), options = { apply: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--apply') {
    if (options.apply) INVALID('duplicate --apply')
    options.apply = true
    continue
  }
  const field = { '--plan-id': 'planId', '--report': 'reportFile' }[args[index]]
  if (!field || options[field] || !args[index + 1] || args[index + 1].startsWith('--'))
    INVALID(`unknown, repeated, or incomplete ${args[index]}`)
  options[field] = args[++index]
}
if (!/^[a-f0-9]{64}$/.test(options.planId ?? '') || !options.reportFile)
  INVALID('--plan-id and --report required')
const manifest = await readA8B5Plan(options.planId)
const report = JSON.parse(await readFile(options.reportFile, 'utf8'))
if (!options.apply) {
  console.log(JSON.stringify({ mode: 'read-only-review-preview', planId: manifest.planId,
    reportVersion: report.version, sourceVideoSha256: report.sourceVideoSha256,
    reportedVerdict: report.verdict, checks: report.checks,
    frameIndices: report.frames?.map(frame => frame.index),
    sourceAccepted: false, providerCalls: 0, databaseWrites: 0 }, null, 2))
} else {
  const signed = await saveA8B5ProvisionalReview(options.planId, report)
  console.log(JSON.stringify({ mode: 'signed-provisional-A-review', planId: manifest.planId,
    sourceVideoSha256: signed.sourceVideoSha256, verdict: signed.verdict,
    sourceAccepted: false, BStillUnreviewed: true,
    providerCalls: 0, databaseWrites: 0 }, null, 2))
}
