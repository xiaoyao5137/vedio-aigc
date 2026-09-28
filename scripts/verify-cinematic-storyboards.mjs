// Pre-plan the first two approved shooting segments with real configured text
// models. The previous script is a plan; this runner never fabricates media or
// actual-tail evidence and cannot authorize rendering a continuous second shot.
import fs from 'node:fs/promises'
import pg from 'pg'
import { SANGUO_CINEMATIC_STORYBOARD_PROMPT } from '../src/storyboard-prompt.ts'
import { storyboardDramaContext } from '../src/history-drama.ts'
import { historicalSourceReviewContext } from '../src/history-source-review.ts'
import { upgradeCinematicDramaQuality } from '../src/quality-node-presets.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { extractTextResponse, normalizeStructuredTextOutput } from '../src/workflow-core.ts'
import { generateHistoricalStoryboard, STORYBOARD_SEGMENTS_KEY, cleanStoryboardForValidation, sceneFromStoryboardSegment } from '../src/storyboard-runtime.ts'

const directory = process.argv[2]
if (!directory) throw Error('Usage: node scripts/verify-cinematic-storyboards.mjs logs/cinematic-drama/TIMESTAMP')
const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:5173'
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc' })
const secrets = new Set()
const summary = { directory, scope: 'preplanned-scripts-only', actualTailEvidenceUsed: false, mediaGenerated: false, databaseMutated: false, accepted: [], calls: [], attempts: [] }
function collectSecrets(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) if (/(?:api.?key|authorization|password|secret|access.?token)/i.test(key) && typeof item === 'string' && item) secrets.add(item); else collectSecrets(item)
}
function redact(value) {
  if (typeof value === 'string') { let text = value; for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]'); return text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/g, 'Bearer [REDACTED]') }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:api.?key|authorization|password|secret|access.?token)/i.test(key) ? '[REDACTED]' : redact(item)]))
  return value
}
async function save(name, value) { await fs.writeFile(`${directory}/${name}`, JSON.stringify(redact(value), null, 2)) }
function params(node, context) { return Object.fromEntries(node.params.map(param => {
  const exact = String(param.value).trim().match(/^\$\{([^}]+)\}$/)
  let value = exact ? exact[1].trim().split('.').reduce((item, key) => item && typeof item === 'object' ? item[key] : undefined, context) : renderWorkflowTemplate(String(param.value), context)
  if (!exact && param.type === 'json') value = JSON.parse(value || '{}')
  if (!exact && param.type === 'number') value = Number(value || 0)
  if (!exact && param.type === 'boolean') value = value === 'true'
  return [param.englishName?.trim() || param.name, value]
})) }
async function request(path, payload, name) {
  await save(name + '-request.json', { url: base + path, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
  const start = Date.now()
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(420_000) })
  const raw = await response.text()
  let result
  try { result = JSON.parse(raw) } catch { result = { raw } }
  summary.calls.push({ name, elapsedMs: Date.now() - start, httpStatus: response.status, status: result.status })
  await save(name + '-response.json', result)
  await save('storyboard-summary.json', summary)
  if (!response.ok || result.status >= 400 || !Object.hasOwn(result, 'body')) throw Error(`${name}: HTTP ${response.status}: ${JSON.stringify(redact(result))}`)
  if (result.body?.routeError) throw Error(String(result.body.routeError))
  return result.body
}
function structured(body) { return normalizeStructuredTextOutput(body, extractTextResponse(body), 'json') }

try {
  const outline = JSON.parse(await fs.readFile(directory + '/accepted.json', 'utf8'))
  if (outline.passed !== true || outline.factualReview?.passed !== true || outline.dramaturgyReview?.passed !== true) throw Error('Outline has not passed both configured reviews')
  const baseContext = JSON.parse(await fs.readFile(directory + '/context.json', 'utf8'))
  const row = (await pool.query('select * from workflow_configs where id=$1', ['wf-sanguo-history-drama'])).rows[0]
  if (!row) throw Error('Production workflow missing')
  const workflow = upgradeCinematicDramaQuality({ ...row, schemaVersion: row.schema_version })
  const writer = workflow.nodes.find(node => node.id === 'sanguo-shot-script')
  const reviewer = workflow.nodes.find(node => node.id === 'sanguo-shot-script-review')
  const gate = workflow.nodes.find(node => node.id === 'sanguo-shot-script-accept')
  const models = new Map()
  for (const id of new Set([writer.modelId, reviewer.modelId])) {
    const model = (await pool.query('select * from model_configs where id=$1', [id])).rows[0]
    if (!model || model.capability !== 'text') throw Error('Only configured text models may be called')
    collectSecrets(model); models.set(id, model)
  }
  await save('outline-accepted.json', outline)
  let previousShot, writerCalls = 0, reviewCalls = 0
  for (const [sceneIndex, scene] of outline.scenes.slice(0, 2).entries()) {
    console.log(JSON.stringify({ event: 'storyboard-started', sceneId: scene.id, sceneIndex, cast: scene.cast, directory }))
    const planning = { ...baseContext, scene_outline: outline, scene, loop: { index: sceneIndex, previous: previousShot ? { shot_script: previousShot } : {} }, planningOnly: true }
    const context = storyboardDramaContext(planning)
    const prompt = renderWorkflowTemplate(SANGUO_CINEMATIC_STORYBOARD_PROMPT, context) + '\n【当前执行范围】本次只做尚未拍摄的分镜预规划；前镜脚本也是计划，worldState所有position/heldProps/pendingAction保持unknown，不得填observed、actualTailEvidence或声称已验收成片。计划构图与动作仍须具体完整；正式生成后续媒体前必须接入前镜真实采证。'
    const result = await generateHistoricalStoryboard({ prompt,
      expected: { scene, previousShot, requireDramaContract: true, requireContinuityContract: true, requireDynamicPacing: true, requireNarrativeClosure: true, productionSpeechRate: 4.5, aspectRatio: baseContext.input.aspect_ratio },
      onAttempt: event => { summary.attempts.push({ sceneId: scene.id, ...event }); console.log(JSON.stringify({ event: 'storyboard-repair', sceneId: scene.id, ...event })) },
      generate: async nextPrompt => {
        writerCalls++
        if (writerCalls > 6) throw Error('STORYBOARD_SMOKE_BUDGET: Two-scene test exhausted six writer requests')
        return request('/api/node-run', { model: models.get(writer.modelId), prompt: nextPrompt, params: params(writer, context), operation: writer.operation, executionContext: { workflowId: row.id, nodeId: writer.id, nodeName: writer.title, requestKey: `cinematic-storyboard-${directory.split('/').at(-1)}-${writerCalls}` } }, `storyboard-writer-${writerCalls}`)
      },
      review: async candidate => {
        const segments = candidate[STORYBOARD_SEGMENTS_KEY] ?? [candidate]
        const reviews = []
        for (const [index, segment] of segments.entries()) {
          const partScene = segments.length > 1 ? sceneFromStoryboardSegment(scene, segment, index, segments.length) : scene
          const current = { ...context, scene: partScene, [writer.resultVar]: segment, loop: { ...context.loop, previous: (index ? segments[index - 1] : previousShot) ? { shot_script: index ? segments[index - 1] : previousShot } : {} } }
          let correction = ''
          for (let attempt = 1; attempt <= 3; attempt++) {
            reviewCalls++
            if (reviewCalls > 9) throw Error('STORYBOARD_SMOKE_BUDGET: Review request budget exhausted')
            const values = params(reviewer, current)
            if (JSON.stringify(values.candidate) !== JSON.stringify(segment)) throw Error('HISTORY_REVIEW_INPUT_INVALID: Reviewer did not receive the actual storyboard segment')
            const reviewPrompt = renderWorkflowTemplate(reviewer.prompt, historicalSourceReviewContext({ ...current, params: values }))
            const report = structured(await request('/api/node-run', { model: models.get(reviewer.modelId), prompt: reviewPrompt + '\n本次只有分镜预规划，无实际视频，前镜为计划脚本。只检查脚本合同与已分配节拍，不能声称实际视觉或口型通过。' + correction, params: values, operation: reviewer.operation, executionContext: { workflowId: row.id, nodeId: reviewer.id, requestKey: `cinematic-shot-review-${directory.split('/').at(-1)}-${reviewCalls}` } }, `storyboard-review-${reviewCalls}`))
            const gateContext = { ...current, [reviewer.resultVar]: report }
            let accepted
            try { accepted = await request('/api/code-node-run', { code: gate.code, prompt: gate.prompt, params: params(gate, gateContext), context: gateContext, files: [] }, `storyboard-gate-${reviewCalls}`) } catch (error) {
              if (attempt >= 3 || !String(error).includes('REVIEW_RESULT_INVALID:')) throw error
              correction = '\n【只修审核报告】' + String(error) + '\n上一报告：' + JSON.stringify(report)
              continue
            }
            if (!accepted.passed) throw Error('HISTORY_CONTENT_REJECTED: ' + JSON.stringify(accepted.issues))
            reviews.push(accepted)
            break
          }
        }
        return { passed: true, scope: 'preplanned-script-source-and-dramaturgy-review', mediaQualityVerified: false, segmentReviews: reviews }
      },
    })
    const segments = result[STORYBOARD_SEGMENTS_KEY] ?? [result]
    for (const [partIndex, shot] of segments.entries()) {
      const actualReview = result.contentReview?.segmentReviews?.[partIndex] ?? shot.contentReview?.segmentReviews?.[partIndex]
      const accepted = { ...shot, ...(actualReview ? { factualReview: actualReview.factualReview, dramaturgyReview: actualReview.dramaturgyReview } : {}), planningValidation: { passed: true, scope: 'preplanned-script-only', actualTailEvidenceUsed: false, readyForContinuousMedia: scene.continuityFromPrevious !== true } }
      const number = summary.accepted.length + 1
      await save(number === 1 ? 'shot-accepted.json' : `shot-${number}-accepted.json`, accepted)
      await save(`shot-${number}-scene.json`, segments.length > 1 ? sceneFromStoryboardSegment(scene, shot, partIndex, segments.length) : scene)
      summary.accepted.push({ sceneId: scene.id, shotId: shot.id, duration: shot.duration, cast: shot.characters, mode: shot.continuity?.mode, file: number === 1 ? 'shot-accepted.json' : `shot-${number}-accepted.json` })
      previousShot = cleanStoryboardForValidation(shot)
    }
    await save('storyboard-summary.json', summary)
    console.log(JSON.stringify({ event: 'storyboard-passed', sceneId: scene.id, segments: segments.length, directory }))
  }
  summary.passed = true
  await save('storyboard-summary.json', summary)
  console.log(JSON.stringify({ event: 'storyboards-passed', ...summary }))
} catch (error) {
  summary.error = redact(error instanceof Error ? error.message : String(error))
  await save('storyboard-summary.json', summary)
  console.error(JSON.stringify({ event: 'failed', directory, error: summary.error }))
  process.exitCode = 1
} finally { await pool.end() }
