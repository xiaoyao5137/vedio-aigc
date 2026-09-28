/** Decode receipts are trusted service evidence, but their optional display
 * fields must still match this exact URL/index/PTS/duration before extending
 * a requirement's range. Self-contained for explicitly bound VM embedding. */
export function resolveNativeFrameDisplayInterval(evidence: Record<string, unknown>, index: number): {
  startSecond: number; endSecond: number; endBasis: string
} | undefined {
  const invalid = (reason: string): never => { throw Error('MEDIA_NATIVE_DISPLAY_INVALID: ' + reason) }
  const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const native = record(evidence.nativeSequence)
  if (native.version !== 2) return undefined
  const frames = evidence.frames, times = evidence.frameTimes, refs = evidence.frameReferences
  if (!Array.isArray(frames) || !Array.isArray(times) || !Array.isArray(refs) || refs.length !== frames.length || times.length !== frames.length
    || !Number.isSafeInteger(index) || index < 0 || index >= refs.length) invalid('原图、时刻与显示回执未逐项绑定')
  const rows = refs as Array<Record<string, unknown>>, frame = record(rows[index]), first = record(rows[0])
  const selected = native.selectedNativeFrameIndices
  if (!/^[a-f0-9]{64}$/.test(String(native.sourceVideoSha256)) || !/^[a-f0-9]{64}$/.test(String(native.archiveSha256))
    || !Number.isSafeInteger(native.totalNativeFrames) || Number(native.totalNativeFrames) < rows.length
    || !Array.isArray(selected) || selected.length !== rows.length || selected[index] !== frame.nativeFrameIndex) invalid('显示回执缺少原视频、原档案或所选解码帧绑定')
  const match = /^(\d+)\/(\d+)$/.exec(String(frame.timeBase)), numerator = Number(match?.[1]), denominator = Number(match?.[2])
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0
    || first.nativeFrameIndex !== 0 || first.second !== 0 || first.timeBase !== frame.timeBase || !Number.isSafeInteger(first.pts)
    || frame.index !== index || frame.evidenceIndex !== index || frame.url !== (frames as unknown[])[index] || frame.second !== (times as unknown[])[index]
    || !/^[a-f0-9]{64}$/.test(String(frame.sourceSha256)) || !Number.isSafeInteger(frame.nativeFrameIndex) || Number(frame.nativeFrameIndex) < 0
    || Number(frame.nativeFrameIndex) >= Number(native.totalNativeFrames) || !Number.isSafeInteger(frame.pts)
    || !Number.isSafeInteger(frame.durationPTS) || Number(frame.durationPTS) < 0
    || frame.second !== (Number(frame.pts) - Number(first.pts)) * numerator / denominator) invalid('显示区间的URL、帧号、原PTS、时刻或源哈希不一致')
  const tail = Number(frame.nativeFrameIndex) === Number(native.totalNativeFrames) - 1
  if (tail ? frame.nextNativeFrameIndex !== null || frame.nextFramePTS !== null
    : frame.nextNativeFrameIndex !== Number(frame.nativeFrameIndex) + 1 || !Number.isSafeInteger(frame.nextFramePTS) || Number(frame.nextFramePTS) <= Number(frame.pts)) invalid('显示区间缺少真实相邻解码帧边界')
  const next = rows.find(row => row.nativeFrameIndex === frame.nextNativeFrameIndex)
  if (next && (next.pts !== frame.nextFramePTS || next.timeBase !== frame.timeBase)) invalid('下一PTS与实际相邻原帧不一致')
  const durationEndPTS = Number(frame.durationPTS) > 0 ? Number(frame.pts) + Number(frame.durationPTS) : undefined
  if (durationEndPTS !== undefined && !Number.isSafeInteger(durationEndPTS)) invalid('显示durationPTS相加超出安全整数范围')
  const nextPTS = tail ? undefined : Number(frame.nextFramePTS)
  const endPTS = durationEndPTS === undefined ? nextPTS : Math.min(durationEndPTS, nextPTS ?? durationEndPTS)
  const basis = durationEndPTS !== undefined ? 'duration-pts' : nextPTS !== undefined ? 'next-pts' : 'unavailable'
  const duration = Number(evidence.duration), start = Number(frame.second)
  if (!Number.isFinite(duration) || duration <= 0 || start < 0 || start > duration) invalid('显示区间超出实际视频时长')
  const end = endPTS === undefined ? start : Math.min(duration, (endPTS - Number(first.pts)) * numerator / denominator)
  if (frame.displayStartSecond !== start || frame.displayEndSecond !== end || frame.displayEndBasis !== basis) invalid('声明的显示区间不符合真实PTS/durationPTS/相邻PTS；不能补造覆盖')
  return { startSecond: start, endSecond: end, endBasis: basis }
}
