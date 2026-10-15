/** Separate signed approval for exactly one new B request after a failed B.
 * The parent A acceptance remains valid and is never rewritten. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { planFreshA8B6PhaseBRetake,
  planFreshA8B6PhaseBSecondRetake,
  planFreshA8B6PhaseBThirdRetake } from
  './staged-scene-cut-a8b6-B-retake-plan.mjs'

const SHA = /^[a-f0-9]{64}$/
const fail = reason => { throw Error(`A8B6_B_RETAKE_APPROVAL_INVALID: ${reason}`) }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)
const filename = (planId, root) => path.join(root,
  '.runtime/staged-scene-cut-a8b6-B-retake', planId, 'approval.json')
const key = root => {
  const secret = readFileSync(path.join(root, '.runtime/staged-scene-cut.key'))
  if (secret.length !== 32) fail('signing key invalid')
  return secret
}
const sign = (body, secret) => createHmac('sha256', secret)
  .update(canonical(body)).digest('hex')

function approvalBody(plan) {
  const source = plan.bRetake
  return { version: source.retakeOrdinal === 3
    ? 'staged-a8b6-B-only-retake-approval-v3'
    : source.previousChild
      ? 'staged-a8b6-B-only-retake-approval-v2'
      : 'staged-a8b6-B-only-retake-approval-v1',
    planId: plan.planId, parentPlanId: source.parentPlanId,
    parentManifestSha256: source.parentManifestSha256,
    parentWorkflowApprovalSha256: source.parentWorkflowApprovalSha256,
    acceptedA: { acceptanceSha256: source.parentAAcceptanceSha256,
      mediaSha256: source.parentAMediaSha256,
      videoSha256: source.parentAVideoSha256,
      nativeTailSha256: source.parentANativeTailSha256 },
    failedB: { planSha256: source.parentBPlanSha256,
      requestSha256: source.parentBRequestSha256,
      taskId: source.parentBTaskId,
      taskSha256: source.parentBTaskSha256,
      mediaSha256: source.parentBMediaSha256,
      videoSha256: source.parentBVideoSha256,
      rejectionSha256: source.parentBRejectionSha256 },
    targetSourceSha256: source.targetSourceSha256,
    targetReviewSha256: source.targetReviewSha256,
    targetEndFrameSha256: source.targetEndFrameSha256,
    newBRequestSha256: source.newBRequestSha256,
    ...(source.previousChild
      ? { previousChild: source.previousChild } : {}),
    ...(source.retakeOrdinal === 3
      ? { retakeOrdinal: 3 } : {}),
    providerLock: plan.providerLock,
    approvalState: 'approved-B-only-retake-before-new-provider-task',
    acceptedAReusedByReference: true,
    newBProviderTaskAccepted: false }
}

/** Synchronous source lock for the composite verifier. The asynchronous
 * verifier additionally recomputes the original media and guide evidence. */
export function verifyFreshA8B6BRetakeApprovalSync(planId,
  root = process.cwd()) {
  if (!SHA.test(String(planId))) fail('child plan ID invalid')
  const signingKey = key(root)
  const manifestPath = path.join(root,
    '.runtime/staged-scene-cut-a8b6-fresh', planId, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const { signature: manifestSignature, planId: _planId,
    workflowApprovalSha256: _approval, ...manifestBody } = manifest
  void _planId; void _approval
  const manifestSignedBody = { ...manifestBody, planId,
    workflowApprovalSha256: manifest.workflowApprovalSha256 }
  if (manifest.version !== 'staged-a8b6-fresh-A-plan-v3'
    || manifest.planId !== planId
    || sha(canonical(manifestBody)) !== planId
    || !SHA.test(String(manifestSignature))
    || !timingSafeEqual(Buffer.from(manifestSignature, 'hex'),
      Buffer.from(sign(manifestSignedBody, signingKey), 'hex')))
    fail('signed B-only child manifest changed')
  const bytes = readFileSync(filename(planId, root))
  const approval = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = approval
  if (!SHA.test(String(signature))
    || !timingSafeEqual(Buffer.from(signature, 'hex'),
      Buffer.from(sign(body, signingKey), 'hex'))
    || canonical(body) !== canonical(approvalBody(manifest)))
    fail('signed B-only approval lost child manifest binding')
  return { approval, approvalSha256: sha(bytes) }
}

export async function prepareFreshA8B6BRetakeApproval(parentPlanId,
  root = process.cwd()) {
  const plan = await planFreshA8B6PhaseBRetake(parentPlanId, root)
  return { body: approvalBody(plan), plan }
}

export async function prepareFreshA8B6BSecondRetakeApproval(
  previousChildPlanId, root = process.cwd()) {
  const plan = await planFreshA8B6PhaseBSecondRetake(
    previousChildPlanId, root)
  return { body: approvalBody(plan), plan }
}

export async function prepareFreshA8B6BThirdRetakeApproval(
  previousChildPlanId, root = process.cwd()) {
  const plan = await planFreshA8B6PhaseBThirdRetake(
    previousChildPlanId, root)
  return { body: approvalBody(plan), plan }
}

export async function issueFreshA8B6BRetakeApproval(parentPlanId,
  expectedPlanId, expectedRequestSha256, root = process.cwd()) {
  const { body, plan } = await prepareFreshA8B6BRetakeApproval(
    parentPlanId, root)
  if (plan.planId !== expectedPlanId
    || plan.bRetake.newBRequestSha256 !== expectedRequestSha256)
    fail('reviewed child plan or B request changed')
  const output = filename(plan.planId, root)
  await mkdir(path.dirname(output), { recursive: true })
  const value = { ...body, signature: sign(body, key(root)) }
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  try { await writeFile(output, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(output)).equals(bytes))
      fail('existing B-only approval differs')
  }
  return verifyFreshA8B6BRetakeApproval(plan.planId, root)
}

export async function issueFreshA8B6BSecondRetakeApproval(
  previousChildPlanId, expectedPlanId, expectedRequestSha256,
  root = process.cwd()) {
  const { body, plan } = await prepareFreshA8B6BSecondRetakeApproval(
    previousChildPlanId, root)
  if (plan.planId !== expectedPlanId
    || plan.bRetake.newBRequestSha256 !== expectedRequestSha256)
    fail('reviewed second child or new B request changed')
  const output = filename(plan.planId, root)
  await mkdir(path.dirname(output), { recursive: true })
  const value = { ...body, signature: sign(body, key(root)) }
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  try { await writeFile(output, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(output)).equals(bytes))
      fail('existing second B-only approval differs')
  }
  return verifyFreshA8B6BRetakeApproval(plan.planId, root)
}

export async function issueFreshA8B6BThirdRetakeApproval(
  previousChildPlanId, expectedPlanId, expectedRequestSha256,
  root = process.cwd()) {
  const { body, plan } = await prepareFreshA8B6BThirdRetakeApproval(
    previousChildPlanId, root)
  if (plan.planId !== expectedPlanId
    || plan.bRetake.newBRequestSha256 !== expectedRequestSha256)
    fail('reviewed third child or new B request changed')
  const output = filename(plan.planId, root)
  await mkdir(path.dirname(output), { recursive: true })
  const value = { ...body, signature: sign(body, key(root)) }
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  try { await writeFile(output, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(output)).equals(bytes))
      fail('existing third B-only approval differs')
  }
  return verifyFreshA8B6BRetakeApproval(plan.planId, root)
}

export async function verifyFreshA8B6BRetakeApproval(planId,
  root = process.cwd()) {
  if (!SHA.test(String(planId))) fail('child plan ID invalid')
  const bytes = await readFile(filename(planId, root))
  const value = JSON.parse(bytes.toString('utf8'))
  const { signature, ...body } = value
  if (!SHA.test(String(signature)) || !timingSafeEqual(
    Buffer.from(signature, 'hex'), Buffer.from(sign(body, key(root)), 'hex')))
    fail('signed B-only approval changed')
  const prepared = value.version
      === 'staged-a8b6-B-only-retake-approval-v3'
    ? await prepareFreshA8B6BThirdRetakeApproval(
      value.previousChild?.planId, root)
    : value.version === 'staged-a8b6-B-only-retake-approval-v2'
      ? await prepareFreshA8B6BSecondRetakeApproval(
        value.previousChild?.planId, root)
      : value.version === 'staged-a8b6-B-only-retake-approval-v1'
        ? await prepareFreshA8B6BRetakeApproval(value.parentPlanId, root)
        : fail('unknown B-only approval version')
  if (prepared.plan.planId !== planId
    || canonical(body) !== canonical(prepared.body))
    fail('approval lost exact accepted A, rejected B or guide')
  return { approval: value, approvalSha256: sha(bytes),
    plan: prepared.plan }
}
