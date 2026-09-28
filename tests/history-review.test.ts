import test from 'node:test'
import assert from 'node:assert/strict'
import { validateContentReview, reviewHistoricalContent } from '../src/history-review.ts'
const sources = [{ index: 1, content: '桓帝即位，甘陵周福字仲進，少遊學京師。' }]
const items = [{ id: 's1' }]
test('review requires actual supporting quotations for every scene', () => {
  assert.throws(() => validateContentReview({ passed: true, issues: [], evidence: [] }, items, sources), /没有逐场核实证据/)
  assert.throws(() => validateContentReview({ passed: true, issues: [], evidence: [{ itemId: 's1', citationIndex: 1, quote: '李膺说左回天具独坐。' }] }, items, sources), /不在所引史料正文中/)
  const review = validateContentReview({ passed: true, issues: [], evidence: [{ itemId: 's1', citationIndex: 1, quote: '甘陵周福字仲進，少遊學京師。' }] }, items, sources)
  assert.equal(review.mediaQualityVerified, false)
  assert.throws(() => validateContentReview({ ...review, passed: false, issues: [{ problem: '名言归属无来源' }] }, items, sources), /名言归属无来源/)
})

test('a malformed reviewer quotation repairs the report without rewriting the scene', async () => {
  const prompts: string[] = []
  const report = await reviewHistoricalContent({ candidate: items[0], citations: sources, generate: async prompt => {
    prompts.push(prompt)
    return { passed: true, issues: [], evidence: [{ itemId: 's1', citationIndex: 1, quote: prompts.length === 1 ? '这是一个不存在的原文引句' : '甘陵周福字仲進，少遊學京師。' }] }
  } })
  assert.equal(report.passed, true)
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], /只修复审查报告，不重写剧本/)
})

test('reviewer invented dialogue-label requirements are challenged before changing story', async () => {
  const prompts: string[] = []
  const report = await reviewHistoricalContent({ candidate: { id: 's1', adaptationBoundary: '对白均为拟制' }, citations: sources, generate: async prompt => {
    prompts.push(prompt)
    if (prompts.length === 1) return { passed: false, issues: [{ problem: '必须在audioText中添加【拟制对白】标签' }], evidence: [] }
    return { passed: true, issues: [], evidence: [{ itemId: 's1', citationIndex: 1, quote: '甘陵周福字仲進，少遊學京師。' }] }
  } })
  assert.equal(report.passed, true)
  assert.match(prompts[1], /复核审稿意见，禁止改写待审大纲\/分镜/)
})

test('a confirmed historical contradiction still blocks after critic self-check', async () => {
  let calls = 0
  await assert.rejects(reviewHistoricalContent({ candidate: items[0], citations: sources, generate: async () => {
    calls++
    return { passed: false, issues: [{ problem: '将谣言归为李膺的亲口发言' }], evidence: [] }
  } }), /HISTORY_CONTENT_REJECTED/)
  assert.equal(calls, 2)
})


test('an exact concise source clause is valid evidence without artificial padding', () => {
  const result = validateContentReview({ passed: true, issues: [], evidence: [{ itemId: 's1', citationIndex: 1, quote: '遂各樹朋徒' }] }, [{ id: 's1' }], [{ content: '二家賓客，互相譏揣，遂各樹朋徒，漸成尤隙。' }])
  assert.equal(result.passed, true)
})
