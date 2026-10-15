#!/usr/bin/env node
/** Offline-only preview. Input files are exported execution rows, not paths
 * to a database or provider. No apply mode exists. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { prepareOriginalScene2HistoricalAdmission,
  inspectOriginalScene2ReviewEnvelope } from '../server/original-scene2-historical-admission.mjs'

const fail = message => { throw Error(`ORIGINAL_SCENE2_HISTORICAL_PREVIEW_INVALID: ${message}`) }
const args = process.argv.slice(2), inputs = {}
for (let index = 0; index < args.length; index++) {
  const flag = args[index]
  if (!['--original-row', '--new-first-row', '--parent-row', '--review-bundle'].includes(flag)
    || inputs[flag] || !path.isAbsolute(String(args[index + 1] ?? '')))
    fail(`expected one absolute local JSON file for ${flag}`)
  inputs[flag] = args[++index]
}
if (!inputs['--original-row'] || !inputs['--new-first-row'] || !inputs['--parent-row'])
  fail('--original-row, --new-first-row, and --parent-row are required')
const readJson = filename => JSON.parse(readFileSync(filename, 'utf8'))
const prepared = prepareOriginalScene2HistoricalAdmission(
  readJson(inputs['--original-row']), readJson(inputs['--new-first-row']),
  readJson(inputs['--parent-row']))
const reviewEnvelope = inputs['--review-bundle'] && prepared.proposal
  ? inspectOriginalScene2ReviewEnvelope(prepared, readJson(inputs['--review-bundle'])) : undefined
console.log(JSON.stringify({ mode: 'offline-read-only', providerCalls: 0, databaseCalls: 0,
  databaseWrites: 0, ...prepared, ...(reviewEnvelope ? { reviewEnvelope } : {}) }, null, 2))
