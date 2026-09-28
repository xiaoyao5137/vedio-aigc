#!/usr/bin/env node
// HTTP regression for the saved text code gate only. /api/node-run dispatches
// external models, so this probe deliberately uses /api/code-node-run, whose
// handler only executes the supplied saved code in the local VM.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import pg from 'pg'

const base = 'http://127.0.0.1:5173'
const directory = path.resolve('logs/dramatic-expression/live-20260928/editorial-hold-http-probe')
const workflowId = 'wf-sanguo-history-drama'
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const load = async name => JSON.parse(await fs.readFile(path.resolve(name), 'utf8'))
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })

await db.connect()
let workflow
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  workflow = (await db.query('SELECT id,schema_version,nodes,edges,xmin::text AS row_version FROM workflow_configs WHERE id=$1', [workflowId])).rows[0]
  assert.ok(workflow && workflow.schema_version === 153)
  await db.query('ROLLBACK')
} catch (error) {
  await db.query('ROLLBACK')
  throw error
} finally { await db.end() }

const gate = workflow.nodes.find(node => node.id === 'sanguo-scene-outline-accept')
assert.equal(gate?.kind, 'code')
assert.ok(gate.code.includes('editorialHold') && gate.code.includes('manualDecisionRequired'), 'Saved code is older than editorial pause')
assert.equal(gate.params.find(param => (param.englishName ?? param.name) === 'qualityDisposition')?.value, 'manual-review-v1')
const listening = execFileSync('lsof', ['-nP', '-iTCP:5173', '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' })
const pid = Number(/^p(\d+)$/m.exec(listening)?.[1])
assert.ok(Number.isInteger(pid) && pid > 0, 'Expected existing local service; do not start a new one')
const processDetails = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,etime=,command='], { encoding: 'utf8' }).trim()
assert.match(processDetails, /scripts\/dev-server\.mjs/)

const candidate693 = await load('logs/episode693-schema151-outline-20260928/candidate.json')
const candidate637 = await load('logs/episode637-schema151-outline-20260928/candidate.json')
const old637Raw = await load('logs/episode637-schema151-outline-20260928/refreshed-text-review-post-media-cas/response.json')
const old637 = JSON.parse(old637Raw.body.content.find(part => part.type === 'text').text)
const report = warnings => ({ version: 'principle-review-v1', decision: 'pass', issues: [], warnings })
const grounded693 = {
  code: 'unnecessary_map', itemId: 'scene-01', relatedItemId: 'scene-02',
  evidence: [
    { itemId: 'scene-01', path: 'scenes.0.requiredBeats.0.observable.visual.1', quote: '阆中城址周围缓慢加深设色，河道和城址位置保持不变' },
    { itemId: 'scene-02', path: 'scenes.1.requiredBeats.0.observable.audio.0', quote: '先回到此前。这样的治兵方式，刘备曾多次劝过张飞。' },
  ],
  problem: '地图只让阆中城址加深设色，空帐再次用旁白讲背景；两段没有新增路线或地理因果，连续占用开场，延迟刘备和张飞交锋。',
  repair: '把阆中地点和此前劝诫并入刘备、张飞真人交锋开场。',
}
const mistaken637 = { ...grounded693,
  evidence: [
    { itemId: 'scene-01', path: 'scenes.0.requiredBeats.0.observable.visual.1', quote: '一条贴合图面的二维路线从汉中向巴西延伸，末端停在巴西区域。' },
    { itemId: 'scene-02', path: 'scenes.1.requiredBeats.0.observable.audio.0', quote: '匿名军士：将军，和张郃对峙五十多天了，还这么守着？' },
  ],
  problem: '地图与相邻场连续说明局势，没有新的空间路线信息，只占用开场并延迟人物冲突。',
  repair: '把信息并入人物开场。',
}
const cases = [
  { key: '693-grounded-map-empty-tent', candidate: candidate693, review: report([grounded693]), expectHold: true },
  { key: '637-actual-old-review', candidate: candidate637, review: old637, expectHold: false },
  { key: '637-route-protected', candidate: candidate637, review: report([mistaken637]), expectHold: false },
]
await fs.mkdir(directory, { recursive: true })
const outcomes = []
for (const item of cases) {
  const payload = { code: gate.code, prompt: gate.prompt,
    params: { qualityMode: 'principle-v1', qualityDisposition: 'manual-review-v1', candidate: item.candidate, review: item.review },
    context: {}, files: [] }
  const requestPath = path.join(directory, `request-${item.key}.json`)
  const responsePath = path.join(directory, `response-${item.key}.json`)
  await fs.writeFile(requestPath, JSON.stringify({ url: base + '/api/code-node-run', method: 'POST', body: payload }, null, 2))
  const response = await fetch(base + '/api/code-node-run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) })
  const envelope = await response.json()
  await fs.writeFile(responsePath, JSON.stringify({ httpStatus: response.status, envelope }, null, 2))
  assert.equal(response.status, 200, `${item.key}: code route failed`)
  assert.equal(envelope.status, 200)
  const accepted = envelope.body
  assert.equal(accepted.passed, true)
  assert.equal(accepted.manualDecisionRequired, item.expectHold)
  assert.equal(accepted.qualityReview?.manualDecisionRequired, item.expectHold)
  assert.equal(Boolean(accepted.qualityReview?.editorialHold), item.expectHold)
  assert.deepEqual(accepted.scenes, item.candidate.scenes)
  assert.deepEqual(accepted.qualityReview.rawReport, item.review)
  outcomes.push({ key: item.key, httpStatus: response.status, passed: accepted.passed,
    manualDecisionRequired: accepted.manualDecisionRequired,
    editorialFindingCount: accepted.qualityReview.editorialHold?.findings?.length ?? 0,
    requestPath, requestSha256: hash(payload), responsePath, responseSha256: hash(envelope) })
}
const proof = { format: 'editorial-text-accept-http-probe-v1', capturedAt: new Date().toISOString(),
  endpoint: '/api/code-node-run', nodeRunAvoided: true, endpointReason: '/api/node-run invokes callNodeExternal; /api/code-node-run executes only supplied VM code',
  service: { pid, processDetails }, workflow: { id: workflow.id, schemaVersion: workflow.schema_version,
    rowVersion: workflow.row_version, nodeCount: workflow.nodes.length, edgesSha256: hash(workflow.edges),
    gateCodeSha256: hash(gate.code) },
  databaseWrites: 0, providerCalls: 0, outcomes }
await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(proof, null, 2))
console.log(JSON.stringify(proof, null, 2))
