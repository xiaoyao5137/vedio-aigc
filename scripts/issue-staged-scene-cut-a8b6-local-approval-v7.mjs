#!/usr/bin/env node
/** Preview, then sign a source-bound NEW 14s first-frame approval. No DB or
 * provider writes. The signed artifact is write-once and verified immediately. */
import { createHmac } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareA8B6LocalWorkflowApprovalV7,
  verifyA8B6LocalWorkflowApprovalV7 } from
  '../server/staged-scene-cut-a8b6-local-approval-v7.mjs'

const fail = reason => { throw Error(`A8B6_LOCAL_V7_APPROVAL_ISSUE_INVALID: ${reason}`) }
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const options = { apply: false }
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--apply') {
    if (options.apply) fail('duplicate --apply')
    options.apply = true
    continue
  }
  const field = { '--plan': 'planId', '--expected-record-md5': 'recordMd5',
    '--expected-request-sha256': 'requestSha256' }[argv[i]]
  if (!field || options[field] || !argv[i + 1] || argv[i + 1].startsWith('--'))
    fail(`invalid or repeated ${argv[i]}`)
  options[field] = argv[++i]
}
if (!/^[a-f0-9]{64}$/.test(options.planId ?? '')) fail('--plan required')
if (options.apply && (!/^[a-f0-9]{32}$/.test(options.recordMd5 ?? '')
  || !/^[a-f0-9]{64}$/.test(options.requestSha256 ?? '')))
  fail('--apply requires the reviewed record and A request hashes')

const prepared = await prepareA8B6LocalWorkflowApprovalV7(options.planId, root)
if (options.recordMd5 && options.recordMd5 !== prepared.approvalResultMd5
  || options.requestSha256 && options.requestSha256 !== prepared.phaseARequestSha256)
  fail('reviewed record or A request changed')
if (!options.apply) {
  console.log(JSON.stringify({ mode: 'read-only-approval-preview',
    planId: prepared.planId,
    approvalExecutionId: prepared.body.approvalExecutionId,
    approvalResultMd5: prepared.approvalResultMd5,
    approvedShotSha256: prepared.body.approvedShotSha256,
    approvedFirstFrameSha256: prepared.body.approvedFirstFrameSha256,
    frameReviewExecutionId: prepared.body.frameReviewExecutionId,
    imageModelExecutionId: prepared.body.imageModelExecutionId,
    phaseARequestSha256: prepared.phaseARequestSha256,
    databaseWrites: 0, providerCalls: 0, artifactWrites: 0 }, null, 2))
} else {
  const key = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) fail('staging signing key invalid')
  const approval = { ...prepared.body, signature: createHmac('sha256', key)
    .update(canonical(prepared.body)).digest('hex') }
  const directory = path.join(root, '.runtime/staged-scene-cut-a8b6-local-approval-v7',
    options.planId)
  await mkdir(directory, { recursive: true })
  const filename = path.join(directory, 'approval.json')
  await writeFile(filename, JSON.stringify(approval, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 })
  const verified = await verifyA8B6LocalWorkflowApprovalV7(options.planId, root)
  console.log(JSON.stringify({ mode: 'signed-local-v7-workflow-approval',
    path: filename, approvalSha256: verified.approvalSha256,
    planId: options.planId,
    approvalExecutionId: prepared.body.approvalExecutionId,
    approvalResultMd5: prepared.approvalResultMd5,
    approvedFirstFrameSha256: prepared.body.approvedFirstFrameSha256,
    phaseARequestSha256: prepared.phaseARequestSha256,
    databaseWrites: 0, providerCalls: 0, artifactWrites: 1 }, null, 2))
}
