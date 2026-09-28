import { renderWorkflowTemplate } from '../src/workflow-template.ts'
// Runs the same storyboard repair/validation engine used by App.tsx against
// the recorded production failure. Credentials are read in memory, never saved.
import fs from 'node:fs/promises'
import pg from 'pg'
import { generateHistoricalStoryboard, STORYBOARD_SEGMENTS_KEY } from '../src/storyboard-runtime.ts'
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
const fixture = JSON.parse(await fs.readFile(new URL('../tests/fixtures/storyboard-coverage-failure.json', import.meta.url), 'utf8'))
const source = await fs.readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const promptTemplate = source.match(/const SANGUO_STORYBOARD_PROMPT = `([\s\S]*?)`\n/)?.[1].replace(/\\\$/g, '$')
if (!promptTemplate) throw new Error('Storyboard prompt not found')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const { rows: [model] } = await pool.query("select * from model_configs where id='claude-opus-4-8'")
await pool.end()
if (!model) throw new Error('Configured text model missing')
const context = { scene: fixture.scene, input: { episode_title: '甘陵党议', aspect_ratio: '16:9' }, historical_sources: { text: '这是历史失败分镜的技术回归，不证明史料有效。保留已有 historicalBasis 和 adaptationBoundary 字段。' } }
const prompt = renderWorkflowTemplate(promptTemplate, context)
const output = await generateHistoricalStoryboard({ prompt, expected: { scene: fixture.scene, requireContinuityContract: true, productionSpeechRate: 3, aspectRatio: '16:9' }, initialCandidate: fixture.candidate,
  onAttempt: (attempt) => console.log(JSON.stringify(attempt)),
  generate: async (prompt) => {
    const response = await fetch(`${base}/api/node-run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, operation: 'history.storyboard', prompt, params: {}, executionContext: { workflowId: 'history-regression', nodeId: 'storyboard-replay' } }) })
    const result = await response.json()
    if (!response.ok || result.status >= 400) throw new Error(JSON.stringify(result))
    return result.body
  },
})
const segments = output[STORYBOARD_SEGMENTS_KEY] ?? [output]
await fs.mkdir('logs/quality-regression', { recursive: true })
await fs.writeFile('logs/quality-regression/production-replay.json', JSON.stringify(output, null, 2))
console.log(JSON.stringify({ ok: true, scope: 'script-contract-only', segments: segments.length, duration: segments.length * 15, ids: segments.map(s => s.id) }))
