// Real text-only acceptance using the saved workflow's models and source run.
// Reads production configuration, never changes it and never requests media.
import fs from 'node:fs/promises'
import pg from 'pg'
import { upgradeCinematicDramaQuality } from '../src/quality-node-presets.ts'
import { SANGUO_SCENE_OUTLINE_PROMPT } from '../src/scene-outline-prompt.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput, validateHistoricalStructuredOutput } from '../src/workflow-core.ts'
import { validateHistoricalProductionPlan, validateHistoricalAgency } from '../src/history-content-guards.ts'
import { applyScopedDramaRepair, attachDramaRepairProvenance } from '../src/drama-repair.ts'
import { historicalSourceReviewContext } from '../src/history-source-review.ts'

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
const directory = `logs/cinematic-drama/${Date.now()}`
const resumeIndex = process.argv.indexOf('--resume-candidate')
const resumeCandidate = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const secrets = new Set()
const summary = { directory, scope: 'real-text-generation-and-configured-source-and-dramaturgy-review', mediaGenerated: false, databaseMutated: false, structurePassed: false, factualPassed: false, dramaturgyPassed: false, attempts: [], calls: [] }
function collectSecrets(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (/(?:api.?key|authorization|password|secret|access.?token)/i.test(key) && typeof item === 'string' && item) secrets.add(item)
    else collectSecrets(item)
  }
}
function redact(value) {
  if (typeof value === 'string') {
    let output = value
    for (const secret of secrets) output = output.replaceAll(secret, '[REDACTED]')
    return output.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/g, 'Bearer [REDACTED]')
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:api.?key|authorization|password|secret|access.?token)/i.test(key) ? '[REDACTED]' : redact(item)]))
  return value
}
async function save(name, value) { await fs.writeFile(`${directory}/${name}`, typeof value === 'string' ? redact(value) : JSON.stringify(redact(value), null, 2)) }
function resolve(path, context) { return path.split('.').reduce((current, key) => current && typeof current === 'object' ? current[key] : undefined, context) }
function parameters(node, context) {
  return Object.fromEntries((node.params ?? []).map(param => {
    const exact = String(param.value).trim().match(/^\$\{([^}]+)\}$/)
    let value = exact ? resolve(exact[1].trim(), context) : renderWorkflowTemplate(String(param.value), context)
    if (!exact && param.type === 'number') value = Number(value || 0)
    if (!exact && param.type === 'boolean') value = value === 'true'
    if (!exact && param.type === 'json') value = JSON.parse(value || '{}')
    return [param.englishName?.trim() || param.name, value]
  }))
}
async function request(path, payload, name, timeout = 420_000) {
  await save(`${name}-request.json`, { url: base + path, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
  const start = Date.now()
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout) })
  const raw = await response.text()
  let result
  try { result = JSON.parse(raw) } catch { result = { unparsedBody: raw } }
  summary.calls.push({ name, elapsedMs: Date.now() - start, httpStatus: response.status, status: result.status })
  await save(`${name}-response.json`, result)
  await save('summary.json', summary)
  if (!response.ok || result.status >= 400 || !Object.hasOwn(result, 'body')) throw Error(`${name}: HTTP ${response.status}: ${JSON.stringify(redact(result))}`)
  if (result.body?.routeError) throw Error(String(result.body.routeError))
  return result.body
}
function structured(body) { return normalizeStructuredTextOutput(body, extractTextResponse(body), 'json') }

try {
  await fs.mkdir(directory, { recursive: true })
  console.log(JSON.stringify({ event: 'started', directory }))
  const probe = await request('/api/code-node-run', { code: 'return {backendReady:true};', context: {}, params: {}, files: [] }, 'backend-probe', 10_000)
  if (probe.backendReady !== true) throw Error('Backend probe did not return executed JSON')
  const original = JSON.parse(await fs.readFile('logs/first-loop-delivery/execution.json', 'utf8'))
  const sourceRun = original.result.nodeRuns.find(node => node.node.id === 'sanguo-scene-outline')
  if (!sourceRun?.inputContext?.historical_sources?.citations?.length) throw Error('Recorded source context is missing')
  const row = (await pool.query('select * from workflow_configs where id=$1', ['wf-sanguo-history-drama'])).rows[0]
  if (!row) throw Error('Production Sanguo workflow missing')
  collectSecrets(row)
  const workflow = upgradeCinematicDramaQuality({ ...row, schemaVersion: row.schema_version })
  const writer = { ...workflow.nodes.find(node => node.id === 'sanguo-scene-outline'), prompt: SANGUO_SCENE_OUTLINE_PROMPT }
  const reviewer = workflow.nodes.find(node => node.id === 'sanguo-scene-outline-review')
  const gate = workflow.nodes.find(node => node.id === 'sanguo-scene-outline-accept')
  if (!reviewer?.prompt?.includes('cinematic-v1 叙事审核') || !gate?.code?.includes('dramaturgyReview')) throw Error('Configured cinematic review migration not available')
  const models = new Map()
  for (const id of new Set([writer.modelId, reviewer.modelId])) {
    const model = (await pool.query('select * from model_configs where id=$1', [id])).rows[0]
    if (!model || model.capability !== 'text') throw Error(`Configured model ${id} is missing or is not text-only`)
    collectSecrets(model); models.set(id, model)
  }
  await save('workflow-before.json', row)
  await save('workflow-effective.json', workflow)
  await save('context.json', sourceRun.inputContext)
  summary.workflowSchemaBefore = row.schema_version
  summary.workflowSchemaEffective = workflow.schemaVersion
  summary.writerModel = writer.modelId
  summary.reviewModel = reviewer.modelId
  let feedback, scopedFeedback
  if (resumeCandidate) { summary.resumedFrom = resumeCandidate; await save('resumed-source.json', { candidatePath: resumeCandidate, purpose: 'Revalidate the already generated candidate with corrected validators; no duplicate writer request' }) }
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(JSON.stringify({ event: 'candidate-started', attempt, directory }))
    const context = { ...sourceRun.inputContext, retry: { attempt, feedback: feedback ?? '' } }
    let prompt = renderWorkflowTemplate(writer.prompt, context)
    if (feedback) prompt += '\n【实际校验及审核反馈】' + JSON.stringify(feedback) + '\n只修复具体问题及直接状态依赖，输出完整cinematic-v1 JSON。'
    const params = parameters(writer, context)
    const payload = { model: models.get(writer.modelId), prompt, params, operation: writer.operation, executionContext: { workflowId: row.id, nodeId: writer.id, nodeName: writer.title, requestKey: `cinematic-outline-${directory.split('/').at(-1)}-${attempt}` } }
    const generated = attempt === 1 && resumeCandidate
      ? JSON.parse(await fs.readFile(resumeCandidate, 'utf8'))
      : structured(await request('/api/node-run', payload, `attempt-${attempt}-writer`))
    await save(`attempt-${attempt}-candidate.json`, generated)
    let validated
    try {
      const candidate = scopedFeedback ? applyScopedDramaRepair(generated, scopedFeedback, context) : generated
      const diagnostics = []
      for (const check of [
        () => validateHistoricalProductionPlan(candidate),
        () => validateHistoricalAgency(candidate, context.historical_sources.citations),
        () => { validated = validateHistoricalStructuredOutput('history.scene-outline', candidate, { ...params, requireDramaContract: true, requireBeatCoverage: true, requireNarrativeClosure: true, input: context.input, historicalSources: context.historical_sources }) },
      ]) { try { check() } catch (error) { diagnostics.push(error instanceof Error ? error.message : String(error)) } }
      if (diagnostics.length) throw Error([...new Set(diagnostics)].join('\n'))
      validated = attachDramaRepairProvenance(validated, scopedFeedback, attempt)
      await save(`attempt-${attempt}-validated.json`, validated)
    } catch (error) {
      const issue = error instanceof Error ? error.message : String(error)
      summary.attempts.push({ attempt, structurePassed: false, issue })
      await save('summary.json', summary)
      feedback = { previousCandidate: generated, issues: issue.split('\n').map(problem => ({ problem, repair: '修复明确的结构/引用/状态/制作容量问题，保留其余内容' })) }
      if (issue.includes('HISTORY_CONTENT_REJECTED:') && /政治动机|历史人物核心立场|本人召集授意|主人.*授权/.test(issue)) {
        const example = JSON.parse(await fs.readFile('tests/fixtures/cinematic-drama-outline.json', 'utf8'))
        feedback.writingReference = { instruction: '下面是同史事的创作结构示例，不是新史料，也不必逐字照抄。重点是两家宾客实际交锋与自己的交往选择。不得把周福/房植写为听报后默许、同意、决定或指挥组织党争的授权者。按当前真实史料及单集规则修正所有同类主体错误，随后使人物状态同步。', episodeDrama: example.episodeDrama, dramaticScenes: example.dramaticScenes, scenes: example.scenes.map(({ historicalBasis: _historicalBasis, adaptationBoundary: _adaptationBoundary, ...scene }) => scene) }
      }
      scopedFeedback = undefined
      if (validated && issue.split('\n').every(problem => problem.startsWith('HISTORY_CONTENT_REJECTED:')) && /建[宁寧]|即位写入|年代不符/.test(issue)) {
        const itemIds = [...issue.matchAll(/HISTORY_CONTENT_REJECTED:\s+(\S+)/g)].map(match => match[1])
        if (itemIds.length) {
          feedback = { previousCandidate: validated, scope: 'scene', issues: itemIds.map(itemId => ({ itemId, problem: issue, repair: '仅删除或纠正本场无依据年月，保留史料明确先后关系、全部其他场景与声画节拍；不要重新构思全剧' })) }
          scopedFeedback = feedback
        }
      }
      console.log(JSON.stringify({ event: 'candidate-structure-failed', attempt, issue }))
      continue
    }
    let reviewCorrection = '', accepted
    for (let reportAttempt = 1; reportAttempt <= 3; reportAttempt++) {
      const reviewContext = { ...context, [writer.resultVar]: validated }
      const reviewParams = parameters(reviewer, reviewContext)
      if (JSON.stringify(reviewParams.candidate) !== JSON.stringify(validated)) throw Error('HISTORY_REVIEW_INPUT_INVALID: Reviewer did not receive the actual outline candidate')
      const reviewPrompt = renderWorkflowTemplate(reviewer.prompt, historicalSourceReviewContext({ ...reviewContext, params: reviewParams })) + reviewCorrection
      const report = structured(await request('/api/node-run', { model: models.get(reviewer.modelId), prompt: reviewPrompt, params: reviewParams, operation: reviewer.operation, executionContext: { workflowId: row.id, nodeId: reviewer.id, nodeName: reviewer.title, requestKey: `cinematic-review-${directory.split('/').at(-1)}-${attempt}-${reportAttempt}` } }, `attempt-${attempt}-review-${reportAttempt}`))
      await save(`attempt-${attempt}-review-${reportAttempt}.json`, report)
      const gateContext = { ...reviewContext, [reviewer.resultVar]: report }
      try {
        accepted = await request('/api/code-node-run', { code: gate.code, prompt: gate.prompt, params: parameters(gate, gateContext), context: gateContext, files: [] }, `attempt-${attempt}-gate-${reportAttempt}`, 15_000)
        break
      } catch (error) {
        if (reportAttempt >= 3 || !String(error).includes('REVIEW_RESULT_INVALID:')) throw error
        reviewCorrection = '\n【只修完整审核报告，不改候选】' + String(error) + '\n上一报告：' + JSON.stringify(report) + '\n叙事证据逐字引用候选声画；事实证据从当前history_source_review.sources的numberedText标签选择sourceSpanId，不重打quote，按expectedCoverage覆盖每一场。修复缺失定位和字段，不改变事实判断。'
        console.log(JSON.stringify({ event: 'review-format-repair', attempt, reportAttempt, issue: String(error).slice(0, 500) }))
      }
    }
    await save(`attempt-${attempt}-acceptance.json`, accepted)
    summary.attempts.push({ attempt, structurePassed: true, factualPassed: accepted.factualReview?.passed === true, dramaturgyPassed: accepted.dramaturgyReview?.passed === true, passed: accepted.passed, issues: accepted.issues, repairScope: accepted.repairContext?.scope })
    if (accepted.passed === true) {
      if (accepted.factualReview?.passed !== true || accepted.dramaturgyReview?.passed !== true || accepted.reviewVersion !== 'cinematic-review-v1') throw Error('Configured gate did not preserve independent factual and dramaturgy acceptance')
      Object.assign(summary, { passed: true, structurePassed: true, factualPassed: true, dramaturgyPassed: true, scenes: accepted.scenes.length, dramaticScenes: accepted.dramaticScenes.length, totalDuration: accepted.totalDuration })
      await save('accepted.json', accepted)
      await save('validated.json', validated)
      await save('summary.json', summary)
      console.log(JSON.stringify({ event: 'passed', ...summary }))
      break
    }
    feedback = accepted.repairContext
    scopedFeedback = feedback
    console.log(JSON.stringify({ event: 'candidate-review-rejected', attempt, issues: accepted.issues, repairScope: feedback?.scope }))
    await save('summary.json', summary)
  }
  if (!summary.passed) throw Error('Cinematic outline did not pass within three candidates; all evidence preserved')
} catch (error) {
  summary.error = redact(error instanceof Error ? error.message : String(error))
  await save('summary.json', summary)
  console.error(JSON.stringify({ event: 'failed', directory, error: summary.error }))
  process.exitCode = 1
} finally { await pool.end() }
