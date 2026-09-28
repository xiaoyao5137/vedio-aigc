#!/usr/bin/env node
// Offline comparison only: preserve the provider response and remove exactly
// the storyboard-only field accidentally emitted in the outline's first scene.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { normalizeDramaOutline } from '../src/history-drama.ts'
import { validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { validateHistoricalProductionPlan, validateHistoricalAgency } from '../src/history-content-guards.ts'
import { validateEpisodeNarrativeBoundary } from '../src/episode-boundary.ts'

const directory = path.resolve(process.argv[2] ?? 'logs/dramatic-expression/live-20260928/episode-610-schema150')
const read = async file => JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'))
const write = async (file, value) => fs.writeFile(path.join(directory, file), JSON.stringify(value, null, 2), { mode: 0o600 })
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

const original = await read('candidate.json')
const context = await read('context.json')
const params = await read('params.json')
const prompt = await fs.readFile(path.join(directory, 'prompt.txt'), 'utf8')
const originalFileHash = hash(await fs.readFile(path.join(directory, 'candidate.json'), 'utf8'))
assert.equal(Array.isArray(original.scenes), true)
assert.equal(typeof original.scenes[0]?.shotIntent, 'string')
assert.deepEqual(original.scenes.flatMap((scene, index) => Object.hasOwn(scene, 'shotIntent') ? [index] : []), [0])

const repaired = structuredClone(original)
const omittedValue = repaired.scenes[0].shotIntent
delete repaired.scenes[0].shotIntent
const restored = structuredClone(repaired)
restored.scenes[0].shotIntent = omittedValue
assert.deepEqual(restored, original, 'all other structured fields and original transport text remain byte-equivalent')
const expected = { ...params, requireBeatCoverage: true, requireNarrativeClosure: true,
  requireDramaContract: prompt.includes('cinematic-v1'), requireEditorialGrammar: prompt.includes('editorialRole'),
  requireCharacterVisuals: prompt.includes('【人物年龄与场景造型·大纲】'), deriveInheritedStates: true,
  input: context.input, historicalSources: context.historical_sources }
const checks = []
const normalized = normalizeDramaOutline(repaired, expected)
for (const [name, check] of [
  ['productionCapacity', () => validateHistoricalProductionPlan(normalized)],
  ['historicalAgency', () => validateHistoricalAgency(normalized, context.historical_sources.citations)],
  ['episodeBoundary', () => validateEpisodeNarrativeBoundary(normalized, context.input, true)],
  ['structuredOutput', () => validateHistoricalStructuredOutput('history.scene-outline', repaired, expected)],
]) {
  try { check(); checks.push({ name, passed: true }) }
  catch (error) { checks.push({ name, passed: false, issue: String(error) }) }
}
const proof = { sourceDirectory: directory, episode: context.input.episode_number,
  originalCandidateFileSha256: originalFileHash,
  originalStructuredSha256: hash(original), repairedStructuredSha256: hash(repaired),
  omittedPath: 'scenes[0].shotIntent', omittedValue, changedStructuredPaths: ['scenes[0].shotIntent'],
  originalTextAndRawPreserved: repaired.text === original.text && JSON.stringify(repaired.raw) === JSON.stringify(original.raw),
  restoredExactlyEqualsOriginal: true, checks,
  passed: checks.every(check => check.passed), modelRequests: 0, mediaGenerated: false,
  manualFilmAcceptance: false, aestheticAcceptance: false }
await write('candidate-structural-repair.json', repaired)
await write('structural-repair-proof.json', proof)
console.log(JSON.stringify(proof))
if (!proof.passed) process.exitCode = 1
