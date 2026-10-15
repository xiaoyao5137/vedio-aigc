#!/usr/bin/env node
/** Direct full-speed 14 second review. Read-only until --apply. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { preflightA8B6WholeShotReview, reviewA8B6WholeShotTemplate,
  saveA8B6WholeShotReview } from '../server/staged-scene-cut-a8b6-qa.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const value = flag => argv[argv.indexOf(flag) + 1]
const planId = value('--plan-id')
if (!/^[a-f0-9]{64}$/.test(planId ?? '')) throw Error('A8B6 review plan ID missing')
if (argv.includes('--template')) {
  console.log(JSON.stringify(reviewA8B6WholeShotTemplate(planId, root), null, 2))
} else {
  const reportFile = value('--report-file')
  if (!reportFile) throw Error('A8B6 direct review report path missing')
  const bytes = await readFile(path.resolve(root, reportFile))
  const rawSha256 = createHash('sha256').update(bytes).digest('hex')
  if (rawSha256 !== value('--expected-report-sha256'))
    throw Error('A8B6 direct review report bytes differ from reviewed SHA-256')
  const report = JSON.parse(bytes.toString('utf8'))
  if (argv.includes('--apply')) {
    const saved = await saveA8B6WholeShotReview(planId, report, root)
    console.log(JSON.stringify({ mode: 'signed-first-shot-direct-review', planId,
      rawReportSha256: rawSha256, signedReviewSha256: saved.sha256,
      signature: saved.signature,
      secondShotAccepted: false, workflowAdmission: false }, null, 2))
  } else {
    const preview = await preflightA8B6WholeShotReview(planId, report, root)
    console.log(JSON.stringify({ mode: 'read-only-first-shot-review-preflight',
      rawReportSha256: rawSha256, ...preview }, null, 2))
  }
}
