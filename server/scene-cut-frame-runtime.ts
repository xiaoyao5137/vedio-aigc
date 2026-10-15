import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import sharp from 'sharp'
import pg from 'pg'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { renderRetryFeedbackPrompt, renderWorkflowTemplate } from '../src/workflow-template.ts'
import { planSceneCutAutoRetry } from '../src/scene-cut-auto-retry.ts'
import { A8B6_LOCAL_V8_REVIEW_IMAGE_DETAIL,
  A8B6_LOCAL_V9_REVIEW_IMAGE_DETAIL } from
  '../src/scene-cut-a8b6-local-detail-review.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT, SCENE_CUT_FRAME_REVIEW_PROMPT,
  validateSceneCutFrameReview } from '../src/scene-cut-first-frame-gate.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V195, SCENE_CUT_FIRST_FRAME_PROMPT_V197 } from '../src/scene-cut-static-opening-v195.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V186, SCENE_CUT_FRAME_REVIEW_PROMPT_V187 } from '../src/scene-cut-advisory-review.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V167, validateSceneCutT0ImageContract } from '../src/scene-cut-t0-image-contract.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V168, SCENE_CUT_FRAME_REVIEW_PROMPT_V168,
  validateSceneCutStanceStartReview } from '../src/scene-cut-opening-plan-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V169, SCENE_CUT_FRAME_REVIEW_PROMPT_V169,
  validateSceneCutTravelStartReview } from '../src/scene-cut-travel-start-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V170,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V170,
  validateSceneCutOpeningProjectionReview } from '../src/scene-cut-opening-projection-workflow.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V171 } from '../src/scene-cut-ellipsis-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V172,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V172, sceneCutActionPerformerFeetRequired,
  validateSceneCutActionVisibilityReview } from '../src/scene-cut-action-visibility-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V173,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V173 } from '../src/scene-cut-staging-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V174,
  SCENE_CUT_FRAME_REVIEW_PROMPT_V174,
  validateSceneCutActionStartReview } from '../src/scene-cut-action-start-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V175 } from '../src/scene-cut-closure-layout-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V176 } from '../src/scene-cut-closure-start-layout-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V177 } from '../src/scene-cut-controlled-edit-prompt.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V178 } from '../src/scene-cut-geometry-guide-workflow.ts'
import { deriveSceneCutOpeningPlan } from './scene-cut-opening-plan.ts'
import { verifySceneCutEllipsisProof } from './scene-cut-ellipsis-proof.ts'
import { assertSceneCutAcceptedSourceLedger } from './scene-cut-source-ledger.ts'
import { issueSceneCutFrameApproval, sceneCutShotSha256, validateSceneCutVideoPayment,
  verifySceneCutFrameApproval } from './scene-cut-frame-approval.ts'
import type { SceneCutImageRepairBinding } from './scene-cut-frame-approval.ts'
import { assertSceneCutApprovalRebindHop, assertSceneCutCompletedApprovalRetryHop,
  assertSceneCutSameMediaReviewHop } from './scene-cut-approval-rebind.ts'
import { sceneCutRebindSha256 } from './scene-cut-approval-rebind.ts'
import { assertSceneCutTailGuideRebindHop } from './scene-cut-tail-guide-rebind.ts'
import { verifySceneCutRepairReceiptForCompletedFork } from './scene-cut-rejected-edit-binder.mjs'
import { assertA8B6ConflictReviewHop,
  verifyA8B6FrameConflictReceipt } from './staged-scene-cut-a8b6-frame-conflict.mjs'
import { A8B6_FRESH_FRAME_ID, A8B6_FRESH_FRAME_VERSION,
  A8B6_FRESH_FIRST_FRAME_PROMPT,
  A8B6_FRESH_REVIEW_PROMPT, assertA8B6FreshFrameHop,
  verifyA8B6FreshImageRequest, verifyA8B6FreshImageBytes } from './staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_FRESH_V2_FRAME_VERSION, A8B6_FRESH_V2_FIRST_FRAME_PROMPT,
  A8B6_FRESH_V2_REVIEW_PROMPT, A8B6_FRESH_EDIT_FRAME_ID,
  A8B6_FRESH_EDIT_FRAME_VERSION, A8B6_FRESH_EDIT_FIRST_FRAME_PROMPT,
  A8B6_FRESH_EDIT_REVIEW_PROMPT, A8B6_FRESH_V5_EDIT_FRAME_ID,
  A8B6_FRESH_V5_RUNTIME_RETRY_ID,
  A8B6_FRESH_V5_EDIT_FRAME_VERSION,
  A8B6_FRESH_V5_EDIT_FIRST_FRAME_PROMPT,
  A8B6_FRESH_V5_EDIT_REVIEW_PROMPT, A8B6_FRESH_V6_EDIT_FRAME_ID,
  A8B6_FRESH_V6_EDIT_FRAME_VERSION,
  A8B6_FRESH_V6_EDIT_FIRST_FRAME_PROMPT,
  A8B6_FRESH_V6_EDIT_REVIEW_PROMPT, A8B6_FRESH_V7_EDIT_FRAME_ID,
  A8B6_FRESH_V7_EDIT_FRAME_VERSION,
  A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT,
  A8B6_FRESH_V7_EDIT_REVIEW_PROMPT, A8B6_FRESH_V8_EDIT_FRAME_ID,
  A8B6_FRESH_V8_EDIT_FRAME_VERSION,
  A8B6_FRESH_V8_EDIT_FIRST_FRAME_PROMPT,
  A8B6_FRESH_V8_EDIT_REVIEW_PROMPT } from '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { assertA8B6FreshEditHop, verifyA8B6FreshEditReceipt,
  verifyA8B6FreshEditPaidRequest } from './staged-scene-cut-a8b6-fresh-edit.mjs'
import { assertA8B6FreshV5EditHop, assertA8B6FreshV5RuntimeRetryHop,
  verifyA8B6FreshV5EditReceipt,
  verifyA8B6FreshV5EditPaidRequest } from './staged-scene-cut-a8b6-fresh-edit-v5.mjs'
import { assertA8B6FreshV6EditHop, verifyA8B6FreshV6EditReceipt,
  verifyA8B6FreshV6EditPaidRequest } from './staged-scene-cut-a8b6-fresh-edit-v6.mjs'
import { assertA8B6FreshV7EditHop, verifyA8B6FreshV7EditReceipt,
  verifyA8B6FreshV7EditPaidRequest,
  A8B6_FRESH_V7_YAN_FRONT_URL, A8B6_FRESH_V7_YAN_FRONT_SHA,
  A8B6_FRESH_V7_FACE_CROP } from './staged-scene-cut-a8b6-fresh-edit-v7.mjs'
import { A8B6_V7_DUAL_OUTPUT_CHILD_ID, A8B6_V7_DUAL_OUTPUT_VERSION,
  assertA8B6V7DualOutputRecoveryHop,
  verifyA8B6V7DualOutputRecoveryReceiptAsync } from
  './staged-scene-cut-a8b6-v7-dual-output.mjs'
import { assertA8B6FreshV8EditHop, verifyA8B6FreshV8EditReceipt,
  verifyA8B6FreshV8EditPaidRequest } from
  './staged-scene-cut-a8b6-fresh-edit-v8.mjs'
import { A8B6_LOCAL_FRAME_ID, A8B6_LOCAL_FRAME_VERSION,
  A8B6_LOCAL_FRAME_REVIEW_PROMPT, A8B6_LOCAL_V2_FRAME_ID,
  A8B6_LOCAL_V2_FRAME_VERSION, A8B6_LOCAL_V2_FRAME_REVIEW_PROMPT,
  A8B6_LOCAL_V3_FRAME_ID, A8B6_LOCAL_V3_FRAME_VERSION,
  A8B6_LOCAL_V3_FRAME_REVIEW_PROMPT,
  A8B6_LOCAL_V4_FRAME_ID, A8B6_LOCAL_V4_FRAME_VERSION,
  A8B6_LOCAL_V4_FRAME_REVIEW_PROMPT,
  A8B6_LOCAL_V5_FRAME_ID, A8B6_LOCAL_V5_FRAME_VERSION,
  A8B6_LOCAL_V5_FRAME_REVIEW_PROMPT,
  A8B6_LOCAL_V6_FRAME_ID, A8B6_LOCAL_V6_FRAME_VERSION,
  A8B6_LOCAL_V6_FRAME_REVIEW_PROMPT,
  A8B6_LOCAL_V7_FRAME_ID, A8B6_LOCAL_V7_FRAME_VERSION,
  A8B6_LOCAL_V7_FRAME_REVIEW_PROMPT,
  A8B6_LOCAL_V8_FRAME_ID, A8B6_LOCAL_V8_FRAME_VERSION,
  A8B6_LOCAL_V8_FRAME_REVIEW_PROMPT,
  A8B6_LOCAL_V9_FRAME_ID, A8B6_LOCAL_V9_FRAME_VERSION,
  A8B6_LOCAL_V9_FRAME_REVIEW_PROMPT } from
  '../src/scene-cut-a8b6-local-frame-workflow.ts'
import { verifyA8B6LocalCompositeSourceReceiptSync,
  verifyA8B6LocalCompositeSourceReceipt } from
  './staged-scene-cut-a8b6-local-composite-admission.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV2Sync,
  verifyA8B6LocalCompositeSourceReceiptV2 } from
  './staged-scene-cut-a8b6-local-composite-admission-v2.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV3Sync,
  verifyA8B6LocalCompositeSourceReceiptV3 } from
  './staged-scene-cut-a8b6-local-composite-admission-v3.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV4Sync,
  verifyA8B6LocalCompositeSourceReceiptV4 } from
  './staged-scene-cut-a8b6-local-composite-admission-v4.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV5Sync,
  verifyA8B6LocalCompositeSourceReceiptV5 } from
  './staged-scene-cut-a8b6-local-composite-admission-v5.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV6Sync,
  verifyA8B6LocalCompositeSourceReceiptV6 } from
  './staged-scene-cut-a8b6-local-composite-admission-v6.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV7Sync,
  verifyA8B6LocalCompositeSourceReceiptV7 } from
  './staged-scene-cut-a8b6-local-composite-admission-v7.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV8Sync,
  verifyA8B6LocalCompositeSourceReceiptV8 } from
  './staged-scene-cut-a8b6-local-composite-admission-v8.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV9Sync,
  verifyA8B6LocalCompositeSourceReceiptV9 } from
  './staged-scene-cut-a8b6-local-composite-admission-v9.mjs'
import { validateCoverageCutPaidResume } from './coverage-cut-runtime.ts'
import { loadReviewImages } from './review-images.ts'
import { buildSceneCutIdentityPlate, buildSceneCutIdentityPlateV3,
  buildSceneCutIdentityPlateV4 } from './scene-cut-frame-storage.ts'
import { SCENE_CUT_IMAGE_COUNT_RETRY_FEEDBACK } from '../src/scene-cut-image-count-retry.ts'

type Value = Record<string, unknown>
type MediaRequest = { model: { id: string; provider?: string; capability?: string; settings: Record<string, string> };
  prompt: string; params: Value; executionContext?: { workflowId?: string; nodeId?: string; requestKey?: string } }
type Queryable = { query: (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }> }
type VideoRepairContext = { executionId: string; recovery: unknown | null;
  tailGuide?: null | { endImage: string; endImageSha256: string; sourceVideoSha256: string } }
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const fail = (message: string): never => { throw Error(`SCENE_CUT_FRAME_BLOCKED: ${message}`) }
type StoredSceneCutRetryState = { id?: string; parentExecutionId?: string;
  branchHistory?: Array<{ from?: string; to?: string; value?: boolean; backwards?: boolean;
    runs?: Array<{ id?: string; nodeId?: string; status?: string; output?: unknown }> }>;
  sceneCutImageCountRecovery?: { version: string; sourceExecutionId: string; sourceResultMd5: string;
    failedModelExecutionId: string; failedThreadId: string; firstPendingIndex: number;
    firstPendingNodeId: string };
  sceneCutAutoRetry?: { sourceExecutionId: string; count: number; sourceReviewRunId: string;
    loopGroupId?: string; loopIndex?: number };
  nodeRuns: Array<{ id: string; node: { id: string }; status: string; error?: string;
    loopGroupId?: string; loopIndex?: number; attempt?: number; revision?: number;
    attempts?: Array<{ id?: string; node?: { id?: string }; status?: string; output?: unknown }>;
    output?: unknown; retryFeedback?: unknown }> }
export async function sceneCutImagePromptMatches(request: MediaRequest, approvedPrompt: string) {
  if (request.prompt === approvedPrompt) return true
  const requestIdentity = String(request.executionContext?.requestKey ?? '')
    .match(/^(record-[\w-]+):attempt-(\d+):revision-(\d+):sanguo-scene-cut-first-frame:(\d+):(scene-\d+)$/)
  if (!requestIdentity) return false
  const [, id, attemptText, revisionText, loopIndexText] = requestIdentity
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  try {
    await db.connect()
    const forkRow = (await db.query('SELECT workflow_id,result FROM execution_records WHERE id=$1', [id])).rows[0]
    if (forkRow?.workflow_id !== 'wf-sanguo-history-drama') return false
    const fork = decodeExecutionState<StoredSceneCutRetryState>(forkRow.result)
    // A review false edge rewinds inside the same execution. Its image run keeps
    // the approved shot and records the exact reviewer feedback in branchHistory.
    const inline = fork.branchHistory?.at(-1)
    if (inline?.from === 'sanguo-scene-cut-review-route'
      && inline.to === 'sanguo-scene-cut-first-frame'
      && inline.value === false && inline.backwards === true) {
      const image = fork.nodeRuns.find(run => run.node.id === 'sanguo-scene-cut-first-frame'
        && run.loopIndex === Number(loopIndexText)
        && run.attempt === Number(attemptText) && run.revision === Number(revisionText))
      const priorImage = inline.runs?.find(run => run.id === image?.id)
      const priorRoute = inline.runs?.find(run => run.nodeId === 'sanguo-scene-cut-review-route')
      const feedback = object(priorRoute?.output).feedback
      if (image && priorImage?.status === 'success'
        && priorRoute?.status === 'success'
        && object(priorRoute.output).value === false
        && image.attempts?.some(run => run.id === priorImage.id
          && run.status === 'success' && isDeepStrictEqual(run.output, priorImage.output))
        && isDeepStrictEqual(image.retryFeedback, feedback)
        && object(feedback).kind === 'image-review-retry'
        && request.prompt === approvedPrompt + renderRetryFeedbackPrompt(feedback)) return true
    }
    const countRetry = fork.sceneCutImageCountRecovery
    if (countRetry?.version === 'scene-cut-image-count-retry-v1'
      && !fork.sceneCutAutoRetry) {
      const [sourceQuery, ledgerQuery] = await Promise.all([
        db.query('SELECT workflow_id,result,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1',
          [countRetry.sourceExecutionId]),
        db.query('SELECT workflow_id,node_id,status,error,response_data,request_data FROM model_execution_records WHERE id=$1',
          [countRetry.failedModelExecutionId]),
      ])
      const sourceRow = sourceQuery.rows[0], ledger = ledgerQuery.rows[0]
      if (sourceRow?.workflow_id !== forkRow.workflow_id
        || sourceRow.result_md5 !== countRetry.sourceResultMd5
        || ledger?.workflow_id !== forkRow.workflow_id
        || ledger.node_id !== 'sanguo-scene-cut-first-frame'
        || ledger.status !== 'failed'
        || ledger.error !== 'CODEX_IMAGE_COUNT_INVALID: 本次线程必须恰好保存1张 PNG 图片'
        || ledger.response_data?.raw?.threadId !== countRetry.failedThreadId
        || ledger.response_data?.raw?.imageCount !== 2
        || !String(ledger.request_data?.requestKey ?? '').startsWith(`${countRetry.sourceExecutionId}:`)) return false
      const source = decodeExecutionState<StoredSceneCutRetryState>(sourceRow.result)
      const index = countRetry.firstPendingIndex, target = fork.nodeRuns[index]
      return Boolean(fork.parentExecutionId === source.id
        && index === 45 && countRetry.firstPendingNodeId === 'sanguo-scene-cut-first-frame'
        && source.nodeRuns[index]?.status === 'failed'
        && source.nodeRuns[index].error === ledger.error
        && target?.node.id === countRetry.firstPendingNodeId
        && target.retryFeedback === SCENE_CUT_IMAGE_COUNT_RETRY_FEEDBACK
        && fork.nodeRuns.slice(0, index).every((run, at) =>
          JSON.stringify(run) === JSON.stringify(source.nodeRuns[at]))
        && request.prompt === approvedPrompt
          + renderRetryFeedbackPrompt(SCENE_CUT_IMAGE_COUNT_RETRY_FEEDBACK))
    }
    const marker = fork.sceneCutAutoRetry
    if (!marker) return false
    const sourceRow = (await db.query('SELECT workflow_id,result FROM execution_records WHERE id=$1',
      [fork.parentExecutionId])).rows[0]
    if (sourceRow?.workflow_id !== forkRow.workflow_id) return false
    const source = decodeExecutionState<StoredSceneCutRetryState>(sourceRow.result)
    const previous = source.sceneCutAutoRetry
    const inheritedOtherLoopSource = marker.count === 1
      && previous?.sourceExecutionId === marker.sourceExecutionId
      && (previous.loopGroupId !== marker.loopGroupId
        || previous.loopIndex !== marker.loopIndex)
    if (marker.count === 1 && fork.parentExecutionId !== marker.sourceExecutionId
      && !inheritedOtherLoopSource) return false
    const failedIndex = source.nodeRuns.findIndex(run =>
      run.status === 'failed' && run.node.id === 'sanguo-scene-cut-approval'
      && run.loopGroupId === marker.loopGroupId && run.loopIndex === marker.loopIndex)
    const failed = source.nodeRuns[failedIndex]
    if (!failed || !/^SCENE_CUT_FRAME_REJECTED:/.test(failed.error ?? '')) return false
    const plan = planSceneCutAutoRetry(source.nodeRuns, failedIndex,
      previous?.loopGroupId === failed.loopGroupId && previous?.loopIndex === failed.loopIndex
        ? (previous?.count ?? 0) : 0)
    const target = fork.nodeRuns[plan?.imageIndex ?? -1]
    return Boolean(plan && marker.count === plan.count
      && marker.sourceReviewRunId === plan.reviewRunId
      && target?.node.id === 'sanguo-scene-cut-first-frame'
      && target?.retryFeedback === plan.feedback
      && fork.nodeRuns.slice(0, plan.imageIndex).every((run: unknown, index: number) =>
        JSON.stringify(run) === JSON.stringify(source.nodeRuns[index]))
      && request.prompt === approvedPrompt + renderRetryFeedbackPrompt(plan.feedback))
  } catch { return false }
  finally { await db.end().catch(() => undefined) }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value ?? null)
}
function storedExecutionText(value: string) {
  return value.length > 100000
    ? `${value.slice(0, 100000)}[日志截断，共${value.length}字符]` : value
}
function ledgerSafeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^data:[^;]+;base64,/i.test(value)
      || value.length > 10000 && /^[A-Za-z0-9+/=\r\n]+$/.test(value))
      return `[素材内容已隐藏，${value.length} 字符]`
    return value.length > 100000
      ? `${value.slice(0, 100000)}[日志截断，共${value.length}字符]` : value
  }
  if (Array.isArray(value)) return value.map(ledgerSafeValue)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key,
      /apiKey|accessKey|secretKey|authorization/i.test(key) ? '[hidden]' : ledgerSafeValue(child)]))
  return value
}
function reviewLedgerSources(sourcesInput: unknown, root: string) {
  const sources = object(sourcesInput)
  const refs = sources.imageReferenceImages
  const bindings = sources.referenceBindings
  if (!Array.isArray(refs) || !Array.isArray(bindings)) return sources
  if (refs.length !== bindings.length) fail('审核人设板数量与冻结来源不一致')
  const logged = refs.map((ref, index) => {
    const binding = object(bindings[index])
    const bytes = localImageBytes(binding.frontUrl, root)
    if (sha256(bytes) !== binding.frontSha256
      || ref !== `data:image/jpeg;base64,${bytes.toString('base64')}`)
      fail('审核人设板字节与冻结来源不一致')
    return `[素材内容已隐藏，${String(ref).length} 字符]`
  })
  return { ...object(ledgerSafeValue(sources)), imageReferenceImages: logged }
}
function localImageBytes(url: unknown, root: string) {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(url)) fail('资产不是本地已归档图片')
  try { return readFileSync(path.join(root, 'public', String(url))) }
  catch { return fail('已归档图片丢失') }
}

/** Codex image must use the frozen small front references, not arbitrary uploads. */
export async function validateSceneCutPaidImageRequest(request: MediaRequest, root = process.cwd(),
  activeSchemaVersion = 167) {
  if (request.model.capability !== 'image' || request.executionContext?.workflowId !== 'wf-sanguo-history-drama'
    || request.executionContext?.nodeId !== 'sanguo-scene-cut-first-frame') return
  const sources = object(request.params.sceneCutSources), shot = object(request.params.sceneCutShot)
  const freshRequest = String(request.executionContext?.requestKey ?? '')
    .startsWith(`${A8B6_FRESH_FRAME_ID}:`)
    || String(request.executionContext?.requestKey ?? '')
      .startsWith(`${A8B6_FRESH_EDIT_FRAME_ID}:`)
    || String(request.executionContext?.requestKey ?? '')
      .startsWith(`${A8B6_FRESH_V5_EDIT_FRAME_ID}:`)
    || String(request.executionContext?.requestKey ?? '')
      .startsWith(`${A8B6_FRESH_V6_EDIT_FRAME_ID}:`)
    || String(request.executionContext?.requestKey ?? '')
      .startsWith(`${A8B6_FRESH_V7_EDIT_FRAME_ID}:`)
    || String(request.executionContext?.requestKey ?? '')
      .startsWith(`${A8B6_FRESH_V8_EDIT_FRAME_ID}:`)
    || request.params.sceneCutFreshImage !== undefined
  const bindings = Array.isArray(sources.referenceBindings) ? sources.referenceBindings.map(object) : []
  const refs = Array.isArray(request.params.referenceImages) ? request.params.referenceImages : []
  const repairReceipt = object(request.params.sceneCutRepairReceipt)
  const hasRepairReference = request.params.sceneCutRepairReceipt !== undefined
  const hasFreshEditReference = request.params.sceneCutFreshEditReceipt !== undefined
  const repairReferenceCount = activeSchemaVersion >= 178 ? 2 : 1
  const v7FreshEdit = hasFreshEditReference
    && object(request.params.sceneCutFreshImage).version
      === A8B6_FRESH_V7_EDIT_FRAME_VERSION
  const v8FreshEdit = hasFreshEditReference
    && object(request.params.sceneCutFreshImage).version
      === A8B6_FRESH_V8_EDIT_FRAME_VERSION
  const identityRefs = hasRepairReference ? refs.slice(0, -repairReferenceCount)
    : hasFreshEditReference ? refs.slice(0, v8FreshEdit ? -3
      : v7FreshEdit ? -2 : -1) : refs
  const expectedPlateVersion = activeSchemaVersion >= 172
    ? 'scene-cut-identity-plate-v4'
    : activeSchemaVersion >= 170 ? 'scene-cut-identity-plate-v3' : 'scene-cut-identity-plate-v2'
  if (request.model.provider !== 'Codex' || sources.version !== 'scene-cut-sources-v1'
    || sources.identityPlateVersion !== expectedPlateVersion
    || sources.shotId !== shot.id || object(shot.continuity).mode !== 'scene_cut'
    || shot.firstFrameMode !== 'reference' || shot.visualTreatment !== 'live_action'
    || bindings.length !== identityRefs.length || bindings.length > 5
    || hasRepairReference && (activeSchemaVersion < 177 || bindings.length !== 2
      || refs.length !== 2 + repairReferenceCount)
    || hasFreshEditReference && (hasRepairReference || bindings.length !== 2
      || refs.length !== (v8FreshEdit ? 5 : v7FreshEdit ? 4 : 3))
    || !Array.isArray(sources.imageReferenceImages)
    || canonical(identityRefs) !== canonical(sources.imageReferenceImages)
    || request.params.singleFrame !== true && request.params.singleFrame !== 'true'
    || request.params.size !== '1536x864') fail('首帧生图未绑定批准分镜或冻结人设')
  for (const [index, binding] of bindings.entries()) {
    const original = localImageBytes(binding.url, root), front = localImageBytes(binding.frontUrl, root)
    const layout = binding.referenceLayout as 'horizontal-three-view' | 'vertical-three-view' | 'single-portrait' | undefined
    const expected = activeSchemaVersion >= 172
      ? await buildSceneCutIdentityPlateV4(original, layout)
      : activeSchemaVersion >= 170 ? await buildSceneCutIdentityPlateV3(original, layout)
        : await buildSceneCutIdentityPlate(original, layout)
    if (sha256(original) !== binding.sha256 || sha256(front) !== binding.frontSha256
      || binding.identityPlateVersion !== expectedPlateVersion
      || binding.referenceLayout !== undefined && binding.referenceLayout !== expected.layout
      || ('partSha256s' in expected
        ? canonical(binding.partSha256s) !== canonical(expected.partSha256s)
        : binding.upperSha256 !== expected.upperSha256
          || binding.lowerSha256 !== expected.lowerSha256)
      || !front.equals(expected.plate)
      || identityRefs[index] !== `data:image/jpeg;base64,${front.toString('base64')}`)
      fail('首帧身份参考不是已归档原图的冻结正面图')
  }
  if (hasRepairReference) {
    const referenceOrder = Array.isArray(repairReceipt.referenceOrder)
      ? repairReceipt.referenceOrder.map(object) : []
    const third = object(referenceOrder[2])
    if (repairReceipt.version !== (activeSchemaVersion >= 178
      ? 'scene-cut-rejected-image-edit-reference-v2'
      : 'scene-cut-rejected-image-edit-reference-v1')
      || repairReceipt.role !== 'reference-only' || repairReceipt.sourceVerdict !== 'rejected'
      || repairReceipt.approvedFirstFrame !== false
      || repairReceipt.requiresFreshIndependentReview !== true
      || repairReceipt.requiresPaidGateRevalidation !== true
      || !Array.isArray(repairReceipt.referenceOrder)
      || referenceOrder.length !== 2 + repairReferenceCount
      || third.position !== 3 || third.role !== 'rejected-edit-source'
      || typeof third.sourceUrl !== 'string' || !/^\/generated\/image-[a-f0-9]{32}\.png$/.test(third.sourceUrl)
      || typeof refs[2] !== 'string' || !refs[2].startsWith('data:image/jpeg;base64,'))
      fail('修复图第三参考不是服务端绑定的失败首帧')
    const failedPng = localImageBytes(third.sourceUrl, root)
    const converted = await sharp(failedPng, { failOn: 'error' })
      .jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
    if (sha256(failedPng) !== third.sourceSha256
      || sha256(converted) !== third.jpegSha256
      || converted.length !== third.bytes
      || refs[2] !== `data:image/jpeg;base64,${converted.toString('base64')}`
      || repairReceipt.sourceImageUrl !== third.sourceUrl
      || repairReceipt.sourceImageSha256 !== third.sourceSha256
      || referenceOrder.some((item, index) => index < 2
        && (item.position !== index + 1 || item.frontUrl !== bindings[index].frontUrl
          || item.sha256 !== bindings[index].frontSha256)))
      fail('修复图第三参考字节、顺序或身份板来源不一致')
    if (activeSchemaVersion >= 178) {
      const guide = object(referenceOrder[3])
      const guideDeclaration = object(repairReceipt.geometryGuide)
      if (guide.position !== 4 || guide.role !== 'geometry-guide'
        || guide.purpose !== 'geometry-only' || guide.referenceOnly !== true
        || guideDeclaration.role !== 'geometry-only'
        || guideDeclaration.identityAuthority !== false
        || guideDeclaration.sourcePath !== guide.sourcePath
        || guideDeclaration.sourceSha256 !== guide.sourceSha256
        || typeof guide.sourcePath !== 'string'
        || !/^qa\/record-[A-Za-z0-9_-]+\/geometry-guide-v\d+-[a-f0-9]{8}\.png$/.test(guide.sourcePath)
        || typeof guide.sourceSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(guide.sourceSha256)
        || typeof refs[3] !== 'string' || !refs[3].startsWith('data:image/jpeg;base64,'))
        fail('第四参考须为只读几何引导图，不能替代冻结身份板')
      let guidePng: Buffer
      try { guidePng = readFileSync(path.join(root, String(guide.sourcePath))) }
      catch { return fail('第四几何引导图丢失') }
      let guideJpeg: Buffer
      try {
        guideJpeg = await sharp(guidePng, { failOn: 'error' })
          .jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer()
      } catch { return fail('第四几何引导图无法解码') }
      if (sha256(guidePng) !== guide.sourceSha256
        || sha256(guideJpeg) !== guide.jpegSha256
        || guideJpeg.length !== guide.bytes
        || refs[3] !== `data:image/jpeg;base64,${guideJpeg.toString('base64')}`)
        fail('第四几何引导图字节、顺序或转换格式不一致')
    }
  }
  if (v7FreshEdit) {
    const receipt = object(request.params.sceneCutFreshEditReceipt)
    const order = Array.isArray(receipt.referenceOrder)
      ? receipt.referenceOrder.map(object) : []
    const face = object(order[3])
    const source = localImageBytes(A8B6_FRESH_V7_YAN_FRONT_URL, root)
    const derived = await sharp(source, { failOn: 'error' })
      .extract(A8B6_FRESH_V7_FACE_CROP)
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer()
    if (order.length !== 4 || face.position !== 4
      || face.role !== 'frozen-face-crop' || face.identityAuthority !== true
      || face.sourceUrl !== A8B6_FRESH_V7_YAN_FRONT_URL
      || face.sourceSha256 !== A8B6_FRESH_V7_YAN_FRONT_SHA
      || canonical(face.crop) !== canonical(A8B6_FRESH_V7_FACE_CROP)
      || sha256(source) !== A8B6_FRESH_V7_YAN_FRONT_SHA
      || face.jpegSha256 !== sha256(derived)
      || face.bytes !== derived.length
      || refs[3] !== `data:image/jpeg;base64,${derived.toString('base64')}`)
      fail('V7 第四身份局部参考不是冻结严颜板原像素裁片')
  }
  if (activeSchemaVersion >= 171) verifySceneCutEllipsisProof(sources, shot, root)
  if (activeSchemaVersion >= 168) {
    const planVersion = activeSchemaVersion >= 195 ? 4 : activeSchemaVersion >= 170 ? 3 : activeSchemaVersion >= 169 ? 2 : 1
    const expectedPlan = deriveSceneCutOpeningPlan(shot, planVersion)
    if (canonical(request.params.sceneCutOpeningPlan) !== canonical(expectedPlan)
      || !await sceneCutImagePromptMatches(request, renderWorkflowTemplate(planVersion >= 3
          ? activeSchemaVersion >= 178 ? freshRequest
            ? hasFreshEditReference ? object(request.params.sceneCutFreshImage).version
              === A8B6_FRESH_V5_EDIT_FRAME_VERSION
              ? A8B6_FRESH_V5_EDIT_FIRST_FRAME_PROMPT
              : object(request.params.sceneCutFreshImage).version
                === A8B6_FRESH_V6_EDIT_FRAME_VERSION
                ? A8B6_FRESH_V6_EDIT_FIRST_FRAME_PROMPT
                : object(request.params.sceneCutFreshImage).version
                  === A8B6_FRESH_V7_EDIT_FRAME_VERSION
                  ? A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT
                  : object(request.params.sceneCutFreshImage).version
                    === A8B6_FRESH_V8_EDIT_FRAME_VERSION
                    ? A8B6_FRESH_V8_EDIT_FIRST_FRAME_PROMPT
              : A8B6_FRESH_EDIT_FIRST_FRAME_PROMPT
              : A8B6_FRESH_FIRST_FRAME_PROMPT : activeSchemaVersion >= 197
                ? SCENE_CUT_FIRST_FRAME_PROMPT_V197 : activeSchemaVersion >= 195
                  ? SCENE_CUT_FIRST_FRAME_PROMPT_V195 : activeSchemaVersion >= 184
                  ? SCENE_CUT_FIRST_FRAME_PROMPT : SCENE_CUT_FIRST_FRAME_PROMPT_V178
          : activeSchemaVersion >= 177 ? SCENE_CUT_FIRST_FRAME_PROMPT_V177
          : activeSchemaVersion >= 176 ? SCENE_CUT_FIRST_FRAME_PROMPT_V176
          : activeSchemaVersion >= 175 ? SCENE_CUT_FIRST_FRAME_PROMPT_V175
          : activeSchemaVersion >= 174 ? SCENE_CUT_FIRST_FRAME_PROMPT_V174
          : activeSchemaVersion >= 173 ? SCENE_CUT_FIRST_FRAME_PROMPT_V173
          : activeSchemaVersion >= 172
            ? SCENE_CUT_FIRST_FRAME_PROMPT_V172 : SCENE_CUT_FIRST_FRAME_PROMPT_V170
        : planVersion === 2 ? SCENE_CUT_FIRST_FRAME_PROMPT_V169 : SCENE_CUT_FIRST_FRAME_PROMPT_V168,
        { shot_script: shot, scene_cut_sources: sources,
          scene_cut_opening_state: request.params.sceneCutOpeningPlan })))
      fail('首帧付费请求未使用当前批准分镜的正向零秒起点计划')
  }
  if (freshRequest) {
    if (hasFreshEditReference) {
      if (object(request.params.sceneCutFreshImage).version
        === A8B6_FRESH_V5_EDIT_FRAME_VERSION)
        await verifyA8B6FreshV5EditPaidRequest(request, root)
      else if (object(request.params.sceneCutFreshImage).version
        === A8B6_FRESH_V6_EDIT_FRAME_VERSION)
        await verifyA8B6FreshV6EditPaidRequest(request, root)
      else if (object(request.params.sceneCutFreshImage).version
        === A8B6_FRESH_V7_EDIT_FRAME_VERSION)
        await verifyA8B6FreshV7EditPaidRequest(request, root)
      else if (object(request.params.sceneCutFreshImage).version
        === A8B6_FRESH_V8_EDIT_FRAME_VERSION)
        await verifyA8B6FreshV8EditPaidRequest(request, root)
      else await verifyA8B6FreshEditPaidRequest(request, root)
    }
    else await verifyA8B6FreshImageRequest(request, root)
  }
}

/** Existing paid task resumes retain the original ledger identity; new scene
 * cut purchases require the signed image review. */
export function validateSceneCutRepairPaymentContext(requestKey: unknown,
  referenceImage: unknown, certificateInput: unknown,
  repairContext?: VideoRepairContext,
activeSchemaVersion = 177) {
  const identity = typeof requestKey === 'string' ? requestKey.match(
    /^(record-[\w-]+):attempt-[1-9]\d*:revision-(?:0|[1-9]\d*):sanguo-video:(\d+):(scene-\d+)$/) : null
  if (!identity || !repairContext || repairContext.executionId !== identity[1])
    fail('视频请求未绑定当前执行记录的修复分支状态')
  const currentIdentity = identity as RegExpMatchArray
  const currentRepair = repairContext as NonNullable<typeof repairContext>
  const certificate = object(certificateInput), recovery = object(currentRepair.recovery)
  const binding = object(certificate.repairBinding), receipt = object(binding.receipt)
  const repairShot = currentRepair.recovery && currentIdentity[2] === '0'
    && currentIdentity[3] === 'scene-01'
  if (repairShot) {
    const hashes = Array.isArray(certificate.sourceSha256s) ? certificate.sourceSha256s : []
    const version = activeSchemaVersion >= 178 ? 2 : 1
    const refs = Array.isArray(receipt.referenceOrder)
      ? receipt.referenceOrder.map(object) : []
    const guide = object(refs[3])
    if (recovery.version !== `scene-cut-image-repair-schema${version === 2 ? 178 : 177}-fork-v${version}`
      || recovery.workflowSchemaVersion !== (version === 2 ? 178 : 177)
      || binding.version !== `scene-cut-image-repair-binding-v${version}`
      || receipt.version !== `scene-cut-rejected-image-edit-reference-v${version}`
      || refs.length !== (version === 2 ? 4 : 3)
      || binding.executionId !== currentRepair.executionId
      || typeof binding.imageExecutionId !== 'string'
      || !/^model-run-[\w-]+$/.test(binding.imageExecutionId)
      || typeof binding.repairRequestFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(binding.repairRequestFingerprint)
      || typeof binding.repairReceiptSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(binding.repairReceiptSha256)
      || receipt.sourceExecutionId !== recovery.sourceExecutionId
      || receipt.sourceResultMd5 !== recovery.sourceResultMd5
      || receipt.sourceImageSha256 !== recovery.failedImageFileSha256
      || receipt.failedReviewOutputSha256 !== recovery.failedReviewOutputSha256
      || receipt.preparationSha256 !== recovery.repairPreparationSha256
      || version === 2 && (guide.position !== 4 || guide.role !== 'geometry-guide'
        || guide.purpose !== 'geometry-only' || guide.referenceOnly !== true
        || guide.sourcePath !== recovery.geometryGuideSourcePath
        || guide.sourceSha256 !== recovery.geometryGuideSourceSha256
        || guide.jpegSha256 !== recovery.geometryGuideJpegSha256
        || typeof receipt.guideProvenanceSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(receipt.guideProvenanceSha256)
        || receipt.guideProvenanceSha256 !== recovery.geometryGuideProvenanceSha256)
      || binding.candidateImageSha256 !== hashes[0]
      || object(certificate.frame).sourceUrl !== referenceImage)
      fail('当前修复分支没有新生首帧的已签来源、模型执行与独立审核凭证')
  } else if (certificate.repairBinding) fail('修复图凭证不可转用于其他分镜执行')
  return true
}

export function validateSceneCutPaidVideoRequest(request: MediaRequest, paidResumeRecord?: unknown,
root = process.cwd(), activeSchemaVersion = 170,
repairContext?: VideoRepairContext) {
  if (request.model.capability !== 'video' || request.executionContext?.workflowId !== 'wf-sanguo-history-drama'
    || request.executionContext?.nodeId !== 'sanguo-video') return 'unrelated'
  if (request.params.resumeTaskId) {
    validateCoverageCutPaidResume(paidResumeRecord, request)
    return 'paid-reattach'
  }
  const shot = object(request.params.sceneCutShot)
  const shotMode = object(shot.continuity).mode
  if (typeof shot.id !== 'string' || !shot.id || typeof shotMode !== 'string' || !shotMode
    || request.params.continuityMode !== shotMode
    || request.params.visualTreatment !== shot.visualTreatment) {
    fail('视频请求缺少批准分镜，或连续性/画面类型与分镜不一致')
  }
  if (shotMode !== 'scene_cut' || shot.visualTreatment !== 'live_action') return 'unrelated'
  if (activeSchemaVersion >= 172
    && object(request.params.sceneCutSources).identityPlateVersion !== 'scene-cut-identity-plate-v4')
    fail('当前换场视频缺少新版连续衣摆身份参考板，旧首帧凭证不可付款')
  if (activeSchemaVersion >= 171) {
    const certificate = object(request.params.sceneCutFrameGate)
    if (!certificate.outlineBinding || !request.params.sceneCutSources)
      fail('当前批准大纲与换场首帧凭证缺失，禁止使用旧凭证付款')
    verifySceneCutEllipsisProof(request.params.sceneCutSources, shot, root)
  }
  const certificate = validateSceneCutVideoPayment(request.params, root)
  if (activeSchemaVersion >= 177) validateSceneCutRepairPaymentContext(
    request.executionContext?.requestKey, request.params.referenceImage, certificate,
    repairContext, activeSchemaVersion)
  validateSceneCutTailGuidePayment(request, repairContext, root)
  return 'new-purchase'
}

/** The persisted in-flight node and its source records are rechecked by
 * readSceneCutRepairVideoContext before this request-level comparison. */
export function validateSceneCutTailGuidePayment(request: MediaRequest,
  repairContext?: VideoRepairContext, root = process.cwd()) {
  const tailGuide = repairContext?.tailGuide
  const requestedEndImage = request.params.endImage
  if (tailGuide) {
    if (request.executionContext?.requestKey?.split(':')[0] !== repairContext?.executionId
      || requestedEndImage !== tailGuide.endImage
      || !/^[a-f0-9]{64}$/.test(tailGuide.endImageSha256)
      || !/^[a-f0-9]{64}$/.test(tailGuide.sourceVideoSha256)
      || sha256(localImageBytes(tailGuide.endImage, root)) !== tailGuide.endImageSha256) {
      fail('尾帧参考未绑定当前记录已采证的原生末帧')
    }
  } else if (typeof requestedEndImage === 'string' && requestedEndImage.trim()) {
    fail('真人换场视频不得使用未经来源验证的目标尾帧')
  }
  return true
}

type SceneCutReviewExpected = { evidence: unknown; shot: unknown; sources: unknown;
  reviewImages: unknown; openingStatePlan?: unknown; sceneCutFreshImage?: unknown;
  sceneCutLocalComposite?: unknown }
const verifiedLocalDetails = Symbol('source-bound local review details')
const LOCAL_DETAIL_VERSIONS = [A8B6_LOCAL_V8_FRAME_VERSION,
  A8B6_LOCAL_V9_FRAME_VERSION]
const localDetailConfig = (version: unknown) =>
  version === A8B6_LOCAL_V9_FRAME_VERSION
    ? A8B6_LOCAL_V9_REVIEW_IMAGE_DETAIL
    : A8B6_LOCAL_V8_REVIEW_IMAGE_DETAIL

/** Recreate the four native-pixel details from the archived JPEG, then match
 * every actual Codex attachment. This is required before a detail ledger may be
 * treated as evidence; metadata or a crop URL alone is insufficient. */
export async function assertSceneCutReviewDetailAttachments(record: unknown,
  expected: SceneCutReviewExpected, root = process.cwd()) {
  const row = object(record), request = object(row.request_data)
  const params = object(request.params), raw = object(object(row.response_data).raw)
  const urls = expected.reviewImages
  const version = object(expected.sceneCutLocalComposite).version
  const detailConfig = localDetailConfig(version)
  if (!LOCAL_DETAIL_VERSIONS.includes(String(version))
    || row.provider !== 'Codex' || raw.provider !== 'Codex'
    || !Array.isArray(urls) || urls.length !== 3
    || canonical(params.reviewImageDetail)
      !== canonical(detailConfig))
    fail('局部审图配置或模型附件来源不匹配')
  const frames = await loadReviewImages(urls, root,
    detailConfig)
  const hashes = frames.map(frame => ({ url: frame.url,
    sha256: sha256(frame.bytes) }))
  const catalog = frames.map((frame, index) => ({
    attachmentIndex: index, fileName: `image-${index}.jpg`, url: frame.url,
    kind: frame.kind ?? 'original', frameIndex: frame.frameIndex ?? index,
    ...(frame.label === undefined ? {} : { label: frame.label }),
    ...(frame.sourceRect === undefined ? {} : {
      sourceRect: frame.sourceRect }),
    sha256: sha256(frame.bytes), byteLength: frame.bytes.length,
  }))
  if (frames.length !== 7
    || !isDeepStrictEqual(request.reviewImageHashes, hashes)
    || !isDeepStrictEqual(raw.attachments, catalog))
    fail('模型附件与归档首帧原像素裁片不一致')
  return true
}

/** A detail ledger can only enter the common managed-prompt and response
 * verification after the asynchronous source-pixel check above succeeds. */
export async function assertSceneCutReviewLedgerRecordWithDetail(record: unknown,
  review: unknown, expected: SceneCutReviewExpected,
  root = process.cwd(), activeSchemaVersion = 171) {
  await assertSceneCutReviewDetailAttachments(record, expected, root)
  return assertSceneCutReviewLedgerRecord(record, review, expected,
    root, activeSchemaVersion, verifiedLocalDetails)
}

/** The signed conclusion must be an actual independent model response to the
 * managed prompt with exactly these JPEG attachments. */
export function assertSceneCutReviewLedgerRecord(record: unknown, review: unknown,
  expected: SceneCutReviewExpected,
  root = process.cwd(), activeSchemaVersion = 171,
  detailProof?: symbol) {
  const row = object(record), request = object(row.request_data), params = object(request.params)
  if (row.channel !== 'workflow' || row.workflow_id !== 'wf-sanguo-history-drama'
    || row.node_id !== 'sanguo-scene-cut-review' || row.capability !== 'text'
    || row.provider === 'Local' || row.status !== 'succeeded'
    || typeof row.id !== 'string' || !/^model-run-[\w-]+$/.test(row.id)
    || typeof request.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(request.fingerprint)) {
    fail('缺少独立视觉模型成功执行记录')
  }
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'sources') {
      const logged = reviewLedgerSources(value, root)
      if (canonical(params.sources) !== canonical(value)
        && canonical(params.sources) !== canonical(logged)) fail('审核请求未绑定当前 sources')
    } else if (canonical(params[key]) !== canonical(value)) fail(`审核请求未绑定当前 ${key}`)
  }
  const images = Array.isArray(expected.reviewImages) ? expected.reviewImages : []
  const reviewImageHashes = Array.isArray(request.reviewImageHashes) ? request.reviewImageHashes : []
  const detailVersion = object(expected.sceneCutLocalComposite).version
  const detailReview = LOCAL_DETAIL_VERSIONS.includes(String(detailVersion))
  if (!Array.isArray(expected.reviewImages) || images.length < 1 || images.length > 7
    || !Array.isArray(request.reviewImageHashes)
    || reviewImageHashes.length !== images.length + (detailReview ? 4 : 0)
    || (detailReview
      ? detailProof !== verifiedLocalDetails
        || canonical(params.reviewImageDetail)
          !== canonical(localDetailConfig(detailVersion))
      : params.reviewImageDetail !== undefined))
    fail('模型实际审核图片不完整')
  for (const [index, image] of images.entries()) {
    if (typeof image !== 'string' || !/^\/generated\/[\w.-]+\.jpg$/.test(image)) fail('审核附件不是本地 JPEG')
    const stored = object(reviewImageHashes[index])
    let bytes: Buffer
    try { bytes = readFileSync(path.join(root, 'public', image)) }
    catch { return fail('审核附件丢失') }
    if (stored.url !== image || stored.sha256 !== sha256(bytes)) fail('当前附件字节与模型查看时不同')
  }
  const archivedEvidence = object(expected.evidence)
  let promptEvidence: unknown = expected.evidence
  const evidenceUrl = archivedEvidence.evidenceUrl
  const generatedReport = typeof evidenceUrl === 'string'
    && /^\/generated\/[\w.-]+\.json$/.test(evidenceUrl)
  const productionReport = typeof evidenceUrl === 'string'
    && /^\/generated\/image-evidence-[a-f0-9]{24}\.json$/.test(evidenceUrl)
  // Legacy fixtures may name a report that was never archived. A real
  // content-addressed production report, however, must still be present.
  if (generatedReport && (productionReport
    || existsSync(path.join(root, 'public', evidenceUrl)))) {
    try {
      const report = JSON.parse(readFileSync(path.join(root, 'public', evidenceUrl), 'utf8'))
      if (canonical(report) !== canonical(expected.evidence)) fail('采证原始报告与审核输入不一致')
      promptEvidence = report
    } catch { fail('采证原始报告丢失或无法核对') }
  }
  const local = expected.sceneCutLocalComposite !== undefined
  const localMarker = object(expected.sceneCutLocalComposite)
  const localV2 = localMarker.version === A8B6_LOCAL_V2_FRAME_VERSION
  const localV3 = localMarker.version === A8B6_LOCAL_V3_FRAME_VERSION
  const localV4 = localMarker.version === A8B6_LOCAL_V4_FRAME_VERSION
  const localV5 = localMarker.version === A8B6_LOCAL_V5_FRAME_VERSION
  const localV6 = localMarker.version === A8B6_LOCAL_V6_FRAME_VERSION
  const localV7 = localMarker.version === A8B6_LOCAL_V7_FRAME_VERSION
  const localV8 = localMarker.version === A8B6_LOCAL_V8_FRAME_VERSION
  const localV9 = localMarker.version === A8B6_LOCAL_V9_FRAME_VERSION
  const localPrompt = localV9 ? A8B6_LOCAL_V9_FRAME_REVIEW_PROMPT
    : localV8 ? A8B6_LOCAL_V8_FRAME_REVIEW_PROMPT
    : localV7 ? A8B6_LOCAL_V7_FRAME_REVIEW_PROMPT
    : localV6 ? A8B6_LOCAL_V6_FRAME_REVIEW_PROMPT
    : localV5 ? A8B6_LOCAL_V5_FRAME_REVIEW_PROMPT
    : localV4 ? A8B6_LOCAL_V4_FRAME_REVIEW_PROMPT
    : localV3 ? A8B6_LOCAL_V3_FRAME_REVIEW_PROMPT
    : localV2 ? A8B6_LOCAL_V2_FRAME_REVIEW_PROMPT
      : A8B6_LOCAL_FRAME_REVIEW_PROMPT
  if (local) {
    const signed = localV9
      ? verifyA8B6LocalCompositeSourceReceiptV9Sync(root)
      : localV8
      ? verifyA8B6LocalCompositeSourceReceiptV8Sync(root)
      : localV7 ? verifyA8B6LocalCompositeSourceReceiptV7Sync(root)
      : localV6 ? verifyA8B6LocalCompositeSourceReceiptV6Sync(root)
      : localV5 ? verifyA8B6LocalCompositeSourceReceiptV5Sync(root)
      : localV4 ? verifyA8B6LocalCompositeSourceReceiptV4Sync(root)
      : localV3 ? verifyA8B6LocalCompositeSourceReceiptV3Sync(root)
      : localV2 ? verifyA8B6LocalCompositeSourceReceiptV2Sync(root)
        : verifyA8B6LocalCompositeSourceReceiptSync(root)
    const signedOutput = object(signed.receipt.output)
    if (expected.sceneCutFreshImage !== undefined
      || ![A8B6_LOCAL_FRAME_VERSION, A8B6_LOCAL_V2_FRAME_VERSION,
        A8B6_LOCAL_V3_FRAME_VERSION, A8B6_LOCAL_V4_FRAME_VERSION,
        A8B6_LOCAL_V5_FRAME_VERSION, A8B6_LOCAL_V6_FRAME_VERSION,
        A8B6_LOCAL_V7_FRAME_VERSION, A8B6_LOCAL_V8_FRAME_VERSION,
        A8B6_LOCAL_V9_FRAME_VERSION]
        .includes(String(localMarker.version))
      || localMarker.sourceReceiptSha256 !== signed.receiptSha256
      || localMarker.outputUrl !== signedOutput.url
      || localMarker.outputSha256 !== signedOutput.sha256
      || localMarker.firstPendingIndex !== 46
      || localMarker.reviewPromptSha256
        !== sha256(Buffer.from(localPrompt))
      || (localV2 && (localMarker.imageGenRawSha256
        !== object(signed.receipt.sources[1]).sha256
        || localMarker.imageGenPromptSha256
          !== object(signed.receipt.imageGen).promptSha256))
      || (localV3 && (localMarker.priorLocalV2ExecutionId
        !== object(signed.receipt.priorLocalV2).executionId
        || localMarker.priorLocalV2ResultMd5
          !== object(signed.receipt.priorLocalV2).resultMd5
        || localMarker.priorLocalV2RejectedReviewSha256
          !== object(signed.receipt.priorLocalV2).rejectedReviewSha256
        || localMarker.priorLocalV2ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV2).reviewModelExecutionId
        || localMarker.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256
        || localMarker.faceImageGenRawSha256
          !== object(signed.receipt.sources[2]).sha256
        || localMarker.gateFrameImageGenRawSha256
          !== object(signed.receipt.sources[3]).sha256))
      || (localV4 && (localMarker.priorLocalV3ExecutionId
        !== object(signed.receipt.priorLocalV3).executionId
        || localMarker.priorLocalV3ResultMd5
          !== object(signed.receipt.priorLocalV3).resultMd5
        || localMarker.priorLocalV3RejectedReviewSha256
          !== object(signed.receipt.priorLocalV3).rejectedReviewSha256
        || localMarker.priorLocalV3ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV3).reviewModelExecutionId
        || localMarker.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256))
      || (localV5 && (localMarker.priorLocalV4ExecutionId
        !== object(signed.receipt.priorLocalV4).executionId
        || localMarker.priorLocalV4FailedResultMd5
          !== object(signed.receipt.priorLocalV4).failedResultMd5
        || localMarker.priorLocalV4RejectedReviewSha256
          !== object(signed.receipt.priorLocalV4).rejectedReviewSha256
        || localMarker.priorLocalV4ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV4).reviewModelExecutionId
        || localMarker.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256))
      || (localV6 && (localMarker.priorLocalV5ExecutionId
        !== object(signed.receipt.priorLocalV5).executionId
        || localMarker.priorLocalV5ResultMd5
          !== object(signed.receipt.priorLocalV5).resultMd5
        || localMarker.priorLocalV5RejectedReviewSha256
          !== object(signed.receipt.priorLocalV5).rejectedReviewSha256
        || localMarker.priorLocalV5ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV5).reviewModelExecutionId
        || localMarker.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256))
      || (localV7 && (localMarker.priorLocalV6ExecutionId
        !== object(signed.receipt.priorLocalV6).executionId
        || localMarker.priorLocalV6ResultMd5
          !== object(signed.receipt.priorLocalV6).resultMd5
        || localMarker.priorLocalV6RejectedReviewSha256
          !== object(signed.receipt.priorLocalV6).rejectedReviewSha256
        || localMarker.priorLocalV6ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV6).reviewModelExecutionId
        || localMarker.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256))
      || (localV8 && (localMarker.priorLocalV7ExecutionId
        !== object(signed.receipt.priorLocalV7).executionId
        || localMarker.priorLocalV7ResultMd5
          !== object(signed.receipt.priorLocalV7).resultMd5
        || localMarker.priorLocalV7RejectedReviewSha256
          !== object(signed.receipt.priorLocalV7).rejectedReviewSha256
        || localMarker.priorLocalV7ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV7).reviewModelExecutionId
        || localMarker.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256))
      || (localV9 && (localMarker.priorLocalV8ExecutionId
        !== object(signed.receipt.priorLocalV8).executionId
        || localMarker.priorLocalV8ResultMd5
          !== object(signed.receipt.priorLocalV8).resultMd5
        || localMarker.priorLocalV8RejectedReviewSha256
          !== object(signed.receipt.priorLocalV8).rejectedReviewSha256
        || localMarker.priorLocalV8ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV8).reviewModelExecutionId
        || localMarker.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256)))
      fail('本地派生首帧审核未绑定签名图像与受管提示')
  }
  const fresh = expected.sceneCutFreshImage !== undefined
  const freshVersion = object(expected.sceneCutFreshImage).version
  const freshFirstPrompt = freshVersion === A8B6_FRESH_V2_FRAME_VERSION
    ? A8B6_FRESH_V2_FIRST_FRAME_PROMPT
    : freshVersion === A8B6_FRESH_V8_EDIT_FRAME_VERSION
      ? A8B6_FRESH_V8_EDIT_FIRST_FRAME_PROMPT
    : freshVersion === A8B6_FRESH_V7_EDIT_FRAME_VERSION
      ? A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT
    : freshVersion === A8B6_FRESH_V6_EDIT_FRAME_VERSION
      ? A8B6_FRESH_V6_EDIT_FIRST_FRAME_PROMPT
    : freshVersion === A8B6_FRESH_V5_EDIT_FRAME_VERSION
      ? A8B6_FRESH_V5_EDIT_FIRST_FRAME_PROMPT
    : freshVersion === A8B6_FRESH_EDIT_FRAME_VERSION
      ? A8B6_FRESH_EDIT_FIRST_FRAME_PROMPT : A8B6_FRESH_FIRST_FRAME_PROMPT
  const freshReviewPrompt = freshVersion === A8B6_FRESH_V2_FRAME_VERSION
    ? A8B6_FRESH_V2_REVIEW_PROMPT
    : freshVersion === A8B6_FRESH_V8_EDIT_FRAME_VERSION
      ? A8B6_FRESH_V8_EDIT_REVIEW_PROMPT
    : freshVersion === A8B6_FRESH_V7_EDIT_FRAME_VERSION
      ? A8B6_FRESH_V7_EDIT_REVIEW_PROMPT
    : freshVersion === A8B6_FRESH_V6_EDIT_FRAME_VERSION
      ? A8B6_FRESH_V6_EDIT_REVIEW_PROMPT
    : freshVersion === A8B6_FRESH_V5_EDIT_FRAME_VERSION
      ? A8B6_FRESH_V5_EDIT_REVIEW_PROMPT
    : freshVersion === A8B6_FRESH_EDIT_FRAME_VERSION
      ? A8B6_FRESH_EDIT_REVIEW_PROMPT : A8B6_FRESH_REVIEW_PROMPT
  if (fresh && (![A8B6_FRESH_FRAME_VERSION, A8B6_FRESH_EDIT_FRAME_VERSION,
    A8B6_FRESH_V2_FRAME_VERSION, A8B6_FRESH_V5_EDIT_FRAME_VERSION,
    A8B6_FRESH_V6_EDIT_FRAME_VERSION]
    .concat(A8B6_FRESH_V7_EDIT_FRAME_VERSION,
      A8B6_FRESH_V8_EDIT_FRAME_VERSION)
    .includes(String(freshVersion))
    || object(expected.sceneCutFreshImage).firstPendingIndex !== 45
    || object(expected.sceneCutFreshImage).firstPromptSha256
      !== sha256(Buffer.from(freshFirstPrompt))))
    fail('新首帧复审缺少受管来源')
  const managedPrompt = local ? localPrompt : fresh
    ? freshReviewPrompt : expected.openingStatePlan
    ? ['scene-cut-opening-plan-v3', 'scene-cut-opening-plan-v4']
      .includes(String(object(expected.openingStatePlan).version))
      ? object(expected.sources).sourceContext
        ? activeSchemaVersion >= 187 ? SCENE_CUT_FRAME_REVIEW_PROMPT_V187
          : activeSchemaVersion >= 186 ? SCENE_CUT_FRAME_REVIEW_PROMPT_V186
          : activeSchemaVersion >= 174 ? SCENE_CUT_FRAME_REVIEW_PROMPT_V174
          : activeSchemaVersion >= 173 ? SCENE_CUT_FRAME_REVIEW_PROMPT_V173
          : activeSchemaVersion >= 172
            ? SCENE_CUT_FRAME_REVIEW_PROMPT_V172 : SCENE_CUT_FRAME_REVIEW_PROMPT_V171
        : SCENE_CUT_FRAME_REVIEW_PROMPT_V170
      : object(expected.openingStatePlan).version === 'scene-cut-opening-plan-v2'
        ? SCENE_CUT_FRAME_REVIEW_PROMPT_V169 : SCENE_CUT_FRAME_REVIEW_PROMPT_V168
    : object(expected.sources).identityPlateVersion === 'scene-cut-identity-plate-v2'
      ? SCENE_CUT_FRAME_REVIEW_PROMPT_V167 : SCENE_CUT_FRAME_REVIEW_PROMPT
  const renderExpected = (evidence: unknown) => renderWorkflowTemplate(managedPrompt,
    { scene_cut_evidence: evidence, shot_script: expected.shot,
      scene_cut_sources: expected.sources, scene_cut_opening_state: expected.openingStatePlan })
  // The archived report and persisted node output are canonically equal above,
  // yet JSONB can reorder their object keys. The browser rendered the node
  // output before persistence, so accept its exact serialization as well.
  const expectedPrompts = [renderExpected(promptEvidence)]
  if (promptEvidence !== expected.evidence)
    expectedPrompts.push(renderExpected(expected.evidence))
  const expectedPrompt = expectedPrompts.find(value =>
    request.prompt === storedExecutionText(value))
    ?? fail('使用了非受管首帧审核提示词')
  const providerRaw = object(object(row.response_data).raw)
  if (expectedPrompt.length > 100000
    && (typeof providerRaw.promptSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(providerRaw.promptSha256)))
    fail('视觉审核模型缺少完整提示哈希')
  if (request.promptSha256 !== undefined
    && request.promptSha256 !== providerRaw.promptSha256)
    fail('视觉审核模型原始提示哈希与请求账本不一致')
  // For prompts archived above 100k characters, JSONB can reorder object keys
  // after the archived prefix. The exact managed prefix, original length,
  // bound params and attachment hashes have already been checked above.
  const archivedLongPrompt = expectedPrompt.length > 100000
    && request.prompt === storedExecutionText(expectedPrompt)
  if (typeof providerRaw.promptSha256 === 'string'
    && providerRaw.promptSha256 !== sha256(Buffer.from(expectedPrompt))
    && !archivedLongPrompt)
    fail('视觉审核模型实际提示与受管提示不一致')
  const parsed = parseStructuredJson(extractTextResponse(row.response_data))
  if (!parsed || Array.isArray(parsed)) fail('原始响应无有效审核 JSON')
  const reviewed = object(review)
  if (typeof row.model_id !== 'string' || reviewed.model !== row.model_id)
    fail('送签结论的审核模型与成功执行记录不同')
  const submitted = Object.fromEntries(Object.entries(reviewed)
    .filter(([key]) => !['text', 'raw', 'model'].includes(key)))
  if (canonical(parsed) !== canonical(submitted)) fail('送签结论与模型原始响应不同')
  return row.id as string
}

export function usesSignedImageRepairInheritance(marker: unknown) {
  const version = object(marker).version
  return version === 'scene-cut-approval-rebind-v1'
    || version === 'scene-cut-approval-rebind-v2'
}

export async function completedRepairBindingForReview(pool: Queryable, row: Value,
  input: { review: unknown; evidence: unknown; shot: unknown; sources: unknown;
    executionRecordId?: string },
  root: string): Promise<SceneCutImageRepairBinding | undefined> {
  const requestKey = object(row.request_data).requestKey
  const match = typeof requestKey === 'string' ? requestKey.match(
    /^(record-[\w-]+):attempt-[1-9]\d*:revision-(?:0|[1-9]\d*):sanguo-scene-cut-review:(\d+):(scene-\d+)$/) : null
  if (!match) fail('首镜视觉审核账本未指向当前执行记录')
  const parsedMatch = match as RegExpMatchArray
  if (parsedMatch[2] !== '0' || parsedMatch[3] !== 'scene-01') return undefined
  const reviewSourceExecutionId = parsedMatch[1] as string
  const executionId = input.executionRecordId as string | undefined
  if (typeof executionId !== 'string' || !/^record-[\w-]+$/.test(executionId))
    fail('修复图审批缺少当前执行记录身份')
  const loadExecution = async (id: string) => {
    const record = object((await pool.query(`select result,md5(result::text) as result_md5 from execution_records where id=$1`,
      [id])).rows[0])
    if (!record.result) fail('视觉审核执行记录丢失')
    const decoded = decodeExecutionState<{ id?: string; parentExecutionId?: string;
      requestScopeId?: string; generationScopeId?: string; workflowId?: string;
      sceneCutImageRepairRecovery?: unknown; sceneCutApprovalRebindRecovery?: unknown;
      sceneCutA8B6ImageReuseRecovery?: unknown; sceneCutA8B6TimingRecovery?: unknown;
      sceneCutApprovedImageReuse?: unknown;
      sceneCutA8B6ConflictReviewRecovery?: unknown;
      sceneCutA8B6FreshFrameRecovery?: unknown;
      sceneCutA8B6LocalFrameRecovery?: unknown;
      nodeRuns?: unknown[] }>(record.result as Value)
    if (decoded.id !== id) fail('视觉审核执行记录 ID 不一致')
    return { ...decoded, resultMd5: record.result_md5 as string }
  }
  const execution = await loadExecution(executionId as string)
  const rebindMarker = object(execution.sceneCutApprovalRebindRecovery)
  if (execution.sceneCutApprovalRebindRecovery !== undefined
    && rebindMarker.version !== 'scene-cut-approval-rebind-v1'
    && rebindMarker.version !== 'scene-cut-approval-rebind-v2')
    fail('当前重签分支标记版本无效')
  let cursor = execution
  let nearestRebindMarker = rebindMarker
  const seen = new Set<string>()
  for (let depth = 0; cursor.id !== reviewSourceExecutionId; depth++) {
    if (depth >= 8 || !cursor.id || seen.has(cursor.id)
      || !cursor.parentExecutionId || !/^record-[\w-]+$/.test(cursor.parentExecutionId))
      fail('继承视觉审核的重试谱系过长或存在循环')
    seen.add(cursor.id as string)
    const parent = await loadExecution(cursor.parentExecutionId as string)
    const hopMarker = object(cursor.sceneCutApprovalRebindRecovery)
    if (hopMarker.version === 'scene-cut-approval-rebind-v2'
      && hopMarker.sourceExecutionId === parent.id) {
      verifySceneCutFrameApproval(object((Array.isArray(parent.nodeRuns)
        ? parent.nodeRuns : [])[50]).output, root)
      const nativeSource = await loadExecution(hopMarker.nativeSourceExecutionId as string)
      const nativeReview = await loadExecution(hopMarker.nativeReviewExecutionId as string)
      const loadVideoReviewLedger = async (id: unknown) => {
        const row = object((await pool.query(`select id,status,model_id,request_data,response_data
          from model_execution_records where id=$1`, [id])).rows[0])
        const request = object(row.request_data)
        return { id: row.id, status: row.status, modelId: row.model_id,
          requestKey: request.requestKey, fingerprint: request.fingerprint,
          output: parseStructuredJson(extractTextResponse(row.response_data)) }
      }
      const nativeReviewLedger = await loadVideoReviewLedger(hopMarker.nativeVideoReviewExecutionId)
      const currentReviewLedger = await loadVideoReviewLedger(hopMarker.failedVideoReviewExecutionId)
      assertSceneCutTailGuideRebindHop(parent, cursor, parent.resultMd5 as string, {
        nativeSource: { state: nativeSource, resultMd5: nativeSource.resultMd5 as string },
        nativeReview: { state: nativeReview, resultMd5: nativeReview.resultMd5 as string },
        nativeReviewLedger, currentReviewLedger,
        }, root, depth === 0 ? 'approval' : 'failed-approval')
      nearestRebindMarker = hopMarker
    } else if (hopMarker.version === 'scene-cut-approval-rebind-v1'
      && hopMarker.sourceExecutionId === parent.id) {
      verifySceneCutFrameApproval(object((Array.isArray(parent.nodeRuns)
        ? parent.nodeRuns : [])[50]).output, root)
      const failedLedger = object((await pool.query(`select id,status,model_id,request_data,response_data
        from model_execution_records where id=$1`,
      [hopMarker.failedVideoReviewExecutionId])).rows[0])
      const failedRequest = object(failedLedger.request_data)
      assertSceneCutApprovalRebindHop(parent, cursor, parent.resultMd5, root, depth === 0, {
        id: failedLedger.id, status: failedLedger.status, modelId: failedLedger.model_id,
        requestKey: failedRequest.requestKey, fingerprint: failedRequest.fingerprint,
        output: parseStructuredJson(extractTextResponse(failedLedger.response_data)),
      })
      nearestRebindMarker = hopMarker
    } else if (nearestRebindMarker.version === 'scene-cut-approval-rebind-v1'
      && cursor.id === nearestRebindMarker.sourceExecutionId
      && parent.id === nearestRebindMarker.sameMediaAncestorExecutionId
      && cursor.id !== parent.id) {
      verifySceneCutFrameApproval(object((Array.isArray(parent.nodeRuns)
        ? parent.nodeRuns : [])[50]).output, root)
      assertSceneCutSameMediaReviewHop(parent, cursor, nearestRebindMarker,
        parent.resultMd5, cursor.resultMd5)
    } else if ((Array.isArray(cursor.nodeRuns) ? cursor.nodeRuns : []).map(object)
      .find(run => object(run.node).id === 'sanguo-scene-cut-approval'
        && run.loopIndex === 0)?.status === 'success') {
      if (rebindMarker.version !== 'scene-cut-approval-rebind-v1'
        && rebindMarker.version !== 'scene-cut-approval-rebind-v2')
        fail('未声明重签来源的成功审批不可继承视觉审核')
      verifySceneCutFrameApproval(object((Array.isArray(cursor.nodeRuns)
        ? cursor.nodeRuns : [])[50]).output, root)
      assertSceneCutCompletedApprovalRetryHop(parent, cursor)
    } else assertSceneCutApprovalRetryHop(parent, cursor, depth === 0)
    cursor = parent
  }
  const activeApprovalRun = (Array.isArray(execution.nodeRuns) ? execution.nodeRuns : [])
    .map(object).find(run => object(run.node).id === 'sanguo-scene-cut-approval'
      && run.loopIndex === 0 && run.status === 'running')
  if (!activeApprovalRun)
    fail('当前换场首帧审批节点不在执行中')
  const approvedReuse = object(execution.sceneCutApprovedImageReuse)
  if (execution.sceneCutApprovedImageReuse !== undefined) {
    if (approvedReuse.version !== 'scene-cut-approved-image-reuse-v1')
      fail('已批准首帧复用标记版本无效')
    const currentRuns = Array.isArray(execution.nodeRuns) ? execution.nodeRuns.map(object) : []
    const latestImage = object(currentRuns[45]?.output)
    if (latestImage.url !== approvedReuse.originalImageUrl) {
      // A later paid image retry supersedes the reuse receipt. Verify the new
      // image against its own successful model ledger before ignoring the old receipt.
      const ledgers = (await pool.query(`select id,status,workflow_id,node_id,model_id,
          request_data,response_data from model_execution_records
        where workflow_id='wf-sanguo-history-drama' and node_id='sanguo-scene-cut-first-frame'
          and status='succeeded' and response_data->'data'->0->>'url'=$1`,
      [latestImage.url])).rows
      let paidImageFound = false
      for (const rawCandidate of ledgers) {
        const candidate = object(rawCandidate)
        const key = object(candidate.request_data).requestKey
        const match = typeof key === 'string' ? key.match(
          /^(record-[\w-]+):attempt-[1-9]\d*:revision-(?:0|[1-9]\d*):sanguo-scene-cut-first-frame:0:scene-01$/) : null
        if (!match || candidate.model_id !== latestImage.model) continue
        let ancestor = execution
        for (let depth = 0; depth < 16; depth++) {
          if (ancestor.id === match[1]) { paidImageFound = true; break }
          if (!ancestor.parentExecutionId) break
          ancestor = await loadExecution(ancestor.parentExecutionId)
        }
        if (paidImageFound) break
      }
      if (!paidImageFound || currentRuns[45]?.status !== 'success'
        || currentRuns[48]?.status !== 'success' || currentRuns[49]?.status !== 'success'
        || object(object(input.review).frame).sourceUrl !== latestImage.url
        || !isDeepStrictEqual(currentRuns[48]?.output, input.evidence)
        || !isDeepStrictEqual(currentRuns[49]?.output, input.review)
        || !isDeepStrictEqual(currentRuns[11]?.output, input.shot)
        || !isDeepStrictEqual(currentRuns[41]?.output, input.sources)
        || !/^\/generated\/image-[a-f0-9]{32}\.png$/.test(String(latestImage.url))
        || sha256(localImageBytes(String(latestImage.url), root))
          !== object(object(object(latestImage.raw).raw).image).sha256) {
        fail('新首帧缺少成功模型账本或与当前审核不一致')
      }
      return undefined
    }
    const source = await loadExecution(String(approvedReuse.sourceExecutionId))
    const parent = await loadExecution(String(approvedReuse.parentExecutionId))
    const sourceRuns = Array.isArray(source.nodeRuns) ? source.nodeRuns.map(object) : []
    const parentRuns = Array.isArray(parent.nodeRuns) ? parent.nodeRuns.map(object) : []
    const runs = Array.isArray(execution.nodeRuns) ? execution.nodeRuns.map(object) : []
    const signed = verifySceneCutFrameApproval(sourceRuns[50]?.output, root)
    const originalImage = object(sourceRuns[45]?.output)
    const currentImage = object(runs[45]?.output)
    const { sourceBoundImageReuse: _tag, ...originalPaidOutput } = currentImage
    void _tag
    const originalUrl = String(originalImage.url ?? '')
    const originalSha = sha256(localImageBytes(originalUrl, root))
    const sourceShot = object(sourceRuns[11]?.output)
    const currentShot = object(runs[11]?.output)
    const imageLedger = object((await pool.query(`select id,status,workflow_id,node_id,request_data,response_data
      from model_execution_records where id=$1`, [approvedReuse.originalImageExecutionId])).rows[0])
    const ledgerData = object(imageLedger.response_data).data
    const newLedgers = (await pool.query(`select id from model_execution_records
      where workflow_id='wf-sanguo-history-drama' and node_id='sanguo-scene-cut-first-frame'
      and request_data->>'requestKey' like $1`, [`${executionId}:%`])).rows
    if (approvedReuse.version !== 'scene-cut-approved-image-reuse-v1'
      || approvedReuse.sourceResultMd5 !== source.resultMd5
      || approvedReuse.parentResultMd5 !== parent.resultMd5
      || execution.parentExecutionId !== parent.id
      || source.workflowId !== parent.workflowId || parent.workflowId !== execution.workflowId
      || signed.passed !== true || signed.frame.sourceUrl !== originalUrl
      || signed.shotSha256 !== approvedReuse.originalShotSha256
      || signed.sourceSha256s?.[0] !== originalSha
      || sourceShot.id !== currentShot.id || currentShot.id !== 'scene-01'
      || approvedReuse.amendedShotSha256 !== sceneCutShotSha256(currentShot)
      || approvedReuse.originalImageUrl !== originalUrl
      || approvedReuse.originalImageSha256 !== originalSha
      || !isDeepStrictEqual(sourceRuns.slice(0, 9), parentRuns.slice(0, 9))
      || !isDeepStrictEqual(runs.slice(0, 45), parentRuns.slice(0, 45))
      || parentRuns[50]?.status !== 'failed'
      || !String(parentRuns[50]?.error ?? '').startsWith('SCENE_CUT_FRAME_REJECTED:')
      || runs[45]?.status !== 'success' || runs[48]?.status !== 'success'
      || runs[49]?.status !== 'success' || reviewSourceExecutionId !== executionId
      || !isDeepStrictEqual(originalPaidOutput, originalImage)
      || !isDeepStrictEqual(currentImage.sourceBoundImageReuse, approvedReuse)
      || !isDeepStrictEqual(object(runs[45]?.inputContext).shot_script, currentShot)
      || !isDeepStrictEqual(object(runs[45]?.inputContext).scene_cut_sources, parentRuns[41]?.output)
      || !isDeepStrictEqual(object(runs[45]?.inputContext).scene_cut_opening_state, parentRuns[43]?.output)
      || !isDeepStrictEqual(runs[48]?.output, input.evidence)
      || !isDeepStrictEqual(runs[49]?.output, input.review)
      || object(object(input.review).frame).sourceUrl !== originalUrl
      || imageLedger.id !== approvedReuse.originalImageExecutionId
      || imageLedger.status !== 'succeeded'
      || imageLedger.workflow_id !== execution.workflowId
      || imageLedger.node_id !== 'sanguo-scene-cut-first-frame'
      || !String(object(imageLedger.request_data).requestKey ?? '').startsWith(`${source.id}:`)
      || object(Array.isArray(ledgerData) ? ledgerData[0] : undefined).url !== originalUrl
      || newLedgers.length !== 0)
      fail('已批准首帧复用缺少原始付费账本、新分镜绑定或独立实图复审')
    return undefined
  }
  const conflict = object(execution.sceneCutA8B6ConflictReviewRecovery)
  if (execution.sceneCutA8B6ConflictReviewRecovery !== undefined) {
    const prior = await loadExecution(String(conflict.sourceExecutionId))
    const signed = await verifyA8B6FrameConflictReceipt(String(conflict.qaPlanId), root)
    assertA8B6ConflictReviewHop(prior, execution, prior.resultMd5, signed, 'running')
    const runs = Array.isArray(execution.nodeRuns) ? execution.nodeRuns.map(object) : []
    const image = object(runs[45]?.output)
    if (reviewSourceExecutionId !== executionId
      || conflict.originalImageSha256 !== signed.receipt.sourceImageSha256
      || image.url !== signed.receipt.sourceImageUrl
      || sha256(localImageBytes(image.url, root)) !== conflict.originalImageSha256
      || !isDeepStrictEqual(runs[48]?.output, input.evidence)
      || !isDeepStrictEqual(runs[49]?.output, input.review)
      || !isDeepStrictEqual(runs[11]?.output, input.shot)
      || !isDeepStrictEqual(runs[41]?.output, input.sources)
      || object(object(input.review).frame).sourceUrl !== image.url)
      fail('同图复审未绑定原始首帧、三图采证和当前模型结论')
    return undefined
  }
  const local = object(execution.sceneCutA8B6LocalFrameRecovery)
  if (execution.sceneCutA8B6LocalFrameRecovery !== undefined) {
    const localV2 = local.version === A8B6_LOCAL_V2_FRAME_VERSION
    const localV3 = local.version === A8B6_LOCAL_V3_FRAME_VERSION
    const localV4 = local.version === A8B6_LOCAL_V4_FRAME_VERSION
    const localV5 = local.version === A8B6_LOCAL_V5_FRAME_VERSION
    const localV6 = local.version === A8B6_LOCAL_V6_FRAME_VERSION
    const localV7 = local.version === A8B6_LOCAL_V7_FRAME_VERSION
    const localV8 = local.version === A8B6_LOCAL_V8_FRAME_VERSION
    const localV9 = local.version === A8B6_LOCAL_V9_FRAME_VERSION
    const localVersion = localV9 ? A8B6_LOCAL_V9_FRAME_VERSION
      : localV8 ? A8B6_LOCAL_V8_FRAME_VERSION
      : localV7 ? A8B6_LOCAL_V7_FRAME_VERSION
      : localV6 ? A8B6_LOCAL_V6_FRAME_VERSION
      : localV5 ? A8B6_LOCAL_V5_FRAME_VERSION
      : localV4 ? A8B6_LOCAL_V4_FRAME_VERSION
      : localV3 ? A8B6_LOCAL_V3_FRAME_VERSION
      : localV2 ? A8B6_LOCAL_V2_FRAME_VERSION
        : A8B6_LOCAL_FRAME_VERSION
    const localPrompt = localV9 ? A8B6_LOCAL_V9_FRAME_REVIEW_PROMPT
      : localV8 ? A8B6_LOCAL_V8_FRAME_REVIEW_PROMPT
      : localV7 ? A8B6_LOCAL_V7_FRAME_REVIEW_PROMPT
      : localV6 ? A8B6_LOCAL_V6_FRAME_REVIEW_PROMPT
      : localV5 ? A8B6_LOCAL_V5_FRAME_REVIEW_PROMPT
      : localV4 ? A8B6_LOCAL_V4_FRAME_REVIEW_PROMPT
      : localV3 ? A8B6_LOCAL_V3_FRAME_REVIEW_PROMPT
      : localV2 ? A8B6_LOCAL_V2_FRAME_REVIEW_PROMPT
        : A8B6_LOCAL_FRAME_REVIEW_PROMPT
    const signed = localV9
      ? await verifyA8B6LocalCompositeSourceReceiptV9(root)
      : localV8
      ? await verifyA8B6LocalCompositeSourceReceiptV8(root)
      : localV7 ? await verifyA8B6LocalCompositeSourceReceiptV7(root)
      : localV6 ? await verifyA8B6LocalCompositeSourceReceiptV6(root)
      : localV5 ? await verifyA8B6LocalCompositeSourceReceiptV5(root)
      : localV4 ? await verifyA8B6LocalCompositeSourceReceiptV4(root)
      : localV3 ? await verifyA8B6LocalCompositeSourceReceiptV3(root)
      : localV2 ? await verifyA8B6LocalCompositeSourceReceiptV2(root)
        : await verifyA8B6LocalCompositeSourceReceipt(root)
    const signedOutput = object(signed.receipt.output)
    const timing = await loadExecution(String(local.sourceExecutionId))
    const runs = Array.isArray(execution.nodeRuns)
      ? execution.nodeRuns.map(object) : []
    const parentRuns = Array.isArray(timing.nodeRuns)
      ? timing.nodeRuns.map(object) : []
    const image = object(runs[45]?.output)
    const bound = object(image.sourceBoundLocalComposite)
    const reviewNode = object(runs[49]?.node)
    const reviewParams = Array.isArray(reviewNode.params)
      ? reviewNode.params.map(object) : []
    const localParam = reviewParams.filter(param =>
      param.name === 'sceneCutLocalComposite')
    const detailParam = reviewParams.filter(param =>
      param.name === 'reviewImageDetail')
    const imageLedgers = (await pool.query(`SELECT id FROM model_execution_records
      WHERE workflow_id='wf-sanguo-history-drama'
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $1`,
    [`${executionId}:%`])).rows
    if (reviewSourceExecutionId !== executionId
      || execution.parentExecutionId !== timing.id
      || timing.id !== 'record-4x5m31-a8b6-timing-approval-v3'
      || ![A8B6_LOCAL_FRAME_VERSION, A8B6_LOCAL_V2_FRAME_VERSION,
        A8B6_LOCAL_V3_FRAME_VERSION, A8B6_LOCAL_V4_FRAME_VERSION,
        A8B6_LOCAL_V5_FRAME_VERSION, A8B6_LOCAL_V6_FRAME_VERSION,
        A8B6_LOCAL_V7_FRAME_VERSION, A8B6_LOCAL_V8_FRAME_VERSION,
        A8B6_LOCAL_V9_FRAME_VERSION]
        .includes(String(local.version))
      || local.sourceResultMd5 !== timing.resultMd5
      || local.sourceReceiptSha256 !== signed.receiptSha256
      || local.outputUrl !== signedOutput.url
      || local.outputSha256 !== signedOutput.sha256
      || local.firstPendingIndex !== 46
      || local.preservedPrefixLength !== 45
      || local.preservedPrefixSha256
        !== sha256(Buffer.from(canonical(parentRuns.slice(0, 45))))
      || !isDeepStrictEqual(runs.slice(0, 45), parentRuns.slice(0, 45))
      || runs[45]?.status !== 'success'
      || image.url !== signedOutput.url
      || bound.version !== localVersion
      || bound.sourceReceiptSha256 !== signed.receiptSha256
      || bound.outputSha256 !== signedOutput.sha256
      || bound.approvedFirstFrame !== false
      || (localV2 && (local.imageGenRawSha256
        !== object(signed.receipt.sources[1]).sha256
        || local.imageGenPromptSha256
          !== object(signed.receipt.imageGen).promptSha256
        || bound.imageGenRawSha256 !== local.imageGenRawSha256))
      || (localV3 && (local.priorLocalV2ExecutionId
        !== object(signed.receipt.priorLocalV2).executionId
        || local.priorLocalV2ResultMd5
          !== object(signed.receipt.priorLocalV2).resultMd5
        || local.priorLocalV2RejectedReviewSha256
          !== object(signed.receipt.priorLocalV2).rejectedReviewSha256
        || local.priorLocalV2ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV2).reviewModelExecutionId
        || local.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256
        || local.faceImageGenRawSha256
          !== object(signed.receipt.sources[2]).sha256
        || local.gateFrameImageGenRawSha256
          !== object(signed.receipt.sources[3]).sha256
        || bound.wallImageGenRawSha256 !== local.wallImageGenRawSha256
        || bound.faceImageGenRawSha256 !== local.faceImageGenRawSha256
        || bound.gateFrameImageGenRawSha256
          !== local.gateFrameImageGenRawSha256))
      || (localV4 && (local.priorLocalV3ExecutionId
        !== object(signed.receipt.priorLocalV3).executionId
        || local.priorLocalV3ResultMd5
          !== object(signed.receipt.priorLocalV3).resultMd5
        || local.priorLocalV3RejectedReviewSha256
          !== object(signed.receipt.priorLocalV3).rejectedReviewSha256
        || local.priorLocalV3ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV3).reviewModelExecutionId
        || local.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256
        || bound.wallImageGenRawSha256 !== local.wallImageGenRawSha256))
      || (localV5 && (local.priorLocalV4ExecutionId
        !== object(signed.receipt.priorLocalV4).executionId
        || local.priorLocalV4FailedResultMd5
          !== object(signed.receipt.priorLocalV4).failedResultMd5
        || local.priorLocalV4RejectedReviewSha256
          !== object(signed.receipt.priorLocalV4).rejectedReviewSha256
        || local.priorLocalV4ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV4).reviewModelExecutionId
        || local.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256
        || bound.wallImageGenRawSha256 !== local.wallImageGenRawSha256))
      || (localV6 && (local.priorLocalV5ExecutionId
        !== object(signed.receipt.priorLocalV5).executionId
        || local.priorLocalV5ResultMd5
          !== object(signed.receipt.priorLocalV5).resultMd5
        || local.priorLocalV5RejectedReviewSha256
          !== object(signed.receipt.priorLocalV5).rejectedReviewSha256
        || local.priorLocalV5ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV5).reviewModelExecutionId
        || local.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256
        || bound.wallImageGenRawSha256 !== local.wallImageGenRawSha256))
      || (localV7 && (local.priorLocalV6ExecutionId
        !== object(signed.receipt.priorLocalV6).executionId
        || local.priorLocalV6ResultMd5
          !== object(signed.receipt.priorLocalV6).resultMd5
        || local.priorLocalV6RejectedReviewSha256
          !== object(signed.receipt.priorLocalV6).rejectedReviewSha256
        || local.priorLocalV6ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV6).reviewModelExecutionId
        || local.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256
        || bound.wallImageGenRawSha256 !== local.wallImageGenRawSha256))
      || (localV8 && (local.priorLocalV7ExecutionId
        !== object(signed.receipt.priorLocalV7).executionId
        || local.priorLocalV7ResultMd5
          !== object(signed.receipt.priorLocalV7).resultMd5
        || local.priorLocalV7RejectedReviewSha256
          !== object(signed.receipt.priorLocalV7).rejectedReviewSha256
        || local.priorLocalV7ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV7).reviewModelExecutionId
        || local.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256
        || bound.wallImageGenRawSha256 !== local.wallImageGenRawSha256))
      || (localV9 && (local.priorLocalV8ExecutionId
        !== object(signed.receipt.priorLocalV8).executionId
        || local.priorLocalV8ResultMd5
          !== object(signed.receipt.priorLocalV8).resultMd5
        || local.priorLocalV8RejectedReviewSha256
          !== object(signed.receipt.priorLocalV8).rejectedReviewSha256
        || local.priorLocalV8ReviewModelExecutionId
          !== object(signed.receipt.priorLocalV8).reviewModelExecutionId
        || local.wallImageGenRawSha256
          !== object(signed.receipt.sources[1]).sha256
        || bound.wallImageGenRawSha256 !== local.wallImageGenRawSha256))
      || reviewNode.prompt !== localPrompt
      || localParam.length !== 1
      || localParam[0].value !== canonical(local)
      || (localV8 || localV9 ? detailParam.length !== 1
        || detailParam[0].value
          !== canonical(localDetailConfig(local.version))
        : detailParam.length !== 0)
      || !isDeepStrictEqual(runs[48]?.output, input.evidence)
      || !isDeepStrictEqual(runs[49]?.output, input.review)
      || !isDeepStrictEqual(runs[11]?.output, input.shot)
      || !isDeepStrictEqual(runs[41]?.output, input.sources)
      || object(object(input.review).frame).sourceUrl !== image.url
      || imageLedgers.length !== 0
      || execution.sceneCutA8B6FreshFrameRecovery !== undefined
      || execution.sceneCutImageRepairRecovery !== undefined
      || execution.sceneCutApprovalRebindRecovery !== undefined)
      fail('本地首帧复审未绑定来源、14秒脚本、实图、独立结论或零图像付款')
    return undefined
  }
  const fresh = object(execution.sceneCutA8B6FreshFrameRecovery)
  if (execution.sceneCutA8B6FreshFrameRecovery !== undefined) {
    const prior = await loadExecution(String(fresh.sourceExecutionId))
    const rejectedFresh = await loadExecution(String(fresh.priorFreshExecutionId))
    const editV5 = fresh.version === A8B6_FRESH_V5_EDIT_FRAME_VERSION
      ? await verifyA8B6FreshV5EditReceipt(root) : undefined
    const editV6 = fresh.version === A8B6_FRESH_V6_EDIT_FRAME_VERSION
      ? await verifyA8B6FreshV6EditReceipt(root) : undefined
    const editV7 = fresh.version === A8B6_FRESH_V7_EDIT_FRAME_VERSION
      ? await verifyA8B6FreshV7EditReceipt(root) : undefined
    const editV8 = fresh.version === A8B6_FRESH_V8_EDIT_FRAME_VERSION
      ? await verifyA8B6FreshV8EditReceipt(root) : undefined
    const dualRecovery = object(execution).sceneCutA8B6V7DualOutputRecovery
    const dualMarker = object(dualRecovery)
    if (dualRecovery !== undefined
      && dualMarker.version !== A8B6_V7_DUAL_OUTPUT_VERSION)
      fail('双输出恢复记录版本无效')
    const dual = dualRecovery !== undefined
      ? await verifyA8B6V7DualOutputRecoveryReceiptAsync(root) : undefined
    const edit = editV8 ?? editV7 ?? editV6 ?? editV5 ?? (fresh.version === A8B6_FRESH_EDIT_FRAME_VERSION
      ? await verifyA8B6FreshEditReceipt(root) : undefined)
    if (editV8) assertA8B6FreshV8EditHop(prior, execution, prior.resultMd5,
      editV8, rejectedFresh, 'approval-running')
    else if (dual && editV7) {
      const failedImage = await loadExecution(String(dualMarker.parentExecutionId))
      assertA8B6FreshV7EditHop(prior, failedImage, prior.resultMd5,
        editV7, rejectedFresh, 'dual-output-failed')
      assertA8B6V7DualOutputRecoveryHop(failedImage, execution,
        failedImage.resultMd5 as string, dual, 'approval-running')
    } else if (editV7) assertA8B6FreshV7EditHop(prior, execution, prior.resultMd5,
      editV7, rejectedFresh, 'approval-running')
    else if (editV6) assertA8B6FreshV6EditHop(prior, execution, prior.resultMd5,
      editV6, rejectedFresh, 'approval-running')
    else if (editV5) {
      const rejectedImage = await loadExecution(String(fresh.priorFreshImageExecutionId))
      if (execution.id === A8B6_FRESH_V5_RUNTIME_RETRY_ID) {
        const failedParent = await loadExecution(A8B6_FRESH_V5_EDIT_FRAME_ID)
        assertA8B6FreshV5EditHop(prior, failedParent, prior.resultMd5,
          editV5, rejectedImage, rejectedFresh, 'pre-provider-failed')
        assertA8B6FreshV5RuntimeRetryHop(failedParent, execution,
          failedParent.resultMd5, 'approval-running')
      } else assertA8B6FreshV5EditHop(prior, execution, prior.resultMd5,
        editV5, rejectedImage, rejectedFresh, 'approval-running')
    } else if (edit) assertA8B6FreshEditHop(prior, execution, prior.resultMd5,
      edit, rejectedFresh, 'approval-running')
    else {
      const signed = await verifyA8B6FrameConflictReceipt(String(fresh.qaPlanId), root)
      assertA8B6FreshFrameHop(prior, execution, prior.resultMd5, signed,
        rejectedFresh, 'approval-running')
    }
    const runs = Array.isArray(execution.nodeRuns) ? execution.nodeRuns.map(object) : []
    const image = object(runs[45]?.output)
    if (reviewSourceExecutionId !== executionId
      || !isDeepStrictEqual(runs[48]?.output, input.evidence)
      || !isDeepStrictEqual(runs[49]?.output, input.review)
      || !isDeepStrictEqual(runs[11]?.output, input.shot)
      || !isDeepStrictEqual(runs[41]?.output, input.sources)
      || object(object(input.review).frame).sourceUrl !== image.url)
      fail('新首帧实审不是当前付费图和已批准14秒脚本')
    const imageSha = verifyA8B6FreshImageBytes(image.url, root)
    if (edit && imageSha === edit.receipt.sourceImageSha256)
      fail('编辑图像等于审核拒绝的来源图')
    if (edit && !dual) {
      const paid = await pool.query(`SELECT id,status,provider,capability,
        workflow_id,node_id,request_data,response_data
        FROM model_execution_records
        WHERE workflow_id='wf-sanguo-history-drama'
          AND node_id='sanguo-scene-cut-first-frame'
          AND status='succeeded'
          AND request_data->>'requestKey' LIKE $1`,
      [`${executionId}:%`])
      const ledger = object(paid.rows[0])
      const loggedRequest = object(ledger.request_data)
      const loggedResponse = object(ledger.response_data)
      const loggedRaw = object(loggedResponse.raw)
      const loggedData = Array.isArray(loggedResponse.data)
        ? loggedResponse.data.map(object) : []
      const ledgerParams = object(loggedRequest.params)
      const refs = edit.referenceImages
      const expectedRefs = refs.map((value: string, index: number) => ({
        index: index + 1,
        bytes: Buffer.from(value.slice('data:image/jpeg;base64,'.length), 'base64').length,
        sha256: sha256(Buffer.from(value.slice('data:image/jpeg;base64,'.length), 'base64')) }))
      if (paid.rows.length !== 1 || ledger.provider !== 'Codex'
        || ledger.capability !== 'image'
        || loggedRequest.sceneCutFreshEditReceiptSha256
          !== edit.receiptSha256
        || !isDeepStrictEqual(ledgerParams.sceneCutFreshEditReceipt,
          edit.receipt)
        || !isDeepStrictEqual(ledgerParams.referenceImages,
          refs.map((value: string) => `[素材内容已隐藏，${value.length} 字符]`))
        || !isDeepStrictEqual(loggedRaw.references,
          expectedRefs)
        || object(loggedRaw.image).sha256 !== imageSha
        || loggedData[0]?.url !== image.url)
        fail('编辑图没有唯一三参考付费账本及真实新图字节')
    }
    return undefined
  }
  const reuse = object(execution.sceneCutA8B6ImageReuseRecovery)
  if (execution.sceneCutA8B6ImageReuseRecovery !== undefined) {
    // A paid image from the approved 13s shot can be considered for the 14s
    // script only as an unchanged asset with a fresh image evidence and model
    // review. Keep the original request and its signed 13s certificate intact.
    const source = await loadExecution(String(reuse.sourceExecutionId))
    const parent = await loadExecution(String(reuse.parentExecutionId))
    const originalRuns = Array.isArray(source.nodeRuns) ? source.nodeRuns.map(object) : []
    const parentRuns = Array.isArray(parent.nodeRuns) ? parent.nodeRuns.map(object) : []
    const runs = Array.isArray(execution.nodeRuns) ? execution.nodeRuns.map(object) : []
    const oldImage = object(originalRuns[45]?.output)
    const oldCertificate = verifySceneCutFrameApproval(originalRuns[50]?.output, root)
    const image = runs[45], evidence = runs[48], review = runs[49]
    const output = object(image?.output)
    const { sourceBoundImageReuse: _reuseTag, ...paidOutput } = output
    void _reuseTag
    const originalImageUrl = oldImage.url
    const sourceBytes = localImageBytes(originalImageUrl, root)
    const currentShot = object(parentRuns[11]?.output)
    const currentSourceArchive = object(parentRuns[41]?.output)
    const currentOpeningPlan = object(parentRuns[43]?.output)
    if (reuse.version !== 'scene-cut-a8b6-image-reuse-v1'
      || source.id !== 'record-4x5m31-original-repair-tail-guide-v2'
      || source.resultMd5 !== '34abee4a7c010616b837dbc175b69c56'
      || !['record-4x5m31-a8b6-timing-approval-v1',
        'record-4x5m31-a8b6-timing-approval-v3'].includes(String(parent.id))
      || parent.resultMd5 !== reuse.parentResultMd5
      || parent.parentExecutionId !== source.id
      || execution.parentExecutionId !== parent.id
      || reuse.sourceResultMd5 !== source.resultMd5
      || reuse.qaPlanId !== object(parent.sceneCutA8B6TimingRecovery).qaPlanId
      || reuse.workflowSchemaVersion !== 180
      || reuse.amendedShotSha256 !== sceneCutShotSha256(currentShot)
      || reuse.amendedScheduleHash !== currentShot.scheduleHash
      || currentShot.duration !== 14
      || parentRuns[10]?.status !== 'success'
      || object(parentRuns[10]?.output).decision !== 'pass'
      || parentRuns[11]?.status !== 'success'
      || object(parentRuns[11]?.output).passed !== true
      || parentRuns[43]?.status !== 'success'
      || parentRuns[45]?.status !== 'failed'
      || !String(parentRuns[45]?.error ?? '').includes('SCENE_CUT_EDIT_BINDER_INVALID')
      || !isDeepStrictEqual(runs.slice(0, 45), parentRuns.slice(0, 45))
      || image?.status !== 'success' || evidence?.status !== 'success'
      || review?.status !== 'success'
      || reviewSourceExecutionId !== executionId
      || execution.sceneCutImageRepairRecovery !== undefined
      || execution.sceneCutApprovalRebindRecovery !== undefined
      || output.url !== originalImageUrl
      || !isDeepStrictEqual(paidOutput, oldImage)
      || !isDeepStrictEqual(object(output.sourceBoundImageReuse),
        { ...reuse, reviewShotSha256: reuse.amendedShotSha256 })
      || reuse.originalImageExecutionId !== object(oldCertificate.repairBinding).imageExecutionId
      || reuse.originalFrameCertificateSha256 !== sceneCutRebindSha256(oldCertificate)
      || reuse.originalImageUrl !== originalImageUrl
      || reuse.originalImageSha256 !== sha256(sourceBytes)
      || oldCertificate.passed !== true
      || oldCertificate.frame.sourceUrl !== originalImageUrl
      || oldCertificate.sourceSha256s?.[0] !== reuse.originalImageSha256
      || oldCertificate.shotSha256 === reuse.amendedShotSha256
      || object(oldImage.raw).modelExecutionId !== reuse.originalImageExecutionId
      || !isDeepStrictEqual(object(image?.inputContext).shot_script, currentShot)
      || !isDeepStrictEqual(object(image?.inputContext).scene_cut_sources, currentSourceArchive)
      || !isDeepStrictEqual(object(image?.inputContext).scene_cut_opening_state, currentOpeningPlan)
      || !isDeepStrictEqual(evidence.output, input.evidence)
      || !isDeepStrictEqual(review.output, input.review)
      || object(object(input.review).frame).sourceUrl !== originalImageUrl)
      fail('14秒复用首帧与旧付费图、新脚本、独立审核或父记录不一致')
    const oldLedger = object((await pool.query(`select id,status,model_id,request_data
      from model_execution_records where id=$1`, [reuse.originalImageExecutionId])).rows[0])
    if (oldLedger.status !== 'succeeded'
      || oldLedger.id !== reuse.originalImageExecutionId
      || oldLedger.model_id !== oldImage.model
      || object(oldLedger.request_data).fingerprint
        !== object(oldCertificate.repairBinding).repairRequestFingerprint)
      fail('14秒复用首帧缺少原始成功付费模型账本')
    return undefined
  }
  if (!execution.sceneCutImageRepairRecovery) return undefined
  const recovery = object(execution.sceneCutImageRepairRecovery)
  const bindingVersion = recovery.version === 'scene-cut-image-repair-schema178-fork-v2'
    ? 'scene-cut-image-repair-binding-v2'
    : recovery.version === 'scene-cut-image-repair-schema177-fork-v1'
      ? 'scene-cut-image-repair-binding-v1' : fail('当前执行记录的修复分支版本无效')
  const runs = Array.isArray(execution.nodeRuns) ? execution.nodeRuns.map(object) : []
  const image = runs[45], evidence = runs[48], review = runs[49], approval = runs[50]
  const imageOutput = object(image.output), imageRaw = object(imageOutput.raw)
  const candidateUrl = imageOutput.url
  if (image.status !== 'success' || evidence.status !== 'success'
    || review.status !== 'success' || approval.status !== 'running'
    || image.node && object(image.node).id !== 'sanguo-scene-cut-first-frame'
    || evidence.node && object(evidence.node).id !== 'sanguo-scene-cut-evidence'
    || review.node && object(review.node).id !== 'sanguo-scene-cut-review'
    || canonical(evidence.output) !== canonical(input.evidence)
    || canonical(review.output) !== canonical(input.review)
    || canonical(object(imageOutput.params).sceneCutShot) !== canonical(input.shot)
    || canonical(object(imageOutput.params).sceneCutSources) !== canonical(input.sources)
    || object(object(input.review).frame).sourceUrl !== candidateUrl
    || !Array.isArray(object(input.evidence).items)
    || object((object(input.evidence).items as unknown[])[0]).url !== candidateUrl)
    fail('修复图审核请求与当前完成图、采证和审核节点不一致')
  const imageExecutionId = imageRaw.modelExecutionId
  const repairRequestFingerprint = imageRaw.repairRequestFingerprint
  if (typeof imageExecutionId !== 'string' || !/^model-run-[\w-]+$/.test(imageExecutionId)
    || typeof repairRequestFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(repairRequestFingerprint))
    fail('新首帧缺少服务端回显的模型账本身份')
  const checkedImageExecutionId = imageExecutionId as string
  const checkedFingerprint = repairRequestFingerprint as string
  const imageLedger = object((await pool.query(`select id,model_id,request_data
    from model_execution_records where id=$1`, [checkedImageExecutionId])).rows[0])
  const receipt = object(object(imageLedger.request_data).params).sceneCutRepairReceipt
  if (!receipt) fail('新首帧模型账本缺少修复参考收据')
  // The original image was fully verified and signed under schema178. A
  // versioned video-retry reapproval may run after a managed media-accept code
  // migration; it must inherit that exact signed image ledger, while the new
  // certificate is issued to the current record. All non-rebind paths still
  // execute the complete original-image verifier.
  const verified = await (usesSignedImageRepairInheritance(rebindMarker)
    ? await (async () => {
      const source = await loadExecution(String(rebindMarker.sourceExecutionId))
      const signed = verifySceneCutFrameApproval(object((Array.isArray(source.nodeRuns)
        ? source.nodeRuns : [])[50]).output, root)
      const prior = object(signed.repairBinding)
      const requestData = object(imageLedger.request_data)
      const referenceOrder = object(receipt).referenceOrder
      const referenceSha256s = Array.isArray(referenceOrder)
        ? referenceOrder.map(item => object(item).sha256 ?? object(item).jpegSha256) : []
      if (source.resultMd5 !== rebindMarker.sourceResultMd5
        || signed.passed !== true
        || canonical(prior.receipt) !== canonical(receipt)
        || prior.imageExecutionId !== checkedImageExecutionId
        || prior.repairRequestFingerprint !== checkedFingerprint
        || prior.repairReceiptSha256 !== sha256(Buffer.from(canonical(receipt)))
        || requestData.fingerprint !== checkedFingerprint
        || prior.candidateImageSha256 !== rebindMarker.approvedImageSha256
        || prior.candidateImageSha256 !== (Array.isArray(signed.sourceSha256s)
          ? signed.sourceSha256s[0] : undefined)
        || imageLedger.model_id !== object(object((Array.isArray(source.nodeRuns)
          ? source.nodeRuns : [])[45]).output).model
        || referenceSha256s.length !== 4
        || referenceSha256s.some(item => typeof item !== 'string'
          || !/^[a-f0-9]{64}$/.test(item))) {
        fail('重签首帧与原已签模型账本或四张参考图不一致')
      }
      return { modelExecutionId: checkedImageExecutionId,
        requestFingerprint: checkedFingerprint,
        repairReceiptSha256: String(prior.repairReceiptSha256),
        candidateSha256: String(prior.candidateImageSha256),
        referenceSha256s: referenceSha256s as string[] }
    })()
    : verifySceneCutRepairReceiptForCompletedFork(
      pool as Parameters<typeof verifySceneCutRepairReceiptForCompletedFork>[0],
      { executionId: reviewSourceExecutionId, receipt, candidateUrl: String(candidateUrl),
        imageExecutionId: checkedImageExecutionId,
        repairRequestFingerprint: checkedFingerprint }, root))
  if (verified.modelExecutionId !== checkedImageExecutionId
    || verified.requestFingerprint !== checkedFingerprint
    || verified.referenceSha256s.length !== (bindingVersion.endsWith('-v2') ? 4 : 3))
    fail('新首帧模型账本与修复收据不一致')
  return { version: bindingVersion, executionId: executionId as string,
    ...(executionId !== reviewSourceExecutionId
      ? { reviewSourceExecutionId } : {}),
    imageExecutionId: checkedImageExecutionId, repairRequestFingerprint: checkedFingerprint,
    repairReceiptSha256: verified.repairReceiptSha256,
    candidateImageSha256: verified.candidateSha256,
    receipt: object(receipt) }
}

/** A retry may inherit the paid image and independent review through several
 * failed approval attempts. Every hop must preserve the complete accepted
 * media prefix and only advance the approval revision. */
export function assertSceneCutApprovalRetryHop(parentInput: unknown, childInput: unknown,
  activeChild: boolean) {
  const parent = object(parentInput), child = object(childInput)
  const parentRuns = Array.isArray(parent.nodeRuns) ? parent.nodeRuns.map(object) : []
  const childRuns = Array.isArray(child.nodeRuns) ? child.nodeRuns.map(object) : []
  const approvalIndex = parentRuns.findIndex(run => object(run.node).id === 'sanguo-scene-cut-approval'
    && run.loopIndex === 0)
  const prior = object(parentRuns[approvalIndex]), next = object(childRuns[approvalIndex])
  if (typeof parent.id !== 'string' || typeof child.id !== 'string'
    || child.parentExecutionId !== parent.id || child.id === parent.id
    || typeof parent.requestScopeId !== 'string' || !parent.requestScopeId
    || child.requestScopeId !== parent.requestScopeId
    || child.generationScopeId !== child.id
    || child.workflowId !== parent.workflowId
    || !isDeepStrictEqual(child.sceneCutImageRepairRecovery,
      parent.sceneCutImageRepairRecovery)
    || !isDeepStrictEqual(child.sceneCutApprovalRebindRecovery,
      parent.sceneCutApprovalRebindRecovery)
    || approvalIndex < 0 || object(object(childRuns[approvalIndex]).node).id !== 'sanguo-scene-cut-approval'
    || parentRuns.length <= approvalIndex || childRuns.length <= approvalIndex
    || !isDeepStrictEqual(parentRuns.slice(0, approvalIndex), childRuns.slice(0, approvalIndex))
    || !isDeepStrictEqual(prior.node, next.node)
    || prior.status !== 'failed' || next.status !== (activeChild ? 'running' : 'failed')
    || prior.id !== next.id
    || Number(next.revision) !== Number(prior.revision ?? 0) + 1)
    fail('继承视觉审核的重试分支与父记录、受管图或完成媒体不一致')
  return true
}

export async function issueRecordedSceneCutFrameApproval(pool: Queryable,
  input: { review: unknown; evidence: { reviewImages?: unknown }; shot: unknown; sources: unknown;
    openingStatePlan?: unknown; executionRecordId?: string },
root = process.cwd()) {
  if (!input.executionRecordId) validateSceneCutFrameReview(
    input.review, input.evidence, input.shot, input.sources)
  const schemaRows = await pool.query(`select schema_version from workflow_configs
    where id='wf-sanguo-history-drama'`, [])
  const activeSchemaVersion = Number(object(schemaRows.rows[0]).schema_version ?? 0)
  if (!Number.isFinite(activeSchemaVersion) || activeSchemaVersion < 165) fail('当前工作流版本不可核对')
  const stateRow = input.executionRecordId ? (await pool.query(
    `select result from execution_records where id=$1`, [input.executionRecordId])).rows[0] : undefined
  const state = stateRow ? decodeExecutionState<Value>(
    object(stateRow).result as Parameters<typeof decodeExecutionState>[0]) : {}
  const activeApproval = Array.isArray(state.nodeRuns) ? state.nodeRuns.map(object)
    .find(run => object(run.node).id === 'sanguo-scene-cut-approval'
      && run.status === 'running') : undefined
  const allowReviewRisks = activeSchemaVersion >= 188
    && object(object(state.runtimeInputs).input).qualityDisposition === 'manual-review-v1'
    && Number(object(state.sceneCutAutoRetry).count) >= 5
    && object(state.sceneCutAutoRetry).loopIndex === activeApproval?.loopIndex
    && object(input.review).passed === false
    && !object(input.sources).approvedEllipsis
  // Even in risk mode, the independent raw review, evidence and paid-image
  // ledgers are verified below. Only visual acceptance becomes advisory.
  validateSceneCutFrameReview(input.review, input.evidence, input.shot, input.sources,
    { allowReviewRisks })
  if (!allowReviewRisks && ['scene-cut-identity-plate-v2', 'scene-cut-identity-plate-v3',
    'scene-cut-identity-plate-v4']
    .includes(String(object(input.sources).identityPlateVersion)))
    validateSceneCutT0ImageContract(input.review, input.shot,
      { visualDetailsAdvisory: activeSchemaVersion >= 186,
        uncertainManipulationAdvisory: activeSchemaVersion >= 187 })
  if (activeSchemaVersion >= 172
    && object(input.sources).identityPlateVersion !== 'scene-cut-identity-plate-v4')
    fail('首帧审核不是当前连续衣摆身份参考板')
  if (activeSchemaVersion >= 171) verifySceneCutEllipsisProof(input.sources, input.shot, root)
  if (activeSchemaVersion >= 171)
    await assertSceneCutAcceptedSourceLedger(pool, input.shot, input.sources)
  if (activeSchemaVersion >= 168) {
    if (canonical(input.openingStatePlan) !== canonical(deriveSceneCutOpeningPlan(input.shot,
      activeSchemaVersion >= 195 ? 4 : activeSchemaVersion >= 170 ? 3 : activeSchemaVersion >= 169 ? 2 : 1)))
      fail('首帧审核未绑定当前分镜的零秒起点计划')
    if (!allowReviewRisks) validateSceneCutStanceStartReview(input.review, input.shot)
    if (!allowReviewRisks && activeSchemaVersion >= 169) validateSceneCutTravelStartReview(input.review, input.shot,
      activeSchemaVersion >= 170 ? 3 : 2,
      activeSchemaVersion >= 172 ? sceneCutActionPerformerFeetRequired(input.shot) : undefined)
    if (!allowReviewRisks && activeSchemaVersion >= 170)
      validateSceneCutOpeningProjectionReview(input.review, input.shot, activeSchemaVersion)
    if (!allowReviewRisks && activeSchemaVersion >= 174) validateSceneCutActionStartReview(input.review, input.shot,
      { visualDetailsAdvisory: activeSchemaVersion >= 186,
        uncertainManipulationAdvisory: activeSchemaVersion >= 187 })
    else if (!allowReviewRisks && activeSchemaVersion >= 172) validateSceneCutActionVisibilityReview(input.review, input.shot)
  }
  const expected = { evidence: input.evidence, shot: input.shot,
    sources: input.sources, reviewImages: input.evidence.reviewImages,
    ...(activeSchemaVersion >= 168 ? { openingStatePlan: input.openingStatePlan } : {}) }
  if ([A8B6_FRESH_FRAME_ID, A8B6_FRESH_EDIT_FRAME_ID,
    A8B6_FRESH_V5_EDIT_FRAME_ID, A8B6_FRESH_V5_RUNTIME_RETRY_ID,
    A8B6_FRESH_V6_EDIT_FRAME_ID, A8B6_FRESH_V7_EDIT_FRAME_ID,
    A8B6_FRESH_V8_EDIT_FRAME_ID,
    A8B6_V7_DUAL_OUTPUT_CHILD_ID]
    .includes(String(input.executionRecordId))) {
    const record = object((await pool.query(`SELECT result FROM execution_records WHERE id=$1`,
      [input.executionRecordId])).rows[0])
    const state = decodeExecutionState<{ sceneCutA8B6FreshFrameRecovery?: unknown }>(
      record.result as Value)
    const marker = object(state.sceneCutA8B6FreshFrameRecovery)
    if (![A8B6_FRESH_FRAME_VERSION, A8B6_FRESH_EDIT_FRAME_VERSION,
      A8B6_FRESH_V5_EDIT_FRAME_VERSION, A8B6_FRESH_V6_EDIT_FRAME_VERSION,
      A8B6_FRESH_V7_EDIT_FRAME_VERSION,
      A8B6_FRESH_V8_EDIT_FRAME_VERSION]
      .includes(String(marker.version)))
      fail('新首帧复审记录缺少来源绑定标记')
    Object.assign(expected, { sceneCutFreshImage: marker })
  } else if ([A8B6_LOCAL_FRAME_ID, A8B6_LOCAL_V2_FRAME_ID,
    A8B6_LOCAL_V3_FRAME_ID, A8B6_LOCAL_V4_FRAME_ID,
    A8B6_LOCAL_V5_FRAME_ID, A8B6_LOCAL_V6_FRAME_ID,
    A8B6_LOCAL_V7_FRAME_ID, A8B6_LOCAL_V8_FRAME_ID,
    A8B6_LOCAL_V9_FRAME_ID]
    .includes(String(input.executionRecordId))) {
    const record = object((await pool.query(`SELECT result FROM execution_records WHERE id=$1`,
      [input.executionRecordId])).rows[0])
    const state = decodeExecutionState<{ sceneCutA8B6LocalFrameRecovery?: unknown }>(
      record.result as Value)
    const marker = object(state.sceneCutA8B6LocalFrameRecovery)
    if (marker.version !== (input.executionRecordId === A8B6_LOCAL_V9_FRAME_ID
      ? A8B6_LOCAL_V9_FRAME_VERSION
      : input.executionRecordId === A8B6_LOCAL_V8_FRAME_ID
      ? A8B6_LOCAL_V8_FRAME_VERSION
      : input.executionRecordId === A8B6_LOCAL_V7_FRAME_ID
        ? A8B6_LOCAL_V7_FRAME_VERSION
      : input.executionRecordId === A8B6_LOCAL_V6_FRAME_ID
        ? A8B6_LOCAL_V6_FRAME_VERSION
      : input.executionRecordId === A8B6_LOCAL_V5_FRAME_ID
        ? A8B6_LOCAL_V5_FRAME_VERSION
      : input.executionRecordId === A8B6_LOCAL_V4_FRAME_ID
        ? A8B6_LOCAL_V4_FRAME_VERSION
      : input.executionRecordId === A8B6_LOCAL_V3_FRAME_ID
        ? A8B6_LOCAL_V3_FRAME_VERSION
      : input.executionRecordId === A8B6_LOCAL_V2_FRAME_ID
        ? A8B6_LOCAL_V2_FRAME_VERSION : A8B6_LOCAL_FRAME_VERSION))
      fail('本地派生首帧复审记录缺少来源绑定标记')
    Object.assign(expected, { sceneCutLocalComposite: marker })
  }
  const records = await pool.query(`select id,channel,workflow_id,node_id,model_id,capability,provider,status,
      request_data,response_data from model_execution_records
    where workflow_id='wf-sanguo-history-drama' and node_id='sanguo-scene-cut-review'
      and capability='text' and status='succeeded'
      and request_data->'params'->'reviewImages'=$1::jsonb
    order by created_at desc limit 30`, [JSON.stringify(input.evidence.reviewImages)])
  let reviewExecutionId = ''
  let imageRepairBinding: SceneCutImageRepairBinding | undefined
  for (const row of records.rows) {
    try {
      const verifiedReviewId = LOCAL_DETAIL_VERSIONS.includes(
        String(object(object(expected).sceneCutLocalComposite).version))
        ? await assertSceneCutReviewLedgerRecordWithDetail(row, input.review,
          expected, root, activeSchemaVersion)
        : assertSceneCutReviewLedgerRecord(row, input.review, expected,
          root, activeSchemaVersion)
      const repair = activeSchemaVersion >= 177
        ? await completedRepairBindingForReview(pool, object(row), input, root) : undefined
      reviewExecutionId = verifiedReviewId
      imageRepairBinding = repair
      break
    }
    catch { /* A prior attempt may have seen a different image. */ }
  }
  if (!reviewExecutionId) fail('缺少与实图、受管提示及原始响应一致的视觉审核账本')
  return issueSceneCutFrameApproval({ ...input, reviewExecutionId,
    visualDetailsAdvisory: activeSchemaVersion >= 186,
    uncertainManipulationAdvisory: activeSchemaVersion >= 187,
    allowReviewRisks,
    ...(imageRepairBinding ? { imageRepairBinding } : {}) }, root)
}
