// Read-only recovery for a local outline request whose HTTP client disconnected
// while the server continued working. Never sends another model request.
import fs from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { modelRequestFingerprint } from '../server/model-request-key.ts'
import { extractTextResponse, normalizeStructuredTextOutput, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { validateHistoricalProductionPlan, validateHistoricalAgency } from '../src/history-content-guards.ts'
import { normalizeDramaOutline } from '../src/history-drama.ts'

const directory = path.resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw Error('Usage: node scripts/recover-dramatic-expression.mjs <existing-output-directory>')
const read = async name => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'))
const save = async (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2), { mode: 0o600 })
const request = (await read('request.json')).body
const source = await read('source.json')
const selection = await read('workflow-selection.json')
const params = await read('params.json')
const requestKey = request.executionContext?.requestKey
if (!requestKey || requestKey !== (await read('summary.json')).requestKey) throw Error('Saved requestKey does not match the original outline summary')
const fingerprint = modelRequestFingerprint(request)
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc',
  options: '-c default_transaction_read_only=on' })
try {
  const rows = (await pool.query(`SELECT id,status,http_status,duration_ms,created_at,request_data->>'fingerprint' AS fingerprint,
      response_data,error FROM model_execution_records WHERE request_data->>'requestKey'=$1 ORDER BY created_at,id`, [requestKey])).rows
  const ledger = rows.map(({ response_data: _response, ...row }) => row)
  await save('recovery-ledger.json', ledger)
  const matches = rows.filter(row => row.fingerprint === fingerprint)
  if (!matches.length) {
    const state = { requestKey, state: rows.length ? 'fingerprint-mismatch' : 'pending-or-no-ledger', ledgerCount: rows.length,
      modelRequestsSentByRecovery: 0 }
    await save('recovery-summary.json', state)
    console.log(JSON.stringify(state))
    process.exitCode = rows.length ? 2 : 3
  } else {
    const completed = matches.findLast(row => row.status === 'succeeded' && row.http_status >= 200 && row.http_status < 300)
    if (!completed) {
      const state = { requestKey, state: matches.at(-1).status, ledgerCount: rows.length, matchingCount: matches.length,
        modelRequestsSentByRecovery: 0 }
      await save('recovery-summary.json', state)
      console.log(JSON.stringify(state))
      process.exitCode = matches.at(-1).status === 'processing' ? 3 : 2
    } else {
      const response = { status: completed.http_status, body: completed.response_data }
      await save('recovered-response.json', response)
      const candidate = normalizeStructuredTextOutput(response.body, extractTextResponse(response.body), 'json')
      await save('recovered-candidate.json', candidate)
      const context = source.usedInputContext
      const expected = { ...params, requireBeatCoverage: true, requireNarrativeClosure: true,
        requireDramaContract: selection.writer.prompt.includes('cinematic-v1'),
        requireEditorialGrammar: selection.writer.prompt.includes('editorialRole'), deriveInheritedStates: true,
        input: context.input, historicalSources: context.historical_sources }
      const issues = []
      let structured
      for (const [name, check] of [
        ['productionCapacity', () => validateHistoricalProductionPlan(normalizeDramaOutline(candidate, expected))],
        ['historicalAgency', () => validateHistoricalAgency(normalizeDramaOutline(candidate, expected), context.historical_sources.citations)],
        ['structuredOutput', () => { structured = validateHistoricalStructuredOutput(selection.writer.operation, candidate, expected) }],
      ]) {
        try { check() } catch (error) { issues.push({ check: name, issue: error instanceof Error ? error.message : String(error) }) }
      }
      await save('recovery-validation.json', { issues, checksPassed: issues.length === 0, modelRequestsSentByRecovery: 0,
        reviewerCalledByRecovery: false, mediaGeneratedByRecovery: false })
      if (structured) await save('recovered-validated.json', structured)
      const state = { requestKey, state: issues.length ? 'candidate-needs-revision' : 'validated',
        ledgerId: completed.id, providerDurationMs: completed.duration_ms, sceneCount: candidate.scenes?.length,
        totalDuration: candidate.totalDuration, issues, modelRequestsSentByRecovery: 0 }
      await save('recovery-summary.json', state)
      console.log(JSON.stringify(state))
      if (issues.length) process.exitCode = 2
    }
  }
} finally { await pool.end() }
