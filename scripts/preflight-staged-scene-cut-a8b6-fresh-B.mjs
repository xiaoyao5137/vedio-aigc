#!/usr/bin/env node
/** B preview uses only the signed accepted native tail of the NEW paid A. */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { planFreshA8B6PhaseB, saveFreshA8B6PhaseBPlan } from
  '../server/staged-scene-cut-a8b6-fresh-phases.mjs'
import { freshA8B6Directory } from
  '../server/staged-scene-cut-a8b6-fresh-ledger.mjs'
import { withV9VerifiedSource } from
  '../server/staged-scene-cut-a8b6-v9-verification-scope.mjs'

const fail = message => { throw Error(`A8B6_FRESH_B_PLAN_INVALID: ${message}`) }
const args = process.argv.slice(2), opts = { save: false }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--save-plan') {
    if (opts.save) fail('duplicate --save-plan')
    opts.save = true
    continue
  }
  const key = { '--plan-id': 'planId',
    '--expected-A-acceptance-sha256': 'acceptanceSha256',
    '--expected-request-sha256': 'requestSha256',
    '--expected-manifest-sha256': 'manifestSha256' }[args[i]]
  if (!key || opts[key] || !args[i + 1] || args[i + 1].startsWith('--'))
    fail(`invalid or repeated ${args[i]}`)
  opts[key] = args[++i]
}
if (!/^[a-f0-9]{64}$/.test(opts.planId ?? '')) fail('signed fresh plan ID required')
if (opts.save && [opts.acceptanceSha256, opts.requestSha256,
  opts.manifestSha256].some(value => !/^[a-f0-9]{64}$/.test(value ?? '')))
  fail('--save-plan requires reviewed A acceptance, A manifest and B request hashes')
const root = process.cwd()
const candidate = JSON.parse(await readFile(path.join(
  freshA8B6Directory(opts.planId, root), 'manifest.json'), 'utf8'))
async function runBPreflight() {
  const plan = await planFreshA8B6PhaseB(opts.planId)
  if (opts.acceptanceSha256 && plan.sourceA.acceptanceSha256 !== opts.acceptanceSha256
    || opts.requestSha256 && plan.phaseBPreview.requestSha256 !== opts.requestSha256
    || opts.manifestSha256 && plan.manifestSha256 !== opts.manifestSha256)
    fail('A source/B request changed since review')
  const saved = opts.save
    ? await saveFreshA8B6PhaseBPlan(opts.planId, plan) : undefined
  console.log(JSON.stringify({ mode: opts.save ? 'signed-new-B-plan' : 'read-only-new-B-preview',
    planId: opts.planId, manifestSha256: plan.manifestSha256,
    sourceA: plan.sourceA, phaseBPreview: plan.phaseBPreview,
    ...(saved ? { BPlanSha256: saved.sha256 } : {}),
    providerCalls: 0, databaseWrites: 0,
    mediaWrites: opts.save ? 1 : 0 }, null, 2))
}
if (candidate.source?.frameProvenanceVariant === 'a8b6-local-composite-v9')
  await withV9VerifiedSource(root, runBPreflight)
else await runBPreflight()
