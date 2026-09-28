import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveNativeSequenceConfig, selectNativeReviewFrames, type NativeFrameArchive } from '../server/native-video-sequence.ts'

const archive = (pts: number[], durations: number[]): NativeFrameArchive => ({ version: 1, complete: true,
  sourceVideoSha256: 'b'.repeat(64), sourceVideoUrl: '/generated/source.mp4', decoder: 'fixture', recipe: 'fixture',
  timeBase: '1/1000', firstPTS: 9000, metadataText: '', totalBytes: pts.length,
  frames: pts.map((offset, nativeFrameIndex) => ({ nativeFrameIndex, pts: 9000 + offset, timeBase: '1/1000', durationPTS: durations[nativeFrameIndex],
    second: offset / 1000, width: 1280, height: 720, url: '/generated/frame-' + nativeFrameIndex + '.jpg', sourceSha256: 'a'.repeat(64), byteLength: 1 })) })
const config = (start: number, end: number) => resolveNativeSequenceConfig({ enabled: true, windows: [{ start, end }], reviewMaxFrames: 160 })!

test('a window beginning between native PTS includes the actual displayed predecessor without changing its PTS', () => {
  const source = archive([0, 100, 200, 300, 400], [100, 100, 100, 100, 100]), before = structuredClone(source)
  const selected = selectNativeReviewFrames(source, [], config(.15, .35), .5), window = selected.windows[0]
  assert.deepEqual(window.nativeFrameIndices, [1, 2, 3])
  assert.deepEqual(window.ptsInWindowNativeFrameIndices, [2, 3])
  assert.deepEqual(window.boundaryContextNativeFrameIndices, [1])
  assert.equal(window.coverageSemantics, 'native-frame-display-intersection-v2')
  assert.equal(window.selectionVersion, 2);assert.equal(window.complete, true)
  assert.deepEqual(window.uncoveredDisplaySpans, [])
  assert.deepEqual(window.boundarySpansWithoutFramePTS, [{ start: .15, end: .2 }, { start: .3, end: .35 }])
  const context = selected.frameReferences[window.boundaryContextEvidenceFrameIndices[0]]
  assert.equal(context.pts, 9100);assert.equal(context.second, .1)
  assert.equal(context.displayStartSecond, .1);assert.equal(context.displayEndSecond, .2)
  assert.equal(context.displayEndBasis, 'duration-pts')
  assert.deepEqual(source, before)
})

test('irregular PTS, declared gaps and unavailable tail duration never fabricate continuous display coverage', () => {
  const source = archive([0, 100, 240, 300], [100, 100, 0, 0])
  const selected = selectNativeReviewFrames(source, [], config(.15, .35), .5), window = selected.windows[0]
  assert.deepEqual(window.nativeFrameIndices, [1, 2, 3])
  assert.equal(window.selectionComplete, true);assert.equal(window.displayCoverageComplete, false);assert.equal(window.complete, false)
  assert.deepEqual(window.uncoveredDisplaySpans, [{ start: .2, end: .24 }, { start: .3, end: .35 }])
  assert.equal(selected.frameReferences[2].displayEndBasis, 'next-pts')
  assert.equal(selected.frameReferences[2].displayEndSecond, .3)
  assert.equal(selected.frameReferences[3].displayEndBasis, 'unavailable')
  assert.equal(selected.frameReferences[3].displayEndSecond, .3, 'container .5 does not invent a tail hold')
  const point = selectNativeReviewFrames(source, [], config(.2, .2), .5).windows[0]
  assert.deepEqual(point.nativeFrameIndices, []);assert.equal(point.complete, false)
  const exact = selectNativeReviewFrames(source, [], config(.24, .24), .5).windows[0]
  assert.deepEqual(exact.nativeFrameIndices, [2]);assert.equal(exact.complete, true)
})

test('next PTS caps a longer declared duration and actual duration only truncates a supported tail', () => {
  const source = archive([0, 100, 200], [500, 100, 100])
  const selected = selectNativeReviewFrames(source, [], config(.15, .25), .25)
  assert.equal(selected.frameReferences[0].displayEndSecond, .1)
  assert.equal(selected.frameReferences.at(-1)!.displayEndSecond, .25)
  assert.equal(selected.windows[0].complete, true)
  assert.deepEqual(selected.windows[0].nativeFrameIndices, [1, 2])
  assert.throws(() => selectNativeReviewFrames(source, [], { ...config(.15, .25), reviewMaxFrames: 2 }, .25), /3.*reviewMaxFrames=2/)
  assert.throws(() => selectNativeReviewFrames({ ...source, frames: source.frames.map((frame, i) => i === 1 ? { ...frame, second: .15 } : frame) }, [], config(.15, .25), .25), /PTS或durationPTS无效/)
})
