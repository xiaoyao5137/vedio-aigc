import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { SANGUO_SCENE_OUTLINE_PROMPT } from '../src/scene-outline-prompt.ts'
import { SANGUO_CINEMATIC_STORYBOARD_PROMPT } from '../src/storyboard-prompt.ts'
import { HISTORY_QUALITY_VERSION } from '../src/history-media.ts'
import { refreshCinematicEvidenceCertaintyCode, refreshCinematicMediaImageReview, refreshCinematicOpeningGateCode, refreshHistoricalSourceReviewGateCode, refreshHistoricalSourceReviewPrompt, upgradeQualityWorkflow } from '../src/quality-node-presets.ts'
import { migrateBranchWorkflow, refreshReportRetryBranches } from '../src/branch-migration.ts'
import { branchConfigurationErrors } from '../src/workflow-branch.ts'
import { validateHistoricalAgency } from '../src/history-content-guards.ts'
import { validateDramaturgyReview } from '../src/drama-quality-presets.ts'

const directory = (await fs.readFile('logs/cinematic-drama/current-directory.txt', 'utf8')).trim()
const before = JSON.parse(await fs.readFile(directory + '/execution-hashes-before.json', 'utf8'))
const originalWorkflow = JSON.parse(await fs.readFile(directory + '/workflow-before.json', 'utf8'))
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
try {
  const row = (await pool.query("select * from workflow_configs where id='wf-sanguo-history-drama'")).rows[0]
  const workflow = { ...row, schemaVersion: row.schema_version }
  // Derive the expected schema from the upgrade chain instead of hardcoding a literal: this
  // script sits outside `npm test`, so a literal here silently rotted at every schema bump.
  const expectedSchemaVersion = upgradeQualityWorkflow({ ...workflow, schemaVersion: 0 }).schemaVersion
  assert.equal(workflow.schemaVersion, expectedSchemaVersion, `生产库必须已迁移到 schema ${expectedSchemaVersion}`)
  assert.equal(workflow.nodes.find(n => n.id === 'sanguo-scene-outline').prompt, SANGUO_SCENE_OUTLINE_PROMPT)
  assert.equal(workflow.nodes.find(n => n.id === 'sanguo-shot-script').prompt, SANGUO_CINEMATIC_STORYBOARD_PROMPT)
  assert.equal(workflow.nodes.find(n => n.id === 'sanguo-episode-review').operation, 'history.episode-review')
  const mediaGate = workflow.nodes.find(n => n.id === 'sanguo-media-accept')
  assert.equal(mediaGate.code, refreshCinematicOpeningGateCode(mediaGate.code), '生产门只比较前镜已观察的关键连续状态')
  assert.equal(mediaGate.code, refreshCinematicEvidenceCertaintyCode(mediaGate.code), '生产门必须拒绝observed与明确不确定证据的矛盾')
  const mediaReviewer = workflow.nodes.find(n => n.id === 'sanguo-media-review')
  assert.deepEqual(mediaReviewer, refreshCinematicMediaImageReview(mediaReviewer), '成片审核必须收到全部实际帧以核对观察误述')
  for (const node of workflow.nodes.filter(n => ['sanguo-scene-outline-review', 'sanguo-shot-script-review'].includes(n.id))) {
    assert.equal(node.prompt, refreshHistoricalSourceReviewPrompt(node.prompt), '生产审稿必须使用当前的原文片段与覆盖清单')
    assert.equal(node.operation, 'history.script-review')
  }
  assert.deepEqual(migrateBranchWorkflow(upgradeQualityWorkflow(workflow)), workflow)
  assert.deepEqual(refreshReportRetryBranches(workflow), workflow)
  assert.deepEqual(branchConfigurationErrors(workflow), [])
  for (const node of workflow.nodes.filter(n => ['sanguo-scene-outline-accept', 'sanguo-shot-script-accept'].includes(n.id))) {
    assert.ok(node.code.includes(validateHistoricalAgency.toString()), '生产内嵌主体检查必须与实测修正版一致')
    assert.ok(node.code.includes(validateDramaturgyReview.toString()), '生产内嵌叙事检查必须与实测版本一致')
    assert.equal(node.code, refreshHistoricalSourceReviewGateCode(node.code), '生产门必须从真实史料解析片段编号')
  }
  for (const prior of originalWorkflow.nodes) {
    const node = workflow.nodes.find(item => item.id === prior.id)
    if (prior.modelId) assert.equal(node?.modelId, prior.modelId, `节点 ${prior.id} 的用户模型选择被修改`)
  }
  const rows = (await pool.query('select id,result from execution_records where id=any($1::text[])', [before.map(item => item.id)])).rows
  const current = new Map(rows.map(item => [item.id, createHash('sha256').update(JSON.stringify(item.result)).digest('hex')]))
  for (const prior of before) assert.equal(current.get(prior.id), prior.sha256, `旧执行 ${prior.id} 被修改`)
  const runtime = await (await fetch((process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173') + '/api/runtime-version')).json()
  assert.equal(runtime.historyQualityVersion, HISTORY_QUALITY_VERSION)
  const report = { schemaVersion: workflow.schemaVersion, nodes: workflow.nodes.length, edges: workflow.edges.length,
    promptsMatch: true, embeddedValidatorsMatch: true, modelSelectionsUnchanged: true, idempotent: true, branchErrors: [], historicalRecordsUnchanged: before.length,
    runtimeVersion: runtime.historyQualityVersion, passed: true }
  await fs.writeFile('logs/cinematic-drama/deployment-verification.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally { await pool.end() }
