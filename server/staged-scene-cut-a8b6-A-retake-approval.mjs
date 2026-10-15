/** Separate, write-once authorization for the V9 A retake request. The old
 * first-frame approval stays attached to the rejected original plan. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { planFreshA8B6PhaseARetake } from
  './staged-scene-cut-a8b6-fresh-ledger.mjs'
import { verifyA8B6LocalWorkflowApprovalV9Sync } from
  './staged-scene-cut-a8b6-local-approval-v9.mjs'
import { verifyFreshA8B6PhaseARejectionSync } from
  './staged-scene-cut-a8b6-fresh-A-rejection.mjs'
import { verifyA8B6ARetakeTargetSourceSync } from
  './staged-scene-cut-a8b6-A-retake-target.mjs'
import { verifyA8B6ARetakeTargetReviewSync } from
  './staged-scene-cut-a8b6-A-retake-target-review.mjs'
import { verifyA8B6ARetakeTargetProvenanceAmendmentSync } from
  './staged-scene-cut-a8b6-A-retake-target-provenance-amendment.mjs'

const fail = reason => { throw Error(`A8B6_A_RETAKE_APPROVAL_INVALID: ${reason}`) }
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const filename = (planId, root) => {
  if (!/^[a-f0-9]{64}$/.test(String(planId))) fail('plan ID invalid')
  return path.join(root, '.runtime/staged-scene-cut-a8b6-A-retake',
    planId, 'approval.json')
}
const key = root => {
  const value = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (value.length !== 32) fail('signing key invalid')
  return value
}
const sign = (body, secret) => createHmac('sha256', secret)
  .update(canonical(body)).digest('hex')

function expectedBody(plan, parentApproval, parentApprovalSha256) {
  const { signature: _signature, version: _version, planId: _parentPlanId,
    phaseARequestSha256: _parentRequestSha256, ...inherited } = parentApproval
  void _signature; void _version; void _parentPlanId; void _parentRequestSha256
  return { ...inherited,
    version: 'staged-a8b6-fresh-A-retake-approval-v1',
    planId: plan.planId,
    approvalState: 'approved-target-guided-A-retake-before-new-provider-task',
    parentPlanId: plan.retake.parentPlanId,
    parentWorkflowApprovalSha256: parentApprovalSha256,
    parentManifestSha256: plan.retake.parentManifestSha256,
    parentTaskId: plan.retake.parentTaskId,
    parentTaskSha256: plan.retake.parentTaskSha256,
    parentRequestSha256: plan.retake.parentRequestSha256,
    parentVideoSha256: plan.retake.parentVideoSha256,
    parentMediaReceiptSha256: plan.retake.parentMediaReceiptSha256,
    parentRejectionSha256: plan.retake.parentRejectionSha256,
    targetSourceReceiptSha256: plan.retake.targetSourceReceiptSha256,
    targetReviewSha256: plan.retake.targetReviewSha256,
    targetPromptAmendmentSha256: plan.retake.targetPromptAmendmentSha256,
    targetEndFrameSha256: plan.phaseA.endFrame.sha256,
    targetEndFrameUrl: plan.phaseA.endFrame.url,
    phaseARequestSha256: plan.phaseAPreview.requestSha256,
    phaseAProviderLock: plan.providerLock,
    acceptedNativeTail: false }
}

export async function prepareA8B6FreshARetakeApproval(planId,
  root = process.cwd()) {
  const plan = await planFreshA8B6PhaseARetake(root)
  if (plan.planId !== planId) fail('retake request changed')
  const parent = verifyA8B6LocalWorkflowApprovalV9Sync(
    plan.retake.parentPlanId, root)
  if (parent.approvalSha256 !== plan.retake.parentWorkflowApprovalSha256)
    fail('parent V9 approval changed')
  const rejection = verifyFreshA8B6PhaseARejectionSync(
    plan.retake.parentPlanId, root)
  const source = verifyA8B6ARetakeTargetSourceSync(root)
  const review = verifyA8B6ARetakeTargetReviewSync(root)
  const provenance = verifyA8B6ARetakeTargetProvenanceAmendmentSync(root)
  if (rejection.rejectionSha256 !== plan.retake.parentRejectionSha256
    || source.receiptSha256 !== plan.retake.targetSourceReceiptSha256
    || review.reviewSha256 !== plan.retake.targetReviewSha256
    || provenance.amendmentSha256
      !== plan.retake.targetPromptAmendmentSha256)
    fail('retake source or independent reviews changed')
  return { body: expectedBody(plan, parent.approval,
    parent.approvalSha256), plan }
}

export function verifyA8B6FreshARetakeApprovalSync(planId,
  root = process.cwd()) {
  const bytes = readFileSync(filename(planId, root))
  const approval = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = approval
  const expected = sign(body, key(root))
  const parent = verifyA8B6LocalWorkflowApprovalV9Sync(
    approval.parentPlanId, root)
  const rejection = verifyFreshA8B6PhaseARejectionSync(
    approval.parentPlanId, root)
  const source = verifyA8B6ARetakeTargetSourceSync(root)
  const review = verifyA8B6ARetakeTargetReviewSync(root)
  const provenance = verifyA8B6ARetakeTargetProvenanceAmendmentSync(root)
  const { version: _version, planId: _planId,
    phaseARequestSha256: _request, signature: _parentSignature,
    ...parentFields } = parent.approval
  void _version; void _planId; void _request; void _parentSignature
  if (!/^[a-f0-9]{64}$/.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || approval.version !== 'staged-a8b6-fresh-A-retake-approval-v1'
    || approval.planId !== planId
    || approval.approvalState
      !== 'approved-target-guided-A-retake-before-new-provider-task'
    || approval.parentWorkflowApprovalSha256 !== parent.approvalSha256
    || approval.parentManifestSha256
      !== rejection.rejection.planManifestSha256
    || approval.parentRequestSha256
      !== parent.approval.phaseARequestSha256
    || approval.parentRejectionSha256 !== rejection.rejectionSha256
    || approval.targetSourceReceiptSha256 !== source.receiptSha256
    || approval.targetReviewSha256 !== review.reviewSha256
    || approval.targetPromptAmendmentSha256 !== provenance.amendmentSha256
    || approval.targetEndFrameSha256 !== source.receipt.output.sha256
    || approval.targetEndFrameUrl !== source.receipt.output.url
    || approval.parentVideoSha256 !== rejection.rejection.videoSha256
    || approval.parentMediaReceiptSha256 !== rejection.rejection.mediaSha256
    || approval.parentTaskId !== rejection.rejection.taskId
    || !/^[a-f0-9]{64}$/.test(String(approval.phaseARequestSha256))
    || approval.acceptedNativeTail !== false
    || Object.entries(parentFields).some(([name, value]) =>
      name !== 'approvalState' && canonical(approval[name]) !== canonical(value)))
    fail('retake approval lost parent V9 source or independent rejection/review')
  return { approval, approvalSha256: sha(bytes) }
}

export async function verifyA8B6FreshARetakeApproval(planId,
  root = process.cwd()) {
  const verified = verifyA8B6FreshARetakeApprovalSync(planId, root)
  const prepared = await prepareA8B6FreshARetakeApproval(planId, root)
  const { signature: _signature, ...body } = verified.approval
  void _signature
  if (canonical(body) !== canonical(prepared.body))
    fail('signed retake approval differs from current plan and evidence')
  return verified
}

export async function issueA8B6FreshARetakeApproval(planId,
  expectedRequestSha256, root = process.cwd()) {
  const prepared = await prepareA8B6FreshARetakeApproval(planId, root)
  if (prepared.plan.phaseAPreview.requestSha256 !== expectedRequestSha256)
    fail('reviewed provider request SHA changed')
  const file = filename(planId, root)
  await mkdir(path.dirname(file), { recursive: true })
  const approval = { ...prepared.body,
    signature: sign(prepared.body, key(root)) }
  const bytes = Buffer.from(JSON.stringify(approval, null, 2) + '\n')
  try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(file)).equals(bytes))
      fail('existing retake approval differs')
  }
  return verifyA8B6FreshARetakeApproval(planId, root)
}
