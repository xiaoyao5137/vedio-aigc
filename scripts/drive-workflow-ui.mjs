#!/usr/bin/env node
// Repeatable UI self-test driver for the historical drama workflow.
//
// It launches a dedicated Chrome instance over the DevTools protocol, opens the real
// production page and presses 下一步 exactly like a person doing single-step debugging,
// while reading execution_records from PostgreSQL to decide what happened. Using the
// shipped step engine (instead of a re-implemented script) is the point: a green run here
// is the same run the user can reproduce in the browser, and a red run carries the real
// node id plus the error the UI shows.
//
// Usage:
//   node scripts/drive-workflow-ui.mjs                          # step until the first loop video succeeds
//   node scripts/drive-workflow-ui.mjs --until sanguo-media-accept
//   node scripts/drive-workflow-ui.mjs --runtime-inputs '{"input":{"episode_number":41}}' --until sanguo-last-frame --until-loop 5
//   node scripts/drive-workflow-ui.mjs --resume record-ab12cd --until sanguo-media-accept --until-index 68
//   node scripts/drive-workflow-ui.mjs --watch record-11myu2    # only report an existing run
//   node scripts/drive-workflow-ui.mjs --resume record-ab12cd   # continue a failed run via 从此节点重试
//   node scripts/drive-workflow-ui.mjs --resume record-ab12cd --retry-index 48 --retry-node sanguo-media-metrics --until sanguo-last-frame --until-loop 1
//   node scripts/drive-workflow-ui.mjs --resume record-ab12cd --continue-idle sanguo-first-frame-branch --until sanguo-scene-cut-approval --until-loop 1
//   node scripts/drive-workflow-ui.mjs --resume latest --reload-page # explicitly load new sources before resuming
//   node scripts/drive-workflow-ui.mjs --restart-server        # bounce the app service first
// Exit code 5 means a saved accept gate requires a human decision; the driver never presses 下一步 for it.
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { planSceneCutAutoRetry } from '../src/scene-cut-auto-retry.ts'
import { createJsonHasher } from './restore-branch-checkpoint.mjs'
import { prepareSceneCutTailGuideRebind } from './fork-original-shot1-tail-guide-rebind.mjs'
import { prepareA8B6FrameConflictReviewFork } from './fork-original-shot1-a8b6-frame-conflict-review.mjs'
import { prepareA8B6FreshFirstFrameFork } from './fork-original-shot1-a8b6-fresh-first-frame.mjs'
import { prepareA8B6FreshEditFork } from './fork-original-shot1-a8b6-fresh-edit.mjs'
import { verifyA8B6FreshEditReceipt } from '../server/staged-scene-cut-a8b6-fresh-edit.mjs'
import { assertSceneCutReviewLedgerRecord,
  assertSceneCutReviewLedgerRecordWithDetail } from
  '../server/scene-cut-frame-runtime.ts'
import { verifyA8B6FrameConflictReceipt } from '../server/staged-scene-cut-a8b6-frame-conflict.mjs'
import { A8B6_FRESH_V2_IMAGE_LEDGER, A8B6_FRESH_V2_REVIEW_LEDGER,
  verifyA8B6FreshV2Rejection } from '../server/staged-scene-cut-a8b6-fresh-frame.mjs'
import { A8B6_FRESH_V2_FRAME_ID } from '../src/scene-cut-a8b6-fresh-frame-workflow.ts'
import { A8B6_FRESH_PREFLIGHT_SOURCE_IDS, readA8B6HistoricQaManifest,
  prepareA8B6FreshRegenerationPreflight } from '../server/staged-scene-cut-a8b6-fresh-preflight.mjs'
import { prepareScene2RegenerationPreflight } from
  '../server/staged-scene2-regeneration-preflight.mjs'
import { prepareFreshA8B6Scene2Replay } from
  '../server/staged-scene-cut-a8b6-fresh-scene2-replay.mjs'
import { verifyFreshA8B6CompositeReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-composite.mjs'
import { prepareFreshA8B6SourceBoundFork } from
  '../server/staged-scene-cut-a8b6-fresh-source-bound-fork.mjs'
import { prepareA8B6FreshV8EditFork } from
  './fork-original-shot1-a8b6-fresh-edit-v8.mjs'
import { assertA8B6LocalFrameHop, prepareA8B6LocalFrameFork } from
  './fork-original-shot1-a8b6-local-face.mjs'
import { assertA8B6LocalFrameHopV2,
  prepareA8B6LocalFrameForkV2 } from
  './fork-original-shot1-a8b6-local-face-v2.mjs'
import { verifyA8B6LocalCompositeSourceReceipt } from
  '../server/staged-scene-cut-a8b6-local-composite-admission.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV2 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v2.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV3 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v3.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV4 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v4.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV5 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v5.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV6 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v6.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV7 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v7.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV8 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v8.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV9 } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v9.mjs'
import { A8B6_V7_REJECTED_MD5, assertA8B6FreshV8EditHop,
  verifyA8B6FreshV8EditReceipt } from
  '../server/staged-scene-cut-a8b6-fresh-edit-v8.mjs'
import { A8B6_V7_DUAL_OUTPUT_CHILD_ID,
  A8B6_V7_FAILED_MD5, A8B6_V7_FAILED_IMAGE_LEDGER,
  assertA8B6V7DualOutputRecoveryHop,
  verifyA8B6V7DualOutputRecoveryReceiptAsync } from
  '../server/staged-scene-cut-a8b6-v7-dual-output.mjs'
import { DRIVE_RECORD_SQL, DRIVE_RECORD_TRIM_CHARS, assertSafeRestartServerTarget, completedProviderRegression, driveRecord, failureSignature, isRetryFork, isTargetedRetryFork, loopTargetOutcome, parseRuntimeInputs, pendingManualDecision, runtimeInputMismatch, sameExecutionScope, targetOutcome, verifiedIdleContinuation, verifiedRetryTarget, verifiedSchema177IdleRecord, verifiedSchema178IdleRecord, verifiedStoryScriptBreakpointFork, verifiedStoryScriptIdleContinuation } from './workflow-drive-state.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const inline = args.find(item => item.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}
const flag = name => args.includes(`--${name}`)

const appUrl = option('app', 'http://127.0.0.1:5173/')
const cdpPort = Number(option('port', '9333'))
const workflowMatch = option('workflow', '三国')
const workflowId = option('workflow-id', 'wf-sanguo-history-drama')
const untilNode = option('until', 'sanguo-video')
const untilIndexOption = option('until-index', '')
const untilIndex = untilIndexOption === '' ? undefined : Number(untilIndexOption)
if (untilIndex !== undefined && (!Number.isSafeInteger(untilIndex) || untilIndex < 0)) throw new Error('--until-index must be a nonnegative integer')
const untilLoopOption = option('until-loop', '')
const untilLoop = untilLoopOption === '' ? undefined : Number(untilLoopOption)
if (untilLoop !== undefined && (!Number.isSafeInteger(untilLoop) || untilLoop < 1)) throw new Error('--until-loop must be a positive integer')
if (untilLoop !== undefined && untilIndex !== undefined) throw new Error('--until-loop and --until-index cannot be combined')
const runtimeInputsOption = option('runtime-inputs', '')
const runtimeInputs = runtimeInputsOption ? parseRuntimeInputs(runtimeInputsOption) : undefined
const outcomeFor = record => untilLoop === undefined ? targetOutcome(record, untilNode, untilIndex) : loopTargetOutcome(record, untilNode, untilLoop)
const stepTimeoutMinutes = Number(option('step-timeout', '14'))
const watchRecord = option('watch', '')
// --resume <record-id>|latest continues an existing run through the UI's 从此节点重试, which re-runs
// only the failed node with revision+1 and keeps every earlier paid result.
const resumeFrom = option('resume', '')
const continueIdleNode = option('continue-idle', '')
const expectedWorkflowEdgesMd5 = option('expected-workflow-edges-md5', '')
const expectedSourceMd5 = option('expected-source-md5', '')
const expectedWorkflowNodesMd5 = option('expected-workflow-nodes-md5', '')
const storyScriptIdle = workflowId === 'wf-story' && continueIdleNode === 'node-script'
const maxSteps = Number(option('max-steps', storyScriptIdle ? '2'
  : untilLoop === undefined ? '40' : String(40 * (untilLoop + 1))))
const retryIndexOption = option('retry-index', '')
const retryIndex = retryIndexOption === '' ? undefined : Number(retryIndexOption)
const retryLoopOption = option('retry-loop', '')
const retryLoop = retryLoopOption === '' ? untilLoop : Number(retryLoopOption)
const rebuildPaidSuffix = flag('rebuild-paid-suffix')
const retryNodeId = option('retry-node', '')
if (retryIndex !== undefined && (!Number.isSafeInteger(retryIndex) || retryIndex < 0
  || !/^record-[\w-]+$/.test(resumeFrom) || !retryNodeId || untilLoop === undefined)) {
  throw new Error('--retry-index requires a nonnegative index, explicit --resume record-ID, --retry-node NODE-ID, and --until-loop ROUND')
}
if (retryIndex === undefined && retryNodeId) throw new Error('--retry-node requires --retry-index')
if (continueIdleNode && (!/^record-[\w-]+$/.test(resumeFrom) || !/^[\w-]+$/.test(continueIdleNode)
  || !/^[a-f0-9]{32}$/i.test(expectedWorkflowEdgesMd5) || retryIndex !== undefined || watchRecord)) {
  throw new Error('--continue-idle requires explicit --resume record-ID, a node ID and --expected-workflow-edges-md5, without --retry-index or --watch')
}
if (!continueIdleNode && expectedWorkflowEdgesMd5) throw new Error('--expected-workflow-edges-md5 requires --continue-idle')
if (storyScriptIdle && (!/^[a-f0-9]{32}$/i.test(expectedSourceMd5)
  || !/^[a-f0-9]{32}$/i.test(expectedWorkflowNodesMd5)
  || untilNode !== 'node-script-review' || untilLoop !== undefined || untilIndex !== undefined
  || maxSteps > 2)) {
  throw new Error('wf-story script continuation requires source/nodes MD5 locks, --until node-script-review and --max-steps <= 2')
}
if (!storyScriptIdle && (expectedSourceMd5 || expectedWorkflowNodesMd5))
  throw new Error('--expected-source-md5 and --expected-workflow-nodes-md5 require wf-story --continue-idle node-script')
if (runtimeInputs && (watchRecord || resumeFrom)) throw new Error('--runtime-inputs is for new executions; resume/watch preserve the stored inputs')
if (retryIndex !== undefined && watchRecord) throw new Error('--retry-index cannot be combined with --watch')
const resumeRetries = Number(option('resume-retries', storyScriptIdle ? '0' : '2'))
if (storyScriptIdle && resumeRetries !== 0)
  throw new Error('wf-story script continuation cannot automatically retry a failed text request')
// The launchd service keeps `hmr: false`, so a long-lived process may answer module requests from a
// transform cache and a browser reload would then self-test code that is no longer on disk. Forcing
// the service to restart is the only way to make "the run exercised my change" true.
const restartServer = flag('restart-server')
const serverLabel = option('service-label', 'com.video-aigc.app')
const serviceLabelExplicit = args.includes('--service-label')
  || args.some(arg => arg.startsWith('--service-label='))
assertSafeRestartServerTarget(appUrl, restartServer, serverLabel,
  serviceLabelExplicit)
const screenSession = option('screen-session', 'video-aigc-app')
const serviceDatabaseUrl = option('service-database', process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc')
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc'
const systemChromeBinary = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Never use the user's ordinary Chrome bundle for a headless, detached CDP session when
// Playwright's purpose-built shell is available. macOS treats another process from the same
// app bundle as a second running Chrome and may deliver ordinary http(s) open events (for
// example links clicked in KIM) to that invisible process. The headless shell has no browser
// URL-handler registration and no Dock app, so automation cannot intercept desktop links.
function installedHeadlessShell() {
  const cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  let releases
  try {
    releases = fsSync.readdirSync(cacheDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  return releases
    .filter(entry => entry.isDirectory() && /^chromium_headless_shell-\d+$/.test(entry.name))
    .sort((left, right) => Number(right.name.split('-').at(-1)) - Number(left.name.split('-').at(-1)))
    .map(entry => path.join(cacheDir, entry.name, `chrome-headless-shell-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, 'chrome-headless-shell'))
    .find(candidate => fsSync.existsSync(candidate))
}

const chromeBinary = option('chrome', flag('headed') ? systemChromeBinary : installedHeadlessShell())
if (!chromeBinary) {
  throw new Error('No Playwright headless shell is installed. Pass --chrome <path>, or use --headed for the system Chrome.')
}
const stateDir = path.resolve(option('state-dir', 'logs/cdp'))
const profileDir = path.join(stateDir, 'chrome-profile')
const logDir = path.join(stateDir, 'runs')
const stepTimeoutMs = stepTimeoutMinutes * 60_000
const pollMs = Number(option('poll', '4000'))

const logPath = path.join(logDir, `drive-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')}.log`)
const lines = []
const log = (message) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${message}`
  lines.push(line)
  console.log(line)
  return fs.appendFile(logPath, `${line}\n`).catch(() => undefined)
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const pool = new pg.Pool({ connectionString: databaseUrl })

// ---------------------------------------------------------------- execution records

async function loadRecord(id) {
  const { rows: [row] } = await pool.query(DRIVE_RECORD_SQL, [id, DRIVE_RECORD_TRIM_CHARS])
  if (!row) return undefined
  return { ...driveRecord(row), resultMd5: row.result_md5 }
}

async function verifyIdleCheckpoint(record) {
  if (continueIdleNode === 'sanguo-map-end-accept') {
    const [{ rows: [forkRow] }, { rows: [workflow] }] = await Promise.all([
      pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [record.id]),
      pool.query('SELECT schema_version,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
    ])
    const fork = forkRow && decodeExecutionState(forkRow.result), marker = fork?.sceneCutApprovedImageReuse
    if (marker?.version === 'scene-cut-approved-image-reuse-v1') {
      const [{ rows: [parentRow] }, { rows: [sourceRow] }] = await Promise.all([
        pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [marker.parentExecutionId]),
        pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [marker.sourceExecutionId]),
      ])
      const parent = parentRow && decodeExecutionState(parentRow.result)
      const source = sourceRow && decodeExecutionState(sourceRow.result)
      const hash = createJsonHasher(), target = fork.nodeRuns?.[46]
      if (workflowId !== 'wf-sanguo-history-drama' || workflow?.schema_version !== 183
        || workflow?.edges_md5 !== expectedWorkflowEdgesMd5 || forkRow.result_md5 !== record.resultMd5
        || !parent || !source || parentRow.result_md5 !== marker.parentResultMd5
        || sourceRow.result_md5 !== marker.sourceResultMd5
        || fork.parentExecutionId !== parent.id || fork.generationScopeId !== fork.id
        || fork.selectedNodeId !== continueIdleNode || marker.firstPendingIndex !== 46
        || marker.firstPendingNodeId !== continueIdleNode || target?.node.id !== continueIdleNode
        || target.status !== 'idle' || fork.nodeRuns[45]?.status !== 'success'
        || fork.nodeRuns[45].output?.url !== marker.originalImageUrl
        || hash(fork.nodeRuns.slice(0, 45)) !== hash(parent.nodeRuns.slice(0, 45))
        || fork.nodeRuns.slice(46).some(run => run.status !== 'idle'))
        throw Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: approved image reuse fork changed')
      return record.runs[46]
    }
  }
  if (continueIdleNode === 'sanguo-duration-replan') {
    const [{ rows: [forkRow] }, { rows: [workflow] }] = await Promise.all([
      pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [record.id]),
      pool.query('SELECT schema_version,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
    ])
    const fork = forkRow && decodeExecutionState(forkRow.result), marker = fork?.durationReplanBudgetRecovery
    if (marker?.version === 'duration-replan-budget-v1') {
      const { rows: [sourceRow] } = await pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [marker.sourceExecutionId])
      const source = sourceRow && decodeExecutionState(sourceRow.result), index = marker.firstPendingIndex
      const hash = createJsonHasher(), target = fork.nodeRuns?.[index]
      if (workflowId !== 'wf-sanguo-history-drama' || workflow?.schema_version !== 183
        || workflow?.edges_md5 !== expectedWorkflowEdgesMd5 || forkRow.result_md5 !== record.resultMd5
        || !source || sourceRow.result_md5 !== marker.sourceResultMd5
        || fork.parentExecutionId !== source.id || fork.generationScopeId !== fork.id
        || fork.selectedNodeId !== continueIdleNode || index !== 60
        || marker.firstPendingNodeId !== continueIdleNode || target?.node.id !== continueIdleNode
        || target.status !== 'idle' || target.node.params?.find(item => (item.englishName ?? item.name) === 'maxAttempts')?.value !== '2'
        || hash(fork.nodeRuns.slice(0, index)) !== hash(source.nodeRuns.slice(0, index))
        || fork.nodeRuns.slice(index).some(run => run.status !== 'idle'))
        throw Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: duration replan budget fork changed')
      return record.runs[index]
    }
  }
  if (continueIdleNode === 'sanguo-media-accept') {
    const [{ rows: [forkRow] }, { rows: [workflow] }] = await Promise.all([
      pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [record.id]),
      pool.query('SELECT schema_version,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
    ])
    const fork = forkRow && decodeExecutionState(forkRow.result)
    const marker = fork?.durationConfirmedConflictRecovery
    if (marker?.version === 'duration-confirmed-conflict-replay-v1') {
      const { rows: [sourceRow] } = await pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [marker.sourceExecutionId])
      const source = sourceRow && decodeExecutionState(sourceRow.result), index = marker.firstPendingIndex
      const hash = createJsonHasher(), target = fork.nodeRuns?.[index]
      if (workflowId !== 'wf-sanguo-history-drama' || workflow?.schema_version !== 182
        || workflow?.edges_md5 !== expectedWorkflowEdgesMd5
        || forkRow.result_md5 !== record.resultMd5 || !source
        || sourceRow.result_md5 !== marker.sourceResultMd5
        || fork.parentExecutionId !== source.id || fork.generationScopeId !== fork.id
        || fork.selectedNodeId !== continueIdleNode || index !== 59
        || marker.firstPendingNodeId !== continueIdleNode
        || target?.node.id !== continueIdleNode || target.status !== 'idle'
        || !target.node.code?.includes('passed:false,manualDecisionRequired:false,durationCompletion:replanned')
        || marker.sourceVideoUrl !== source.nodeRuns[54]?.output?.url
        || hash(fork.nodeRuns.slice(0, index)) !== hash(source.nodeRuns.slice(0, index))
        || fork.nodeRuns.slice(index).some(run => run.status !== 'idle'))
        throw Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: duration conflict fork changed')
      return record.runs[index]
    }
  }
  if (continueIdleNode === 'sanguo-scene-cut-first-frame') {
    const { rows: [forkRow] } = await pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [record.id])
    const fork = forkRow && decodeExecutionState(forkRow.result)
    const marker = fork?.sceneCutImageCountRecovery
    if (marker?.version === 'scene-cut-image-count-retry-v1') {
      const [{ rows: [sourceRow] }, { rows: [workflow] }, { rows: [failedLedger] }] = await Promise.all([
        pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [marker.sourceExecutionId]),
        pool.query('SELECT md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
        pool.query('SELECT id,error,response_data FROM model_execution_records WHERE id=$1', [marker.failedModelExecutionId]),
      ])
      const source = sourceRow && decodeExecutionState(sourceRow.result), index = marker.firstPendingIndex
      const hash = createJsonHasher(), target = fork.nodeRuns?.[index]
      if (workflowId !== 'wf-sanguo-history-drama'
        || workflow?.edges_md5 !== expectedWorkflowEdgesMd5
        || forkRow.result_md5 !== record.resultMd5 || !source
        || sourceRow.result_md5 !== marker.sourceResultMd5
        || failedLedger?.id !== marker.failedModelExecutionId
        || failedLedger.error !== 'CODEX_IMAGE_COUNT_INVALID: 本次线程必须恰好保存1张 PNG 图片'
        || failedLedger.response_data?.raw?.threadId !== marker.failedThreadId
        || failedLedger.response_data?.raw?.imageCount !== 2
        || fork.parentExecutionId !== source.id || fork.generationScopeId !== fork.id
        || fork.selectedNodeId !== continueIdleNode || index !== 45
        || marker.firstPendingNodeId !== continueIdleNode
        || target?.node.id !== continueIdleNode || target.status !== 'idle'
        || hash(fork.nodeRuns.slice(0, index)) !== hash(source.nodeRuns.slice(0, index))
        || fork.nodeRuns.slice(index).some(run => run.status !== 'idle'))
        throw Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: image count recovery changed')
      return record.runs[index]
    }
  }
  if (continueIdleNode === 'sanguo-scene-outline-review') {
    const [{ rows: [forkRow] }, { rows: [workflow] }] = await Promise.all([
      pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [record.id]),
      pool.query('SELECT md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
    ])
    const fork = forkRow && decodeExecutionState(forkRow.result)
    const marker = fork?.sceneCutOpeningStoryRecovery
    if (marker?.version === 'scene-cut-opening-story-recovery-v1') {
      const { rows: [sourceRow] } = await pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1',
        [marker.sourceExecutionId])
      const source = sourceRow && decodeExecutionState(sourceRow.result)
      const hash = createJsonHasher(), target = fork.nodeRuns?.[4]
      if (workflowId !== 'wf-sanguo-history-drama'
        || workflow?.edges_md5 !== expectedWorkflowEdgesMd5
        || forkRow.result_md5 !== record.resultMd5
        || !source || sourceRow.result_md5 !== marker.sourceResultMd5
        || fork.parentExecutionId !== source.id || fork.generationScopeId !== fork.id
        || fork.selectedNodeId !== continueIdleNode || marker.firstPendingIndex !== 4
        || (marker.firstPendingNodeId ?? target?.node.id) !== continueIdleNode
        || target?.node.id !== continueIdleNode || target.status !== 'idle'
        || hash(fork.nodeRuns.slice(0, 3)) !== hash(source.nodeRuns.slice(0, 3))
        || fork.nodeRuns.slice(4).some(run => run.status !== 'idle'))
        throw Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: opening story fork changed')
      return record.runs[4]
    }
  }
  if (continueIdleNode === 'sanguo-scene-cut-opening-plan') {
    const [{ rows: [forkRow] }, { rows: [workflow] }] = await Promise.all([
      pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [record.id]),
      pool.query('SELECT md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
    ])
    const fork = forkRow && decodeExecutionState(forkRow.result)
    const v195 = fork?.sceneCutOpeningV195Recovery
    if (v195?.version === 'scene-cut-opening-v195-fork-v1') {
      const [{ rows: [sourceRow] }, { rows: [savedWorkflow] }] = await Promise.all([
        pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1',
          [v195.sourceExecutionId]),
        pool.query('SELECT schema_version,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
      ])
      const source = sourceRow && decodeExecutionState(sourceRow.result)
      const index = v195.firstPendingIndex, hash = createJsonHasher()
      if (workflowId !== 'wf-sanguo-history-drama' || savedWorkflow?.schema_version !== 195
        || savedWorkflow.nodes_md5 !== v195.workflowNodesMd5
        || savedWorkflow.edges_md5 !== v195.workflowEdgesMd5
        || savedWorkflow.edges_md5 !== expectedWorkflowEdgesMd5
        || forkRow.result_md5 !== record.resultMd5
        || !source || sourceRow.result_md5 !== v195.sourceResultMd5
        || fork.parentExecutionId !== source.id || fork.selectedNodeId !== continueIdleNode
        || fork.generationScopeId !== fork.id || index !== 45
        || v195.firstPendingNodeId !== continueIdleNode
        || v195.shotSha256 !== source.nodeRuns[index]?.output?.shotSha256
        || fork.nodeRuns[index]?.node.id !== continueIdleNode || fork.nodeRuns[index].status !== 'idle'
        || hash(fork.nodeRuns.slice(0, index).map(run => [run.id, run.status, run.output]))
          !== hash(source.nodeRuns.slice(0, index).map(run => [run.id, run.status, run.output]))
        || fork.nodeRuns.slice(index).some(run => run.status !== 'idle'))
        throw Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: v195 opening repair changed')
      return record.runs[index]
    }
    const marker = fork?.sceneCutOpeningContractRepair
    if (marker?.version === 'scene-cut-opening-contract-repair-v1') {
      const { rows: [sourceRow] } = await pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1',
        [marker.sourceExecutionId])
      const source = sourceRow && decodeExecutionState(sourceRow.result)
      const index = marker.firstPendingIndex, hash = createJsonHasher()
      const target = fork.nodeRuns?.[index]
      if (workflowId !== 'wf-sanguo-history-drama'
        || workflow?.edges_md5 !== expectedWorkflowEdgesMd5
        || forkRow.result_md5 !== record.resultMd5
        || !source || sourceRow.result_md5 !== marker.sourceResultMd5
        || fork.parentExecutionId !== source.id || fork.selectedNodeId !== continueIdleNode
        || fork.generationScopeId !== fork.id || marker.firstPendingNodeId !== continueIdleNode
        || marker.shotSha256 !== source.nodeRuns?.[index]?.output?.shotSha256
        || target?.node.id !== continueIdleNode || target.status !== 'idle'
        || hash(fork.nodeRuns.slice(0, index).map(run => [run.id, run.status, run.output]))
          !== hash(source.nodeRuns.slice(0, index).map(run => [run.id, run.status, run.output]))
        || fork.nodeRuns.slice(index).some(run => run.status !== 'idle'))
        throw Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: opening contract repair changed')
      return record.runs[index]
    }
  }
  if (continueIdleNode === 'sanguo-scene-cut-first-frame') {
    const [{ rows: [forkRow] }, { rows: [workflow] }] = await Promise.all([
      pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [record.id]),
      pool.query('SELECT md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
    ])
    const fork = forkRow && decodeExecutionState(forkRow.result)
    if (fork?.sceneCutAutoRetry && fork?.parentExecutionId === record.parentExecutionId) {
      const { rows: [sourceRow] } = await pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1',
        [fork.parentExecutionId])
      const source = sourceRow && decodeExecutionState(sourceRow.result)
      const failedIndex = source?.nodeRuns.findIndex(run => run.status === 'failed'
        && run.node.id === 'sanguo-scene-cut-approval') ?? -1
      const failed = source?.nodeRuns[failedIndex]
      const prior = source?.sceneCutAutoRetry
      const plan = failed && planSceneCutAutoRetry(source.nodeRuns, failedIndex,
        prior?.loopGroupId === failed.loopGroupId && prior?.loopIndex === failed.loopIndex
          ? prior.count : 0)
      const target = fork.nodeRuns?.[plan?.imageIndex ?? -1]
      const hash = createJsonHasher()
      if (!plan || workflowId !== 'wf-sanguo-history-drama'
        || workflow?.edges_md5 !== expectedWorkflowEdgesMd5
        || forkRow.result_md5 !== record.resultMd5
        || fork.sceneCutAutoRetry.count !== plan.count
        || fork.sceneCutAutoRetry.sourceReviewRunId !== plan.reviewRunId
        || fork.generationScopeId !== fork.id
        || fork.selectedNodeId !== continueIdleNode
        || target?.node.id !== continueIdleNode || target.status !== 'idle'
        || target.retryFeedback !== plan.feedback
        || hash(fork.nodeRuns.slice(0, plan.imageIndex).map(run => [run.id, run.status, run.output]))
          !== hash(source.nodeRuns.slice(0, plan.imageIndex).map(run => [run.id, run.status, run.output]))
        || fork.nodeRuns.slice(plan.imageIndex).some(run => run.status !== 'idle'))
        throw Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: scene-cut image retry fork changed')
      return record.runs[plan.imageIndex]
    }
  }
  if (workflowId === 'wf-sanguo-history-drama') {
    const { rows: [forkRow] } = await pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [record.id])
    const fork = forkRow && decodeExecutionState(forkRow.result)
    const thresholdMarker = fork?.scene02ThresholdImage
    if (thresholdMarker?.version === 'scene02-threshold-image-v197') {
      const [{ rows: [sourceRow] }, { rows: [workflow] }] = await Promise.all([
        pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [thresholdMarker.sourceExecutionId]),
        pool.query('SELECT schema_version,nodes,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
      ])
      const source = sourceRow && decodeExecutionState(sourceRow.result)
      const index = thresholdMarker.firstPendingIndex, hash = createJsonHasher()
      const firstIdleIndex = fork.nodeRuns.findIndex(run => run.status === 'idle')
      if (workflow?.schema_version !== 197
        || workflow.nodes_md5 !== thresholdMarker.workflowNodesMd5
        || workflow.edges_md5 !== thresholdMarker.workflowEdgesMd5
        || workflow.edges_md5 !== expectedWorkflowEdgesMd5
        || forkRow.result_md5 !== record.resultMd5
        || !source || sourceRow.result_md5 !== thresholdMarker.sourceResultMd5
        || fork.parentExecutionId !== source.id || fork.generationScopeId !== fork.id
        || index !== 105 || thresholdMarker.firstPendingNodeId !== 'sanguo-scene-cut-first-frame'
        || thresholdMarker.originalImageUrl !== source.nodeRuns[index]?.output?.url
        || fork.nodeRuns[index]?.node.prompt !== workflow.nodes.find(node => node.id === 'sanguo-scene-cut-first-frame')?.prompt
        || fork.nodeRuns[108]?.node.prompt !== workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')?.prompt
        || hash(fork.nodeRuns.slice(0, index).map(run => [run.id, run.status, run.output]))
          !== hash(source.nodeRuns.slice(0, index).map(run => [run.id, run.status, run.output]))
        || firstIdleIndex < index || fork.nodeRuns[firstIdleIndex]?.node.id !== continueIdleNode
        || fork.nodeRuns.slice(0, firstIdleIndex).some(run => !['success', 'skipped'].includes(run.status))
        || fork.nodeRuns.slice(firstIdleIndex).some(run => run.status !== 'idle'))
        throw Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: scene02 threshold image fork changed')
      return record.runs[firstIdleIndex]
    }
    const imageReviewMarker = fork?.scene02ImageReviewContract
    if (imageReviewMarker?.version === 'scene02-image-review-v196') {
      const [{ rows: [sourceRow] }, { rows: [workflow] }] = await Promise.all([
        pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [imageReviewMarker.sourceExecutionId]),
        pool.query('SELECT schema_version,nodes,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
      ])
      const source = sourceRow && decodeExecutionState(sourceRow.result)
      const index = imageReviewMarker.firstPendingIndex, hash = createJsonHasher()
      const firstIdleIndex = fork.nodeRuns.findIndex(run => run.status === 'idle')
      if (workflow?.schema_version !== 196
        || workflow.nodes_md5 !== imageReviewMarker.workflowNodesMd5
        || workflow.edges_md5 !== imageReviewMarker.workflowEdgesMd5
        || workflow.edges_md5 !== expectedWorkflowEdgesMd5
        || forkRow.result_md5 !== record.resultMd5
        || !source || sourceRow.result_md5 !== imageReviewMarker.sourceResultMd5
        || fork.parentExecutionId !== source.id || fork.generationScopeId !== fork.id
        || index !== 107 || imageReviewMarker.firstPendingNodeId !== 'sanguo-scene-cut-evidence'
        || imageReviewMarker.imageIndex !== 105
        || fork.nodeRuns[105]?.output?.url !== imageReviewMarker.imageUrl
        || fork.nodeRuns[108]?.node.prompt !== workflow.nodes.find(node => node.id === 'sanguo-scene-cut-review')?.prompt
        || hash(fork.nodeRuns.slice(0, index).map(run => [run.id, run.status, run.output]))
          !== hash(source.nodeRuns.slice(0, index).map(run => [run.id, run.status, run.output]))
        || firstIdleIndex < index || fork.nodeRuns[firstIdleIndex]?.node.id !== continueIdleNode
        || fork.nodeRuns.slice(0, firstIdleIndex).some(run => !['success', 'skipped'].includes(run.status))
        || fork.nodeRuns.slice(firstIdleIndex).some(run => run.status !== 'idle'))
        throw Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: scene02 image review contract changed')
      return record.runs[firstIdleIndex]
    }
    const durationMarker = fork?.scene02DurationReplan
    if (durationMarker?.version === 'scene02-duration-replan-v1') {
      const [{ rows: [sourceRow] }, { rows: [workflow] }] = await Promise.all([
        pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [durationMarker.sourceExecutionId]),
        pool.query('SELECT schema_version,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
      ])
      const source = sourceRow && decodeExecutionState(sourceRow.result)
      const index = durationMarker.firstPendingIndex, hash = createJsonHasher()
      const firstIdleIndex = fork.nodeRuns.findIndex(run => run.status === 'idle')
      if (workflow?.schema_version !== 195
        || workflow.nodes_md5 !== durationMarker.workflowNodesMd5
        || workflow.edges_md5 !== durationMarker.workflowEdgesMd5
        || workflow.edges_md5 !== expectedWorkflowEdgesMd5
        || forkRow.result_md5 !== record.resultMd5
        || !source || sourceRow.result_md5 !== durationMarker.sourceResultMd5
        || fork.parentExecutionId !== source.id || fork.generationScopeId !== fork.id
        || index !== 67 || durationMarker.firstPendingNodeId !== 'sanguo-shot-script'
        || durationMarker.originalShotId !== source.nodeRuns[index]?.output?.id
        || fork.nodeRuns[index]?.node.id !== 'sanguo-shot-script'
        || fork.nodeRuns[index].retryFeedback?.kind !== 'shot-script-duration-replan'
        || hash(fork.nodeRuns.slice(0, index).map(run => [run.id, run.status, run.output]))
          !== hash(source.nodeRuns.slice(0, index).map(run => [run.id, run.status, run.output]))
        || firstIdleIndex < index || fork.nodeRuns[firstIdleIndex]?.node.id !== continueIdleNode
        || fork.nodeRuns.slice(0, firstIdleIndex).some(run => !['success', 'skipped'].includes(run.status))
        || fork.nodeRuns.slice(firstIdleIndex).some(run => run.status !== 'idle'))
        throw Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: scene02 duration replan changed')
      return record.runs[firstIdleIndex]
    }
    const marker = fork?.scene01ActionReplan
    if (marker?.version === 'scene01-action-replan-v1') {
      const [{ rows: [sourceRow] }, { rows: [workflow] }] = await Promise.all([
        pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [marker.sourceExecutionId]),
        pool.query('SELECT schema_version,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
      ])
      const source = sourceRow && decodeExecutionState(sourceRow.result)
      const index = marker.firstPendingIndex, hash = createJsonHasher()
      const firstIdleIndex = fork.nodeRuns.findIndex(run => run.status === 'idle')
      if (workflowId !== 'wf-sanguo-history-drama' || workflow?.schema_version !== 195
        || workflow.nodes_md5 !== marker.workflowNodesMd5
        || workflow.edges_md5 !== marker.workflowEdgesMd5
        || workflow.edges_md5 !== expectedWorkflowEdgesMd5
        || forkRow.result_md5 !== record.resultMd5
        || !source || sourceRow.result_md5 !== marker.sourceResultMd5
        || fork.parentExecutionId !== source.id
        || fork.generationScopeId !== fork.id || index !== 9
        || marker.firstPendingNodeId !== 'sanguo-shot-script'
        || marker.originalShotId !== source.nodeRuns[index]?.output?.id
        || fork.nodeRuns[index]?.node.id !== 'sanguo-shot-script'
        || fork.nodeRuns[index].retryFeedback?.kind !== 'shot-script-action-replan'
        || hash(fork.nodeRuns.slice(0, index).map(run => [run.id, run.status, run.output]))
          !== hash(source.nodeRuns.slice(0, index).map(run => [run.id, run.status, run.output]))
        || firstIdleIndex < index || fork.nodeRuns[firstIdleIndex]?.node.id !== continueIdleNode
        || fork.nodeRuns.slice(0, firstIdleIndex).some(run => run.status !== 'success')
        || fork.nodeRuns.slice(firstIdleIndex).some(run => run.status !== 'idle'))
        throw Error('IDLE_CHECKPOINT_IDENTITY_MISMATCH: scene01 action replan changed')
      return record.runs[firstIdleIndex]
    }
  }
  if (storyScriptIdle) {
    const target = verifiedStoryScriptIdleContinuation(record, { workflowId, nodeId: continueIdleNode })
    const [{ rows: [fork] }, { rows: [source] }, { rows: [workflow] }] = await Promise.all([
      pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [record.id]),
      pool.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [record.parentExecutionId]),
      pool.query('SELECT *,md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
    ])
    const proof = verifiedStoryScriptBreakpointFork(source, fork, workflow, {
      projectedResultMd5: record.resultMd5, expectedSourceMd5, expectedWorkflowNodesMd5,
      expectedWorkflowEdgesMd5,
    })
    const [{ rows: [sourceAfter] }, { rows: [forkAfter] }, { rows: [workflowAfter] }] = await Promise.all([
      pool.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [record.parentExecutionId]),
      pool.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1', [record.id]),
      pool.query('SELECT md5(nodes::text) AS nodes_md5,md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
    ])
    if (sourceAfter?.md5 !== proof.sourceResultMd5 || forkAfter?.md5 !== proof.forkResultMd5
      || workflowAfter?.nodes_md5 !== proof.workflowNodesMd5
      || workflowAfter?.edges_md5 !== proof.workflowEdgesMd5)
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: wf-story source, fork or workflow changed before click')
    return target
  }
  const target = verifiedIdleContinuation(record, { workflowId, nodeId: continueIdleNode })
  if (record.sceneCutCompositeRecovery?.version
    === 'source-bound-composite-a8b6-fresh-first-shot-v1') {
    const marker = record.sceneCutCompositeRecovery
    const [currentQuery, sourceQuery, imageQuery, workflowQuery, verified] =
      await Promise.all([
        pool.query(`SELECT *,md5(result::text) AS result_md5
          FROM execution_records WHERE id=$1`, [record.id]),
        pool.query(`SELECT *,md5(result::text) AS result_md5
          FROM execution_records WHERE id=$1`, [marker.sourceExecutionId]),
        pool.query(`SELECT *,md5(result::text) AS result_md5
          FROM execution_records WHERE id=$1`,
        [marker.imageApprovalExecutionId]),
        pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
          md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
        [workflowId]),
        verifyFreshA8B6CompositeReceipt(marker.planId),
      ])
    const current = currentQuery.rows[0], source = sourceQuery.rows[0]
    const image = imageQuery.rows[0], workflow = workflowQuery.rows[0]
    if (current?.result_md5 !== record.resultMd5
      || source?.result_md5 !== marker.sourceResultMd5
      || image?.result_md5 !== marker.imageApprovalResultMd5
      || workflow?.schema_version !== 180
      || workflow.nodes_md5 !== marker.workflowNodesMd5
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || verified.manifestSha256 !== marker.manifestSha256
      || verified.receiptSha256 !== marker.receiptSha256
      || verified.receipt.output.sha256 !== marker.compositeVideoSha256)
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: fresh composite source changed')
    const reconstructed = prepareFreshA8B6SourceBoundFork(source, image,
      workflow, verified, { id: record.id })
    const currentState = decodeExecutionState(current.result)
    // A later idle checkpoint has legitimately advanced the mutable suffix.
    // Keep the paid and approved prefix pinned to the signed fork while the
    // pure continuation guard checks that the suffix reaches only the selected
    // next idle node, without failed/running nodes or gaps.
    if (currentState.id !== reconstructed.state.id
      || currentState.workflowId !== reconstructed.state.workflowId
      || currentState.parentExecutionId
        !== reconstructed.state.parentExecutionId
      || createJsonHasher()(currentState.sceneCutCompositeRecovery)
        !== createJsonHasher()(reconstructed.state.sceneCutCompositeRecovery)
      || createJsonHasher()(currentState.nodeRuns?.slice(0, 53))
        !== createJsonHasher()(reconstructed.state.nodeRuns?.slice(0, 53)))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: fresh composite prefix differs from exact fork')
    const [sourceAfter, imageAfter, currentAfter, graphAfter] =
      await Promise.all([
        pool.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
          [source.id]),
        pool.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
          [image.id]),
        pool.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
          [record.id]),
        pool.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
          md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
        [workflowId]),
      ])
    if (sourceAfter.rows[0]?.md5 !== source.result_md5
      || imageAfter.rows[0]?.md5 !== image.result_md5
      || currentAfter.rows[0]?.md5 !== record.resultMd5
      || graphAfter.rows[0]?.schema_version !== 180
      || graphAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || graphAfter.rows[0]?.edges_md5 !== workflow.edges_md5)
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: fresh composite changed before click')
    return target
  }
  if (['record-4x5m31-a8b6-local-v7-router-v1',
    'record-4x5m31-a8b6-local-v8-router-v1',
    'record-4x5m31-a8b6-local-v9-router-v1'].includes(record.id)) {
    const isV9 = record.id === 'record-4x5m31-a8b6-local-v9-router-v1'
    const isV8 = record.id === 'record-4x5m31-a8b6-local-v8-router-v1'
    const version = isV9 ? 'V9' : isV8 ? 'V8' : 'V7'
    const marker = record.sceneCutA8B6FreshRouterRecovery
    const approvalModule = await import(
      `../server/staged-scene-cut-a8b6-local-approval-${version.toLowerCase()}.mjs`)
    const routerModule = await import(
      `./fork-original-shot1-a8b6-local-${version.toLowerCase()}-fresh-router.mjs`)
    const verifyApproval = approvalModule[`verifyA8B6LocalWorkflowApproval${version}`]
    const prepareRouter = routerModule[`prepareA8B6Local${version}RouterFork`]
    if (typeof verifyApproval !== 'function'
      || typeof prepareRouter !== 'function')
      throw new Error(`IDLE_CHECKPOINT_SOURCE_CHANGED: ${version} router verifier missing`)
    const [parentQuery, currentQuery, graphQuery, signed] =
      await Promise.all([
        pool.query(`SELECT *,md5(result::text) AS result_md5
          FROM execution_records WHERE id=$1`,
        [marker.imageApprovalExecutionId]),
        pool.query(`SELECT *,md5(result::text) AS result_md5
          FROM execution_records WHERE id=$1`, [record.id]),
        pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
          md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
        [workflowId]),
        verifyApproval(marker.planId),
      ])
    const parent = parentQuery.rows[0]
    const current = currentQuery.rows[0]
    const graph = graphQuery.rows[0]
    if (parent?.result_md5 !== marker.imageApprovalResultMd5
      || current?.result_md5 !== record.resultMd5
      || parent.workflow_id !== workflowId
      || current.workflow_id !== workflowId
      || graph?.schema_version !== marker.workflowSchemaVersion
      || graph.nodes_md5 !== marker.workflowNodesMd5
      || graph.edges_md5 !== marker.workflowEdgesMd5
      || graph.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || signed.approvalSha256 !== marker.workflowApprovalSha256)
      throw new Error(`IDLE_CHECKPOINT_SOURCE_CHANGED: ${version} router parent, approval or graph changed`)
    const prepared = prepareRouter(parent, graph, signed)
    if (createJsonHasher()(decodeExecutionState(current.result))
      !== createJsonHasher()(prepared.state)
      || !isDeepStrictEqual(prepared.marker, marker))
      throw new Error(`IDLE_CHECKPOINT_SOURCE_CHANGED: ${version} router fork differs from signed parent`)
    const [parentAfter, childAfter, graphAfter] = await Promise.all([
      pool.query(`SELECT md5(result::text) AS result_md5
        FROM execution_records WHERE id=$1`, [parent.id]),
      pool.query(`SELECT md5(result::text) AS result_md5
        FROM execution_records WHERE id=$1`, [record.id]),
      pool.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
    ])
    if (parentAfter.rows[0]?.result_md5 !== parent.result_md5
      || childAfter.rows[0]?.result_md5 !== current.result_md5
      || graphAfter.rows[0]?.schema_version !== graph.schema_version
      || graphAfter.rows[0]?.nodes_md5 !== graph.nodes_md5
      || graphAfter.rows[0]?.edges_md5 !== graph.edges_md5)
      throw new Error(`IDLE_CHECKPOINT_SOURCE_CHANGED: ${version} router changed before click`)
    return target
  }
  if (['record-4x5m31-a8b6-local-wall-v6',
    'record-4x5m31-a8b6-local-wall-v7',
    'record-4x5m31-a8b6-local-wall-v8',
    'record-4x5m31-a8b6-local-wall-v9'].includes(record.id)) {
    const isV9 = record.id === 'record-4x5m31-a8b6-local-wall-v9'
    const isV8 = record.id === 'record-4x5m31-a8b6-local-wall-v8'
    const isV7 = record.id === 'record-4x5m31-a8b6-local-wall-v7'
    const version = isV9 ? 'v9' : isV8 ? 'v8' : isV7 ? 'v7' : 'v6'
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = continueIdleNode === 'sanguo-scene-cut-approval'
    const ids = [marker.sourceExecutionId,
      isV9 ? marker.priorLocalV8ExecutionId
        : isV8 ? marker.priorLocalV7ExecutionId
        : isV7 ? marker.priorLocalV6ExecutionId
          : marker.priorLocalV5ExecutionId, record.id]
    const [rowsQuery, workflowQuery, imageLedgerQuery,
      reviewLedgerQuery, signed] = await Promise.all([
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids]),
      pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT id FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-first-frame'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT *,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      isV9 ? verifyA8B6LocalCompositeSourceReceiptV9()
        : isV8 ? verifyA8B6LocalCompositeSourceReceiptV8()
        : isV7 ? verifyA8B6LocalCompositeSourceReceiptV7()
          : verifyA8B6LocalCompositeSourceReceiptV6(),
    ])
    const byId = new Map(rowsQuery.rows.map(row => [row.id, row]))
    const timing = byId.get(marker.sourceExecutionId)
    const rejected = byId.get(ids[1])
    const current = byId.get(record.id)
    const workflow = workflowQuery.rows[0]
    if (new Set(ids).size !== 3 || rowsQuery.rowCount !== 3
      || timing?.result_md5 !== marker.sourceResultMd5
      || rejected?.result_md5 !== (isV9
        ? marker.priorLocalV8ResultMd5
        : isV8
        ? marker.priorLocalV7ResultMd5
        : isV7 ? marker.priorLocalV6ResultMd5
          : marker.priorLocalV5ResultMd5)
      || current?.result_md5 !== record.resultMd5
      || rowsQuery.rows.some(row => row.workflow_id !== workflowId)
      || workflow?.schema_version !== 180
      || workflow.nodes_md5 !== marker.workflowNodesMd5
      || workflow.edges_md5 !== marker.workflowEdgesMd5
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || signed.receiptSha256 !== marker.sourceReceiptSha256
      || imageLedgerQuery.rowCount !== 0
      || reviewLedgerQuery.rowCount !== (forApproval ? 1 : 0))
      throw new Error(`IDLE_CHECKPOINT_SOURCE_CHANGED: local ${version} sources, graph or ledger changed`)
    const assertHop = isV9
      ? (await import('./fork-original-shot1-a8b6-local-wall-v9.mjs'))
        .assertA8B6LocalFrameHopV9
      : isV8
      ? (await import('./fork-original-shot1-a8b6-local-wall-v8.mjs'))
        .assertA8B6LocalFrameHopV8
      : isV7
        ? (await import('./fork-original-shot1-a8b6-local-wall-v7.mjs'))
          .assertA8B6LocalFrameHopV7
        : (await import('./fork-original-shot1-a8b6-local-wall-v6.mjs'))
          .assertA8B6LocalFrameHopV6
    const state = decodeExecutionState(current.result)
    assertHop(decodeExecutionState(timing.result), state,
      timing.result_md5, signed, forApproval ? 'review-complete' : 'pending')
    if (forApproval) {
      const runs = state.nodeRuns
      const reviewLedger = reviewLedgerQuery.rows[0]
      const expectedReview = { evidence: runs[48].output,
        shot: runs[11].output, sources: runs[41].output,
        reviewImages: runs[48].output.reviewImages,
        openingStatePlan: runs[43].output,
        sceneCutLocalComposite: state.sceneCutA8B6LocalFrameRecovery }
      const verifiedReviewId = reviewLedger
        && (isV9 || isV8
          ? await assertSceneCutReviewLedgerRecordWithDetail(reviewLedger,
            runs[49].output, expectedReview, process.cwd(), 180)
          : assertSceneCutReviewLedgerRecord(reviewLedger,
            runs[49].output, expectedReview, process.cwd(), 180))
      if (runs[49].output?.passed !== true
        || !isDeepStrictEqual(runs[49].output.issues, [])
        || reviewLedger?.status !== 'succeeded'
        || !String(reviewLedger.request_data?.requestKey ?? '')
          .startsWith(`${record.id}:`)
        || verifiedReviewId !== reviewLedger.id)
        throw new Error(`IDLE_CHECKPOINT_SOURCE_CHANGED: local ${version} review lacks pass or model ledger`)
    }
    const [casQuery, graphAfter, imageAfter, reviewAfter] = await Promise.all([
      pool.query(`SELECT id,md5(result::text) AS result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids]),
      pool.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT id FROM model_execution_records WHERE workflow_id=$1
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT id,status,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
    ])
    const cas = new Map(casQuery.rows.map(row => [row.id, row.result_md5]))
    if (casQuery.rowCount !== 3
      || ids.some(id => cas.get(id) !== byId.get(id).result_md5)
      || graphAfter.rows[0]?.schema_version !== 180
      || graphAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || graphAfter.rows[0]?.edges_md5 !== workflow.edges_md5
      || imageAfter.rowCount !== 0
      || reviewAfter.rowCount !== reviewLedgerQuery.rowCount
      || forApproval && (reviewAfter.rows[0]?.id !== reviewLedgerQuery.rows[0].id
        || reviewAfter.rows[0]?.status !== 'succeeded'
        || reviewAfter.rows[0]?.request_md5
          !== reviewLedgerQuery.rows[0].request_md5
        || reviewAfter.rows[0]?.response_md5
          !== reviewLedgerQuery.rows[0].response_md5))
      throw new Error(`IDLE_CHECKPOINT_SOURCE_CHANGED: local ${version} child changed before click`)
    return target
  }
  if (record.id === 'record-4x5m31-a8b6-local-wall-v5') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = continueIdleNode === 'sanguo-scene-cut-approval'
    const ids = [marker.sourceExecutionId,
      marker.priorLocalV4ExecutionId, record.id]
    const [rowsQuery, workflowQuery, imageLedgerQuery,
      reviewLedgerQuery, signed] = await Promise.all([
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids]),
      pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT id FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-first-frame'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT *,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      verifyA8B6LocalCompositeSourceReceiptV5(),
    ])
    const byId = new Map(rowsQuery.rows.map(row => [row.id, row]))
    const timing = byId.get(marker.sourceExecutionId)
    const rejectedV4 = byId.get(marker.priorLocalV4ExecutionId)
    const current = byId.get(record.id)
    const workflow = workflowQuery.rows[0]
    if (new Set(ids).size !== 3 || rowsQuery.rowCount !== 3
      || timing?.result_md5 !== marker.sourceResultMd5
      || rejectedV4?.result_md5 !== marker.priorLocalV4FailedResultMd5
      || current?.result_md5 !== record.resultMd5
      || rowsQuery.rows.some(row => row.workflow_id !== workflowId)
      || workflow?.schema_version !== 180
      || workflow.nodes_md5 !== marker.workflowNodesMd5
      || workflow.edges_md5 !== marker.workflowEdgesMd5
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || signed.receiptSha256 !== marker.sourceReceiptSha256
      || imageLedgerQuery.rowCount !== 0
      || reviewLedgerQuery.rowCount !== (forApproval ? 1 : 0))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local v5 sources, graph or ledger changed')
    const { assertA8B6LocalFrameHopV5 } = await import(
      './fork-original-shot1-a8b6-local-wall-v5.mjs')
    const state = decodeExecutionState(current.result)
    assertA8B6LocalFrameHopV5(decodeExecutionState(timing.result), state,
      timing.result_md5, signed, forApproval ? 'review-complete' : 'pending')
    if (forApproval) {
      const runs = state.nodeRuns
      const reviewLedger = reviewLedgerQuery.rows[0]
      if (runs[49].output?.passed !== true
        || !isDeepStrictEqual(runs[49].output.issues, [])
        || reviewLedger?.status !== 'succeeded'
        || !String(reviewLedger.request_data?.requestKey ?? '')
          .startsWith(`${record.id}:`)
        || assertSceneCutReviewLedgerRecord(reviewLedger,
          runs[49].output, { evidence: runs[48].output,
            shot: runs[11].output, sources: runs[41].output,
            reviewImages: runs[48].output.reviewImages,
            openingStatePlan: runs[43].output,
            sceneCutLocalComposite: state.sceneCutA8B6LocalFrameRecovery },
          process.cwd(), 180)
          !== reviewLedger.id)
        throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local v5 review lacks pass or model ledger')
    }
    const [casQuery, graphAfter, imageAfter, reviewAfter] = await Promise.all([
      pool.query(`SELECT id,md5(result::text) AS result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids]),
      pool.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT id FROM model_execution_records WHERE workflow_id=$1
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT id,status,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
    ])
    const cas = new Map(casQuery.rows.map(row => [row.id, row.result_md5]))
    if (casQuery.rowCount !== 3
      || ids.some(id => cas.get(id) !== byId.get(id).result_md5)
      || graphAfter.rows[0]?.schema_version !== 180
      || graphAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || graphAfter.rows[0]?.edges_md5 !== workflow.edges_md5
      || imageAfter.rowCount !== 0
      || reviewAfter.rowCount !== reviewLedgerQuery.rowCount
      || forApproval && (reviewAfter.rows[0]?.id !== reviewLedgerQuery.rows[0].id
        || reviewAfter.rows[0]?.status !== 'succeeded'
        || reviewAfter.rows[0]?.request_md5
          !== reviewLedgerQuery.rows[0].request_md5
        || reviewAfter.rows[0]?.response_md5
          !== reviewLedgerQuery.rows[0].response_md5))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local v5 child changed before click')
    return target
  }
  if (record.id === 'record-4x5m31-a8b6-local-wall-v4') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = continueIdleNode === 'sanguo-scene-cut-approval'
    const ids = [marker.sourceExecutionId,
      marker.priorLocalV3ExecutionId, record.id]
    const [rowsQuery, workflowQuery, imageLedgerQuery,
      reviewLedgerQuery, signed] = await Promise.all([
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids]),
      pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT id FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-first-frame'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT *,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      verifyA8B6LocalCompositeSourceReceiptV4(),
    ])
    const byId = new Map(rowsQuery.rows.map(row => [row.id, row]))
    const timing = byId.get(marker.sourceExecutionId)
    const rejectedV3 = byId.get(marker.priorLocalV3ExecutionId)
    const current = byId.get(record.id)
    const workflow = workflowQuery.rows[0]
    if (new Set(ids).size !== 3 || rowsQuery.rowCount !== 3
      || timing?.result_md5 !== marker.sourceResultMd5
      || rejectedV3?.result_md5 !== marker.priorLocalV3ResultMd5
      || current?.result_md5 !== record.resultMd5
      || rowsQuery.rows.some(row => row.workflow_id !== workflowId)
      || workflow?.schema_version !== 180
      || workflow.nodes_md5 !== marker.workflowNodesMd5
      || workflow.edges_md5 !== marker.workflowEdgesMd5
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || signed.receiptSha256 !== marker.sourceReceiptSha256
      || imageLedgerQuery.rowCount !== 0
      || reviewLedgerQuery.rowCount !== (forApproval ? 1 : 0))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local v4 sources, graph or ledger changed')
    const { assertA8B6LocalFrameHopV4 } = await import(
      './fork-original-shot1-a8b6-local-wall-v4.mjs')
    const state = decodeExecutionState(current.result)
    assertA8B6LocalFrameHopV4(decodeExecutionState(timing.result), state,
      timing.result_md5, signed, forApproval ? 'review-complete' : 'pending')
    if (forApproval) {
      const runs = state.nodeRuns
      const reviewLedger = reviewLedgerQuery.rows[0]
      if (runs[49].output?.passed !== true
        || !isDeepStrictEqual(runs[49].output.issues, [])
        || reviewLedger?.status !== 'succeeded'
        || !String(reviewLedger.request_data?.requestKey ?? '')
          .startsWith(`${record.id}:`)
        || assertSceneCutReviewLedgerRecord(reviewLedger,
          runs[49].output, { evidence: runs[48].output,
            shot: runs[11].output, sources: runs[41].output,
            reviewImages: runs[48].output.reviewImages,
            openingStatePlan: runs[43].output,
            sceneCutLocalComposite: state.sceneCutA8B6LocalFrameRecovery },
          process.cwd(), 180)
          !== reviewLedger.id)
        throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local v4 review lacks pass or model ledger')
    }
    const [casQuery, graphAfter, imageAfter, reviewAfter] = await Promise.all([
      pool.query(`SELECT id,md5(result::text) AS result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids]),
      pool.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT id FROM model_execution_records WHERE workflow_id=$1
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT id,status,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
    ])
    const cas = new Map(casQuery.rows.map(row => [row.id, row.result_md5]))
    if (casQuery.rowCount !== 3
      || ids.some(id => cas.get(id) !== byId.get(id).result_md5)
      || graphAfter.rows[0]?.schema_version !== 180
      || graphAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || graphAfter.rows[0]?.edges_md5 !== workflow.edges_md5
      || imageAfter.rowCount !== 0
      || reviewAfter.rowCount !== reviewLedgerQuery.rowCount
      || forApproval && (reviewAfter.rows[0]?.id !== reviewLedgerQuery.rows[0].id
        || reviewAfter.rows[0]?.status !== 'succeeded'
        || reviewAfter.rows[0]?.request_md5
          !== reviewLedgerQuery.rows[0].request_md5
        || reviewAfter.rows[0]?.response_md5
          !== reviewLedgerQuery.rows[0].response_md5))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local v4 child changed before click')
    return target
  }
  if (record.id === 'record-4x5m31-a8b6-local-face-wall-v3') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = continueIdleNode === 'sanguo-scene-cut-approval'
    const ids = [marker.sourceExecutionId,
      marker.priorLocalV2ExecutionId, record.id]
    const [rowsQuery, workflowQuery, imageLedgerQuery,
      reviewLedgerQuery, signed] = await Promise.all([
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids]),
      pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT id FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-first-frame'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT *,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      verifyA8B6LocalCompositeSourceReceiptV3(),
    ])
    const byId = new Map(rowsQuery.rows.map(row => [row.id, row]))
    const timing = byId.get(marker.sourceExecutionId)
    const rejectedV2 = byId.get(marker.priorLocalV2ExecutionId)
    const current = byId.get(record.id)
    const workflow = workflowQuery.rows[0]
    if (new Set(ids).size !== 3 || rowsQuery.rowCount !== 3
      || timing?.result_md5 !== marker.sourceResultMd5
      || rejectedV2?.result_md5 !== marker.priorLocalV2ResultMd5
      || current?.result_md5 !== record.resultMd5
      || rowsQuery.rows.some(row => row.workflow_id !== workflowId)
      || workflow?.schema_version !== 180
      || workflow.nodes_md5 !== marker.workflowNodesMd5
      || workflow.edges_md5 !== marker.workflowEdgesMd5
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || signed.receiptSha256 !== marker.sourceReceiptSha256
      || imageLedgerQuery.rowCount !== 0
      || reviewLedgerQuery.rowCount !== (forApproval ? 1 : 0))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local v3 sources, graph or ledger changed')
    const { assertA8B6LocalFrameHopV3 } = await import(
      './fork-original-shot1-a8b6-local-face-wall-v3.mjs')
    const state = decodeExecutionState(current.result)
    assertA8B6LocalFrameHopV3(decodeExecutionState(timing.result), state,
      timing.result_md5, signed, forApproval ? 'review-complete' : 'pending')
    if (forApproval) {
      const runs = state.nodeRuns
      const reviewLedger = reviewLedgerQuery.rows[0]
      if (runs[49].output?.passed !== true
        || !isDeepStrictEqual(runs[49].output.issues, [])
        || reviewLedger?.status !== 'succeeded'
        || !String(reviewLedger.request_data?.requestKey ?? '')
          .startsWith(`${record.id}:`)
        || assertSceneCutReviewLedgerRecord(reviewLedger,
          runs[49].output, { evidence: runs[48].output,
            shot: runs[11].output, sources: runs[41].output,
            reviewImages: runs[48].output.reviewImages,
            openingStatePlan: runs[43].output,
            sceneCutLocalComposite: state.sceneCutA8B6LocalFrameRecovery },
          process.cwd(), 180)
          !== reviewLedger.id)
        throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local v3 review lacks pass or model ledger')
    }
    const [casQuery, graphAfter, imageAfter, reviewAfter] = await Promise.all([
      pool.query(`SELECT id,md5(result::text) AS result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids]),
      pool.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT id FROM model_execution_records WHERE workflow_id=$1
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT id,status,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
    ])
    const cas = new Map(casQuery.rows.map(row => [row.id, row.result_md5]))
    if (casQuery.rowCount !== 3
      || ids.some(id => cas.get(id) !== byId.get(id).result_md5)
      || graphAfter.rows[0]?.schema_version !== 180
      || graphAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || graphAfter.rows[0]?.edges_md5 !== workflow.edges_md5
      || imageAfter.rowCount !== 0
      || reviewAfter.rowCount !== reviewLedgerQuery.rowCount
      || forApproval && (reviewAfter.rows[0]?.id !== reviewLedgerQuery.rows[0].id
        || reviewAfter.rows[0]?.status !== 'succeeded'
        || reviewAfter.rows[0]?.request_md5
          !== reviewLedgerQuery.rows[0].request_md5
        || reviewAfter.rows[0]?.response_md5
          !== reviewLedgerQuery.rows[0].response_md5))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local v3 child changed before click')
    return target
  }
  if (record.id === 'record-4x5m31-a8b6-local-face-v2') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = continueIdleNode === 'sanguo-scene-cut-approval'
    const ids = [marker.sourceExecutionId, marker.v7ExecutionId,
      marker.v4ExecutionId, marker.v8ExecutionId,
      marker.priorLocalV1ExecutionId, record.id]
    const [rowsQuery, workflowQuery, imageLedgerQuery,
      reviewLedgerQuery, signed] = await Promise.all([
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids]),
      pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT id FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-first-frame'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT *,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      verifyA8B6LocalCompositeSourceReceiptV2(),
    ])
    const byId = new Map(rowsQuery.rows.map(row => [row.id, row]))
    const timing = byId.get(marker.sourceExecutionId)
    const v7 = byId.get(marker.v7ExecutionId)
    const v4 = byId.get(marker.v4ExecutionId)
    const v8 = byId.get(marker.v8ExecutionId)
    const rejectedV1 = byId.get(marker.priorLocalV1ExecutionId)
    const current = byId.get(record.id)
    const workflow = workflowQuery.rows[0]
    if (new Set(ids).size !== 6 || rowsQuery.rowCount !== 6
      || timing?.result_md5 !== marker.sourceResultMd5
      || v7?.result_md5 !== marker.v7ResultMd5
      || v4?.result_md5 !== marker.v4ResultMd5
      || v8?.result_md5 !== marker.v8ResultMd5
      || rejectedV1?.result_md5 !== marker.priorLocalV1ResultMd5
      || current?.result_md5 !== record.resultMd5
      || rowsQuery.rows.some(row => row.workflow_id !== workflowId)
      || workflow?.schema_version !== 180
      || workflow.nodes_md5 !== marker.workflowNodesMd5
      || workflow.edges_md5 !== marker.workflowEdgesMd5
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || signed.receiptSha256 !== marker.sourceReceiptSha256
      || imageLedgerQuery.rowCount !== 0
      || reviewLedgerQuery.rowCount !== (forApproval ? 1 : 0))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local v2 sources, graph or ledger changed')
    const state = decodeExecutionState(current.result)
    if (forApproval) {
      assertA8B6LocalFrameHopV2(decodeExecutionState(timing.result), state,
        timing.result_md5, signed, 'review-complete')
      const runs = state.nodeRuns
      const reviewLedger = reviewLedgerQuery.rows[0]
      if (runs[49].output?.passed !== true
        || !isDeepStrictEqual(runs[49].output.issues, [])
        || reviewLedger?.status !== 'succeeded'
        || !String(reviewLedger.request_data?.requestKey ?? '')
          .startsWith(`${record.id}:`)
        || assertSceneCutReviewLedgerRecord(reviewLedger,
          runs[49].output, { evidence: runs[48].output,
            shot: runs[11].output, sources: runs[41].output,
            reviewImages: runs[48].output.reviewImages,
            openingStatePlan: runs[43].output,
            sceneCutLocalComposite: state.sceneCutA8B6LocalFrameRecovery },
          process.cwd(), 180) !== reviewLedger.id)
        throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local v2 review lacks pass or model ledger')
    } else {
      const prepared = prepareA8B6LocalFrameForkV2(timing, v7, v4, v8,
        rejectedV1, workflow, signed)
      if (createJsonHasher()(state) !== createJsonHasher()(prepared.state))
        throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local v2 child differs from signed fork')
      assertA8B6LocalFrameHopV2(decodeExecutionState(timing.result), state,
        timing.result_md5, signed, 'pending')
    }
    const [casQuery, graphAfter, imageAfter, reviewAfter] = await Promise.all([
      pool.query(`SELECT id,md5(result::text) AS result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids]),
      pool.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT id FROM model_execution_records WHERE workflow_id=$1
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT id,status,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
    ])
    const cas = new Map(casQuery.rows.map(row => [row.id, row.result_md5]))
    if (casQuery.rowCount !== 6
      || ids.some(id => cas.get(id) !== byId.get(id).result_md5)
      || graphAfter.rows[0]?.schema_version !== 180
      || graphAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || graphAfter.rows[0]?.edges_md5 !== workflow.edges_md5
      || imageAfter.rowCount !== 0
      || reviewAfter.rowCount !== reviewLedgerQuery.rowCount
      || forApproval && (reviewAfter.rows[0]?.id !== reviewLedgerQuery.rows[0].id
        || reviewAfter.rows[0]?.status !== 'succeeded'
        || reviewAfter.rows[0]?.request_md5
          !== reviewLedgerQuery.rows[0].request_md5
        || reviewAfter.rows[0]?.response_md5
          !== reviewLedgerQuery.rows[0].response_md5))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local v2 child changed before click')
    return target
  }
  if (record.id === 'record-4x5m31-a8b6-local-face-v1') {
    const marker = record.sceneCutA8B6LocalFrameRecovery
    const forApproval = continueIdleNode === 'sanguo-scene-cut-approval'
    const ids = [marker.sourceExecutionId, marker.v7ExecutionId,
      marker.v4ExecutionId, marker.v8ExecutionId, record.id]
    const [rowsQuery, workflowQuery, imageLedgerQuery,
      reviewLedgerQuery, signed] = await Promise.all([
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids]),
      pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT *,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-first-frame'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT *,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      verifyA8B6LocalCompositeSourceReceipt(),
    ])
    const byId = new Map(rowsQuery.rows.map(row => [row.id, row]))
    const timing = byId.get(marker.sourceExecutionId)
    const v7 = byId.get(marker.v7ExecutionId)
    const v4 = byId.get(marker.v4ExecutionId)
    const v8 = byId.get(marker.v8ExecutionId)
    const current = byId.get(record.id)
    const workflow = workflowQuery.rows[0]
    if (rowsQuery.rowCount !== 5
      || timing?.result_md5 !== marker.sourceResultMd5
      || v7?.result_md5 !== marker.v7ResultMd5
      || v4?.result_md5 !== marker.v4ResultMd5
      || v8?.result_md5 !== marker.v8ResultMd5
      || current?.result_md5 !== record.resultMd5
      || rowsQuery.rows.some(row => row.workflow_id !== workflowId)
      || workflow?.schema_version !== 180
      || workflow.nodes_md5 !== marker.workflowNodesMd5
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || signed.receiptSha256 !== marker.sourceReceiptSha256
      || imageLedgerQuery.rowCount !== 0
      || reviewLedgerQuery.rowCount !== (forApproval ? 1 : 0))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local sources, graph or ledger changed')
    const state = decodeExecutionState(current.result)
    if (forApproval) {
      assertA8B6LocalFrameHop(decodeExecutionState(timing.result), state,
        timing.result_md5, signed, 'review-complete')
      const runs = state.nodeRuns
      const reviewLedger = reviewLedgerQuery.rows[0]
      if (reviewLedger?.status !== 'succeeded'
        || !String(reviewLedger.request_data?.requestKey ?? '')
          .startsWith(`${record.id}:`)
        || assertSceneCutReviewLedgerRecord(reviewLedger,
          runs[49].output, { evidence: runs[48].output,
            shot: runs[11].output, sources: runs[41].output,
            reviewImages: runs[48].output.reviewImages,
            openingStatePlan: runs[43].output,
            sceneCutLocalComposite: marker },
          process.cwd(), 180) !== reviewLedger.id)
        throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local review lacks real model ledger')
    } else {
      const prepared = prepareA8B6LocalFrameFork(timing, v7, v4, v8,
        workflow, signed)
      if (createJsonHasher()(state) !== createJsonHasher()(prepared.state))
        throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local child differs from signed fork')
      assertA8B6LocalFrameHop(decodeExecutionState(timing.result), state,
        timing.result_md5, signed, 'pending')
    }
    const [casQuery, graphAfter, imageAfter, reviewAfter] = await Promise.all([
      pool.query(`SELECT id,md5(result::text) AS result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids]),
      pool.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT id FROM model_execution_records WHERE workflow_id=$1
        AND node_id='sanguo-scene-cut-first-frame'
        AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT id,status,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
    ])
    const cas = new Map(casQuery.rows.map(row => [row.id, row.result_md5]))
    if (casQuery.rowCount !== 5
      || ids.some(id => cas.get(id) !== byId.get(id).result_md5)
      || graphAfter.rows[0]?.schema_version !== 180
      || graphAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || graphAfter.rows[0]?.edges_md5 !== workflow.edges_md5
      || imageAfter.rowCount !== 0
      || reviewAfter.rowCount !== reviewLedgerQuery.rowCount
      || forApproval && (reviewAfter.rows[0]?.id !== reviewLedgerQuery.rows[0].id
        || reviewAfter.rows[0]?.status !== 'succeeded'
        || reviewAfter.rows[0]?.request_md5
          !== reviewLedgerQuery.rows[0].request_md5
        || reviewAfter.rows[0]?.response_md5
          !== reviewLedgerQuery.rows[0].response_md5))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: local child changed before click')
    return target
  }
  if (record.id === 'record-4x5m31-a8b6-fresh-first-frame-v8-edit') {
    const marker = record.sceneCutA8B6FreshFrameRecovery
    const afterImage = continueIdleNode === 'sanguo-map-end-accept'
    const forApproval = continueIdleNode === 'sanguo-scene-cut-approval'
    const postImage = afterImage || forApproval
    const [timingQuery, rejectedQuery, currentQuery, workflowQuery,
      imageLedgerQuery, reviewLedgerQuery, signed] = await Promise.all([
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=$1`, [marker.sourceExecutionId]),
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=$1`, [marker.priorFreshExecutionId]),
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=$1`, [record.id]),
      pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT *,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-first-frame'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT *,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      verifyA8B6FreshV8EditReceipt(),
    ])
    const timing = timingQuery.rows[0], rejected = rejectedQuery.rows[0]
    const current = currentQuery.rows[0], workflow = workflowQuery.rows[0]
    if (timing?.result_md5 !== marker.sourceResultMd5
      || rejected?.result_md5 !== A8B6_V7_REJECTED_MD5
      || current?.result_md5 !== record.resultMd5
      || timing.workflow_id !== workflowId
      || rejected.workflow_id !== workflowId
      || current.workflow_id !== workflowId
      || workflow?.schema_version !== 180
      || workflow.nodes_md5 !== marker.workflowNodesMd5
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || signed.receiptSha256 !== marker.editReceiptSha256
      || imageLedgerQuery.rowCount !== (postImage ? 1 : 0)
      || reviewLedgerQuery.rowCount !== (forApproval ? 1 : 0))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: V8 source, graph or image intent changed')
    const currentState = decodeExecutionState(current.result)
    if (postImage) {
      assertA8B6FreshV8EditHop(decodeExecutionState(timing.result),
        currentState, timing.result_md5, signed,
        decodeExecutionState(rejected.result), forApproval
          ? 'review-complete' : 'image-complete')
      const output = currentState.nodeRuns[45].output
      const url = output?.url
      if (typeof url !== 'string'
        || !/^\/generated\/[\w.-]+\.png$/.test(url))
        throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: V8 image URL invalid')
      const imageSha = createHash('sha256').update(fsSync.readFileSync(
        path.join(process.cwd(), 'public', url.slice(1)))).digest('hex')
      const refs = signed.referenceImages
      const refProof = refs.map((value, index) => {
        const bytes = Buffer.from(value.slice('data:image/jpeg;base64,'.length),
          'base64')
        return { index: index + 1, bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') }
      })
      const ledger = imageLedgerQuery.rows[0]
      if (imageSha === signed.receipt.referenceOrder[2].sourceSha256
        || ledger.status !== 'succeeded'
        || ledger.model_id !== 'codex-gpt-image-2'
        || ledger.provider !== 'Codex' || ledger.capability !== 'image'
        || ledger.request_data?.sceneCutFreshEditReceiptSha256
          !== signed.receiptSha256
        || !isDeepStrictEqual(ledger.request_data?.params
          ?.sceneCutFreshEditReceipt, signed.receipt)
        || !isDeepStrictEqual(ledger.request_data?.params
          ?.sceneCutFreshImage, currentState.sceneCutA8B6FreshFrameRecovery)
        || !isDeepStrictEqual(ledger.request_data?.params?.referenceImages,
          refs.map(value => `[素材内容已隐藏，${value.length} 字符]`))
        || !isDeepStrictEqual(ledger.response_data?.raw?.references, refProof)
        || ledger.response_data?.raw?.image?.sha256 !== imageSha
        || ledger.response_data?.data?.[0]?.url !== url)
        throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: V8 paid image is not source-bound')
      if (forApproval) {
        const runs = currentState.nodeRuns
        const reviewLedger = reviewLedgerQuery.rows[0]
        if (runs[47]?.status !== 'success'
          || runs[48]?.status !== 'success'
          || runs[49]?.status !== 'success'
          || runs[50]?.status !== 'idle'
          || reviewLedger?.status !== 'succeeded'
          || !String(reviewLedger.request_data?.requestKey ?? '')
            .startsWith(`${record.id}:`)
          || assertSceneCutReviewLedgerRecord(reviewLedger,
            runs[49].output, { evidence: runs[48].output,
              shot: runs[11].output, sources: runs[41].output,
              reviewImages: runs[48].output.reviewImages,
              openingStatePlan: runs[43].output,
              sceneCutFreshImage:
                currentState.sceneCutA8B6FreshFrameRecovery },
            process.cwd(), 180) !== reviewLedger.id)
          throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: V8 accepted review lacks real ledger')
      }
    } else {
      const prepared = prepareA8B6FreshV8EditFork(timing, rejected,
        workflow, signed)
      if (createJsonHasher()(currentState)
        !== createJsonHasher()(prepared.state))
        throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: V8 child differs from signed fork')
    }
    const [timingAfter, rejectedAfter, currentAfter, graphAfter,
      imageLedgerAfter, reviewLedgerAfter] = await Promise.all([
      pool.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
        [timing.id]),
      pool.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
        [rejected.id]),
      pool.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
        [record.id]),
      pool.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
      pool.query(`SELECT id,status,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-first-frame'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
      pool.query(`SELECT id,status,md5(request_data::text) AS request_md5,
        md5(response_data::text) AS response_md5 FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $2`,
      [workflowId, `${record.id}:%`]),
    ])
    if (timingAfter.rows[0]?.md5 !== timing.result_md5
      || rejectedAfter.rows[0]?.md5 !== rejected.result_md5
      || currentAfter.rows[0]?.md5 !== current.result_md5
      || graphAfter.rows[0]?.schema_version !== 180
      || graphAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || graphAfter.rows[0]?.edges_md5 !== workflow.edges_md5
      || imageLedgerAfter.rowCount !== imageLedgerQuery.rowCount
      || postImage && (imageLedgerAfter.rows[0]?.id
          !== imageLedgerQuery.rows[0].id
        || imageLedgerAfter.rows[0]?.status !== 'succeeded'
        || imageLedgerAfter.rows[0]?.request_md5
          !== imageLedgerQuery.rows[0].request_md5
        || imageLedgerAfter.rows[0]?.response_md5
          !== imageLedgerQuery.rows[0].response_md5)
      || reviewLedgerAfter.rowCount !== reviewLedgerQuery.rowCount
      || forApproval && (reviewLedgerAfter.rows[0]?.id
          !== reviewLedgerQuery.rows[0].id
        || reviewLedgerAfter.rows[0]?.status !== 'succeeded'
        || reviewLedgerAfter.rows[0]?.request_md5
          !== reviewLedgerQuery.rows[0].request_md5
        || reviewLedgerAfter.rows[0]?.response_md5
          !== reviewLedgerQuery.rows[0].response_md5))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: V8 changed before click')
    return target
  }
  if (record.id === A8B6_V7_DUAL_OUTPUT_CHILD_ID) {
    const [parentQuery, currentQuery, workflowQuery, signed] =
      await Promise.all([
        pool.query(`SELECT *,md5(result::text) AS result_md5
          FROM execution_records WHERE id=$1`, [record.parentExecutionId]),
        pool.query(`SELECT *,md5(result::text) AS result_md5
          FROM execution_records WHERE id=$1`, [record.id]),
        pool.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
          md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
        [workflowId]),
        verifyA8B6V7DualOutputRecoveryReceiptAsync(),
      ])
    const parent = parentQuery.rows[0], current = currentQuery.rows[0]
    const workflow = workflowQuery.rows[0]
    if (parent?.result_md5 !== A8B6_V7_FAILED_MD5
      || current?.result_md5 !== record.resultMd5
      || parent.workflow_id !== workflowId || current.workflow_id !== workflowId
      || workflow?.schema_version !== 180
      || workflow.nodes_md5 !== '3ed9cf16e56b311458f4c6fa7e7f1e2e'
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || signed.receipt.failedImageModelExecutionId
        !== A8B6_V7_FAILED_IMAGE_LEDGER)
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: V7 failed parent or graph changed')
    const parentState = decodeExecutionState(parent.result)
    const childState = decodeExecutionState(current.result)
    assertA8B6V7DualOutputRecoveryHop(parentState, childState,
      parent.result_md5, signed, 'image-complete')
    if (childState.selectedNodeId !== 'sanguo-map-end-accept'
      || childState.nodeRuns?.[46]?.status !== 'idle'
      || childState.nodeRuns.slice(46).some(run => run.status !== 'idle'))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: V7 child advanced')
    const [parentAfter, childAfter, graphAfter] = await Promise.all([
      pool.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
        [parent.id]),
      pool.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
        [record.id]),
      pool.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
    ])
    if (parentAfter.rows[0]?.md5 !== parent.result_md5
      || childAfter.rows[0]?.md5 !== current.result_md5
      || graphAfter.rows[0]?.schema_version !== 180
      || graphAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || graphAfter.rows[0]?.edges_md5 !== workflow.edges_md5)
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: V7 child changed before click')
    return target
  }
  if (record.sceneCutFirstFrameRecovery?.version
    === 'a8b6-fresh-scene2-script-replay-v1') {
    const marker = record.sceneCutFirstFrameRecovery
    const [currentQuery, sourceQuery, originalQuery, workflowQuery] =
      await Promise.all([
        pool.query(`SELECT *,md5(result::text) AS result_md5
          FROM execution_records WHERE id=$1`, [record.id]),
        pool.query(`SELECT *,md5(result::text) AS result_md5
          FROM execution_records WHERE id=$1`, [marker.sourceExecutionId]),
        pool.query(`SELECT *,md5(result::text) AS result_md5
          FROM execution_records WHERE id='record-4x5m31'`),
        pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
          md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
        [workflowId]),
      ])
    const current = currentQuery.rows[0], source = sourceQuery.rows[0]
    const original = originalQuery.rows[0], workflow = workflowQuery.rows[0]
    const sourceState = decodeExecutionState(source?.result ?? {})
    const composite = sourceState.sceneCutCompositeRecovery
    if (current?.result_md5 !== record.resultMd5
      || source?.result_md5 !== marker.sourceResultMd5
      || original?.result_md5 !== '74e5e2f8afcf8f829694aef350629950'
      || workflow?.schema_version !== 180
      || workflow.nodes_md5 !== marker.workflowNodesMd5
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || composite?.version
        !== 'source-bound-composite-a8b6-fresh-first-shot-v1')
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: fresh scene-02 source changed')
    const [routerQuery, approvalQuery] = await Promise.all([
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=$1`, [composite.sourceExecutionId]),
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=$1`, [composite.imageApprovalExecutionId]),
    ])
    const router = routerQuery.rows[0], imageApproval = approvalQuery.rows[0]
    if (!router || !imageApproval)
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: fresh scene-02 ancestors missing')
    const preflight = prepareScene2RegenerationPreflight(original, source,
      router, process.cwd(), imageApproval)
    if (preflight.status !== 'ready-for-new-image-review-only')
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: fresh first shot incomplete')
    const reconstructed = prepareFreshA8B6Scene2Replay(source,
      original, workflow, preflight, { id: record.id })
    const currentState = decodeExecutionState(current.result)
    if (createJsonHasher()(currentState)
      !== createJsonHasher()(reconstructed.state)
      || JSON.stringify(currentState.sceneCutFirstFrameRecovery)
        !== JSON.stringify(currentState.secondShotReplayRecovery))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: scene-02 replay differs from exact fork')
    const [sourceAfter, currentAfter, graphAfter] = await Promise.all([
      pool.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
        [source.id]),
      pool.query('SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
        [record.id]),
      pool.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
      [workflowId]),
    ])
    if (sourceAfter.rows[0]?.md5 !== source.result_md5
      || currentAfter.rows[0]?.md5 !== record.resultMd5
      || graphAfter.rows[0]?.schema_version !== 180
      || graphAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || graphAfter.rows[0]?.edges_md5 !== workflow.edges_md5)
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: scene-02 changed before click')
    return target
  }
  if (record.sceneCutA8B6FreshFrameRecovery?.version
    === 'scene-cut-a8b6-fresh-first-frame-v4-edit') {
    const marker = record.sceneCutA8B6FreshFrameRecovery
    const ids = [A8B6_FRESH_PREFLIGHT_SOURCE_IDS.SOURCE_ID,
      A8B6_FRESH_PREFLIGHT_SOURCE_IDS.TIMING_ID,
      A8B6_FRESH_PREFLIGHT_SOURCE_IDS.REJECTED_ID,
      A8B6_FRESH_PREFLIGHT_SOURCE_IDS.RETRY_ID,
      marker.priorFreshExecutionId, record.id]
    const [rowsQuery, workflowQuery, ledgerQuery, conflict, signedEdit] =
      await Promise.all([
        pool.query(`SELECT *,md5(result::text) AS result_md5
          FROM execution_records WHERE id=ANY($1)`, [ids]),
        pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
          md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
        [workflowId]),
        pool.query(`SELECT * FROM model_execution_records
          WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
            AND status='succeeded' AND request_data->>'requestKey' LIKE $2
          ORDER BY created_at DESC LIMIT 20`, [workflowId,
          `${A8B6_FRESH_PREFLIGHT_SOURCE_IDS.RETRY_ID}:%`]),
        verifyA8B6FrameConflictReceipt(marker.qaPlanId),
        verifyA8B6FreshEditReceipt(),
      ])
    const rows = new Map(rowsQuery.rows.map(row => [row.id, row]))
    const workflow = workflowQuery.rows[0]
    const current = rows.get(record.id)
    const source = rows.get(marker.sourceExecutionId)
    if (rows.size !== ids.length || !current || !source || !workflow
      || current.result_md5 !== record.resultMd5
      || source.result_md5 !== marker.sourceResultMd5
      || workflow.schema_version !== 180
      || workflow.nodes_md5 !== marker.workflowNodesMd5
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || signedEdit.receiptSha256 !== marker.editReceiptSha256)
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: A8B6 v4 edit source changed')
    const qa = readA8B6HistoricQaManifest()
    const preflight = prepareA8B6FreshRegenerationPreflight({
      sourceRow: rows.get(A8B6_FRESH_PREFLIGHT_SOURCE_IDS.SOURCE_ID),
      timingRow: source,
      rejectedRow: rows.get(A8B6_FRESH_PREFLIGHT_SOURCE_IDS.REJECTED_ID),
      retryRow: rows.get(A8B6_FRESH_PREFLIGHT_SOURCE_IDS.RETRY_ID),
      workflowRow: workflow, qa, conflict, ledgerRows: ledgerQuery.rows,
    })
    const prepared = prepareA8B6FreshEditFork(source, workflow,
      preflight, conflict, signedEdit, rows.get(marker.priorFreshExecutionId))
    if (createJsonHasher()(decodeExecutionState(current.result))
      !== createJsonHasher()(prepared.state))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: A8B6 v4 edit fork differs from strict replay')
    return target
  }
  if (record.sceneCutA8B6FreshFrameRecovery?.version
    === 'scene-cut-a8b6-fresh-first-frame-v3') {
    const marker = record.sceneCutA8B6FreshFrameRecovery
    const ids = [A8B6_FRESH_PREFLIGHT_SOURCE_IDS.SOURCE_ID,
      A8B6_FRESH_PREFLIGHT_SOURCE_IDS.TIMING_ID,
      A8B6_FRESH_PREFLIGHT_SOURCE_IDS.REJECTED_ID,
      A8B6_FRESH_PREFLIGHT_SOURCE_IDS.RETRY_ID,
      A8B6_FRESH_V2_FRAME_ID, record.id]
    const [rowsQuery, workflowQuery, ledgerQuery, priorLedgerQuery,
      conflict] = await Promise.all([
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids]),
      pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`, [workflowId]),
      pool.query(`SELECT * FROM model_execution_records
        WHERE workflow_id=$1 AND node_id='sanguo-scene-cut-review'
          AND status='succeeded' AND request_data->>'requestKey' LIKE $2
        ORDER BY created_at DESC LIMIT 20`, [workflowId,
        `${A8B6_FRESH_PREFLIGHT_SOURCE_IDS.RETRY_ID}:%`]),
      pool.query(`SELECT * FROM model_execution_records WHERE id=ANY($1)`,
        [[A8B6_FRESH_V2_IMAGE_LEDGER, A8B6_FRESH_V2_REVIEW_LEDGER]]),
      verifyA8B6FrameConflictReceipt(marker.qaPlanId),
    ])
    const rows = new Map(rowsQuery.rows.map(row => [row.id, row]))
    const workflow = workflowQuery.rows[0]
    const current = rows.get(record.id), source = rows.get(marker.sourceExecutionId)
    if (rows.size !== 6 || !current || !source || !workflow
      || current.result_md5 !== record.resultMd5
      || source.result_md5 !== marker.sourceResultMd5
      || workflow.schema_version !== 180
      || workflow.nodes_md5 !== marker.workflowNodesMd5
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || conflict.receiptSha256 !== marker.adjudicationReceiptSha256)
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: A8B6 fresh source changed')
    const qa = readA8B6HistoricQaManifest()
    const priorById = new Map(priorLedgerQuery.rows.map(row => [row.id, row]))
    const verifiedPrior = await verifyA8B6FreshV2Rejection(
      rows.get(A8B6_FRESH_V2_FRAME_ID),
      priorById.get(A8B6_FRESH_V2_IMAGE_LEDGER),
      priorById.get(A8B6_FRESH_V2_REVIEW_LEDGER))
    const preflight = prepareA8B6FreshRegenerationPreflight({
      sourceRow: rows.get(A8B6_FRESH_PREFLIGHT_SOURCE_IDS.SOURCE_ID),
      timingRow: source,
      rejectedRow: rows.get(A8B6_FRESH_PREFLIGHT_SOURCE_IDS.REJECTED_ID),
      retryRow: rows.get(A8B6_FRESH_PREFLIGHT_SOURCE_IDS.RETRY_ID),
      workflowRow: workflow, qa, conflict, ledgerRows: ledgerQuery.rows,
    })
    const prepared = prepareA8B6FreshFirstFrameFork(source, workflow,
      preflight, conflict, verifiedPrior)
    if (createJsonHasher()(decodeExecutionState(current.result))
      !== createJsonHasher()(prepared.state))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: A8B6 fresh fork differs from strict replay')
    return target
  }
  if (record.sceneCutA8B6ConflictReviewRecovery?.version
    === 'scene-cut-a8b6-conflict-review-retry-v1') {
    const marker = record.sceneCutA8B6ConflictReviewRecovery
    const [sourceQuery, currentQuery, workflowQuery, signed] = await Promise.all([
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=$1`, [marker.sourceExecutionId]),
      pool.query(`SELECT *,md5(result::text) AS result_md5
        FROM execution_records WHERE id=$1`, [record.id]),
      pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`, [workflowId]),
      verifyA8B6FrameConflictReceipt(marker.qaPlanId),
    ])
    const source = sourceQuery.rows[0], current = currentQuery.rows[0]
    const workflow = workflowQuery.rows[0]
    if (!source || !current || !workflow
      || source.result_md5 !== marker.sourceResultMd5
      || current.result_md5 !== record.resultMd5
      || workflow.schema_version !== 180
      || workflow.nodes_md5 !== marker.workflowNodesMd5
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || signed.receiptSha256 !== marker.adjudicationReceiptSha256)
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: A8B6 review source changed')
    const prepared = prepareA8B6FrameConflictReviewFork(source, workflow, signed)
    if (createJsonHasher()(decodeExecutionState(current.result))
      !== createJsonHasher()(prepared.state))
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: A8B6 retry differs from strict replay')
    return target
  }
  if (record.sceneCutApprovalRebindRecovery?.version === 'scene-cut-approval-rebind-v2') {
    const current = (await pool.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=$1`, [record.id])).rows[0]
    const marker = decodeExecutionState(current?.result ?? {}).sceneCutApprovalRebindRecovery
    const ids = ['record-4x5m31', marker?.sourceExecutionId,
      marker?.nativeSourceExecutionId, marker?.nativeReviewExecutionId]
    const { rows: ancestors } = await pool.query(`SELECT *,md5(result::text) AS result_md5
      FROM execution_records WHERE id=ANY($1::text[])`, [ids])
    const byId = new Map(ancestors.map(row => [row.id, row]))
    const workflow = (await pool.query(`SELECT *,md5(nodes::text) AS nodes_md5,
      md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`,
    [workflowId])).rows[0]
    const modelIds = [marker?.failedVideoReviewExecutionId,
      marker?.nativeVideoReviewExecutionId]
    const { rows: ledgers } = await pool.query(`SELECT * FROM model_execution_records
      WHERE id=ANY($1::text[])`, [modelIds])
    const ledgerById = new Map(ledgers.map(row => [row.id, row]))
    if (current?.result_md5 !== record.resultMd5 || current.workflow_id !== workflowId
      || !workflow || workflow.schema_version !== 180
      || workflow.nodes_md5 !== record.sceneCutApprovalRebindRecovery.workflowNodesMd5
      || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
      || ids.some(id => !byId.has(id)) || modelIds.some(id => !ledgerById.has(id))) {
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: native-tail rebind source or graph changed')
    }
    const prepared = prepareSceneCutTailGuideRebind({
      original: byId.get('record-4x5m31'), source: byId.get(marker.sourceExecutionId),
      native: byId.get(marker.nativeSourceExecutionId),
      reviewed: byId.get(marker.nativeReviewExecutionId), workflow,
      sourceReviewLedger: ledgerById.get(marker.failedVideoReviewExecutionId),
      nativeReviewLedger: ledgerById.get(marker.nativeVideoReviewExecutionId),
      id: record.id,
    })
    const hash = createJsonHasher()
    if (hash(decodeExecutionState(current.result)) !== hash(prepared.state)) {
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: native-tail rebind checkpoint differs from strict replay')
    }
    const [sourceAfter, currentAfter, graphAfter] = await Promise.all([
      pool.query(`SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1`,
        [marker.sourceExecutionId]),
      pool.query(`SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1`, [record.id]),
      pool.query(`SELECT schema_version,md5(nodes::text) AS nodes_md5,
        md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1`, [workflowId]),
    ])
    if (sourceAfter.rows[0]?.md5 !== marker.sourceResultMd5
      || currentAfter.rows[0]?.md5 !== record.resultMd5
      || graphAfter.rows[0]?.schema_version !== 180
      || graphAfter.rows[0]?.nodes_md5 !== workflow.nodes_md5
      || graphAfter.rows[0]?.edges_md5 !== workflow.edges_md5) {
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: native-tail rebind changed before click')
    }
    return target
  }
  const repairSchema = [177, 178].includes(record.sceneCutFirstFrameRecovery.workflowSchemaVersion)
  const [{ rows: [source] }, { rows: [workflow] }, currentQuery] = await Promise.all([
    pool.query(repairSchema
      ? 'SELECT id,result,md5(result::text) AS md5 FROM execution_records WHERE id=$1'
      : 'SELECT md5(result::text) AS md5 FROM execution_records WHERE id=$1',
    [record.sceneCutFirstFrameRecovery.sourceExecutionId]),
    pool.query('SELECT schema_version, md5(nodes::text) AS md5, md5(edges::text) AS edges_md5 FROM workflow_configs WHERE id=$1', [workflowId]),
    repairSchema ? pool.query('SELECT id,workflow_id,result,md5(result::text) AS md5 FROM execution_records WHERE id=$1', [record.id]) : null,
  ])
  if (source?.md5 !== record.sceneCutFirstFrameRecovery.sourceResultMd5
    || workflow?.schema_version !== record.sceneCutFirstFrameRecovery.workflowSchemaVersion
    || workflow.md5 !== record.sceneCutFirstFrameRecovery.workflowNodesMd5
    || workflow.edges_md5 !== expectedWorkflowEdgesMd5.toLowerCase()
    || (record.sceneCutFirstFrameRecovery.workflowEdgesMd5
      && workflow.edges_md5 !== record.sceneCutFirstFrameRecovery.workflowEdgesMd5)) {
    throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: source record or workflow differs from the reviewed fork')
  }
  if (repairSchema) {
    const current = currentQuery?.rows?.[0]
    if (current?.id !== record.id || current.workflow_id !== workflowId
      || current.md5 !== record.resultMd5 || source.id !== record.sceneCutFirstFrameRecovery.sourceExecutionId) {
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: image repair checkpoint changed after projection')
    }
    const verifyFull = record.sceneCutFirstFrameRecovery.workflowSchemaVersion === 177
      ? verifiedSchema177IdleRecord : verifiedSchema178IdleRecord
    const { marker } = verifyFull(decodeExecutionState(current.result), record,
      decodeExecutionState(source.result))
    const identities = [[marker.sourceExecutionId, marker.sourceResultMd5],
      [marker.parentExecutionId, marker.parentResultMd5],
      [marker.originalExecutionId, marker.originalResultMd5]]
    const { rows: ancestors } = await pool.query(`SELECT id,md5(result::text) AS md5
      FROM execution_records WHERE id = ANY($1::text[])`, [identities.map(([id]) => id)])
    if (identities.some(([id, expected]) => ancestors.find(row => row.id === id)?.md5 !== expected)) {
      throw new Error('IDLE_CHECKPOINT_SOURCE_CHANGED: image repair ancestry changed')
    }
  }
  return target
}

/** "从此节点重试" does not revise a step-mode record in place: the app forks a fresh execution
 * record that replays the finished prefix and re-runs only the failed node. A driver pinned to the
 * old id therefore reports a failure that was already cleared, forever, and pressing retry again
 * buys the same paid generation a second time. Following the fork keeps both the observation and
 * the money honest. */
async function followFork(pinned, targetedIndex) {
  const { rows } = await pool.query(
    `select id from execution_records where workflow_id = $1 and created_at > $2
     and coalesce(result->>'requestScopeId', result->>'id', id) = $3
     order by created_at desc limit 20`, [pinned.workflowId, pinned.createdAt, pinned.requestScopeId])
  const candidates = (await Promise.all(rows.filter(row => row.id !== pinned.id)
    .map(row => loadRecord(row.id)))).filter(Boolean)
  // The app may already have created the bounded image retry before an
  // operator also clicked the failed approval. Follow that original automatic
  // recovery, never the later duplicate failed-node retry.
  if (targetedIndex === undefined && pinned.runs.some(run => run.status === 'failed'
    && run.id === 'sanguo-scene-cut-approval')) candidates.sort((a, b) =>
      Number(Boolean(b.sceneCutAutoRetry && b.parentExecutionId === pinned.id))
      - Number(Boolean(a.sceneCutAutoRetry && a.parentExecutionId === pinned.id)))
  for (const candidate of candidates) {
    if (!candidate) continue
    if (targetedIndex === undefined ? isRetryFork(pinned, candidate) : isTargetedRetryFork(pinned, candidate, targetedIndex)) {
      if (targetedIndex !== undefined) {
        const lost = completedProviderRegression({ runs: pinned.runs.slice(0, targetedIndex) }, candidate)
        if (lost.length) throw new Error(`PAID_PREFIX_REGRESSION: targeted retry ${candidate.id} would replay ${lost.length} completed provider run(s), first ${lost[0].nodeId} ${lost[0].key}`)
      }
      return candidate
    }
  }
  return undefined
}

async function newestRecord(after) {
  const { rows } = await pool.query(
    `select id from execution_records where workflow_id = $1 and created_at > $2
     order by created_at desc limit 3`, [workflowId, after.toISOString()])
  for (const row of rows) {
    const record = await loadRecord(row.id)
    if (record && record.runs.some(run => run.status !== 'idle')) return record
  }
  return rows.length ? loadRecord(rows[0].id) : undefined
}

const summarize = (record) => record.runs
  .filter(run => run.status !== 'idle')
  .map(run => `${run.index}:${run.id}=${run.status}#${run.revision}/${run.attempt}${run.error ? `(${run.error.slice(0, 160)})` : ''}`).join(' ')

// ---------------------------------------------------------------- chrome + devtools

async function cdpAlive() {
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch { return false }
}

async function launchChrome() {
  await fs.mkdir(profileDir, { recursive: true })
  await fs.mkdir(logDir, { recursive: true })
  const chromeLog = await fs.open(path.join(stateDir, 'chrome.log'), 'a')
  const child = spawn(chromeBinary, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-features=Translate',
    ...(flag('headed') ? [] : ['--headless=new']), '--window-size=1680,1200',
    // The step engine is timer driven; a throttled background tab would stall the click loop.
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    appUrl,
  ], { detached: true, stdio: ['ignore', chromeLog.fd, chromeLog.fd] })
  child.unref()
  await chromeLog.close().catch(() => undefined)
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await cdpAlive()) return child.pid
    await sleep(500)
  }
  throw new Error(`Chrome did not open DevTools port ${cdpPort}; see ${path.join(stateDir, 'chrome.log')}`)
}

class Session {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
  }

  async open() {
    this.socket = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true })
      this.socket.addEventListener('error', event => reject(new Error(event.message ?? 'cdp socket error')), { once: true })
    })
    this.socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      const waiter = message.id ? this.pending.get(message.id) : undefined
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(`${message.error.message} ${JSON.stringify(message.error.data ?? '')}`))
      else waiter.resolve(message.result)
    })
    // A closed devtools socket used to leave every in-flight send() pending. With no timer left the
    // process then exited quietly with code 0, so a broken run looked like a finished one. Rejecting
    // the waiters turns that into a visible ERROR instead.
    const drop = (reason) => {
      const waiters = [...this.pending.values()]
      this.pending.clear()
      waiters.forEach(waiter => waiter.reject(new Error(`CDP_SOCKET_CLOSED: ${reason}`)))
    }
    this.socket.addEventListener('close', event => drop(`code ${event.code ?? 'unknown'}`))
    this.socket.addEventListener('error', event => drop(event.message ?? 'socket error'))
    await this.send('Page.enable')
    await this.send('Runtime.enable')
  }

  close() { try { this.socket?.close() } catch { /* already gone */ } }

  get alive() { return Boolean(this.socket) && this.socket.readyState <= WebSocket.OPEN }

  /** Re-attach to the same tab. A dropped devtools socket does not stop the page: the step engine
   * keeps running and paid generations keep being spent. Losing the observation channel used to
   * abort the driver and throw away a run that was still alive, which forced a full restart. */
  async reopen() {
    const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
    const target = list.find(item => item.type === 'page' && item.url.startsWith(new URL(appUrl).origin))
    if (!target) throw new Error('CDP_TARGET_GONE: the app tab is no longer open')
    this.url = target.webSocketDebuggerUrl
    this.pending = new Map()
    this.nextId = 1
    await this.open()
  }

  static transportLoss(message) {
    return /CDP_SOCKET_CLOSED|CDP_TARGET_GONE|socket error|socket hang up|Target closed|Session with given id|WebSocket|Disconnected|inspected target navigated/i.test(message)
  }

  async guarded(label, run, attempts = 10) {
    for (let index = 0;; index += 1) {
      try {
        if (!this.alive) await this.reopen()
        return await run()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (index >= attempts || !Session.transportLoss(message)) throw error
        log(`cdp transport lost during ${label}: ${message.slice(0, 120)}; re-attaching (${index + 1}/${attempts})`)
        this.close()
        await sleep(2000)
        try { await this.reopen() } catch (reopenError) { log(`reattach failed: ${reopenError instanceof Error ? reopenError.message : reopenError}`) }
      }
    }
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState > WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP_SOCKET_CLOSED: cannot send ${method}`))
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
    }
    return result.result.value
  }

  async call(fn, ...callArgs) {
    return this.guarded('Runtime.evaluate', () => this.evaluate(
      `(${fn.toString()})(${callArgs.map(item => JSON.stringify(item)).join(',')})`))
  }
}

async function openPage() {
  const existing = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
  let target = existing.find(item => item.type === 'page' && item.url.startsWith(new URL(appUrl).origin))
  if (!target) {
    target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(appUrl)}`, { method: 'PUT' })).json()
  }
  const session = new Session(target.webSocketDebuggerUrl)
  await session.open()
  // A page kept alive from an earlier run still holds the bundle that was loaded then, so a
  // fresh self-test reloads before pressing anything. A resumed run preserves its live page so an
  // in-flight purchase survives; --reload-page explicitly loads changes and --keep-page preserves it.
  if (!flag('keep-page') && (!resumeFrom || flag('reload-page') || flag('probe'))) {
    const waitReady = async (label) => {
      const deadline = Date.now() + 60_000
      for (;;) {
        const state = await session.guarded('page readiness', () => session
          .evaluate('({ready:document.readyState,cards:document.querySelectorAll(".workflow-card").length,root:!!document.querySelector("#root")?.childElementCount})'))
        if (state && state.ready === 'complete' && state.root) return
        if (Date.now() > deadline) { log(`${label} timed out: ${JSON.stringify(state)}`); return }
        await sleep(1000)
      }
    }
    await session.guarded('Page.navigate', () => session.send('Page.navigate', { url: appUrl }))
    await waitReady('page load')
    // A plain navigation still lets Chrome answer ES-module requests from its disk cache, so the run
    // can measure a bundle that no longer matches the sources under test. ignoreCache forces a real
    // revalidation, and it has to come from the Page domain: enabling Network on this Chrome build
    // closes the page websocket the moment the document navigates.
    await session.guarded('Page.reload', () => session.send('Page.reload', { ignoreCache: true }))
    await waitReady('cache-bypassing reload')
    await sleep(1500)
  } else if (!target.url.startsWith(appUrl)) {
    await session.guarded('Page.navigate', () => session.send('Page.navigate', { url: appUrl }))
    await sleep(4000)
  }
  return session
}

// ---------------------------------------------------------------- page interactions

const clickCardAction = (match) => {
  const cards = [...document.querySelectorAll('.workflow-card, .studio-project')]
  if (!cards.length) return { ok: false, reason: 'workflow cards not rendered yet', cards: 0 }
  const card = cards.find(item => item.querySelector('.studio-project-cover')
    ?.getAttribute('aria-label') === `查看详情 ${match}`)
    ?? cards.find(item => item.textContent.includes(match))
  if (!card) return { ok: false, reason: `no card contains ${match}`, cards: cards.map(item => item.textContent.slice(0, 40)) }
  const button = [...card.querySelectorAll('button')].find(item => item.textContent.trim().startsWith('执行'))
  if (!button) return { ok: false, reason: 'card has no 执行 button' }
  if (button.disabled) return { ok: false, reason: '执行 disabled' }
  button.click()
  return { ok: true, title: card.textContent.trim().slice(0, 60) }
}

const pressButton = (label, expectedExecutionId) => {
  if (expectedExecutionId) {
    let activeId
    try { activeId = JSON.parse(sessionStorage.getItem('vedio-aigc:app-view-state:v1'))?.executionId } catch { /* wait for a valid execution view */ }
    if (activeId !== expectedExecutionId) return { clicked: false, reason: `execution view changed: ${activeId ?? 'none'}` }
  }
  const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim().startsWith(label))
  if (!button) return { found: false }
  const disabled = button.disabled
  if (!disabled) button.click()
  return { found: true, disabled, clicked: !disabled }
}

/** Set the native value and dispatch input so React's controlled input calls
 * its actual onChange handler. React's per-element setter tracks direct value
 * assignments, so assigning field.value alone can leave workflow state stale. */
const writeRuntimeInput = async (resultVar, key, value) => {
  const labels = [...document.querySelectorAll('.runner-params-panel label[data-runtime-result-var]')]
    .filter(label => label.dataset.runtimeResultVar === resultVar && label.dataset.runtimeParamKey === key)
  if (labels.length !== 1) return { ok: false, reason: `runtime field ${resultVar}.${key} matched ${labels.length} controls` }
  const label = labels[0]
  const field = label.querySelector('input,textarea')
  if (!field || field.disabled) return { ok: false, reason: `runtime field ${resultVar}.${key} is not editable` }
  const type = label.dataset.runtimeParamType
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    return { ok: false, reason: `runtime field ${resultVar}.${key} requires a JSON number` }
  }
  if (type === 'boolean' && typeof value !== 'boolean') return { ok: false, reason: `runtime field ${resultVar}.${key} requires a JSON boolean` }
  if (!['number', 'boolean', 'json'].includes(type) && typeof value !== 'string') return { ok: false, reason: `runtime field ${resultVar}.${key} requires a JSON string` }
  const serialized = type === 'json' ? JSON.stringify(value) : String(value)
  const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, serialized)
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise(resolve => requestAnimationFrame(resolve))
  const fresh = [...document.querySelectorAll('.runner-params-panel label[data-runtime-result-var]')]
    .find(item => item.dataset.runtimeResultVar === resultVar && item.dataset.runtimeParamKey === key)?.querySelector('input,textarea')
  return { ok: fresh?.value === serialized, reason: `runtime field ${resultVar}.${key} did not retain its requested value` }
}

async function setRuntimeInputs(session, inputs) {
  await untilPage(session, 'runtime parameter controls', async () => {
    if (await session.evaluate('!!document.querySelector(".runner-params-panel")')) return { ok: true }
    const clicked = await session.call(pressButton, '运行参数')
    return { ok: false, reason: clicked.found ? 'opening runtime parameters' : 'runtime parameter toggle not found' }
  }, 30_000)
  for (const [resultVar, params] of Object.entries(inputs)) {
    for (const [key, value] of Object.entries(params)) {
      const written = await session.call(writeRuntimeInput, resultVar, key, value)
      if (!written.ok) throw new Error(`RUNTIME_INPUT_INVALID: ${written.reason}; execution was not started`)
    }
  }
  log(`filled runtime inputs through UI ${JSON.stringify(inputs)}`)
}

function verifyRuntimeInputs(record) {
  if (!runtimeInputs) return
  const mismatch = runtimeInputMismatch(record.runtimeInputs, runtimeInputs)
  if (mismatch) throw new Error(`RUNTIME_INPUT_MISMATCH: ${record.id} ${mismatch}; no downstream node submitted`)
}

/** Press the first enabled button among the given labels; used to leave a restored view. */
const pressAnyButton = (labels, expectedExecutionId, expectedRun) => {
  if (expectedExecutionId) {
    let activeId
    try { activeId = JSON.parse(sessionStorage.getItem('vedio-aigc:app-view-state:v1'))?.executionId } catch { /* wait for a valid execution view */ }
    if (activeId !== expectedExecutionId) return { clicked: false, reason: `execution view changed: ${activeId ?? 'none'}` }
  }
  if (expectedRun) {
    const inspector = document.querySelector('.runner-context-title')
    const status = inspector?.querySelector('p')?.textContent ?? ''
    const expectedStatus = expectedRun.status === 'failed' ? '失败' : expectedRun.status === 'success' ? '已完成' : ''
    const selectedNode = document.querySelector('.runner-dag-node.selected')
    if (!expectedStatus || inspector?.querySelector('h2')?.textContent !== expectedRun.title || !status.includes(expectedStatus)
      || (expectedRun.loopIndex !== undefined && !status.includes(`第 ${expectedRun.loopIndex + 1} 轮`))
      || (expectedRun.status === 'success' && selectedNode?.getAttribute('data-canvas-node-id') !== expectedRun.id)) {
      return { clicked: false, reason: 'the expected node, round, or status is not selected; refusing to retry another run' }
    }
  }
  const buttons = [...document.querySelectorAll('button')]
  for (const label of labels) {
    const button = buttons.find(item => item.textContent.trim().startsWith(label) && !item.disabled)
    if (button) { button.click(); return { clicked: true, label } }
  }
  return { clicked: false, labels }
}

/** Select a completed run only after its persisted identity has been checked. */
const selectRetryNode = (expectedExecutionId, nodeId) => {
  let activeId
  try { activeId = JSON.parse(sessionStorage.getItem('vedio-aigc:app-view-state:v1'))?.executionId } catch { /* wait for a valid execution view */ }
  if (activeId !== expectedExecutionId) return { clicked: false, reason: `execution view changed: ${activeId ?? 'none'}` }
  const nodes = [...document.querySelectorAll('.runner-dag-node')].filter(item => item.getAttribute('data-canvas-node-id') === nodeId)
  if (nodes.length !== 1) return { clicked: false, reason: `expected one DAG node for ${nodeId}, found ${nodes.length}` }
  nodes[0].click()
  return { clicked: true }
}

const readCursor = () => {
  if (!document.body) return { step: '', canNext: false, canStart: false, notice: '', executionId: undefined, loading: true }
  const text = document.body.innerText
  const step = text.match(/第\s*\d+\s*\/\s*\d+\s*步[^\n]*/)?.[0] ?? ''
  const next = [...document.querySelectorAll('button')].find(item => item.textContent.trim().startsWith('下一步'))
  const start = [...document.querySelectorAll('button')].find(item => item.textContent.trim().includes('开始单步调试'))
  const notice = text.match(/[^\n]*(缺少必填输入|未通过|失败|错误)[^\n]*/)?.[0] ?? ''
  let executionId
  try { executionId = JSON.parse(sessionStorage.getItem('vedio-aigc:app-view-state:v1'))?.executionId } catch { /* the page may still be restoring */ }
  return { step, canNext: Boolean(next && !next.disabled), canStart: Boolean(start && !start.disabled), notice: notice.slice(0, 200), executionId }
}

/** A reload can migrate the saved execution to a fresh same-scope record. Adopt
 * that visible recovery record, but never press buttons in an unrelated run. */
async function alignPageRecord(session, record) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const cursor = await session.call(readCursor)
    if (cursor.executionId === record.id) return record
    const visible = cursor.executionId ? await loadRecord(cursor.executionId) : undefined
    if (sameExecutionScope(record, visible) && new Date(visible.createdAt) >= new Date(record.createdAt)) {
      const lost = completedProviderRegression(record, visible)
      if (lost.length) throw new Error(`PAID_PREFIX_REGRESSION: migrated recovery ${visible.id} would replay ${lost.length} completed provider run(s), first ${lost[0].nodeId} ${lost[0].key}; no node submitted`)
      log(`following visible same-scope recovery ${record.id} -> ${visible.id}`)
      return visible
    }
    if (visible || attempt === 9) throw new Error(`UI_RECORD_MISMATCH: expected ${record.id}, page shows ${cursor.executionId ?? 'none'}; no node submitted`)
    await sleep(500)
  }
}

/** Open the exact persisted execution before retrying it. A prior driver run or
 * the user's last browser session may leave the automation profile on an
 * unrelated record; selecting by the validated database identity prevents a
 * safe resume from depending on whichever page happened to be open. */
async function openRecordView(session, record) {
  const cursor = await session.call(readCursor)
  if (cursor.executionId === record.id) return
  const view = { page: 'workflow', workflowView: 'run', activeWorkflowId: record.workflowId, runnerTab: 'execute', executionId: record.id }
  await session.evaluate(`sessionStorage.setItem('vedio-aigc:app-view-state:v1', ${JSON.stringify(JSON.stringify(view))})`)
  await session.guarded('open requested execution record', () => session.send('Page.reload', { ignoreCache: true }))
  await untilPage(session, `execution record ${record.id}`, async () => {
    const state = await session.call(readCursor)
    return { ...state, ok: state.executionId === record.id }
  }, 60_000)
}

async function untilPage(session, describe, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last.ok) return last
    await sleep(1500)
  }
  throw new Error(`${describe} timed out; last state ${JSON.stringify(last)}`)
}

// ---------------------------------------------------------------- main

async function main() {
  await fs.mkdir(logDir, { recursive: true })
  if (flag('check-idle-only')) {
    if (!continueIdleNode || watchRecord || restartServer)
      throw new Error('--check-idle-only requires one exact --continue-idle checkpoint')
    const record = await loadRecord(resumeFrom)
    if (!record) throw new Error(`resume record ${resumeFrom} not found`)
    const target = await verifyIdleCheckpoint(record)
    console.log(JSON.stringify({ mode: 'read-only-idle-checkpoint',
      recordId: record.id, resultMd5: record.resultMd5,
      nodeId: target.id, status: target.status,
      databaseWrites: 0, providerCalls: 0, uiClicks: 0 }, null, 2))
    return
  }
  log(`start app=${appUrl} until=${untilNode}${untilLoop === undefined ? '' : ` loop=${untilLoop}`} log=${logPath}`)

  if (restartServer) {
    // "The run exercised my change" needs proof: this service is launched with `hmr: false` and can
    // outlive dozens of edits, so the driver bounces it and waits for it to answer again. launchctl is
    // tried first, then the screen session the repo's own launcher uses.
    const repoRoot = path.resolve(import.meta.dirname, '..')
    const appPort = new URL(appUrl).port || '5173'
    try {
      execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${serverLabel}`], { stdio: 'ignore' })
      log(`kickstarted ${serverLabel}`)
    } catch {
      // Stop only the configured app port. A broad command-name match can
      // terminate unrelated development servers and interrupt live reviews.
      let portPids = []
      try {
        portPids = execFileSync('/usr/sbin/lsof', ['-nP', '-t', `-iTCP:${appPort}`, '-sTCP:LISTEN'],
          { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean)
      } catch { /* the port is already free */ }
      for (const value of portPids) {
        const pid = Number(value)
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid listener PID for port ${appPort}`)
        const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
        if (!/(?:^|\/)node\s+scripts\/dev-server\.mjs(?:\s|$)/.test(command)) {
          throw new Error(`port ${appPort} is held by an unexpected process; refusing to stop it`)
        }
        process.kill(pid, 'SIGTERM')
      }
      // strictPort means a half-dead predecessor still holding the target port would kill the new process.
      await sleep(2500)
      execFileSync('/usr/bin/screen', ['-dmS', screenSession, '/bin/zsh', '-lc',
        `cd '${repoRoot}' && APP_PORT='${appPort}' DATABASE_URL='${serviceDatabaseUrl}' exec node scripts/dev-server.mjs`], { stdio: 'ignore' })
      log(`restarted scripts/dev-server.mjs inside screen -S ${screenSession}`)
    }
    const upBy = Date.now() + 120_000
    for (;;) {
      const version = await fetch(`${appUrl.replace(/\/$/, '')}/api/runtime-version`).then(response => response.ok).catch(() => false)
      if (version) break
      if (Date.now() > upBy) throw new Error('the app service did not come back within 120s')
      await sleep(2000)
    }
    log('the app service answers again, so the page will load the current sources')
  }

  if (watchRecord) {
    let previous = ''
    let lastProgress = Date.now()
    let watchedId = watchRecord
    for (;;) {
      let record = await loadRecord(watchedId)
      if (!record) throw new Error(`record ${watchedId} not found`)
      const fork = await followFork(record)
      if (fork) {
        log(`following retry fork ${record.id} -> ${fork.id}`)
        watchedId = fork.id
        record = fork
        lastProgress = Date.now()
      }
      const summary = summarize(record)
      if (summary !== previous) { log(summary); previous = summary; lastProgress = Date.now() }
      const failed = record.runs.filter(run => run.status === 'failed')
      if (failed.length) {
        failed.forEach(run => log(`FAILED ${run.id}: ${run.error}`))
        process.exitCode = 1
        return
      }
      const manualHold = pendingManualDecision(record)
      if (manualHold) {
        log(`MANUAL DECISION REQUIRED ${record.id} step ${manualHold.index} ${manualHold.id}: saved accept gate is waiting for human review; refusing automatic 下一步`)
        process.exitCode = 5
        return
      }
      const target = outcomeFor(record)
      if (target.done) {
        log(`DONE ${record.id} step ${target.run.index} ${untilNode} duration=${Math.round((target.run.durationMs ?? 0) / 1000)}s${target.url ? ` url=${target.url}` : ' output=present'}`)
        return
      }
      if (target.settled) {
        log(`TARGET NOT ACCEPTED ${untilNode}: ${target.reason}`)
        process.exitCode = 4
        return
      }
      if (Date.now() - lastProgress > stepTimeoutMs) {
        log(`STALLED: no run status change for ${stepTimeoutMinutes} minutes; target ${target.reason}`)
        process.exitCode = 2
        return
      }
      await sleep(pollMs)
    }
  }

  if (!(await cdpAlive())) {
    log(`launching chrome on port ${cdpPort}`)
    await launchChrome()
  }
  const session = await openPage()
  try {
    if (flag('probe')) {
      log(`probe page title=${JSON.stringify(await session.evaluate('document.title'))} cards=${JSON.stringify(await session.evaluate('document.querySelectorAll(".workflow-card").length'))} cursor=${JSON.stringify(await session.call(readCursor))}`)
      if (flag('buttons')) log(`buttons=${JSON.stringify(await session.evaluate('[...document.querySelectorAll("button")].map(b=>b.textContent.trim().slice(0,20)).filter(Boolean)'))}`)
      return
    }
    let record
    let initialRetrySignature
    let followedExistingRetryFork = false
    let targetedRetrySourceId
    if (resumeFrom) {
      record = resumeFrom === 'latest'
        ? await newestRecord(new Date(Date.now() - 12 * 3600_000))
        : await loadRecord(resumeFrom)
      if (!record) throw new Error(`resume record ${resumeFrom} not found`)
      if (continueIdleNode) await verifyIdleCheckpoint(record)
      const fork = await followFork(record, retryIndex)
      if (fork) {
        // The retry already happened - possibly in a previous driver process that died - so the only
        // safe action is to adopt its record instead of pressing the button again.
        log(`record ${record.id} was already retried; following fork ${fork.id}`)
        record = fork
        followedExistingRetryFork = true
      }
      await openRecordView(session, record)
      record = await alignPageRecord(session, record)
      await untilPage(session, 'saved workflow runner', async () => session.call(() => ({
        ok: Boolean(document.querySelector('.runner-context-title')),
        reason: document.body?.innerText?.slice(0, 120) ?? 'page is blank',
      })), 120_000)
      if (continueIdleNode && record.id !== resumeFrom) throw new Error('IDLE_CHECKPOINT_VIEW_CHANGED: refusing to continue a different record')
      if (retryIndex !== undefined && !followedExistingRetryFork) {
        const target = verifiedRetryTarget(record, { workflowId, index: retryIndex, nodeId: retryNodeId, loopIndex: retryLoop - 1, rebuildPaidSuffix })
        const selected = await session.call(selectRetryNode, record.id, target.id)
        if (!selected.clicked) {
          // The runner can hide its DAG while the inspector and step controls
          // remain available. Walk backwards through those native controls and
          // verify the persisted node identity before submitting any retry.
          let matched = false
          for (let back = 0; back < record.runs.length; back += 1) {
            const state = await session.call(pressAnyButton, [], record.id, target)
            if (state.reason === undefined) { matched = true; break }
            const previous = await session.call(pressButton, '上一步', record.id)
            if (!previous.clicked) break
            await sleep(200)
          }
          if (!matched) throw new Error(`retry target not selected: ${selected.reason}`)
        }
        await untilPage(session, `selected retry step ${retryIndex}`, async () => {
          const state = await session.call(pressAnyButton, [], record.id, target)
          return { ...state, ok: state.reason === undefined }
        }, 30_000)
        const pressed = await session.call(pressAnyButton, ['从此节点重试'], record.id, target)
        if (!pressed.clicked) throw new Error(`retry not submitted: ${pressed.reason ?? 'retry button was not available'}`)
        initialRetrySignature = failureSignature(record)
        targetedRetrySourceId = record.id
        log(`pressed 从此节点重试 for verified step ${retryIndex} ${target.id} round ${untilLoop}; paid prefix retained`)
      } else if (record.runs.some(run => run.status === 'failed') && (retryIndex === undefined || !followedExistingRetryFork)) {
        // Restoring a saved run does not always restore the failed node's inspector selection.
        // Select the persisted failed node before using its guarded retry control.
        const failedRun = record.runs.find(run => run.status === 'failed')
        const selected = await session.call(selectRetryNode, record.id, failedRun.id)
        if (!selected.clicked) {
          // The compact runner can hide the DAG. Its inspector still exposes
          // the persisted title, status and loop round for guarded navigation.
          let matched = false
          for (let back = 0; back < record.runs.length; back += 1) {
            const state = await session.call(pressAnyButton, [], record.id, failedRun)
            if (state.reason === undefined) { matched = true; break }
            const previous = await session.call(pressButton, '上一步', record.id)
            if (!previous.clicked) break
            await sleep(200)
          }
          if (!matched) {
            const failedIndex = record.runs.findIndex(run => run.id === failedRun.id)
            if (failedIndex < 0 || record.runs.slice(0, failedIndex)
              .some(run => !['success', 'skipped'].includes(run.status)))
              throw new Error('failed retry navigation has an unfinished prefix')
            for (let forward = 0; forward <= failedIndex; forward += 1) {
              const state = await session.call(pressAnyButton, [], record.id, failedRun)
              if (state.reason === undefined) { matched = true; break }
              const next = await session.call(pressButton, '下一步', record.id)
              if (!next.clicked) break
              await sleep(200)
            }
          }
          if (!matched) {
            const visible = await session.call(() => ({
              title: document.querySelector('.runner-context-title h2')?.textContent,
              status: document.querySelector('.runner-context-title p')?.textContent,
              body: document.body?.innerText?.slice(0, 600),
              previousDisabled: [...document.querySelectorAll('button')].find(item => item.textContent.trim() === '上一步')?.disabled,
              nextDisabled: [...document.querySelectorAll('button')].find(item => item.textContent.trim() === '下一步')?.disabled,
            }))
            throw new Error(`failed retry node not selected: ${selected.reason}; inspector=${JSON.stringify(visible)}`)
          }
        }
        await untilPage(session, '从此节点重试 button', async () => {
          const pressed = await session.call(pressAnyButton, ['从此节点重试'], record.id, failedRun)
          return { ok: pressed.clicked, reason: pressed.reason ?? pressed.label ?? 'button not found' }
        }, 30_000)
        initialRetrySignature = failureSignature(record)
        log(`pressed 从此节点重试 (resume ${resumeRetries} more time(s) allowed)`)
      } else {
        // Nothing failed: the record was only left un-stepped, for instance when a dropped devtools
        // socket killed the driver while a paid generation was still running in the page. Pressing a
        // retry would discard that work, so the loop just keeps single-stepping from the checkpoint.
        log(`record ${record.id} has no failed node; checking its saved checkpoint before any 下一步`)
      }
    } else {
      await untilPage(session, 'workflow list', async () => {
        const clicked = await session.call(clickCardAction, workflowMatch)
        if (clicked.ok) return clicked
        // The app restores the last execution view across reloads, so the card list may not be on
        // screen at all. Leaving that view is part of driving the UI, not a workaround.
        const left = await session.call(pressAnyButton, ['返回列表', '工作流编排'])
        return { ok: false, reason: `${clicked.reason ?? 'no card'}${left.clicked ? ` (pressed ${left.label})` : ''}` }
      }, 90_000)
      log(`opened workflow for “${workflowMatch}”`)
      await untilPage(session, 'single-step button', async () => {
        const state = await session.call(readCursor)
        return { ...state, ok: state.canStart }
      }, 30_000)
      if (runtimeInputs) await setRuntimeInputs(session, runtimeInputs)
      const startedAt = new Date()
      const pressed = await session.call(pressButton, '开始单步调试')
      if (!pressed.clicked) throw new Error('single-step execution was not started: the start button was unavailable')
      log('pressed 开始单步调试')

      let attempt = 0
      for (; attempt < 40; attempt += 1) {
        record = await newestRecord(startedAt)
        if (record) break
        await sleep(2000)
      }
      if (!record) throw new Error('no execution record appeared; the run never started')
      record = await alignPageRecord(session, record)
      verifyRuntimeInputs(record)
      if (runtimeInputs) log(`verified stored runtime inputs ${record.id} ${JSON.stringify(runtimeInputs)}`)
    }
    log(`record ${record.id}`)

    let previous = summarize(record)
    let lastProgress = Date.now()
    let clicks = 0
    let continueIdlePending = Boolean(continueIdleNode)
    let resumesLeft = resumeRetries
    // A 从此节点重试 keeps the previous failed entry until the new revision finishes, so every
    // signature already seen (including the one the startup press was meant to clear) is remembered
    // instead of being treated as a fresh failure and retried twice.
    const seenFailures = new Set(initialRetrySignature ? [initialRetrySignature] : [])
    for (;;) {
      record = await loadRecord(record.id)
      if (!record) throw new Error('active execution record disappeared')
      verifyRuntimeInputs(record)
      const summary = summarize(record)
      if (summary !== previous) {
        log(summary.slice(-900))
        previous = summary
        lastProgress = Date.now()
      }
      if (record.id === targetedRetrySourceId) {
        const fork = await followFork(record, retryIndex)
        if (fork) {
          log(`following targeted retry fork ${record.id} -> ${fork.id}`)
          record = fork
          previous = summarize(record)
          lastProgress = Date.now()
          continue
        }
        if (Date.now() - lastProgress > stepTimeoutMs) {
          log(`STALLED: targeted retry did not create a fork for ${stepTimeoutMinutes} minutes; refusing to click again`)
          process.exitCode = 2
          return
        }
        await sleep(pollMs)
        continue
      }
      const failed = record.runs.filter(run => run.status === 'failed')
      if (failed.length) {
        const signature = failureSignature(record)
        // The retry may already have produced its own record, either from an earlier press in this
        // process or from a driver that was killed while the page kept working.
        const fork = await followFork(record, record.id === targetedRetrySourceId ? retryIndex : undefined)
        if (fork) {
          log(`following 从此节点重试 fork ${fork.id}: observing its current retry state`)
          record = fork
          previous = summarize(record)
          lastProgress = Date.now()
          continue
        }
        failed.forEach(run => log(`FAILED step ${run.index} ${run.id} “${run.title}” rev${run.revision}: ${run.error}`))
        if (!resumeFrom) {
          process.exitCode = 1
          return
        }
        // Already retried once and the new revision is still running: wait for it instead of pressing twice.
        if (seenFailures.has(signature)) {
          if (Date.now() - lastProgress > stepTimeoutMs) {
            log(`STALLED: retry did not advance for ${stepTimeoutMinutes} minutes; refusing to submit it again`)
            process.exitCode = 2
            return
          }
          await sleep(pollMs)
          continue
        }
        if (resumesLeft <= 0) {
          log('no resumes left; stopping so the failure is not papered over')
          process.exitCode = 1
          return
        }
        const visible = await alignPageRecord(session, record)
        if (visible.id !== record.id) { record = visible; continue }
        const pressed = await session.call(pressAnyButton, ['从此节点重试'], record.id, failed[0])
        if (!pressed.clicked) throw new Error(`retry not submitted: ${pressed.reason ?? 'retry button was not available'}`)
        seenFailures.add(signature)
        resumesLeft -= 1
        log(`resuming from the failed node (${resumesLeft} left)`)
        lastProgress = Date.now()
        // A retry that forks leaves the pinned record permanently failed, so give the new record a
        // moment to appear and then let the next iteration follow it.
        await sleep(6000)
        continue
      }
      const manualHold = pendingManualDecision(record)
      if (manualHold) {
        log(`MANUAL DECISION REQUIRED ${record.id} step ${manualHold.index} ${manualHold.id}: saved accept gate is waiting for human review; refusing automatic 下一步`)
        process.exitCode = 5
        return
      }
      const target = outcomeFor(record)
      if (target.done) {
        log(`DONE ${record.id} step ${target.run.index} ${untilNode} in ${Math.round((target.run.durationMs ?? 0) / 1000)}s${target.url ? ` url=${target.url}` : ' output=present'}`)
        return
      }
      if (target.settled) {
        log(`TARGET NOT ACCEPTED ${untilNode}: ${target.reason}`)
        process.exitCode = 4
        return
      }
      if (Date.now() - lastProgress > stepTimeoutMs) {
        log(`STALLED: no run status change for ${stepTimeoutMinutes} minutes; cursor ${JSON.stringify(await session.call(readCursor))}`)
        process.exitCode = 2
        return
      }
      if (clicks >= maxSteps) {
        log(`MAX-STEPS reached (${maxSteps}) with cursor ${JSON.stringify(await session.call(readCursor))}`)
        process.exitCode = 3
        return
      }
      const state = await session.call(readCursor)
      // The UI may enable the next step before its successful checkpoint is
      // visible in PostgreSQL. Wait for that checkpoint so an --until target
      // cannot accidentally submit the following node during this window.
      if (state.canNext && !record.runs.some(run => run.status === 'running')) {
        const visible = await alignPageRecord(session, record)
        if (continueIdlePending && visible.id !== resumeFrom) throw new Error('IDLE_CHECKPOINT_VIEW_CHANGED: refusing to continue a different record')
        if (visible.id !== record.id) { record = visible; continue }
        // Persistence can advance between the loop's first read and the UI
        // click. Re-read the exact record so a just-saved manual gate cannot
        // be crossed by a stale `canNext` cursor.
        const latest = await loadRecord(record.id)
        if (!latest) throw new Error(`active execution record ${record.id} disappeared before 下一步`)
        if (pendingManualDecision(latest) || latest.runs.some(run => run.status === 'running')
          || summarize(latest) !== summarize(record) || outcomeFor(latest).settled) { record = latest; continue }
        if (continueIdlePending) await verifyIdleCheckpoint(latest)
        const pressed = await session.call(pressButton, '下一步', record.id)
        if (pressed.clicked) {
          continueIdlePending = false
          clicks += 1
          const upcoming = record.runs.find(run => run.status === 'idle')
          log(`step ▶ ${upcoming ? `${upcoming.index} ${upcoming.id} “${upcoming.title}”` : '(unknown)'} | ${state.step}`)
        }
      }
      await sleep(pollMs)
    }
  } finally {
    session.close()
  }
}

main().catch(async (error) => {
  await log(`ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 4
}).finally(async () => {
  await pool.end()
  await fs.writeFile(logPath.replace(/\.log$/, '-final.json'), JSON.stringify({ untilNode, untilIndex, untilLoop, runtimeInputs, exitCode: process.exitCode ?? 0, lines }, null, 2))
})
