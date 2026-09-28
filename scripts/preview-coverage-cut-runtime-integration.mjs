#!/usr/bin/env node
// Default is an in-memory integration check. --apply writes the three watched
// files only after the owner has coordinated a safe runtime transition.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

const apply = process.argv.includes('--apply')
const hash = value => createHash('sha256').update(value).digest('hex')
const exactlyOne = (source, oldText, newText, label) => {
  assert.equal(source.split(oldText).length, 2, `COVERAGE_INTEGRATION_ANCHOR_CHANGED: ${label}`)
  return source.replace(oldText, newText)
}
const paths = ['vite.config.ts', 'server/workflow-contracts.ts', 'src/App.tsx']
const originals = await Promise.all(paths.map(file => readFile(file, 'utf8')))
let [vite, contract, app] = originals
const beforeHashes = originals.map(hash)

vite = exactlyOne(vite,
  "import { collectImageEvidence } from './server/image-evidence.ts'",
  "import { collectImageEvidence } from './server/image-evidence.ts'\nimport { archiveCoverageCutSources, persistCoverageCutFirstFrameResponse } from './server/coverage-cut-frame-storage.ts'\nimport { issueRecordedCoverageCutFrameApproval, validateCoverageCutPaidImageRequest, validateCoverageCutPaidVideoRequest } from './server/coverage-cut-runtime.ts'",
  'Vite coverage imports')
vite = exactlyOne(vite,
  "    validateHistoricalMapPaidImageRequest(effectiveRequest)",
  "    validateHistoricalMapPaidImageRequest(effectiveRequest)\n    validateCoverageCutPaidImageRequest(effectiveRequest)",
  'paid image guard')
vite = exactlyOne(vite,
  "    if (request.model.provider === 'Kling' && request.model.capability === 'video' && !request.params.resumeTaskId && request.executionContext?.workflowId && request.executionContext.nodeId) {",
  "    let reusedVideoResult: { status: number; body: unknown } | undefined\n    if (request.model.provider === 'Kling' && request.model.capability === 'video' && !request.params.resumeTaskId && request.executionContext?.workflowId && request.executionContext.nodeId) {",
  'defer video dedup return until coverage payment gate')
vite = exactlyOne(vite,
  "      if (pending.rows[0]?.status === 'succeeded') return { status: pending.rows[0].http_status ?? 200, body: pending.rows[0].response_data }\n      if (pending.rows[0]) effectiveRequest = { ...request, params: { ...request.params, resumeTaskId: pending.rows[0].task_id,",
  "      if (pending.rows[0]?.status === 'succeeded') reusedVideoResult = { status: pending.rows[0].http_status ?? 200, body: pending.rows[0].response_data }\n      if (pending.rows[0]) effectiveRequest = { ...request, params: { ...request.params, resumeTaskId: pending.rows[0].task_id,",
  'paid-video successful task reuse')
vite = exactlyOne(vite,
  "&& ['sanguo-animated-map-first-frame', 'sanguo-end-frame'].includes(request.executionContext.nodeId ?? '')\n      && request.params.animationStyle === 'historical_map' && !request.params.resumeTaskId",
  "&& ['sanguo-animated-map-first-frame', 'sanguo-end-frame', 'sanguo-coverage-first-frame'].includes(request.executionContext?.nodeId ?? '')\n      && (request.params.animationStyle === 'historical_map' || request.executionContext?.nodeId === 'sanguo-coverage-first-frame') && !request.params.resumeTaskId",
  'image task dedup selector')
vite = exactlyOne(vite,
  "        const body = request.params.animationAesthetic === 'historical_cartography'\n          ? await persistHistoricalMapFrameResponse(prior.rows[0].response_data) : prior.rows[0].response_data",
  "        const body = request.executionContext?.nodeId === 'sanguo-coverage-first-frame'\n          ? await persistCoverageCutFirstFrameResponse(prior.rows[0].response_data)\n          : request.params.animationAesthetic === 'historical_cartography'\n            ? await persistHistoricalMapFrameResponse(prior.rows[0].response_data) : prior.rows[0].response_data",
  'image task result persistence')
vite = exactlyOne(vite,
  "    if (submittedTaskId && result.body && typeof result.body === 'object') result.body = { ...result.body, resumeQueryMode }",
  "    if (request.model.capability === 'image' && result.status < 400\n      && request.executionContext?.workflowId === 'wf-sanguo-history-drama'\n      && request.executionContext?.nodeId === 'sanguo-coverage-first-frame') {\n      result.body = await persistCoverageCutFirstFrameResponse(result.body)\n    }\n    if (submittedTaskId && result.body && typeof result.body === 'object') result.body = { ...result.body, resumeQueryMode }",
  'new image result persistence')
vite = exactlyOne(vite,
  "    if (effectiveRequest.model.capability === 'video' && Array.isArray(effectiveRequest.params.characterVoices)) {",
  "    if (effectiveRequest.model.capability === 'video'\n      && effectiveRequest.executionContext?.workflowId === 'wf-sanguo-history-drama'\n      && effectiveRequest.executionContext?.nodeId === 'sanguo-video') {\n      let paidResumeRecord: unknown\n      if (effectiveRequest.params.resumeTaskId) {\n        await ensureSchema()\n        const paid = await pool.query(`select task_id,workflow_id,node_id,model_id,provider,capability,status,request_data\n          from model_execution_records where task_id=$1 and workflow_id=$2 and node_id=$3\n            and model_id=$4 and status in ('processing','succeeded')\n          order by created_at desc limit 1`, [effectiveRequest.params.resumeTaskId,\n          effectiveRequest.executionContext.workflowId, effectiveRequest.executionContext.nodeId, effectiveRequest.model.id])\n        paidResumeRecord = paid.rows[0]\n      }\n      validateCoverageCutPaidVideoRequest(effectiveRequest, paidResumeRecord)\n    }\n    if (reusedVideoResult) return reusedVideoResult\n    if (effectiveRequest.model.capability === 'video' && Array.isArray(effectiveRequest.params.characterVoices)) {",
  'paid video guard before provider')
vite = exactlyOne(vite,
  "        server.middlewares.use('/api/historical-map-annotation-approval', async (req, res) => {",
  "        server.middlewares.use('/api/coverage-cut-source-archive', async (req, res) => {\n          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })\n          try { return jsonResponse(res, 200, await archiveCoverageCutSources(await readJson<Parameters<typeof archiveCoverageCutSources>[0]>(req))) }\n          catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }\n        })\n        server.middlewares.use('/api/coverage-cut-frame-approval', async (req, res) => {\n          if (req.method !== 'POST') return jsonResponse(res, 405, { error: 'Method not allowed' })\n          try { return jsonResponse(res, 200, await issueRecordedCoverageCutFrameApproval(pool,\n            await readJson<Parameters<typeof issueRecordedCoverageCutFrameApproval>[1]>(req))) }\n          catch (error) { return jsonResponse(res, 422, { error: errorMessage(error) }) }\n        })\n        server.middlewares.use('/api/historical-map-annotation-approval', async (req, res) => {",
  'source archive and approval HTTP routes')

contract = exactlyOne(contract,
  "import { historicalMapFrameShotSha256, verifyHistoricalMapFrameApproval } from './historical-map-frame-approval.ts'",
  "import { historicalMapFrameShotSha256, verifyHistoricalMapFrameApproval } from './historical-map-frame-approval.ts'",
  'contract import')
contract = exactlyOne(contract,
  "if (continuityMode === 'coverage_cut' && hasFirstFrame && !animatedShot) missing.push('同场切镜不能锁定前镜原构图为像素首帧')",
  "if (continuityMode === 'coverage_cut' && hasFirstFrame && !animatedShot && !params.coverageCutFrameGate)\n      missing.push('同场切镜新机位首帧缺少实际图片验收凭证')",
  'old blanket pixel-frame rejection')

app = exactlyOne(app,
  "import { CHARACTER_BIOGRAPHY_SOURCE_PARAM, upgradeCharacterBiographyWorkflow } from './character-biography-workflow'",
  "import { CHARACTER_BIOGRAPHY_SOURCE_PARAM, upgradeCharacterBiographyWorkflow } from './character-biography-workflow'\nimport { upgradeCoverageCutFrameWorkflow } from './coverage-cut-frame-gate'",
  'fresh workflow upgrade import')
app = exactlyOne(app,
  "if (workflow.id === 'wf-sanguo-history-drama') return upgradeCharacterBiographyWorkflow(",
  "if (workflow.id === 'wf-sanguo-history-drama') return upgradeCoverageCutFrameWorkflow(upgradeCharacterBiographyWorkflow(",
  'fresh workflow upgrade wrapper')
app = exactlyOne(app,
  "upgradeQualityWorkflow(migrateSanguoWorkflow(legacy))))))))))))))))\n  if (workflow.id !== 'wf-story') return migrateBranchWorkflow(base)",
  "upgradeQualityWorkflow(migrateSanguoWorkflow(legacy)))))))))))))))))\n  if (workflow.id !== 'wf-story') return migrateBranchWorkflow(base)",
  'fresh workflow upgrade closing parenthesis')

const proposals = [vite, contract, app]
for (const [file, source] of paths.map((file, index) => [file, proposals[index]])) {
  const parsed = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
  assert.ok(!parsed.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error), `${file} syntax error`)
}
const overlay = new Map(paths.map((file, index) => [path.resolve(file), proposals[index]]))
const baselineTypeErrors = []
for (const configuration of ['tsconfig.app.json', 'tsconfig.node.json']) {
  const parsedConfig = ts.readConfigFile(configuration, ts.sys.readFile)
  assert.equal(parsedConfig.error, undefined, `${configuration} cannot be read`)
  const config = ts.parseJsonConfigFileContent(parsedConfig.config, ts.sys, process.cwd())
  const diagnosticsFor = proposedOverlay => {
    const compilerHost = ts.createCompilerHost(config.options)
    const originalGetSourceFile = compilerHost.getSourceFile.bind(compilerHost)
    compilerHost.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
      const proposed = proposedOverlay.get(path.resolve(file))
      return proposed === undefined
        ? originalGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(file, proposed, languageVersion, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    }
    const program = ts.createProgram({ rootNames: config.fileNames, options: config.options, host: compilerHost })
    return ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error)
  }
  const signature = item => `${item.file?.fileName ?? ''}:${item.start ?? ''}:${item.code}:${ts.flattenDiagnosticMessageText(item.messageText, '\n')}`
  const baseline = diagnosticsFor(new Map())
  baselineTypeErrors.push(...baseline.map(item => `${configuration}:${signature(item)}`))
  const existing = new Set(baseline.map(signature))
  const newErrors = diagnosticsFor(overlay).filter(item => !existing.has(signature(item)))
  assert.equal(newErrors.length, 0, `${configuration} proposed code type errors:\n${ts.formatDiagnosticsWithColorAndContext(newErrors, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
  })}`)
}
if (apply) {
  for (let index = 0; index < paths.length; index++) {
    assert.equal(hash(await readFile(paths[index], 'utf8')), beforeHashes[index], `${paths[index]} changed during guarded patch`)
  }
  for (const [index, source] of proposals.entries()) await writeFile(paths[index], source)
}
console.log(JSON.stringify({ format: 'coverage-cut-runtime-integration-preview-v1', applied: apply,
  files: paths.map((file, index) => ({ file, beforeSha256: hash(originals[index]),
    proposedSha256: hash(proposals[index]), changed: originals[index] !== proposals[index] })),
  syntaxChecked: true, typeCheckedAgainstCurrentTree: true, baselineTypeErrors,
  databaseWrites: 0, providerCalls: 0 }, null, 2))
