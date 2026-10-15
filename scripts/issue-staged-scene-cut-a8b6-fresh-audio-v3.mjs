#!/usr/bin/env node
/** Probe each archived native clip's audio before the direct 1x review. */
import { withV9VerifiedSource } from
  '../server/staged-scene-cut-a8b6-v9-verification-scope.mjs'
import { readFreshA8B6PhaseAPlan } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { prepareFreshA8B6AudioIsolationV3,
  freshA8B6AudioIsolationV3BodySha256,
  saveFreshA8B6AudioIsolationV3 } from
  '../server/staged-scene-cut-a8b6-fresh-audio-v3.mjs'

const fail = reason => { throw Error(`A8B6_FRESH_AUDIO_V3_CLI_INVALID: ${reason}`) }
const args = process.argv.slice(2), opts = { save: false }
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--save') {
    if (opts.save) fail('duplicate --save')
    opts.save = true
    continue
  }
  const field = { '--plan-id': 'planId', '--phase': 'phase',
    '--expected-video-sha256': 'videoSha256',
    '--expected-body-sha256': 'bodySha256' }[args[index]]
  if (!field || opts[field] || !args[index + 1]
    || args[index + 1].startsWith('--'))
    fail(`invalid or repeated ${args[index]}`)
  opts[field] = args[++index]
}
if (!/^[a-f0-9]{64}$/.test(opts.planId ?? '')
  || !['A', 'B'].includes(opts.phase))
  fail('signed plan ID and phase required')
if (opts.save && [opts.videoSha256, opts.bodySha256].some(value =>
  !/^[a-f0-9]{64}$/.test(value ?? '')))
  fail('--save requires reviewed video and audio-body SHA')

const root = process.cwd()
await withV9VerifiedSource(root, async () => {
  const { manifest } = await readFreshA8B6PhaseAPlan(opts.planId, root)
  if (manifest.version === 'staged-a8b6-fresh-A-plan-v3'
    && opts.phase !== 'B')
    fail('B-only child cannot create new A audio evidence')
  const body = await prepareFreshA8B6AudioIsolationV3(
    opts.planId, opts.phase, root)
  const bodySha256 = freshA8B6AudioIsolationV3BodySha256(body)
  if (opts.videoSha256 && opts.videoSha256 !== body.videoSha256
    || opts.bodySha256 && opts.bodySha256 !== bodySha256)
    fail('decoded audio isolation or video changed since preview')
  const saved = opts.save ? await saveFreshA8B6AudioIsolationV3(
    opts.planId, opts.phase, root, bodySha256) : undefined
  console.log(JSON.stringify({ mode: opts.save
    ? 'signed-v3-audio-isolation' : 'read-only-v3-audio-isolation-preview',
  planId: opts.planId, phase: opts.phase,
  videoSha256: body.videoSha256,
  mediaSha256: body.mediaSha256,
  nativeFrameDigestSha256: body.nativeFrameDigestSha256,
  status: body.status, witness: body.witness,
  bodySha256, receiptSha256: saved?.receiptSha256 ?? null,
  modelCalls: 0, videoProviderCalls: 0, databaseWrites: 0 }, null, 2))
})
