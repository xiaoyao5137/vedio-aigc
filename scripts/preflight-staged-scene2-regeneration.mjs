#!/usr/bin/env node
/** Read-only scene-02 regeneration preflight. No image/video/provider request. */
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { decodeExecutionState } from '../src/execution-storage.ts'
import { prepareScene2RegenerationPreflight } from '../server/staged-scene2-regeneration-preflight.mjs'

function args(values) {
  const result = {}
  for (let i = 0; i < values.length; i++) {
    const flag = values[i]
    if (!['--source', '--expected-source-md5'].includes(flag)
      || result[flag] !== undefined || !values[i + 1] || values[i + 1].startsWith('--'))
      throw Error(`SCENE2_REGEN_PREFLIGHT_INVALID: unexpected or incomplete ${flag}`)
    result[flag] = values[++i]
  }
  if (result['--source'] && !/^record-[\w-]+$/.test(result['--source']))
    throw Error('SCENE2_REGEN_PREFLIGHT_INVALID: source ID is invalid')
  if (result['--expected-source-md5'] && (!result['--source']
    || !/^[a-f0-9]{32}$/.test(result['--expected-source-md5'])))
    throw Error('SCENE2_REGEN_PREFLIGHT_INVALID: source MD5 lock is invalid')
  return result
}

async function main() {
  const options = args(process.argv.slice(2))
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL
    ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
  await db.connect()
  try {
    await db.query('BEGIN READ ONLY')
    const row = async id => (await db.query('SELECT *,md5(result::text) AS result_md5 FROM execution_records WHERE id=$1', [id])).rows[0]
    const original = await row('record-4x5m31')
    const first = options['--source'] ? await row(options['--source']) : undefined
    if (options['--source'] && (!first
      || options['--expected-source-md5'] && first.result_md5 !== options['--expected-source-md5']))
      throw Error('SCENE2_REGEN_PREFLIGHT_INVALID: first-shot source missing or MD5 changed')
    const marker = first ? decodeExecutionState(first.result).sceneCutCompositeRecovery : undefined
    const parent = marker?.sourceExecutionId ? await row(marker.sourceExecutionId) : undefined
    const imageApproval = marker?.version
      === 'source-bound-composite-a8b6-fresh-first-shot-v1'
      && marker.imageApprovalExecutionId
      ? await row(marker.imageApprovalExecutionId) : undefined
    const prepared = prepareScene2RegenerationPreflight(original,
      first, parent, process.cwd(), imageApproval)
    await db.query('ROLLBACK')
    console.log(JSON.stringify({ mode: 'read-only', ...prepared }, null, 2))
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { await db.end() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
