import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import pg from 'pg'
import { refreshCinematicEvidenceCertaintyCode, refreshCinematicMediaImageReview, refreshCinematicOpeningGateCode, refreshHistoricalSourceReviewGateCode, refreshHistoricalSourceReviewPrompt, refreshScriptReviewSourceQuotes, upgradeQualityWorkflow } from '../src/quality-node-presets.ts'
import { migrateBranchWorkflow, refreshReportRetryBranches } from '../src/branch-migration.ts'
import { branchConfigurationErrors } from '../src/workflow-branch.ts'
import { refreshEmbeddedHistoricalAgencyCode } from '../src/history-content-guards.ts'
import { refreshEmbeddedDramaturgyReviewCode, refreshDramaturgyReviewPrompt } from '../src/drama-quality-presets.ts'

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const client = await pool.connect()
try {
  await client.query('begin')
  const row = (await client.query("select * from workflow_configs where id='wf-sanguo-history-drama' for update")).rows[0]
  if (!row) throw Error('三国生产工作流不存在')
  const workflow = { ...row, schemaVersion: row.schema_version }
  const upgrade = value => migrateBranchWorkflow(upgradeQualityWorkflow(value))
  let upgraded = upgrade(workflow)
  if (process.argv.includes('--refresh-guard')) {
    upgraded = { ...upgraded, nodes: upgraded.nodes.map(node => {
      if (!['sanguo-scene-outline-accept', 'sanguo-shot-script-accept'].includes(node.id)) return node
      const code = String(node.code)
      // An explicit refresh must not pass silently on a gate whose guard was hand-edited away.
      if (!code.includes('(function validateHistoricalAgency')) throw Error('Cannot safely locate embedded historical guard; preserve custom code')
      return { ...node, code: refreshEmbeddedHistoricalAgencyCode(code) }
    }) }
  }
  if (process.argv.includes('--refresh-review-format')) upgraded = { ...upgraded, nodes: upgraded.nodes.map(node =>
    ['sanguo-scene-outline-accept', 'sanguo-shot-script-accept'].includes(node.id)
      ? { ...node, code: refreshEmbeddedDramaturgyReviewCode(node.code) } : node) }
  // Re-apply the schema-79 convergence fix to hand-edited reviewers and gates.
  if (process.argv.includes('--refresh-dramaturgy-convergence')) upgraded = { ...upgraded, nodes: upgraded.nodes.map(node =>
    ['sanguo-scene-outline-review', 'sanguo-shot-script-review'].includes(node.id)
      ? { ...node, prompt: refreshHistoricalSourceReviewPrompt(refreshDramaturgyReviewPrompt(node.prompt)) }
      : ['sanguo-scene-outline-accept', 'sanguo-shot-script-accept'].includes(node.id)
        ? { ...node, code: refreshEmbeddedDramaturgyReviewCode(node.code) } : node) }
  if (process.argv.includes('--refresh-episode-transport')) upgraded = { ...upgraded, nodes: upgraded.nodes.map(node =>
    node.id === 'sanguo-episode-review' ? { ...node, operation: 'history.episode-review' } : node) }
  if (process.argv.includes('--refresh-source-quote-prompt')) upgraded = { ...upgraded, nodes: upgraded.nodes.map(node =>
    ['sanguo-scene-outline-review', 'sanguo-shot-script-review'].includes(node.id)
      ? { ...node, prompt: refreshScriptReviewSourceQuotes(node.prompt) } : node) }
  if (process.argv.includes('--refresh-source-span-review')) upgraded = { ...upgraded, nodes: upgraded.nodes.map(node =>
    ['sanguo-scene-outline-review', 'sanguo-shot-script-review'].includes(node.id)
      ? { ...node, operation: 'history.script-review', prompt: refreshHistoricalSourceReviewPrompt(node.prompt) }
      : ['sanguo-scene-outline-accept', 'sanguo-shot-script-accept'].includes(node.id)
        ? { ...node, code: refreshHistoricalSourceReviewGateCode(node.code) } : node) }
  if (process.argv.includes('--refresh-report-retry')) upgraded = refreshReportRetryBranches(upgraded)
  if (process.argv.includes('--refresh-cinematic-opening')) upgraded = { ...upgraded, nodes: upgraded.nodes.map(node =>
    node.id === 'sanguo-media-accept' ? { ...node, code: refreshCinematicOpeningGateCode(node.code) } : node) }
  if (process.argv.includes('--refresh-media-images')) upgraded = { ...upgraded, nodes: upgraded.nodes.map(refreshCinematicMediaImageReview) }
  if (process.argv.includes('--refresh-media-certainty')) upgraded = { ...upgraded, nodes: upgraded.nodes.map(node =>
    node.id === 'sanguo-media-accept' ? { ...node, code: refreshCinematicEvidenceCertaintyCode(node.code) } : node) }
  assert.deepEqual(upgrade(upgraded), upgraded, '迁移必须幂等')
  assert.deepEqual(branchConfigurationErrors(upgraded), [], '迁移后的分支必须完整')
  const changed = JSON.stringify([workflow.nodes, workflow.edges, workflow.schemaVersion]) !== JSON.stringify([upgraded.nodes, upgraded.edges, upgraded.schemaVersion])
  if (changed) {
    await fs.mkdir('logs/cinematic-drama', { recursive: true })
    await fs.writeFile(`logs/cinematic-drama/workflow-before-schema${row.schema_version}-${Date.now()}.json`, JSON.stringify(row, null, 2))
    await client.query('update workflow_configs set nodes=$2::jsonb,edges=$3::jsonb,schema_version=$4,updated_at=now() where id=$1', [row.id, JSON.stringify(upgraded.nodes), JSON.stringify(upgraded.edges), upgraded.schemaVersion])
  }
  await client.query('commit')
  console.log(JSON.stringify({ id: row.id, schemaVersion: upgraded.schemaVersion, nodes: upgraded.nodes.length, edges: upgraded.edges.length, changed, idempotent: true }))
} catch (error) { await client.query('rollback'); throw error }
finally { client.release(); await pool.end() }
