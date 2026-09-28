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
//   node scripts/drive-workflow-ui.mjs --resume latest --reload-page # explicitly load new sources before resuming
//   node scripts/drive-workflow-ui.mjs --restart-server        # bounce the app service first
// Exit code 5 means a saved accept gate requires a human decision; the driver never presses 下一步 for it.
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { DRIVE_RECORD_SQL, DRIVE_RECORD_TRIM_CHARS, completedProviderRegression, driveRecord, failureSignature, isRetryFork, loopTargetOutcome, parseRuntimeInputs, pendingManualDecision, runtimeInputMismatch, sameExecutionScope, targetOutcome } from './workflow-drive-state.mjs'

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
const maxSteps = Number(option('max-steps', untilLoop === undefined ? '40' : String(40 * (untilLoop + 1))))
const stepTimeoutMinutes = Number(option('step-timeout', '14'))
const watchRecord = option('watch', '')
// --resume <record-id>|latest continues an existing run through the UI's 从此节点重试, which re-runs
// only the failed node with revision+1 and keeps every earlier paid result.
const resumeFrom = option('resume', '')
if (runtimeInputs && (watchRecord || resumeFrom)) throw new Error('--runtime-inputs is for new executions; resume/watch preserve the stored inputs')
const resumeRetries = Number(option('resume-retries', '2'))
// The launchd service keeps `hmr: false`, so a long-lived process may answer module requests from a
// transform cache and a browser reload would then self-test code that is no longer on disk. Forcing
// the service to restart is the only way to make "the run exercised my change" true.
const restartServer = flag('restart-server')
const serverLabel = option('service-label', 'com.video-aigc.app')
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
  return driveRecord(row)
}

/** "从此节点重试" does not revise a step-mode record in place: the app forks a fresh execution
 * record that replays the finished prefix and re-runs only the failed node. A driver pinned to the
 * old id therefore reports a failure that was already cleared, forever, and pressing retry again
 * buys the same paid generation a second time. Following the fork keeps both the observation and
 * the money honest. */
async function followFork(pinned) {
  const { rows } = await pool.query(
    `select id from execution_records where workflow_id = $1 and created_at > $2
     and coalesce(result->>'requestScopeId', result->>'id', id) = $3
     order by created_at desc limit 20`, [pinned.workflowId, pinned.createdAt, pinned.requestScopeId])
  for (const row of rows) {
    if (row.id === pinned.id) continue
    const candidate = await loadRecord(row.id)
    if (!candidate) continue
    if (isRetryFork(pinned, candidate)) return candidate
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
  const cards = [...document.querySelectorAll('.workflow-card')]
  if (!cards.length) return { ok: false, reason: 'workflow cards not rendered yet', cards: 0 }
  const card = cards.find(item => item.textContent.includes(match))
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
const pressAnyButton = (labels, expectedExecutionId, expectedFailure) => {
  if (expectedExecutionId) {
    let activeId
    try { activeId = JSON.parse(sessionStorage.getItem('vedio-aigc:app-view-state:v1'))?.executionId } catch { /* wait for a valid execution view */ }
    if (activeId !== expectedExecutionId) return { clicked: false, reason: `execution view changed: ${activeId ?? 'none'}` }
  }
  if (expectedFailure) {
    const inspector = document.querySelector('.runner-context-title')
    const status = inspector?.querySelector('p')?.textContent ?? ''
    if (inspector?.querySelector('h2')?.textContent !== expectedFailure.title || !status.includes('失败')
      || (expectedFailure.loopIndex !== undefined && !status.includes(`第 ${expectedFailure.loopIndex + 1} 轮`))) {
      return { clicked: false, reason: 'the failed node is not selected; refusing to retry another completed node' }
    }
  }
  const buttons = [...document.querySelectorAll('button')]
  for (const label of labels) {
    const button = buttons.find(item => item.textContent.trim().startsWith(label) && !item.disabled)
    if (button) { button.click(); return { clicked: true, label } }
  }
  return { clicked: false, labels }
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
      // pkill exits 1 when nothing matched, which simply means the service is already stopped.
      try {
        execFileSync('/usr/bin/pkill', ['-f', 'node scripts/dev-server.mjs'], { stdio: 'ignore' })
      } catch { /* nothing to stop */ }
      // strictPort means a half-dead predecessor still holding 5173 would kill the new process.
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
    if (resumeFrom) {
      record = resumeFrom === 'latest'
        ? await newestRecord(new Date(Date.now() - 12 * 3600_000))
        : await loadRecord(resumeFrom)
      if (!record) throw new Error(`resume record ${resumeFrom} not found`)
      const fork = await followFork(record)
      if (fork) {
        // The retry already happened - possibly in a previous driver process that died - so the only
        // safe action is to adopt its record instead of pressing the button again.
        log(`record ${record.id} was already retried; following fork ${fork.id}`)
        record = fork
      }
      await openRecordView(session, record)
      record = await alignPageRecord(session, record)
      if (record.runs.some(run => run.status === 'failed')) {
        // The app restores the last execution view, so the only click needed is the retry itself.
        await untilPage(session, '从此节点重试 button', async () => {
          const pressed = await session.call(pressAnyButton, ['从此节点重试'], record.id, record.runs.find(run => run.status === 'failed'))
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
      const failed = record.runs.filter(run => run.status === 'failed')
      if (failed.length) {
        const signature = failureSignature(record)
        // The retry may already have produced its own record, either from an earlier press in this
        // process or from a driver that was killed while the page kept working.
        const fork = await followFork(record)
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
        if (visible.id !== record.id) { record = visible; continue }
        // Persistence can advance between the loop's first read and the UI
        // click. Re-read the exact record so a just-saved manual gate cannot
        // be crossed by a stale `canNext` cursor.
        const latest = await loadRecord(record.id)
        if (!latest) throw new Error(`active execution record ${record.id} disappeared before 下一步`)
        if (pendingManualDecision(latest) || latest.runs.some(run => run.status === 'running')
          || summarize(latest) !== summarize(record) || outcomeFor(latest).settled) { record = latest; continue }
        const pressed = await session.call(pressButton, '下一步', record.id)
        if (pressed.clicked) {
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
