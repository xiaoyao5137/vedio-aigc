#!/usr/bin/env node
/** Read-only by default. --save-plan only writes a signed QA manifest. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planA8B6QA, saveA8B6QAPlan } from '../server/staged-scene-cut-a8b6-qa.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const value = flag => argv[argv.indexOf(flag) + 1]
const has = flag => argv.includes(flag)
const SHA = /^[a-f0-9]{64}$/
const fail = message => { throw Error(`STAGED_A8B6_QA_PREFLIGHT_INVALID: ${message}`) }
const options = {
  retryPlanId: value('--retry-plan-id'),
  pictureUrl: value('--picture-url'),
  narratedUrl: value('--narrated-url'),
  compositionKey: value('--composition-key'),
}
if (!SHA.test(options.retryPlanId ?? '') || !SHA.test(options.compositionKey ?? '')
  || !options.pictureUrl || !options.narratedUrl) fail('required source IDs and QA URLs missing')
const plan = await planA8B6QA(options.retryPlanId, options.pictureUrl,
  options.narratedUrl, options.compositionKey, root)
if (has('--save-plan')) {
  const expectedPlan = value('--expected-plan-id')
  const expectedPicture = value('--expected-picture-sha256')
  const expectedNarrated = value('--expected-narrated-sha256')
  const expectedRejection = value('--expected-rejection-sha256')
  if (plan.planId !== expectedPlan || plan.picture.sha256 !== expectedPicture
    || plan.narration.qaSha256 !== expectedNarrated
    || plan.source.retryBRejectionSha256 !== expectedRejection)
    fail('signed plan, QA media, or rejected 13 second provenance changed')
  const saved = await saveA8B6QAPlan(plan, root)
  const manifestSha256 = createHash('sha256').update(await readFile(saved.manifestPath)).digest('hex')
  console.log(JSON.stringify({ status: 'saved-QA-only', ...saved, manifestSha256,
    acceptanceState: plan.acceptanceState }, null, 2))
} else {
  console.log(JSON.stringify(has('--summary')
    ? { status: 'read-only-QA-preflight', planId: plan.planId,
      source: { retryPlanId: plan.source.retryPlanId,
        BTaskId: plan.source.BTaskId,
        retryBRejectionSha256: plan.source.retryBRejectionSha256 },
      picture: plan.picture, narration: {
        qaUrl: plan.narration.qaUrl, qaSha256: plan.narration.qaSha256,
        compositionReceiptKey: plan.narration.compositionReceiptKey,
        compositionReceiptSha256: plan.narration.compositionReceiptSha256,
        mixerVersion: plan.narration.mixerVersion,
        originalTtsStarts: plan.narration.tracks.map(track => track.start) },
      acceptanceState: plan.acceptanceState }
    : { status: 'read-only-QA-preflight', plan }, null, 2))
}
