import test from 'node:test'
import assert from 'node:assert/strict'
import { withModelRequestAdvisoryLock } from '../server/model-request-lock.ts'

test('a keyed request holds and releases one PostgreSQL advisory lock', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  let released = 0
  const pool = { connect: async () => ({
    query: async (sql: string, values?: unknown[]) => { calls.push({ sql, values }) },
    release: () => { released += 1 },
  }) }

  assert.equal(await withModelRequestAdvisoryLock(pool, 'record:generation-1:fingerprint', async () => 'result'), 'result')
  assert.match(calls[0].sql, /pg_advisory_lock/)
  assert.match(calls[1].sql, /pg_advisory_unlock/)
  assert.deepEqual(calls.map(call => call.values), [
    ['record:generation-1:fingerprint'],
    ['record:generation-1:fingerprint'],
  ])
  assert.equal(released, 1)
})

test('the advisory lock is released when the provider request fails', async () => {
  const sql: string[] = []
  let released = false
  const pool = { connect: async () => ({
    query: async (statement: string) => { sql.push(statement) },
    release: () => { released = true },
  }) }

  await assert.rejects(withModelRequestAdvisoryLock(pool, 'same-request', async () => {
    throw new Error('provider failed')
  }), /provider failed/)
  assert.equal(sql.length, 2)
  assert.equal(released, true)
})

test('unkeyed calls do not consume a database connection', async () => {
  let connects = 0
  const pool = { connect: async () => { connects += 1; throw new Error('must not connect') } }
  assert.equal(await withModelRequestAdvisoryLock(pool, undefined, async () => 42), 42)
  assert.equal(connects, 0)
})
