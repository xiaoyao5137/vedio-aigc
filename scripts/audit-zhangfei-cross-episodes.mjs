#!/usr/bin/env node
// Read-only, no-provider regression of the exact saved episode-input code node.
// The workbook is the production attachment, not a substitute spreadsheet fixture.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { executeCodeNode } from '../server/code-node.ts'
import { retrieveInternetSources } from '../server/web-sources.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'

const workflowId = 'wf-sanguo-history-drama'
const allCases = [
  { episode: 518, title: '张飞据水', opportunity: '追击压力、主角抉择与短促的人物关切' },
  { episode: 610, title: '张飞释严颜', opportunity: '交锋后的敬重和威猛外表与克制选择的反差' },
  { episode: 637, title: '张飞破张郃', opportunity: '狭道战术冲突与判断、反制' },
  { episode: 693, title: '张飞治兵', opportunity: '性格缺陷与严重后果，须避免强加喜剧' },
]
const argument = name => {
  const exact = process.argv.find(item => item.startsWith(`${name}=`))
  if (exact) return exact.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const output = path.resolve(argument('--out') ?? 'logs/zhangfei-dramaturgy-cross-episode-20260928.json')
const fetchSources = process.argv.includes('--fetch-sources')
const candidateUpload = process.argv.includes('--candidate-upload')
const selectedEpisodes = argument('--episodes')?.split(',').map(Number)
const cases = selectedEpisodes ? allCases.filter(item => selectedEpisodes.includes(item.episode)) : allCases
if (cases.length === 0 || (selectedEpisodes && selectedEpisodes.length !== cases.length)) {
  throw Error('Select only known case numbers: 518,610,637,693')
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/video_aigc',
  options: '-c default_transaction_read_only=on',
})
const sha = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const result = {
  scope: candidateUpload ? 'saved-workflow-code-with-in-memory-candidate-upload' : 'saved-workflow-exact-context-init-offline-replay',
  providerRequests: 0,
  databaseWrites: 0,
  mediaGenerated: false,
  caveat: 'The source workbook is an episode planning table, not full scene-by-scene scripts. Only episode 518 has stored generated story/media; the other episodes here prove exact input and writer-prompt routing, not generated storytelling or video quality.',
  cases: [],
}

try {
  const workflow = (await pool.query('select id,name,schema_version,nodes,xmin::text as version from workflow_configs where id=$1', [workflowId])).rows[0]
  if (!workflow) throw Error('Saved production workflow missing')
  const init = workflow.nodes.find(node => node.id === 'sanguo-context-init')
  const writer = workflow.nodes.find(node => node.id === 'sanguo-scene-outline')
  const review = workflow.nodes.find(node => node.id === 'sanguo-scene-outline-review')
  if (init?.kind !== 'code' || writer?.operation !== 'history.scene-outline' || !review?.prompt) throw Error('Saved production input/writer/reviewer nodes are missing')
  const upload = init.uploads?.find(item => item.name === '三国历史短剧1000集策划总表.xlsx')
  if (!upload) throw Error('Saved production workbook attachment missing')
  const attached = Buffer.from(String(upload.dataUrl).split(',')[1] ?? '', 'base64')
  const local = await fs.readFile(new URL('../public/data/三国历史短剧1000集策划总表.xlsx', import.meta.url))
  if (!candidateUpload && sha(attached) !== sha(local)) throw Error('Production workbook differs from local authoritative workbook')
  const effectiveUpload = candidateUpload ? {
    ...upload,
    dataUrl: `${String(upload.dataUrl).split(',')[0]},${local.toString('base64')}`,
    size: local.length,
  } : upload
  Object.assign(result, {
    workflowId, workflowSchema: workflow.schema_version, workflowName: workflow.name,
    workflowRowVersionBefore: workflow.version,
    savedWorkbookSha256: sha(attached), effectiveWorkbookSha256: sha(candidateUpload ? local : attached),
    candidateUpload, inputCodeSha256: sha(init.code),
    writerPromptSha256: sha(writer.prompt), reviewerPromptSha256: sha(review.prompt),
    reviewerQualityMode: review.params?.find(param => param.englishName === 'qualityMode')?.value ?? null,
  })
  const { rows: recordsBefore } = await pool.query(`select id,created_at,xmin::text as version,result->'runtimeInputs'->'input'->>'episode_number' as episode
    from execution_records where workflow_id=$1 and result->'runtimeInputs'->'input'->>'episode_number' in ('518','610','637','693')
    order by created_at desc`, [workflowId])

  const retrievedInputs = []
  for (const item of cases) {
    const input = { episode_number: item.episode, qualityDisposition: 'manual-review-v1' }
    const actual = await executeCodeNode({ code: init.code, prompt: init.prompt, context: { input }, params: {}, files: [effectiveUpload] })
    if (actual.fields?.episode_number !== item.episode || actual.fields?.episode_title !== item.title || actual.matchedBy?.rowNumber !== item.episode + 1) {
      throw Error(`Production input node selected the wrong row for episode ${item.episode}`)
    }
    if (actual.contextPatch?.input?.episode_title !== item.title || actual.internetRequest?.urls?.length === 0) {
      throw Error(`Production input node did not bind source and title for episode ${item.episode}`)
    }
    // This is the saved writer's actual template with the exact code-node fields.
    // Source retrieval and generation are intentionally not simulated here.
    const prompt = renderWorkflowTemplate(writer.prompt, {
      input: actual.contextPatch.input,
      historical_sources: { text: '', citations: [] },
      retry: { attempt: 1, feedback: '' },
      branch: {},
    })
    if (!prompt.includes(`第${item.episode}集《${item.title}》`) || prompt.includes('[object Object]')) {
      throw Error(`Saved writer prompt did not render the selected episode ${item.episode}`)
    }
    const episodeBoundary = actual.fields.episode_boundary ?? null
    const boundaryPromptBound = Boolean(episodeBoundary && prompt.includes('【策划表分集边界】')
      && prompt.includes(episodeBoundary.current?.title)
      && episodeBoundary.next?.every(neighbor => prompt.includes(neighbor.title)))
    if (workflow.schema_version >= 149 && !boundaryPromptBound) {
      throw Error(`Saved writer prompt did not bind adjacent episode ownership for episode ${item.episode}`)
    }
    result.cases.push({
      episode: item.episode,
      expectedTitle: item.title,
      dramaturgyOpportunity: item.opportunity,
      inputNode: {
        matchedRow: actual.matchedBy.rowNumber,
        sourceLevel: actual.fields.source_level,
        sourceTitles: actual.fields.source_titles,
        sourceDetail: actual.fields.source_detail,
        adaptationPolicy: actual.fields.adaptation_policy,
        episodeBoundary,
        query: actual.internetRequest.query,
        sourceUrls: actual.internetRequest.urls,
      },
      writerPrompt: {
        sha256: sha(prompt),
        chars: prompt.length,
        episodeBound: true,
        boundaryPromptBound,
        historicalSourceStillRequired: true,
      },
    })
    retrievedInputs.push({ episode: item.episode, input: actual.contextPatch.input, request: actual.internetRequest })
  }

  if (fetchSources) {
    // Same source retriever and request as internet.retrieve, without execution
    // cache, model requests, application calls or execution-record writes.
    // Fetch serially: four concurrent searches can get the shared Wiki API
    // rate-limited (429) even when the same requests succeed one by one.
    const fetched = []
    for (const item of retrievedInputs) {
      try {
        const sources = await retrieveInternetSources(item.request)
        const sourceFile = path.join(path.dirname(output), `zhangfei-source-${item.episode}${candidateUpload ? '-candidate' : ''}.json`)
        await fs.mkdir(path.dirname(sourceFile), { recursive: true })
        await fs.writeFile(sourceFile, JSON.stringify({
          scope: 'live-source-node-read-only', episode: item.episode,
          workflowId, input: item.input, historical_sources: sources,
        }, null, 2), { mode: 0o600 })
        fetched.push({ status: 'fulfilled', value: { sourceFile, sources } })
      } catch (reason) { fetched.push({ status: 'rejected', reason }) }
    }
    fetched.forEach((entry, index) => {
      const item = result.cases[index]
      if (entry.status === 'rejected') {
        item.liveHistoricalSources = { passed: false, error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) }
        return
      }
      const { sources, sourceFile } = entry.value
      const eventAnchors = {
        518: /飞据水断桥|飛據水斷橋/u,
        610: /飞壮而释之|飛壯而釋之/u,
        637: /飞率精卒万馀人|飛率精卒萬餘人|飞遂破郃|飛遂破郃/u,
        693: /卿刑杀既过差|卿刑殺既過差/u,
      }
      const eventCitationIds = sources.citations.filter(citation => eventAnchors[item.episode].test(citation.content)).map(citation => citation.id)
      const directZhangfeiChapterFound = sources.citations.some(citation =>
        /三[國国]志(?:\/|%2F)卷0?36/u.test(decodeURI(citation.url)))
      const sourcePrompt = renderWorkflowTemplate(writer.prompt, {
        input: retrievedInputs[index].input,
        historical_sources: sources,
        characterVisualCatalog: [],
        selectedCharacterVisuals: [],
        retry: { attempt: 1, feedback: '' },
        branch: {},
      })
      const eventCitationBoundToWriter = eventCitationIds.some(id => sourcePrompt.includes(id))
      item.liveHistoricalSources = {
        passed: eventCitationIds.length > 0 && directZhangfeiChapterFound && eventCitationBoundToWriter,
        count: sources.count,
        eventCitationIds,
        eventCitationBoundToWriter,
        writerPromptSha256WithLiveSources: sha(sourcePrompt),
        writerPromptCharsWithLiveSources: sourcePrompt.length,
        directZhangfeiChapterFound,
        sourceDetailMissingDirectChapter: item.episode === 637 && !/卷三十六|卷36/u.test(item.inputNode.sourceDetail),
        urls: [...new Set(sources.citations.map(citation => citation.url))],
        sourceFile,
        failures: sources.failures,
      }
    })
  }

  // Distinguish the one existing generation from the other three input-only cases.
  const { rows: recordsAfter } = await pool.query('select id,xmin::text as version from execution_records where id=any($1::text[])', [recordsBefore.map(record => record.id)])
  for (const item of result.cases) {
    const matching = recordsBefore.filter(record => Number(record.episode) === item.episode)
    item.storedExecutions = { count: matching.length, latestId: matching[0]?.id ?? null }
  }
  const afterVersions = new Map(recordsAfter.map(record => [record.id, record.version]))
  result.existingExecutionRowsUnchanged = recordsBefore.every(record => afterVersions.get(record.id) === record.version)
  const workflowAfter = (await pool.query('select schema_version,nodes,xmin::text as version from workflow_configs where id=$1', [workflowId])).rows[0]
  result.workflowRowVersionAfter = workflowAfter?.version ?? null
  result.workflowUnchanged = workflowAfter?.version === workflow.version
    && workflowAfter?.schema_version === workflow.schema_version
    && sha(workflowAfter?.nodes) === sha(workflow.nodes)
  result.passed = result.workflowUnchanged && result.existingExecutionRowsUnchanged
    && result.cases.every(item => !fetchSources || item.liveHistoricalSources?.passed === true)
  if (!result.passed) process.exitCode = 1
} catch (error) {
  result.passed = false
  result.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await pool.end()
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ passed: result.passed, output, workflowSchema: result.workflowSchema,
    cases: result.cases.map(item => ({ episode: item.episode, title: item.expectedTitle, matchedRow: item.inputNode.matchedRow,
      storedExecutions: item.storedExecutions?.count ?? 0 })), error: result.error }))
}
