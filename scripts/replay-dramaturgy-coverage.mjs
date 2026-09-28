// Offline replay of the audio-visual coverage gate. Zero paid calls: it reads the outline
// candidate and the reviewer reports an actual execution already stored, then judges them
// with the current validator. It proves that the schema-83 exit removes a bookkeeping
// failure without letting an undeclared segment or a fully exempted scene through.
import fs from 'node:fs/promises'
import pg from 'pg'
import { validateDramaturgyReview } from '../src/drama-quality-presets.ts'

const REVIEW_NODE = 'sanguo-scene-outline-review'
const ACCEPT_NODE = 'sanguo-scene-outline-accept'
const BRANCH_NODE = 'sanguo-scene-outline-accept-error-branch'
const requestedId = process.argv[2] ?? 'latest'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })

const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const rowsOf = value => Array.isArray(value) ? value.map(obj) : []
const groupOf = item => (typeof item.dramaticSceneId === 'string' ? item.dramaticSceneId : '')
const coverageIds = message => [...String(message ?? '').matchAll(/([\w-]+)缺少声画覆盖/g)].map(match => match[1])
/** The archived gate had no exemption channel and ignored any extra field, so dropping
 * `uncovered` before the current validator is exactly what the old rule judged. */
const withoutChannel = report => { const copy = { ...report }; delete copy.uncovered; return copy }

/** Split the collected-defect message back into the individual problems the gate reported. */
function problemList(message) {
  const text = String(message ?? '').replace(/^REVIEW_RESULT_INVALID: 叙事报告 /, '')
  const marker = '不要只修第一项：'
  const listed = text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length) : text
  return listed.split('；(').map(part => part.replace(/^\d+\)\s*/, '')).filter(Boolean)
}
// A report that failed on coverage and nothing else is the case this change is about; any
// other report is replayed as a guard that the new channel cannot mask its real defects.
const isCoverageOnly = message => {
  const parts = problemList(message)
  return parts.length > 0 && parts.every(part => part.includes('缺少声画覆盖') && coverageIds(part).length > 0)
}
const probes = message => ({
  mustCite: /不得免证/.test(String(message ?? '')),
  contradiction: /不能再声明免证/.test(String(message ?? '')),
  uncitedCarrier: /没有被本报告 evidence 引用/.test(String(message ?? '')),
  crossSceneCarrier: /免证声明必须落在同一完整戏内/.test(String(message ?? '')),
  groupFloor: /整场戏没有任何声画 evidence 落点/.test(String(message ?? '')),
  coverageGap: /缺少声画覆盖/.test(String(message ?? '')),
})

async function loadRecord() {
  if (requestedId !== 'latest') {
    const row = (await pool.query('select id,result,created_at from execution_records where id=$1', [requestedId])).rows[0]
    if (!row) throw new Error(`Execution record not found: ${requestedId}`)
    return row
  }
  const list = (await pool.query(
    "select id,result,created_at from execution_records where workflow_id='wf-sanguo-history-drama' and result->>'mode'='step' order by created_at desc limit 200",
  )).rows
  const failedAt = (row, node) => row.result?.nodeRuns?.find(run => run.node?.id === node && run.status === 'failed')
  return list.find(row => failedAt(row, BRANCH_NODE) && /缺少声画覆盖/.test(String(failedAt(row, BRANCH_NODE).error)))
    ?? list.find(row => failedAt(row, BRANCH_NODE))
    ?? list.find(row => failedAt(row, ACCEPT_NODE) && /缺少声画覆盖/.test(String(failedAt(row, ACCEPT_NODE).error)))
    ?? null
}

/** Every reviewer report the record kept, including the earlier attempts it rejected. */
function collectReports(record) {
  const reports = []
  const seen = new Set()
  for (const run of (record.result?.nodeRuns ?? []).filter(run => run.node?.id === REVIEW_NODE)) {
    const outputs = [...rowsOf(run.attempts).map(entry => ({ source: 'stored-attempt', output: entry.output })), { source: 'stored-output', output: run.output }]
    for (const entry of outputs) {
      const review = obj(entry.output).dramaturgyReview
      if (!Object.keys(review).length) continue
      const key = JSON.stringify(review)
      if (seen.has(key)) continue
      seen.add(key)
      reports.push({ source: entry.source, attempt: run.attempt ?? null, revision: run.revision ?? null, review })
    }
  }
  return reports
}

const record = await loadRecord()
if (!record) {
  await pool.end()
  throw new Error('No stored step execution failed on the outline audio-visual coverage gate; pass an execution record id explicitly')
}
const runs = record.result?.nodeRuns ?? []
const acceptRun = runs.find(run => run.node?.id === ACCEPT_NODE && Array.isArray(obj(run.context).outline_candidate?.scenes))
  ?? runs.find(run => run.node?.id === REVIEW_NODE && Array.isArray(obj(run.inputContext).outline_candidate?.scenes))
const candidate = obj(acceptRun?.context?.outline_candidate).scenes ? obj(acceptRun.context.outline_candidate) : obj(acceptRun?.inputContext?.outline_candidate)
const stored = rowsOf(candidate.scenes)
if (stored.length < 2) {
  await pool.end()
  throw new Error('Stored record does not carry a multi-scene outline candidate')
}
const branchRun = runs.find(run => run.node?.id === BRANCH_NODE && run.status === 'failed')
const reports = collectReports(record)
await pool.end()

// Path grounding rewrites a mislabeled itemId from the verified path, so read the scene a
// row really cites the same way the validator does.
const citedScene = row => {
  const index = Number(/^scenes\.(\d+)\./.exec(String(row?.path ?? ''))?.[1] ?? NaN)
  return Number.isInteger(index) && stored[index] ? String(stored[index].id) : String(row?.itemId ?? '')
}
const citedIds = review => new Set(rowsOf(review.evidence).map(citedScene))
const withoutEvidenceOf = (review, ids) => ({ ...review, evidence: rowsOf(review.evidence).filter(row => !ids.has(citedScene(row))) })
const episode = obj(candidate.episodeDrama)
const promiseBeats = new Set([obj(episode.openingPromise), obj(episode.payoff)]
  .flatMap(check => Array.isArray(check.beatIds) ? check.beatIds : []).map(String))
// Mirrors the validator: both ends of the candidate plus whoever owns the opening promise
// or the payoff must carry a citation of their own.
const mustCite = new Set(stored.filter((item, index) => index === 0 || index === stored.length - 1).map(item => String(item.id)))
for (const item of stored) if (rowsOf(item.requiredBeats).some(beat => promiseBeats.has(String(beat.id ?? '')))) mustCite.add(String(item.id))
const reason = '回放占位：本短段是同一场完整戏内的过渡或空镜，无独立台词与可引声画落点，其声画义务由已引证短段承担'
const declaration = (item, carrier) => ({ itemId: String(item.id), reason, ...(carrier ? { coveredBy: String(carrier.id) } : {}) })
const findCarrier = (cited, item, sameGroup) => stored.find(other => String(other.id) !== String(item.id) && groupOf(other)
  && (sameGroup ? groupOf(other) === groupOf(item) : groupOf(other) !== groupOf(item)) && cited.has(String(other.id)))

const attempt = review => { try { validateDramaturgyReview(candidate, review); return { threw: false } } catch (error) { return { threw: true, message: String(error?.message ?? error) } } }
const storedGapIds = [...new Set(coverageIds(branchRun?.error))]

const outcome = {
  scope: 'offline-replay-stored-reports',
  recordId: record.id,
  recordCreatedAt: record.created_at ?? null,
  storedBranchError: branchRun ? String(branchRun.error).slice(0, 600) : null,
  storedCoverageGapIds: storedGapIds,
  candidate: {
    scenes: stored.length,
    dramaticScenes: [...new Set(stored.map(groupOf).filter(Boolean))],
    mustCiteScenes: [...mustCite],
    episodeDrama: Boolean(candidate.episodeDrama),
  },
  reports: [],
}

for (const entry of reports) {
  // Tier A: the archived report as-is. Segments nobody declared must still fail, otherwise
  // the new exit would be a silent pass instead of honest bookkeeping.
  const tierA = attempt(entry.review)
  // The ids the gate itself names are the authoritative "no citation landed here" list.
  const gapIds = tierA.threw ? [...new Set(coverageIds(tierA.message))] : []
  const cited = new Set(stored.map(item => String(item.id)).filter(id => !gapIds.includes(id)))
  // Tier B: the minimal machine patch. Only the named segments gain a declaration, each
  // pointing at an already cited segment of the same complete scene; nothing else changes.
  const exposable = gapIds.filter(id => !mustCite.has(id))
  const blocked = gapIds.filter(id => mustCite.has(id))
  const segment = id => stored.find(item => String(item.id) === id)
  const withPatch = { ...entry.review, uncovered: exposable.map(id => declaration(segment(id), findCarrier(cited, segment(id), true))) }
  const tierB = attempt(withPatch)
  const legacy = attempt(withoutChannel(withPatch))
  const first = stored[0]
  const firstCited = stored.find(item => cited.has(String(item.id)))
  const firstGroup = groupOf(firstCited)
  const groupMembers = stored.filter(item => groupOf(item) === firstGroup)
  // Tier C: abuse attempts, each probing one refusal of the same exemption channel.
  const candidates = [
    {
      name: 'blanket', expect: ['contradiction'],
      review: { ...entry.review, uncovered: stored.map(item => declaration(item, findCarrier(cited, item, true))) },
    },
    {
      name: 'mustCite', expect: ['mustCite'], attributionSensitive: true,
      review: (() => {
        const base = withoutEvidenceOf(entry.review, new Set([String(first.id)]))
        return { ...base, uncovered: [declaration(first, findCarrier(citedIds(base), first, true) ?? firstCited)] }
      })(),
    },
    {
      name: 'uncitedCarrier', expect: ['uncitedCarrier'], review: { ...entry.review, uncovered: gapIds.length > 1 ? [declaration(segment(gapIds[1]), { id: gapIds[0] })] : [] },
    },
    {
      name: 'crossSceneCarrier', expect: ['crossSceneCarrier'], review: { ...entry.review, uncovered: exposable.length ? [declaration(segment(exposable[0]), findCarrier(cited, { id: exposable[0], dramaticSceneId: 'wf-replay-other-dramatic-scene' }, false))] : [] },
    },
    {
      // Wipe one complete scene's citations and route the whole group elsewhere: the floor
      // must refuse it even though every member carries a declaration.
      name: 'groupFloor', expect: ['groupFloor'], attributionSensitive: true,
      review: (() => {
        const base = withoutEvidenceOf(entry.review, new Set(groupMembers.map(item => String(item.id))))
        const outside = citedIds(base)
        return { ...base, uncovered: groupMembers.map(item => declaration(item, findCarrier(outside, item, false))) }
      })(),
    },
  ]
  const negatives = candidates.filter(probe => probe.review.uncovered.length)
    .map(probe => {
      const result = attempt(probe.review)
      const found = result.threw ? probes(result.message) : {}
      return {
        name: probe.name, attributionSensitive: probe.attributionSensitive === true,
        threw: result.threw, refusedBy: probe.expect.filter(key => found[key]),
        missedBy: probe.expect.filter(key => !found[key]), expectedBy: probe.expect, message: result.message ?? null,
      }
    })
  outcome.reports.push({
    source: entry.source, attempt: entry.attempt, revision: entry.revision,
    evidence: rowsOf(obj(entry.review).evidence).length,
    reviewPassed: obj(entry.review).passed ?? null,
    gateCited: cited.size,
    coverageCase: tierA.threw && isCoverageOnly(tierA.message),
    tierA: { threw: tierA.threw, gapIds, otherProblems: tierA.threw ? problemList(tierA.message).filter(part => !part.includes('缺少声画覆盖')).length : 0, message: tierA.message ?? null },
    tierB: { threw: tierB.threw, declared: withPatch.uncovered.map(row => row.itemId), carrierless: withPatch.uncovered.filter(row => !row.coveredBy).map(row => row.itemId), blocked, remainingProblems: tierB.threw ? problemList(tierB.message).length : 0, gapLeft: tierB.threw ? [...new Set(coverageIds(tierB.message))] : [], message: tierB.message ?? null },
    legacyOnB: { threw: legacy.threw, gapIds: legacy.threw ? [...new Set(coverageIds(legacy.message))] : [], message: legacy.message ?? null },
    negatives,
  })
}

const checks = outcome.reports.map(entry => ({
  // Silence stays a defect: a report that failed must have had its uncovered segments named,
  // and a report that passes needs no declaration at all. Neither may be laundered by the exit.
  a_stillFails: !entry.tierA.threw || entry.tierA.gapIds.length > 0,
  // In the coverage case the machine patch must converge in one step, with no declaration
  // lacking a carrier and no must-cite segment routed through the channel.
  b_converges: !entry.coverageCase || (entry.tierB.threw === false && entry.tierB.carrierless.length === 0 && entry.tierB.blocked.length === 0),
  // Outside the coverage case the report carries unrelated real defects, so the channel must
  // neither clear them nor invent new ones: the defect count may only shrink.
  b_neverMasksDefects: entry.coverageCase || (entry.tierB.threw === true && entry.tierB.remainingProblems <= entry.tierA.otherProblems + entry.tierA.gapIds.length),
  // The same variant judged by the archived rule still fails: the exit is the only change.
  b_legacyStillFails: entry.legacyOnB.threw === true && entry.legacyOnB.gapIds.length > 0,
  // Refusals whose construction depends on an exactly attributed cited set are only asserted
  // on the coverage case; on other reports the replay cannot attribute every row.
  c_refusals: entry.negatives.length > 0
    && entry.negatives.filter(negative => entry.coverageCase || !negative.attributionSensitive)
      .every(negative => negative.threw && negative.refusedBy.length === negative.expectedBy.length),
}))
const coverageCases = outcome.reports.filter(entry => entry.coverageCase)
outcome.checks = checks
outcome.passed = outcome.reports.length > 0 && checks.every(entry => Object.values(entry).every(Boolean)) && coverageCases.length > 0
  // The replay must reproduce the failure the user actually saw, id for id.
  && coverageCases.some(entry => storedGapIds.length > 0 && entry.tierA.gapIds.length === storedGapIds.length
    && storedGapIds.every(id => entry.tierA.gapIds.includes(id)))

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
const dir = `logs/cinematic-drama/dramaturgy-coverage-replay-${stamp}`
await fs.mkdir(dir, { recursive: true })
await fs.writeFile(`${dir}/report.json`, JSON.stringify(outcome, null, 2))
console.log(JSON.stringify({
  stage: 'finished', recordId: record.id, reports: outcome.reports.length, passed: outcome.passed, dir,
  coverageCases: coverageCases.length,
  note: coverageCases.length ? null : 'the archived reports of this record carry no coverage-only failure to replay; pass the id of a record that failed on 缺少声画覆盖',
  storedCoverageGapIds: storedGapIds,
  perReport: outcome.reports.map(entry => ({
    source: entry.source, evidence: entry.evidence, gateCited: entry.gateCited, coverageCase: entry.coverageCase,
    a: entry.tierA.threw ? `${entry.tierA.gapIds.length} gaps / ${entry.tierA.otherProblems} other defects` : 'THROUGH',
    b: entry.tierB.threw ? `fails: ${entry.tierB.gapLeft.length ? entry.tierB.gapLeft.length + ' gap left' : entry.tierB.remainingProblems + ' unrelated defects'}` : `ok via ${entry.tierB.declared.length} declarations`,
    legacyB: entry.legacyOnB.threw ? 'legacy still fails' : 'LEGACY PASSED (regression)',
    c: entry.negatives.map(negative => `${negative.name}:${negative.threw ? (negative.refusedBy.length === negative.expectedBy.length ? 'refused' : 'wrong-reason') : 'THROUGH'}`).join(' '),
  })),
}, null, 2))
if (!outcome.passed) process.exitCode = 1
