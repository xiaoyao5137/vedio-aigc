/** Immutable local evidence for a terminal, zero-deduction Kling task failure.
 * This module never queries the provider, generates media, or edits a record. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readStageTaskReceipt, readStagedSceneCutManifest } from './staged-scene-cut.mjs'

const SHA = /^[a-f0-9]{64}$/
const invalid = message => { throw Error(`STAGED_FAILED_TASK_INVALID: ${message}`) }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)
const location = (root, planId, name) => {
  if (!SHA.test(String(planId))) invalid('plan ID invalid')
  return path.join(root, '.runtime/staged-scene-cut', planId, name)
}
async function fileSha256(filename) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(filename)) hash.update(bytes)
  return hash.digest('hex')
}
async function signingKey(root) {
  const key = await readFile(path.join(root, '.runtime/staged-scene-cut.key'))
  if (key.length !== 32) invalid('existing staging key invalid')
  return key
}
function signedObject(value, key) {
  const { signature: _signature, ...content } = value
  void _signature
  return createHmac('sha256', key).update(canonical(content)).digest('hex')
}
function verifySignature(value, key) {
  const actual = String(value?.signature ?? ''), expected = signedObject(value, key)
  if (!SHA.test(actual) || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')))
    invalid('failed-task receipt signature invalid')
}

export const FAILED_V3_PLAN_ID = 'dc8f9fd00f18fade4c8b38c34779639b5305d2946cbd5c61ed927d19efed9418'
export const FAILED_V3_TASK_ID = '933795869852717098'
export const FAILED_V3_REQUEST_SHA256 = '409e2468198559c271d879fe2aec6313f44cda95ce150518ab2b0c297152a296'
export const FAILED_V3_TERMINAL_SHA256 = '1cae6dda8279e1a29070a35ba2696a8121d05c32855ef26a0deeb34c8b91c8cf'
export const FAILED_V3_STATUS_MSG = 'Something went wrong when we tried to get the contents of the file.'
export const FAILED_V3_RETRY1_PLAN_ID = 'ff5e5f076006371431bb718741420a8a493f4a96ed75b5efd95057be4c9f595e'
export const FAILED_V3_RETRY1_TASK_ID = '933798685308629047'
export const FAILED_V3_RETRY1_TERMINAL_SHA256 = '6d7b5a37345619d5ce920e13b09a94d41eb2e5f42bc2cbff22ef1f8976ee3b80'

/** The raw terminal GET body was saved by the operator, not by this module. */
export async function inspectFailedV3Task(root = process.cwd()) {
  const planId = FAILED_V3_PLAN_ID
  const manifest = await readStagedSceneCutManifest(planId, root)
  const task = await readStageTaskReceipt(planId, 'A', root)
  const intentPath = location(root, planId, 'phase-A-submit-intent.json')
  const terminalPath = location(root, planId, 'phase-A-provider-terminal.json')
  const [intentBytes, terminalBytes] = await Promise.all([readFile(intentPath), readFile(terminalPath)])
  const intent = JSON.parse(intentBytes.toString('utf8'))
  const terminal = JSON.parse(terminalBytes.toString('utf8'))
  if (manifest.version !== 'staged-scene-cut-shot1-v3'
    || task.taskId !== FAILED_V3_TASK_ID || task.requestSha256 !== FAILED_V3_REQUEST_SHA256
    || manifest.phaseAPreview?.requestSha256 !== FAILED_V3_REQUEST_SHA256
    || intent.version !== 'staged-paid-submit-intent-v1' || intent.planId !== planId
    || intent.phase !== 'A' || intent.requestSha256 !== task.requestSha256
    || intent.modelId !== task.providerModelId || intent.endpointSha256 !== task.endpointSha256
    || intent.endpoint !== 'https://api-beijing.klingai.com/v1/videos/omni-video'
    || sha256(intent.endpoint) !== intent.endpointSha256
    || sha256(terminalBytes) !== FAILED_V3_TERMINAL_SHA256
    || terminal.code !== 0 || terminal.data?.task_id !== task.taskId
    || terminal.data?.task_status !== 'failed'
    || terminal.data?.task_status_msg !== FAILED_V3_STATUS_MSG
    || terminal.data?.model_name && terminal.data.model_name !== 'kling-v3-omni'
    || terminal.data?.final_unit_deduction !== '0'
    || terminal.data?.final_balance_deduction?.quota !== '0'
    || terminal.data?.final_balance_deduction?.list_price !== '0'
    || Object.keys(terminal.data?.task_result ?? {}).length !== 0
    || existsSync(location(root, planId, 'phase-A-media.json'))
    || existsSync(location(root, planId, 'phase-A-acceptance.json')))
    invalid('signed task/intent, terminal failure, zero deduction, or no-media boundary changed')
  return { manifest, task, intent, terminal,
    manifestSha256: await fileSha256(location(root, planId, 'manifest.json')),
    taskReceiptSha256: await fileSha256(location(root, planId, 'phase-A-task.json')),
    intentSha256: sha256(intentBytes), terminalSha256: sha256(terminalBytes) }
}

export async function saveFailedV3TaskReceipt(root = process.cwd()) {
  const inspected = await inspectFailedV3Task(root)
  const { task, terminal } = inspected
  const value = { version: 'staged-provider-terminal-failure-v1',
    planId: FAILED_V3_PLAN_ID, phase: 'A', taskId: task.taskId,
    requestSha256: task.requestSha256,
    providerModelId: task.providerModelId, endpointSha256: task.endpointSha256,
    manifestSha256: inspected.manifestSha256,
    taskReceiptSha256: inspected.taskReceiptSha256,
    submitIntentSha256: inspected.intentSha256,
    providerTerminalSha256: inspected.terminalSha256,
    taskStatus: 'failed', taskStatusMsg: terminal.data.task_status_msg,
    finalUnitDeduction: '0', finalBalanceDeduction: { quota: '0', listPrice: '0' },
    outputMedia: 'none', retryAllowance: { attempt: 1, maximum: 1,
      reason: 'terminal-zero-deduction-file-ingestion-failure' }, signature: '' }
  value.signature = signedObject(value, await signingKey(root))
  const filename = location(root, FAILED_V3_PLAN_ID, 'phase-A-failure.json')
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(bytes))
      invalid('immutable failed-task receipt differs')
  }
  return { receipt: value, sha256: sha256(bytes), path: filename }
}

export async function readFailedV3TaskReceipt(root = process.cwd()) {
  const inspected = await inspectFailedV3Task(root)
  const filename = location(root, FAILED_V3_PLAN_ID, 'phase-A-failure.json')
  const bytes = await readFile(filename)
  const receipt = JSON.parse(bytes.toString('utf8'))
  verifySignature(receipt, await signingKey(root))
  if (receipt.version !== 'staged-provider-terminal-failure-v1'
    || receipt.planId !== FAILED_V3_PLAN_ID || receipt.phase !== 'A'
    || receipt.taskId !== inspected.task.taskId
    || receipt.requestSha256 !== inspected.task.requestSha256
    || receipt.providerModelId !== inspected.task.providerModelId
    || receipt.endpointSha256 !== inspected.task.endpointSha256
    || receipt.manifestSha256 !== inspected.manifestSha256
    || receipt.taskReceiptSha256 !== inspected.taskReceiptSha256
    || receipt.submitIntentSha256 !== inspected.intentSha256
    || receipt.providerTerminalSha256 !== inspected.terminalSha256
    || receipt.taskStatus !== 'failed' || receipt.taskStatusMsg !== FAILED_V3_STATUS_MSG
    || receipt.finalUnitDeduction !== '0'
    || receipt.finalBalanceDeduction?.quota !== '0'
    || receipt.finalBalanceDeduction?.listPrice !== '0'
    || receipt.outputMedia !== 'none'
    || receipt.retryAllowance?.attempt !== 1 || receipt.retryAllowance?.maximum !== 1
    || receipt.retryAllowance?.reason !== 'terminal-zero-deduction-file-ingestion-failure')
    invalid('failed-task receipt is not the terminal zero-deduction task')
  return { receipt, sha256: sha256(bytes), path: filename }
}

/** The identical-request allowance is exhausted after retry1 also fails. */
export async function inspectFailedV3Retry1Task(root = process.cwd()) {
  const planId = FAILED_V3_RETRY1_PLAN_ID
  const previous = await readFailedV3TaskReceipt(root)
  const manifest = await readStagedSceneCutManifest(planId, root)
  const task = await readStageTaskReceipt(planId, 'A', root)
  const [intentBytes, terminalBytes] = await Promise.all([
    readFile(location(root, planId, 'phase-A-submit-intent.json')),
    readFile(location(root, planId, 'phase-A-provider-terminal.json')),
  ])
  const intent = JSON.parse(intentBytes.toString('utf8'))
  const terminal = JSON.parse(terminalBytes.toString('utf8'))
  if (manifest.version !== 'staged-scene-cut-shot1-v3-retry1'
    || manifest.retryOf?.failureReceiptSha256 !== previous.sha256
    || manifest.retryOf?.attempt !== 1 || manifest.retryOf?.maximum !== 1
    || task.taskId !== FAILED_V3_RETRY1_TASK_ID
    || task.requestSha256 !== FAILED_V3_REQUEST_SHA256
    || manifest.phaseAPreview?.requestSha256 !== task.requestSha256
    || intent.version !== 'staged-paid-submit-intent-v1' || intent.planId !== planId
    || intent.phase !== 'A' || intent.requestSha256 !== task.requestSha256
    || intent.modelId !== task.providerModelId || intent.endpointSha256 !== task.endpointSha256
    || intent.endpoint !== 'https://api-beijing.klingai.com/v1/videos/omni-video'
    || sha256(intent.endpoint) !== intent.endpointSha256
    || sha256(terminalBytes) !== FAILED_V3_RETRY1_TERMINAL_SHA256
    || terminal.code !== 0 || terminal.data?.task_id !== task.taskId
    || terminal.data?.task_status !== 'failed'
    || terminal.data?.task_status_msg !== FAILED_V3_STATUS_MSG
    || terminal.data?.model_name && terminal.data.model_name !== 'kling-v3-omni'
    || terminal.data?.final_unit_deduction !== '0'
    || terminal.data?.final_balance_deduction?.quota !== '0'
    || terminal.data?.final_balance_deduction?.list_price !== '0'
    || Object.keys(terminal.data?.task_result ?? {}).length !== 0
    || existsSync(location(root, planId, 'phase-A-media.json'))
    || existsSync(location(root, planId, 'phase-A-acceptance.json')))
    invalid('retry1 signed task/intent, terminal failure, zero deduction, or no-media boundary changed')
  return { manifest, task, intent, terminal, previous,
    manifestSha256: await fileSha256(location(root, planId, 'manifest.json')),
    taskReceiptSha256: await fileSha256(location(root, planId, 'phase-A-task.json')),
    intentSha256: sha256(intentBytes), terminalSha256: sha256(terminalBytes) }
}

export async function saveFailedV3Retry1TaskReceipt(root = process.cwd()) {
  const inspected = await inspectFailedV3Retry1Task(root)
  const { task, terminal } = inspected
  const value = { version: 'staged-provider-terminal-failure-v1',
    planId: FAILED_V3_RETRY1_PLAN_ID, phase: 'A', taskId: task.taskId,
    requestSha256: task.requestSha256,
    providerModelId: task.providerModelId, endpointSha256: task.endpointSha256,
    manifestSha256: inspected.manifestSha256,
    taskReceiptSha256: inspected.taskReceiptSha256,
    submitIntentSha256: inspected.intentSha256,
    providerTerminalSha256: inspected.terminalSha256,
    priorFailureReceiptSha256: inspected.previous.sha256,
    taskStatus: 'failed', taskStatusMsg: terminal.data.task_status_msg,
    finalUnitDeduction: '0', finalBalanceDeduction: { quota: '0', listPrice: '0' },
    outputMedia: 'none', retryAllowance: { attempt: 0, maximum: 0,
      reason: 'identical-request-retry-exhausted' },
    nextVariant: 'compact-image-transport-only', signature: '' }
  value.signature = signedObject(value, await signingKey(root))
  const filename = location(root, FAILED_V3_RETRY1_PLAN_ID, 'phase-A-failure.json')
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  try { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(bytes))
      invalid('immutable retry1 failed-task receipt differs')
  }
  return { receipt: value, sha256: sha256(bytes), path: filename }
}

export async function readFailedV3Retry1TaskReceipt(root = process.cwd()) {
  const inspected = await inspectFailedV3Retry1Task(root)
  const filename = location(root, FAILED_V3_RETRY1_PLAN_ID, 'phase-A-failure.json')
  const bytes = await readFile(filename)
  const receipt = JSON.parse(bytes.toString('utf8'))
  verifySignature(receipt, await signingKey(root))
  if (receipt.version !== 'staged-provider-terminal-failure-v1'
    || receipt.planId !== FAILED_V3_RETRY1_PLAN_ID || receipt.phase !== 'A'
    || receipt.taskId !== inspected.task.taskId
    || receipt.requestSha256 !== inspected.task.requestSha256
    || receipt.providerModelId !== inspected.task.providerModelId
    || receipt.endpointSha256 !== inspected.task.endpointSha256
    || receipt.manifestSha256 !== inspected.manifestSha256
    || receipt.taskReceiptSha256 !== inspected.taskReceiptSha256
    || receipt.submitIntentSha256 !== inspected.intentSha256
    || receipt.providerTerminalSha256 !== inspected.terminalSha256
    || receipt.priorFailureReceiptSha256 !== inspected.previous.sha256
    || receipt.taskStatus !== 'failed' || receipt.taskStatusMsg !== FAILED_V3_STATUS_MSG
    || receipt.finalUnitDeduction !== '0'
    || receipt.finalBalanceDeduction?.quota !== '0'
    || receipt.finalBalanceDeduction?.listPrice !== '0'
    || receipt.outputMedia !== 'none'
    || receipt.retryAllowance?.attempt !== 0 || receipt.retryAllowance?.maximum !== 0
    || receipt.retryAllowance?.reason !== 'identical-request-retry-exhausted'
    || receipt.nextVariant !== 'compact-image-transport-only')
    invalid('retry1 failed-task receipt is not the terminal zero-deduction task')
  return { receipt, sha256: sha256(bytes), path: filename }
}
