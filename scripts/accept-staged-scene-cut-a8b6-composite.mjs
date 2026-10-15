#!/usr/bin/env node
/** Formal first-shot source admission, after independent 14 second approval. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { preflightA8B6CompositeReceipt, saveA8B6CompositeReceipt } from
  '../server/staged-scene-cut-a8b6-qa.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const value = flag => argv[argv.indexOf(flag) + 1]
const planId = value('--plan-id')
if (!/^[a-f0-9]{64}$/.test(planId ?? '')) throw Error('A8B6 composite plan ID missing')
const preview = await preflightA8B6CompositeReceipt(planId, root)
if (argv.includes('--apply')) {
  if (preview.manifestSha256 !== value('--expected-manifest-sha256')
    || preview.wholeShotReviewSha256 !== value('--expected-review-sha256')
    || preview.workflowApprovalSha256 !== value('--expected-workflow-approval-sha256'))
    throw Error('A8B6 composite signed source hashes differ from reviewed values')
  const result = await saveA8B6CompositeReceipt(planId, root)
  const receiptPath = path.join(root, '.runtime/staged-scene-cut-a8b6-qa',
    planId, 'composite-receipt.json')
  const receiptSha256 = createHash('sha256').update(await readFile(receiptPath)).digest('hex')
  console.log(JSON.stringify({ mode: 'signed-14s-first-shot-composite', planId,
    manifestSha256: result.manifestSha256,
    wholeShotReviewSha256: preview.wholeShotReviewSha256,
    workflowApprovalSha256: preview.workflowApprovalSha256,
    receiptSha256, secondShotAccepted: false }, null, 2))
} else {
  console.log(JSON.stringify({ mode: 'read-only-14s-composite-preflight', planId,
    manifestSha256: preview.manifestSha256,
    wholeShotReviewSha256: preview.wholeShotReviewSha256,
    workflowApprovalSha256: preview.workflowApprovalSha256,
    candidate: preview.candidate }, null, 2))
}
