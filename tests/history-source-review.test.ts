import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rolldown } from 'rolldown'
import { historicalSourceSpans, historicalSourceReviewContext, resolveHistoricalReviewSourceSpans, HISTORICAL_SOURCE_REVIEW_RUNTIME_CODE } from '../src/history-source-review.ts'
import { renderWorkflowTemplate } from '../src/workflow-template.ts'
import { executeCodeNode } from '../server/code-node.ts'

const sources = [
  { index: 92, title: '来源编号不作为当前数组定位', content: '  桓帝爲蠡吾侯，受學於甘陵周福。\n二家賓客，互相譏揣〈初委反〉，遂各樹朋徒。\n短。\n' },
  { content: '\t由是甘陵有南北部，黨人之議，自此始矣。\n' + '連續原文'.repeat(170) + '。' },
]
const candidate = { scenes: [
  { id: 'scene-01', cast: ['周家宾客', '房家宾客'], requiredBeats: [{ id: 'b1', observable: { visual: ['周家宾客停步'], audio: ['一句歌谣，便能断人高下'] } }] },
  { id: 'scene-02', cast: ['房家宾客'], requiredBeats: [{ id: 'b2', observable: { visual: ['房家宾客迎着目光'], audio: ['我只不过学了一句'] } }] },
] }

test('source spans preserve exact source bytes, punctuation, variants, footnotes and offsets', () => {
  const spans = historicalSourceSpans(sources)
  assert.ok(spans.length >= 5)
  for (const span of spans) {
    assert.equal(span.quote, sources[span.citationIndex - 1].content.slice(span.start, span.end))
    assert.ok(span.quote.length <= 320)
  }
  assert.equal(spans[0].citationIndex, 1, 'cite the actual array position, not source.index or metadata')
  assert.ok(spans.some(span => span.quote.includes('爲蠡吾侯，受學')))
  assert.ok(spans.some(span => span.quote.includes('譏揣〈初委反〉')))
  assert.ok(!spans.some(span => span.quote === '短。'))
  assert.deepEqual(historicalSourceSpans(sources), spans, 'same source bytes produce stable ids')
  assert.deepEqual(historicalSourceSpans([{ content: undefined }, null]), [])
})

test('stale span ids fail when referenced source text or offsets change', () => {
  const span = historicalSourceSpans(sources)[0]
  const report = { evidence: [{ itemId: 'scene-01', sourceSpanId: span.id, supports: '交代周福教授桓帝' }] }
  const changed = structuredClone(sources)
  changed[0].content = changed[0].content.replace('周福', '房植')
  assert.throws(() => resolveHistoricalReviewSourceSpans(report, changed), /编号不存在或史料已变化/)
  const shifted = structuredClone(sources)
  shifted[0].content = '新加入的完整原文。\n' + shifted[0].content
  assert.throws(() => resolveHistoricalReviewSourceSpans(report, shifted), /编号不存在或史料已变化/)
})

test('resolution rebuilds from actual sources and ignores forged catalogues and locator metadata', () => {
  const span = historicalSourceSpans(sources)[0]
  const review = { history_source_review: { sourceSpans: [{ ...span, quote: '模型伪造的另一段史料' }] }, evidence: [
    { itemId: 'scene-01', sourceSpanId: span.id, supports: '教授关系', sourceSpan: { id: 'forged', start: 0, end: 2 } },
  ] }
  const resolved = resolveHistoricalReviewSourceSpans(review, sources) as typeof review & { evidence: Array<{ quote: string; sourceSpan: unknown }> }
  assert.equal(resolved.evidence[0].quote, span.quote)
  assert.deepEqual(resolved.evidence[0].sourceSpan, { id: span.id, start: span.start, end: span.end })
  assert.throws(() => resolveHistoricalReviewSourceSpans({ ...review, evidence: [{ ...review.evidence[0], sourceSpanId: 'catalog-only-id' }] }, sources), /编号不存在/)
  const context = historicalSourceReviewContext({ params: { candidate }, historical_sources: { citations: sources }, history_source_review: review.history_source_review })
  assert.equal(context.history_source_review.sources.length, sources.length)
  for (const span of historicalSourceSpans(sources)) assert.ok(context.history_source_review.sources[span.citationIndex - 1].numberedText.includes('⟦' + span.id + '⟧' + span.quote + '⟦/⟧'))
  assert.doesNotMatch(JSON.stringify(context.history_source_review), /模型伪造的另一段史料/)
})

test('numbered source text restores every original character including short negative answers', () => {
  const originals = structuredClone(sources)
  originals[0].content = '否。\n非也。\n' + originals[0].content + '不。\n未嘗。\n'
  originals[1].content += '\r\n不許！\n  未。  '
  const context = historicalSourceReviewContext({ params: { candidate }, historical_sources: { citations: originals } })
  const removeInsertedLabels = (value: string) => value.replace(/⟦s\d+:\d+-\d+:[0-9a-f]+⟧|⟦\/⟧/g, '')
  assert.deepEqual(context.history_source_review.sources.map(source => removeInsertedLabels(source.numberedText)), originals.map(source => source.content))
  assert.ok(context.history_source_review.sources[0].numberedText.startsWith('否。\n非也。\n'))
  assert.ok(context.history_source_review.sources[1].numberedText.endsWith('\r\n不許！\n  未。  '))
  assert.deepEqual(context.history_source_review.expectedCoverage.map(item => item.itemId), ['scene-01', 'scene-02'])
})

test('a model cannot attach a conflicting quote, source index or unsupported assertion to a real span', () => {
  const span = historicalSourceSpans(sources)[0]
  const row = { itemId: 'scene-01', sourceSpanId: span.id, supports: '教授关系' }
  for (const conflicting of [
    { ...row, quote: span.quote.replace('爲', '为') },
    { ...row, quote: '桓帝即位后提拔周福' },
    { ...row, citationIndex: 2 },
    { ...row, supports: '' },
  ]) assert.throws(() => resolveHistoricalReviewSourceSpans({ evidence: [conflicting] }, sources), /REVIEW_RESULT_INVALID/)
  assert.doesNotThrow(() => resolveHistoricalReviewSourceSpans({ evidence: [{ ...row, citationIndex: 1, quote: span.quote }] }, sources))
})

test('shared source evidence expands only the explicitly named unique itemIds', () => {
  const span = historicalSourceSpans(sources)[1]
  const row = { sourceSpanId: span.id, supports: '两家宾客互相讥揣', itemIds: ['scene-01', 'scene-02'] }
  const resolved = resolveHistoricalReviewSourceSpans({ evidence: [row] }, sources) as { evidence: Array<{ itemId: string; quote: string }> }
  assert.deepEqual(resolved.evidence.map(item => item.itemId), ['scene-01', 'scene-02'])
  assert.ok(resolved.evidence.every(item => item.quote === span.quote && !('itemIds' in item)))
  const single = resolveHistoricalReviewSourceSpans({ evidence: [{ sourceSpanId: span.id, supports: row.supports, itemId: 'scene-01' }] }, sources) as typeof resolved
  assert.equal(single.evidence.length, 1, 'never invent scene-02 coverage from a shared historical fact')
  for (const bad of [{ ...row, itemIds: [] }, { ...row, itemIds: ['scene-01', 'scene-01'] }, { ...row, itemIds: ['scene-01', ''] }, { ...row, itemId: 'scene-01' }]) {
    assert.throws(() => resolveHistoricalReviewSourceSpans({ evidence: [bad] }, sources), /共享引证/)
  }
})

test('resolving spans creates a new report without changing raw model bytes, judgement or issues', () => {
  const span = historicalSourceSpans(sources)[0]
  const report = { passed: false, issues: [{ itemId: 'scene-02', problem: '候选中有具体史实疑问' }], evidence: [{ itemIds: ['scene-01'], sourceSpanId: span.id, supports: '教授关系' }], raw: { text: '原始模型输出' } }
  const before = structuredClone(report)
  const resolved = resolveHistoricalReviewSourceSpans(report, sources) as Record<string, unknown>
  assert.notEqual(resolved, report)
  assert.deepEqual(report, before)
  assert.equal(resolved.passed, false)
  assert.deepEqual(resolved.issues, report.issues)
  assert.deepEqual(resolved.raw, report.raw)
  assert.deepEqual(resolveHistoricalReviewSourceSpans({ evidence: [{ itemId: 'scene-01', citationIndex: 1, quote: '原来的手工引文' }] }, sources), { evidence: [{ itemId: 'scene-01', citationIndex: 1, quote: '原来的手工引文' }] }, 'legacy quotes still go through the downstream strict source gate')
})

test('each context requires actual resolved params.candidate and derives exact per-item coverage', () => {
  const context = historicalSourceReviewContext({ params: { candidate }, historical_sources: { citations: sources } })
  assert.deepEqual(context.history_source_review.expectedCoverage, [
    { itemId: 'scene-01', characters: ['周家宾客', '房家宾客'], evidenceRequired: true },
    { itemId: 'scene-02', characters: ['房家宾客'], evidenceRequired: true },
  ])
  const prompt = renderWorkflowTemplate('候选：${params.candidate}\n当前来源：${history_source_review}', context)
  for (const scene of candidate.scenes) {
    assert.ok(prompt.includes(scene.id))
    for (const beat of scene.requiredBeats) for (const anchor of [...beat.observable.visual, ...beat.observable.audio]) assert.ok(prompt.includes(anchor))
  }
  for (const missing of [undefined, null, [], {}, { scenes: [] }, { scenes: [{ id: '' }] }, { scenes: [null] }, { scenes: [{ id: 'same' }, { id: 'same' }] }]) {
    assert.throws(() => historicalSourceReviewContext({ scene_outline: candidate, params: { candidate: missing }, historical_sources: { citations: sources } }), /HISTORY_REVIEW_INPUT_INVALID/)
  }
  assert.throws(() => historicalSourceReviewContext({ scene_outline: candidate, historical_sources: { citations: sources } }), /HISTORY_REVIEW_INPUT_INVALID/)
  assert.throws(() => historicalSourceReviewContext({ params: { candidate }, historical_sources: { citations: [{ content: '短' }] } }), /没有可定位正文片段/)
  const shot = historicalSourceReviewContext({ params: { candidate: { id: 'shot-1', characters: ['周家宾客'] } }, historical_sources: { citations: sources } })
  assert.deepEqual(shot.history_source_review.expectedCoverage, [{ itemId: 'shot-1', characters: ['周家宾客'], evidenceRequired: true }])
})

test('the editable code-node runtime resolves spans identically without module imports', () => {
  const span = historicalSourceSpans(sources)[0]
  const report = { evidence: [{ itemId: 'scene-01', sourceSpanId: span.id, supports: '教授关系' }] }
  const run = new Function('review', 'sources', HISTORICAL_SOURCE_REVIEW_RUNTIME_CODE + '\nreturn resolveHistoricalReviewSourceSpans(review, sources);')
  assert.deepEqual(run(report, sources), resolveHistoricalReviewSourceSpans(report, sources))
})

test('real production minification preserves the exported runtime through template rendering and code-node execution', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cinematic-source-runtime-'))
  const output = path.join(directory, 'history-source-review.min.mjs')
  const bundle = await rolldown({ input: fileURLToPath(new URL('../src/history-source-review.ts', import.meta.url)) })
  try {
    await bundle.write({ file: output, format: 'esm', minify: true })
    const minified = await import(pathToFileURL(output).href)
    assert.notEqual(minified.historicalSourceSpans.toString(), historicalSourceSpans.toString(), 'exercise the actual transformed functions, not manually renamed source')
    const span = minified.historicalSourceSpans(sources)[0]
    const report = { passed: false, issues: ['保留原判断'], evidence: [{ itemIds: ['scene-01', 'scene-02'], sourceSpanId: span.id, supports: '教授关系' }] }
    const code = renderWorkflowTemplate(minified.HISTORICAL_SOURCE_REVIEW_RUNTIME_CODE + '\nreturn {review:resolveHistoricalReviewSourceSpans(params.review, params.sources)};', {})
    const result = await executeCodeNode({ code, params: { review: report, sources }, context: {} })
    assert.deepEqual(result.review, resolveHistoricalReviewSourceSpans(report, sources))
    assert.equal((result.review as { evidence: Array<{ quote: string }> }).evidence[0].quote, sources[0].content.slice(span.start, span.end))
  } finally {
    await bundle.close()
    await rm(directory, { recursive: true, force: true })
  }
})
