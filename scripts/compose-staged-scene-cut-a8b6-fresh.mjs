#!/usr/bin/env node
/** Original-speed A+B composition, gated by both signed native acceptances. */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { prepareFreshA8B6Composite, composeFreshA8B6 } from
  '../server/staged-scene-cut-a8b6-fresh-composite.mjs'
import { freshA8B6Directory } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { withV9VerifiedSource } from
  '../server/staged-scene-cut-a8b6-v9-verification-scope.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_COMPOSE_INVALID: ${reason}`) }
const args = process.argv.slice(2), opts = { apply: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') {
    if (opts.apply) fail('duplicate --apply')
    opts.apply = true
    continue
  }
  const key = { '--plan-id': 'planId',
    '--expected-A-acceptance-sha256': 'ASha256',
    '--expected-B-acceptance-sha256': 'BSha256' }[args[i]]
  if (!key || opts[key] || !args[i + 1] || args[i + 1].startsWith('--'))
    fail(`invalid or repeated ${args[i]}`)
  opts[key] = args[++i]
}
if (!/^[a-f0-9]{64}$/.test(opts.planId ?? ''))
  fail('signed fresh plan ID required')
if (opts.apply && [opts.ASha256, opts.BSha256]
  .some(value => !/^[a-f0-9]{64}$/.test(value ?? '')))
  fail('--apply requires reviewed A and B acceptance hashes')
const root = process.cwd()
const candidate = JSON.parse(await readFile(path.join(
  freshA8B6Directory(opts.planId, root), 'manifest.json'), 'utf8'))
async function runComposition() {
  if (!opts.apply) {
    const source = await prepareFreshA8B6Composite(opts.planId)
    if (opts.ASha256 && opts.ASha256 !== source.A.acceptanceSha256
      || opts.BSha256 && opts.BSha256 !== source.B.acceptanceSha256)
      fail('new A/B native acceptance changed since review')
    console.log(JSON.stringify({ mode: 'read-only-new-14s-composite-preflight',
      planId: opts.planId, manifestSha256: source.manifestSha256,
      AVideoSha256: source.A.media.videoSha256,
      BVideoSha256: source.B.media.videoSha256,
      AAcceptanceSha256: source.A.acceptanceSha256,
      BAcceptanceSha256: source.B.acceptanceSha256,
      mapping: source.mapping,
      narrationTrackSha256s: source.manifest.narrationTracks
        .map(track => track.sha256),
      sourceAudioPolicy: 'full source mute',
      providerCalls: 0, databaseWrites: 0, compositeWrites: 0 }, null, 2))
    return
  }
  const result = await composeFreshA8B6(opts.planId, process.cwd(), {
    A: opts.ASha256, B: opts.BSha256 })
  console.log(JSON.stringify({ mode: 'new-A8B6-source-bound-composed',
    planId: opts.planId, manifestSha256: result.manifestSha256,
    receiptSha256: result.receiptSha256,
    picture: result.receipt.picture, output: result.receipt.output,
    wholeShotReview: result.receipt.review.wholeShot,
    next: 'new schema180 first-shot composite fork and real node58 review still required' }, null, 2))
}
if (candidate.source?.frameProvenanceVariant === 'a8b6-local-composite-v9')
  await withV9VerifiedSource(root, runComposition)
else await runComposition()
