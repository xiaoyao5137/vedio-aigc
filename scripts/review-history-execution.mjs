// Recheck completed production clips using the current reviewer. Never generates media.
import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { reviewHistoricalMedia, HISTORY_QUALITY_VERSION } from '../src/history-media.ts'
const recordId = process.argv[2]
if (!recordId) throw new Error('Usage: node scripts/review-history-execution.mjs <record-id>')
const scenes = process.argv.slice(3).map(Number)
if (scenes.some(scene => !Number.isInteger(scene) || scene < 1)) throw new Error('Optional scene numbers must be positive integers')
const reviewRunId = `review-${Date.now()}`
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
try {
  const row = (await pool.query('select result,workflow_id from execution_records where id=$1', [recordId])).rows[0]
  if (!row) throw new Error('Execution not found')
  const model = (await pool.query("select * from model_configs where id='claude-opus-4-8'")).rows[0]
  if (!model || model.provider === 'Local') throw new Error('A real reviewer is required')
  const directory = path.join('logs/quality-regression/full-execution', recordId)
  await fs.mkdir(directory, { recursive: true })
  const clips = row.result.nodeRuns.filter(run => run.node.id === 'sanguo-video' && run.status === 'success' && (!scenes.length || scenes.includes(run.loopIndex + 1)))
  if (!clips.length || scenes.some(scene => !clips.some(clip => clip.loopIndex + 1 === scene))) throw new Error('Requested scenes are not completed in this execution')
  let failures = 0
  for (const clip of clips) {
    const shot = row.result.nodeRuns.find(run => run.node.id === 'sanguo-shot-script' && run.loopIndex === clip.loopIndex)?.output
    const report = { recordId, reviewRunId, loopIndex: clip.loopIndex, video: clip.output.url, checkedAt: new Date().toISOString(), runtime: HISTORY_QUALITY_VERSION,
      reviewer: { id: model.id, model: model.settings.model, endpoint: model.settings.endpoint }, scope: 'independent-recheck-of-completed-production-video' }
    try {
      report.review = await reviewHistoricalMedia({ shot, frames: clip.output.frames, speechEvidence: clip.output.speechValidation,
        generate: async (prompt, reviewImages) => {
          const response = await fetch(`${base}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            model, prompt, params: { reviewImages }, operation: 'history.media-review', executionContext: { workflowId: row.workflow_id,
              nodeId: `independent-review-${clip.loopIndex}`, requestKey: `${row.result.requestScopeId ?? recordId}:independent-review:${reviewRunId}:${clip.loopIndex}` },
          }) })
          const result = await response.json()
          if (!response.ok || result.status >= 400) throw new Error(JSON.stringify(result))
          return result.body
        },
      })
      report.passed = true
    } catch (error) {
      report.passed = false
      report.error = error.message
      failures += 1
    }
    await fs.writeFile(path.join(directory, `independent-review-${clip.loopIndex}.json`), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ index: clip.loopIndex, passed: report.passed, error: report.error }))
  }
  if (failures) process.exitCode = 1
} finally { await pool.end() }
