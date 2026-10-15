import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { A8B6_FRESH_FRAME_PARENT_ID } from
  '../server/staged-scene-cut-a8b6-fresh-frame.mjs'
import { verifyA8B6LocalCompositeSourceReceiptV6Sync } from
  '../server/staged-scene-cut-a8b6-local-composite-admission-v6.mjs'
import { A8B6_LOCAL_V7_REJECTED_V6,
  assertA8B6LocalV7RejectedV6State,
  verifyA8B6LocalV7RejectedV6Ancestry } from
  '../server/staged-scene-cut-a8b6-local-v7-rejected-ancestry.mjs'

test('V7 cannot treat a rejected V6 frame as approved', () => {
  const state = { id: A8B6_LOCAL_V7_REJECTED_V6.executionId,
    nodeRuns: Array.from({ length: 51 }, () => ({ status: 'idle' })) }
  state.nodeRuns[49] = { status: 'success', output: { passed: true } }
  state.nodeRuns[50] = { status: 'success', output: { passed: true } }
  assert.throws(() => assertA8B6LocalV7RejectedV6State(state,
    A8B6_LOCAL_V7_REJECTED_V6.resultMd5, {}, '', {}, [], []),
  /A8B6_LOCAL_V7_ANCESTRY_INVALID/)
})

test('V7 verifies V6 signed source, real model rejection and no image payment',
  { skip: !process.env.A8B6_LIVE_ANCESTRY_TEST }, async () => {
    const root = process.cwd()
    const actual = await verifyA8B6LocalV7RejectedV6Ancestry(root)
    assert.deepEqual(actual.rejected, A8B6_LOCAL_V7_REJECTED_V6)
    assert.equal(actual.sourceReceiptSha256,
      A8B6_LOCAL_V7_REJECTED_V6.sourceReceiptSha256)
    assert.equal(actual.rejectedImageSha256,
      '62ffed8c2f94027ce519061bc2979c61aea1b71210d5c43763cfc96fc1c34254')

    const signed = verifyA8B6LocalCompositeSourceReceiptV6Sync(root)
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL
      ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
    await db.connect()
    try {
      await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const ids = [A8B6_FRESH_FRAME_PARENT_ID,
        A8B6_LOCAL_V7_REJECTED_V6.executionId]
      const rows = (await db.query(`SELECT id,result,md5(result::text) result_md5
        FROM execution_records WHERE id=ANY($1)`, [ids])).rows
      const byId = new Map(rows.map(row => [row.id, row]))
      const timingRow = byId.get(ids[0]), rejectedRow = byId.get(ids[1])
      assert.ok(timingRow && rejectedRow)
      const timing = decodeExecutionState(timingRow.result)
      const rejected = decodeExecutionState(rejectedRow.result)
      const reviewLedgers = (await db.query(`SELECT * FROM model_execution_records
        WHERE workflow_id='wf-sanguo-history-drama'
          AND node_id='sanguo-scene-cut-review'
          AND request_data->>'requestKey' LIKE $1`, [`${ids[1]}:%`])).rows
      const imageLedgers = (await db.query(`SELECT id FROM model_execution_records
        WHERE workflow_id='wf-sanguo-history-drama'
          AND node_id='sanguo-scene-cut-first-frame'
          AND request_data->>'requestKey' LIKE $1`, [`${ids[1]}:%`])).rows
      const check = (state: typeof rejected, ledgers = reviewLedgers,
        images = imageLedgers) => assertA8B6LocalV7RejectedV6State(
          state, rejectedRow.result_md5, timing, timingRow.result_md5,
          signed, ledgers, images, root)
      assert.deepEqual(check(rejected), A8B6_LOCAL_V7_REJECTED_V6)

      const promoted = structuredClone(rejected)
      promoted.nodeRuns[49].output.passed = true
      assert.throws(() => check(promoted), /A8B6_LOCAL_V7_ANCESTRY_INVALID/)

      const signedOff = structuredClone(rejected)
      signedOff.nodeRuns[50].status = 'success'
      assert.throws(() => check(signedOff), /A8B6_LOCAL_V7_ANCESTRY_INVALID/)

      const tamperedReview = structuredClone(rejected)
      tamperedReview.nodeRuns[49].output.issues[0].code = 'wall_passed'
      assert.throws(() => check(tamperedReview),
        /A8B6_LOCAL_V7_ANCESTRY_INVALID/)

      assert.throws(() => check(rejected, reviewLedgers,
        [{ id: 'unexpected-paid-image' }]),
      /A8B6_LOCAL_V7_ANCESTRY_INVALID/)
      await db.query('ROLLBACK')
    } catch (error) {
      await db.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { await db.end() }
  })
