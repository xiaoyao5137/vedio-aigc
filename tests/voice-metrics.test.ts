import test from 'node:test'
import assert from 'node:assert/strict'
import { readVoiceMetrics, summarizeVoiceRequests } from '../server/voice-metrics.ts'
import pg from 'pg'
import { createHash, randomUUID } from 'node:crypto'
import { voiceReviewIdentity } from '../src/voice-review.ts'

test('voice metrics deduplicate task recovery, preserve missing charges and use observed request denominators', () => {
  const rows = [
    { id: 'query', modelId: 'm', taskId: 'one', status: 'processing', requestKey: 'run:attempt-1:revision-0:video:0', preparationMs: 10 },
    { id: 'done', modelId: 'm', taskId: 'one', status: 'succeeded', requestKey: 'run:attempt-1:revision-0:video:0', units: '4.8', preparationMs: 20 },
    { id: 'retry', modelId: 'm', taskId: 'two', status: 'succeeded', requestKey: 'run:attempt-2:revision-1:video:0', units: null },
    { id: 'blocked', modelId: 'm', status: 'failed', error: 'VOICE_BINDING_MISSING: 张三', preparationMs: 30 },
    { id: 'capability', modelId: 'm', status: 'failed', error: 'VOICE_PROVIDER_UNSUPPORTED: 旧模型' },
    { id: 'unknown-cost', modelId: 'other', status: 'succeeded', taskId: 'three', units: '' },
  ]
  const result = summarizeVoiceRequests(rows)
  assert.equal(result.requests, 6)
  assert.equal(result.bindingBlockRate, 1 / 6)
  assert.equal(result.unsupportedBlocks, 1)
  assert.equal(result.preparationMeanMs, 20)
  assert.equal(result.remoteTasks, 3)
  assert.equal(result.completed.length, 3)
  assert.equal(result.additionalTasksAtSamePosition, 1)
  assert.deepEqual(result.costs, [{ modelId: 'm', tasks: 2, reported: 1, units: 4.8 }, { modelId: 'other', tasks: 1, reported: 0, units: null }])
  assert.equal(summarizeVoiceRequests([]).bindingBlockRate, null)
  assert.equal(summarizeVoiceRequests([]).preparationMeanMs, null)
})

test('voice metrics query isolates workflows and dates, matches reviews to exact voice versions and preserves unknown fees', { skip: !process.env.VOICE_TEST_DATABASE_URL }, async () => {
  const schema = `voice_metrics_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: process.env.VOICE_TEST_DATABASE_URL })
  await admin.query(`create schema ${schema}`)
  const db = new pg.Pool({ connectionString: process.env.VOICE_TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  try {
    await db.query(`create table model_execution_records(id text,model_id text,task_id text,status text,error text,workflow_id text,capability text,request_data jsonb,response_data jsonb,created_at timestamptz default now(),updated_at timestamptz default now()); create table voice_listening_reviews(id text primary key,review jsonb)`)
    const characters = [{ characterId: 'actor', characterName: '甲', voiceId: 'voice', version: 1, modelId: 'model', accountScope: 'account' }]
    for (const [id, workflow, age, version, response] of [
      ['passed', 'wf', 0, 1, { originalUrl: 'https://example.com/passed.mp4', raw: { data: { final_unit_deduction: '4.8' } } }],
      ['missing', 'wf', 0, 2, { url: 'https://example.com/missing.mp4' }],
      ['other', 'other', 0, 1, {}],
      ['old', 'wf', 31, 1, {}],
    ] as const) {
      await db.query(`insert into model_execution_records(id,model_id,task_id,status,workflow_id,capability,request_data,response_data,created_at) values($1,'model',$1,'succeeded',$2,'video',$3,$4,now()-$5*interval '1 day')`, [id, workflow, { voicePolicy: 'strict', params: { characterVoices: characters.map(c => ({ ...c, version })) } }, response, age])
    }
    for (const videoUrl of ['https://example.com/passed.mp4', 'https://example.com/missing.mp4']) {
      const id = createHash('sha256').update(voiceReviewIdentity({ videoUrl, characters })).digest('hex')
      await db.query('insert into voice_listening_reviews values($1,$2)', [id, { status: 'passed' }])
    }
    await db.query(`insert into model_execution_records(id,model_id,task_id,status,workflow_id,capability,request_data) values('silent','model','silent','succeeded','wf','video','{"voicePolicy":"strict","params":{}}')`)
    const stats = await readVoiceMetrics(db, 'wf')
    assert.equal(stats.totalMatchingRequests, 3)
    assert.equal(stats.completedTasks, 3)
    assert.equal(stats.reviewedTaskDenominator, 2)
    assert.equal(stats.completedWithoutVoiceBinding, 1)
    assert.deepEqual(stats.reviews, { passed: 1, failed: 0, uncertain: 0, missing: 1 })
    assert.equal(stats.unresolvedReviewRate, 0.5, 'a review for version 1 cannot pass version 2')
    assert.deepEqual(stats.costs, [{ modelId: 'model', tasks: 3, reported: 1, units: 4.8 }])
    const empty = await readVoiceMetrics(db, 'empty')
    assert.equal(empty.failedReviewRate, null)
    assert.equal(empty.capped, false)
  } finally {
    await db.end()
    await admin.query(`drop schema ${schema} cascade`)
    await admin.end()
  }
})
