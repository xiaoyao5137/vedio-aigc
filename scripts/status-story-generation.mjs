#!/usr/bin/env node
// Compact, repeatable read-only status. Never prints provider URLs, request
// payloads, prompts, raw responses, uploaded image data, or model settings.
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'

const generated = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/generated')
const safeId = value => typeof value === 'string' && /^[\w:.-]+$/.test(value) ? value : null
const localUrl = value => typeof value === 'string' && /^\/generated\/[\w.-]+$/.test(value) ? value : null
const text = value => typeof value === 'string' ? value
  .replace(/https?:\/\/[^\s"'<>]+/gi, '[remote URL omitted]')
  .replace(/data:[^\s"'<>]+/gi, '[data omitted]')
  .replace(/(?:bearer\s+)[\w.+/=-]+/gi, '[credential omitted]')
  .replace(/(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, '[credential omitted]')
  .replace(/[A-Za-z0-9+/=_-]{180,}/g, '[encoded value omitted]').slice(0, 600) : null

async function existingLocal(url) {
  if (!localUrl(url)) return null
  try {
    const base = await realpath(generated)
    const file = await realpath(path.join(base, url.slice('/generated/'.length)))
    return file.startsWith(base + path.sep) && (await stat(file)).isFile() ? url : null
  } catch { return null }
}

async function savedLocalMedia(run) {
  const output = run.output
  const direct = localUrl(output?.storyMediaReview?.videoEvidence?.url)
    ?? localUrl(output?.videoEvidence?.url) ?? localUrl(output?.url)
  if (direct) return { localUrl: direct, localFileExists: Boolean(await existingLocal(direct)), source: 'node-output' }
  if (run.node?.id === 'node-video' && /^https?:\/\//.test(output?.url ?? '')) {
    // The review collector saves this exact source-URL archive before its
    // asynchronous report is persisted. No directory scan or download occurs.
    const key = createHash('sha256').update(output.url).digest('hex').slice(0, 20)
    const archive = await existingLocal(`/generated/verified-${key}.mp4`)
    if (archive) return { localUrl: archive, localFileExists: true, source: 'existing-source-url-archive' }
  }
  return { localUrl: null, localFileExists: false, source: null }
}

function reviewSummary(run) {
  const output = run.output
  const review = output?.storyMediaReview
  if (review) return { passed: review.passed === true, status: text(review.reviewStatus),
    beats: Array.isArray(review.beatChecks) ? review.beatChecks.map(beat => ({ id: safeId(beat.id), status: text(beat.status) })) : [],
    endingHold: text(review.endingHold?.status), issues: Array.isArray(review.issues) ? review.issues.slice(0, 3).map(text) : [] }
  if (run.node?.id === 'node-script-review' && output) return { passed: output.passed === true,
    shotCount: Array.isArray(output.shots) ? output.shots.length : 0,
    issues: Array.isArray(output.issues) ? output.issues.slice(0, 3).map(text) : [] }
  return null
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/status-story-generation.mjs --record record-ID\nRead-only compact snapshot. Can be rerun while generation is active; no provider URLs or raw payloads are printed.')
    return
  }
  if (args.length !== 2 || args[0] !== '--record' || !/^record-[\w-]+$/.test(args[1])) throw Error('Use --record record-ID')
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const row = (await db.query('SELECT id,workflow_id,md5(result::text) AS result_md5,result FROM execution_records WHERE id=$1', [args[1]])).rows[0]
    await db.query('COMMIT')
    if (!row || row.workflow_id !== 'wf-story') throw Error('Record missing or not wf-story')
    const state = decodeExecutionState(row.result)
    if (state.id !== row.id || state.workflowId !== 'wf-story' || !Array.isArray(state.nodeRuns)) throw Error('Stored record identity is inconsistent')
    const nodes = []
    for (const [index, run] of state.nodeRuns.entries()) {
      const review = reviewSummary(run), error = text(run.error), media = await savedLocalMedia(run)
      nodes.push({ index, id: safeId(run.node?.id), loopIndex: Number.isSafeInteger(run.loopIndex) ? run.loopIndex : null,
        status: text(run.status), ...(Number.isSafeInteger(run.revision) && run.revision ? { revision: run.revision } : {}),
        ...(review ? { review } : {}), ...(error ? { error } : {}), ...(media.localUrl ? { media } : {}) })
    }
    const counts = Object.fromEntries(['success', 'running', 'failed', 'idle', 'skipped'].map(status => [status, nodes.filter(node => node.status === status).length]))
    console.log(JSON.stringify({ recordId: row.id, observedAt: new Date().toISOString(), resultMd5: row.result_md5,
      parentExecutionId: safeId(state.parentExecutionId), generationScopeId: safeId(state.generationScopeId ?? state.id),
      selectedNodeId: safeId(state.selectedNodeId), counts,
      firstPendingIndex: nodes.find(node => !['success', 'skipped'].includes(node.status))?.index ?? null,
      note: 'Node completion and machine review do not imply final content acceptance.', nodes }, null, 2))
  } finally { await db.end() }
}

main().catch(error => { console.error(text(error instanceof Error ? error.message : String(error))); process.exitCode = 1 })
