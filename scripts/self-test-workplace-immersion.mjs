#!/usr/bin/env node
// Fresh text-only three-shot trial of the exact saved writer prompt.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import pg from 'pg'
import { callCodexText, CodexTextError, resolveCodexTextConfig } from '../server/codex-text.ts'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { WORKPLACE_IMMERSION_PROMPT } from '../src/story-workplace-immersion.ts'

const out = 'qa/workplace-immersion-20261007'
const flags = process.argv.slice(2)
if (flags.some(flag => !['--medium', '--retest', '--production', '--final'].includes(flag)) || new Set(flags).size !== flags.length
  || ['--retest', '--production', '--final'].filter(flag => flags.includes(flag)).length > 1)
  throw Error('Usage: node scripts/self-test-workplace-immersion.mjs [--medium] [--retest|--production|--final]')
const reasoningEffort = flags.includes('--medium') ? 'medium' : undefined
const suffix = flags.includes('--final') ? '-v4' : flags.includes('--production') ? '-v3' : flags.includes('--retest') ? '-v2' : ''
const sha = value => createHash('sha256').update(value).digest('hex')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let model, workflow, sourceMd5
try {
  workflow = (await db.query(`SELECT nodes,md5(nodes::text) nodes_md5 FROM workflow_configs
    WHERE id='wf-workplace-second-trial-v1'`)).rows[0]
  model = (await db.query(`SELECT id,provider,capability,settings FROM model_configs
    WHERE id='codex-local-vision'`)).rows[0]
  sourceMd5 = (await db.query(`SELECT md5(result::text) md5 FROM execution_records
    WHERE id='record-onxgw6-review-retry'`)).rows[0]?.md5
} finally { await db.end() }
const writer = workflow?.nodes?.find(node => node.id === 'node-script')
if (!sourceMd5 || writer?.prompt !== WORKPLACE_IMMERSION_PROMPT || model?.provider !== 'Codex'
  || model.capability !== 'text') throw Error('saved writer prompt or source changed')
const writerParams = Object.fromEntries((writer.params ?? []).map(param => [param.englishName, param.value]))
if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(writerParams.reasoningEffort)
  || !Number.isSafeInteger(Number(writerParams.timeoutMs))) throw Error('saved writer model parameters changed')
const prompt = writer.prompt.replaceAll('${input.platform}', '抖音')
  .replaceAll('${input.vedio_count}', '3').replaceAll('${input.topic}', '[]')
await mkdir(out, { recursive: true })
let response
try {
  response = await callCodexText(resolveCodexTextConfig(model,
    { reasoningEffort: reasoningEffort ?? writerParams.reasoningEffort,
      timeoutMs: reasoningEffort ? 240000 : Number(writerParams.timeoutMs) }), prompt)
} catch (error) {
  const failure = { version: 'workplace-immersion-three-shot-transport-failure-v1',
    workflowId: 'wf-workplace-second-trial-v1', workflowNodesMd5: workflow.nodes_md5,
    sourceRecordId: 'record-onxgw6-review-retry', sourceResultMd5: sourceMd5,
    modelId: model.id, reasoningEffort: reasoningEffort ?? writerParams.reasoningEffort,
    promptSha256: sha(prompt), error: error instanceof Error ? error.message : String(error),
    ...(error instanceof CodexTextError ? { diagnostics: {
      durationMs: error.raw.durationMs, exitSignal: error.raw.exitSignal,
      stderr: error.raw.stderr, recoveredDiagnostics: error.raw.recoveredDiagnostics } } : {}),
    mediaCalls: 0, originalRecordMutated: false }
  const filename = `${out}/three-shot-failure-${reasoningEffort ?? 'configured'}${suffix}.json`
  await writeFile(filename, JSON.stringify(failure, null, 2) + '\n', { flag: 'wx' })
  throw error
}
const text = extractTextResponse(response.body)
const shots = parseStructuredJson(text)
const review = await executeBuiltinNode(null, { operation: 'story.script-review',
  executionContext: { workflowId: 'wf-workplace-second-trial-v1' },
  params: { script: shots, expectedCount: 3, topics: [] } })
const proof = { version: 'workplace-immersion-three-shot-trial-v1',
  workflowId: 'wf-workplace-second-trial-v1', workflowNodesMd5: workflow.nodes_md5,
  sourceRecordId: 'record-onxgw6-review-retry', sourceResultMd5: sourceMd5,
  modelId: model.id, reasoningEffort: reasoningEffort ?? writerParams.reasoningEffort,
  promptSha256: sha(prompt), responseSha256: sha(text),
  textModelStatus: response.status, shotCount: Array.isArray(shots) ? shots.length : null,
  scriptReview: { passed: review.passed, issues: review.issues, code: review.code },
  mediaCalls: 0, originalRecordMutated: false }
await writeFile(`${out}/three-shot-model-output${suffix}.json`, JSON.stringify(shots, null, 2) + '\n', { flag: 'wx' })
await writeFile(`${out}/three-shot-trial${suffix}.json`, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(proof, null, 2))
