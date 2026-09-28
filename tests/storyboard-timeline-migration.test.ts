import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { executeCodeNode } from '../server/code-node.ts'
import { deriveMediaRequirements } from '../src/media-requirement-coverage.ts'
import { VIDEO_REQUEST_CODE, VIDEO_REQUEST_PREFIX_SCHEMA112, upgradeStoryboardTimelineSyntax } from '../src/quality-node-presets.ts'

const savedRequest = JSON.parse(readFileSync(new URL('./fixtures/managed-video-request-before-time-separators.json', import.meta.url), 'utf8'))
const legacyWindows = String.raw`[...source.matchAll(/(\d+(?:\.\d+)?)\s*[-–—~～至到]\s*(\d+(?:\.\d+)?)\s*秒\s*[:：]/g)]`
const legacyRequirement = deriveMediaRequirements.toString().replace('storyboardTimelineMatches(source)', legacyWindows)
const fixture = () => ({ id: 'wf-sanguo-history-drama', schemaVersion: 112, nodes: [
  { ...savedRequest, code: '// retained request prefix\n' + savedRequest.code.replace('[-—~～至到]', '[-–—~～至到]') + '\n// retained request suffix' },
  { ...savedRequest, id: 'sanguo-media-metrics', code: `const shot=context.shot_script;\n// media-requirement-list-v1\nconst requirements=(${legacyRequirement})(shot);\n// /media-requirement-list-v1\nreturn {requirements};` },
  { ...savedRequest, id: 'sanguo-media-accept', code: `// media-defect-evidence-v3\nconst deriveMediaRequirements=(${legacyRequirement});\n// /media-defect-evidence-v3\nreturn {requirements:deriveMediaRequirements(context.shot_script)};` },
  { ...savedRequest, id: 'sanguo-shot-script', kind: 'text', code: undefined, prompt: '保留作者的全部原提示词' },
], edges: [{ id: 'edge', from: 'sanguo-media-request', to: 'sanguo-media-metrics' }] })

test('schema113 upgrades persisted speech, sampling and requirement scopes while preserving graph and writer', async () => {
  const source = fixture(), before = structuredClone(source), next = upgradeStoryboardTimelineSyntax(source)
  assert.equal(next.schemaVersion, 113)
  assert.deepEqual(source, before)
  assert.equal(next.edges, source.edges)
  assert.equal(next.nodes[3], source.nodes[3])
  assert.equal(upgradeStoryboardTimelineSyntax(next), next)
  assert.ok(next.nodes[0].code.startsWith('// retained request prefix\n'))
  assert.ok(next.nodes[0].code.endsWith('\n// retained request suffix'))
  for (const [index, node] of source.nodes.entries()) {
    assert.deepEqual({ ...next.nodes[index], code: undefined }, { ...node, code: undefined })
    assert.equal(next.nodes[index].params, node.params)
  }
  const shot = { duration: 4, audioType: '对白', audioText: '甲：遵命。',
    videoPrompt: '【0秒-1秒】：甲抬手。\n【1秒-2秒】：甲开口说出“遵命”。\n【2秒-4秒】：甲放下陶樽。' }
  const oldResult = await executeCodeNode({ code: source.nodes[0].code, context: { shot_script: shot }, params: { maxSamplingFrames: 24 } }).catch(error => error)
  assert.ok(oldResult instanceof Error)
  const result = await executeCodeNode({ code: next.nodes[0].code, context: { shot_script: shot }, params: { maxSamplingFrames: 24 } })
  assert.deepEqual(result.speechWindows, [{ start: 1, end: 2, text: '遵命。' }])
  for (const second of [0, .5, 1, 1.5, 2, 3, 4]) assert.ok((result.sampleTimes as number[]).includes(second), String(second))
  for (const node of next.nodes.slice(1, 3)) {
    const result = await executeCodeNode({ code: node.code, context: { shot_script: shot } })
    assert.deepEqual(result.requirements, deriveMediaRequirements(shot))
  }
})

test('schema113 refuses missing, duplicate and edited managed request prefixes without partial mutation', () => {
  for (const edit of [
    (w: ReturnType<typeof fixture>) => { w.nodes[0].code = 'return customSampling(context);' },
    (w: ReturnType<typeof fixture>) => { w.nodes[0].code = w.nodes[0].code.replace("split('【')[0]", "split('【')[1]") },
    (w: ReturnType<typeof fixture>) => { w.nodes[0].code += VIDEO_REQUEST_PREFIX_SCHEMA112 },
    (w: ReturnType<typeof fixture>) => { w.nodes.push(w.nodes[0]) },
    (w: ReturnType<typeof fixture>) => { w.nodes[1].code = w.nodes[1].code.replaceAll('media-requirement-list-v1', 'user-custom') },
  ]) {
    const source = fixture(); edit(source)
    const before = structuredClone(source)
    assert.equal(upgradeStoryboardTimelineSyntax(source), source)
    assert.deepEqual(source, before)
  }
  for (const schemaVersion of [111, 113, 114]) {
    const source = { ...fixture(), schemaVersion }
    assert.equal(upgradeStoryboardTimelineSyntax(source), source)
  }
})

test('schema113 accepts already current parser code without duplicate helper declarations', async () => {
  const source = fixture()
  source.nodes[0].code = VIDEO_REQUEST_CODE
  const next = upgradeStoryboardTimelineSyntax(source)
  assert.equal(next.schemaVersion, 113)
  assert.equal(next.nodes[0], source.nodes[0])
  const result = await executeCodeNode({ code: next.nodes[0].code, context: { shot_script: {
    audioType: '对白', audioText: '甲：遵命。', duration: 3, videoPrompt: '0秒-1秒：甲抬手。1秒-2秒：甲说出“遵命”。2秒-3秒：甲转身。',
  } } })
  assert.deepEqual(result.speechWindows, [{ start: 1, end: 2, text: '遵命。' }])
})
