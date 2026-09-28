/** A draft observer may retain sparse coverage while authoritative reviewers
 * receive every frame in the explicit review view. No unviewed frame becomes
 * an observation merely because its native archive exists. Self-contained. */
export function deriveMediaEvidenceViews(evidence: Record<string, unknown>) {
  const invalid = (message: string): never => { throw Error('MEDIA_EVIDENCE_VIEW_INVALID: ' + message) }
  const frames = evidence.frames, times = evidence.frameTimes
  if (!Array.isArray(frames) || !Array.isArray(times) || frames.length !== times.length) invalid('frames与frameTimes未逐项绑定')
  const native = evidence.nativeSequence as Record<string, unknown> | undefined
  const all = (frames as string[]).map((url, index) => ({ url, index, second: (times as number[])[index] }))
  if (!native) return { observerFrames: all, reviewImageDetail: { indices: [0], columns: 2, rows: 2, overlap: .25 } }
  const refs = evidence.frameReferences as Array<Record<string, unknown>>
  if (!Array.isArray(refs) || refs.length !== all.length || refs.some((frame, index) => frame.evidenceIndex !== index || frame.url !== all[index].url
    || frame.second !== all[index].second || !Number.isSafeInteger(frame.nativeFrameIndex) || !Number.isSafeInteger(frame.pts)
    || typeof frame.timeBase !== 'string')) invalid('原生帧URL、时刻与解码索引不一致')
  const samples = native.preservedSamples as Array<Record<string, unknown>>
  if (!Array.isArray(samples) || !samples.length || samples.some(sample => !Number.isSafeInteger(sample.evidenceIndex)
    || !refs[Number(sample.evidenceIndex)] || refs[Number(sample.evidenceIndex)].nativeFrameIndex !== sample.nativeFrameIndex)) invalid('缺少有效旧覆盖点映射')
  const observerIndices = [...new Set([0, ...samples.map(sample => Number(sample.evidenceIndex)), all.length - 1])].sort((a, b) => a - b)
  if (observerIndices.length > 24) invalid('草稿观察覆盖点超出独立24项预算；完整审核帧未被截断')
  return { observerFrames: observerIndices.map(index => all[index]),
    reviewImageDetail: { transport: { mode: 'sequence-grid', columns: 2, rows: 2, format: 'jpeg', quality: 95, chromaSubsampling: '4:4:4' },
      frameMetadata: refs.map((frame, evidenceIndex) => ({ evidenceIndex, nativeFrameIndex: frame.nativeFrameIndex,
        url: frame.url, time: frame.second, pts: frame.pts, timeBase: frame.timeBase })) } }
}
