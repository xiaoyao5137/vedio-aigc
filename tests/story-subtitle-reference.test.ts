import assert from 'node:assert/strict'
import test from 'node:test'
import { generateStorySubtitleReference, validateStorySubtitleReference } from '../server/story-subtitle-reference.ts'
import { upgradeWorkplaceShotSubtitles } from '../src/story-subtitle-workflow.ts'

const sha = 'a'.repeat(64)
const evidence = { duration: 8, sha256: sha, evidenceUrl: '/generated/evidence.json',
  url: '/generated/clip.mp4', decoded: true, frames: ['/generated/a.jpg', '/generated/b.jpg'],
  frameTimes: [0, 7.9] }

test('subtitle reference uses video frames and script, returns advisory variable without media mutation', async () => {
  let called: Record<string, unknown> | undefined
  const result = await generateStorySubtitleReference({
    params: { shot: { title: '吃饭', content: '饭洒了', duration: 8 }, video: { url: evidence.url } },
    model: { id: 'vision', provider: 'Codex', capability: 'text', settings: {} },
  }, async request => {
    called = request
    return { status: 200, body: { text: JSON.stringify({ version: 'story-subtitle-reference-v1',
      sourceVideoSha256: sha, evidenceUrl: evidence.evidenceUrl,
      subtitles: [{ startSecond: 1, endSecond: 3, text: '晚饭又被工作打断' }] }) } }
  }, async () => evidence as never)
  assert.deepEqual(called?.params, { reviewImages: evidence.frames, maxTokens: 2048, temperature: 0 })
  assert.match(String(called?.prompt), /饭洒了/)
  assert.equal(result.videoEmbedded, false)
  assert.equal(result.status, 'suggested')
  assert.equal(result.subtitles[0].text, '晚饭又被工作打断')
})

test('bad timing is unavailable rather than a block on paid media routing', async () => {
  const result = await generateStorySubtitleReference({ params: { shot: { content: '汤洒了' }, video: { url: evidence.url } },
    model: { id: 'vision', provider: 'Codex', capability: 'text', settings: {} } },
  async () => ({ status: 200, body: { text: JSON.stringify({ version: 'story-subtitle-reference-v1',
    sourceVideoSha256: sha, evidenceUrl: evidence.evidenceUrl,
    subtitles: [{ startSecond: 7, endSecond: 9, text: '晚饭' }] }) } }), async () => evidence as never)
  assert.equal(result.status, 'unavailable')
  assert.deepEqual(result.subtitles, [])
  assert.throws(() => validateStorySubtitleReference({ version: 'story-subtitle-reference-v1',
    sourceVideoSha256: sha, evidenceUrl: evidence.evidenceUrl,
    subtitles: [{ startSecond: 7, endSecond: 9, text: '晚饭' }] }, evidence), /时间或正文非法/)
})

test('workflow inserts one loop node between shot generation and review', () => {
  const node = (id: string, kind: string, x: number) => ({ id, kind, title: id,
    resultVar: id === 'node-video' ? 'video_shot' : id, prompt: '', params: [], uploads: [],
    loop: { enabled: false, sourcePath: '', fallbackCount: 0, itemVar: 'shot' }, position: { x, y: 0 },
    ...(id === 'node-video-review' ? { modelId: 'vision' } : {}),
    ...(id === 'node-video' ? { modelId: 'video' } : {}),
    ...(id === 'node-loop' ? { childIds: ['node-video', 'node-video-review'] } : {}) })
  const source = { id: 'wf-workplace-second-trial-v1', schemaVersion: 11,
    nodes: [node('node-loop', 'loop', 0), node('node-video', 'video', 300), node('node-video-review', 'validation', 600)],
    edges: [{ id: 'old', from: 'node-video', to: 'node-video-review' }] }
  const next = upgradeWorkplaceShotSubtitles(source)
  assert.deepEqual(next.nodes.find(item => item.id === 'node-loop')?.childIds,
    ['node-video', 'node-shot-subtitles', 'node-video-review'])
  assert.deepEqual(next.edges.map(edge => [edge.from, edge.to]),
    [['node-video', 'node-shot-subtitles'], ['node-shot-subtitles', 'node-video-review']])
  assert.equal(upgradeWorkplaceShotSubtitles(next), next)
})
