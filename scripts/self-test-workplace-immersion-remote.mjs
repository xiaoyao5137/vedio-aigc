#!/usr/bin/env node
// Independent text-only provider control when the configured Codex transport is unavailable.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import pg from 'pg'
import { executeBuiltinNode } from '../server/builtin-nodes.ts'
import { extractTextResponse, parseStructuredJson } from '../src/workflow-core.ts'
import { WORKPLACE_IMMERSION_PROMPT } from '../src/story-workplace-immersion.ts'

const out = 'qa/workplace-immersion-20261007'
const sha = value => createHash('sha256').update(value).digest('hex')
const db = new pg.Client({ connectionString: process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
await db.connect()
let model, workflow
try {
  workflow = (await db.query(`SELECT nodes,md5(nodes::text) nodes_md5 FROM workflow_configs
    WHERE id='wf-workplace-second-trial-v1'`)).rows[0]
  model = (await db.query(`SELECT id,name,provider,capability,settings FROM model_configs
    WHERE id='gpt-5.6-sol'`)).rows[0]
} finally { await db.end() }
if (workflow?.nodes?.find(node => node.id === 'node-script')?.prompt !== WORKPLACE_IMMERSION_PROMPT
  || model?.provider !== 'OpenAI' || model.capability !== 'text') throw Error('saved prompt or control model changed')
const prompt = WORKPLACE_IMMERSION_PROMPT.replaceAll('${input.platform}', '抖音')
  .replaceAll('${input.vedio_count}', '3').replaceAll('${input.topic}', '[]')
const requestKey = `workplace-immersion-three-shot-control:${randomUUID()}`
await mkdir(out, { recursive: true })
await writeFile(`${out}/remote-control-intent.json`, JSON.stringify({ version: 'workplace-immersion-control-intent-v1',
  workflowNodesMd5: workflow.nodes_md5, modelId: model.id, requestKey, promptSha256: sha(prompt), mediaCalls: 0 }, null, 2) + '\n', { flag: 'wx' })
const response = await fetch('http://127.0.0.1:5173/api/node-run', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model, prompt, params: { temperature: 0.7 }, operation: 'story.script-generation',
    executionContext: { workflowId: 'wf-workplace-second-trial-v1', nodeId: 'node-script',
      nodeName: '三镜代入感对照', requestKey } }), signal: AbortSignal.timeout(300000) })
const envelope = await response.json()
const text = response.ok && envelope.status === 200 ? extractTextResponse(envelope.body) : null
let shots, review
if (text) {
  shots = parseStructuredJson(text)
  review = await executeBuiltinNode(null, { operation: 'story.script-review',
    executionContext: { workflowId: 'wf-workplace-second-trial-v1' },
    params: { script: shots, expectedCount: 3, topics: [] } })
  await writeFile(`${out}/three-shot-control-output.json`, JSON.stringify(shots, null, 2) + '\n', { flag: 'wx' })
}
const proof = { version: 'workplace-immersion-three-shot-control-v1', modelId: model.id,
  workflowId: 'wf-workplace-second-trial-v1', workflowNodesMd5: workflow.nodes_md5,
  promptSha256: sha(prompt), responseStatus: response.status, modelStatus: envelope.status,
  ...(text ? { responseSha256: sha(text), shotCount: Array.isArray(shots) ? shots.length : null,
    scriptReview: { passed: review.passed, issues: review.issues ?? [], code: review.code ?? null } } : {
    error: typeof envelope.error === 'string' ? envelope.error.slice(0, 500) : 'model response unavailable' }),
  mediaCalls: 0, productionModelUnchanged: true }
await writeFile(`${out}/remote-control-result.json`, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(proof, null, 2))
