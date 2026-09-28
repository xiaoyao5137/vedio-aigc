import { collectVideoEvidence } from './video-inspection.ts'

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
const fractions = [.125, .25, .375, .5, .625, .75, .875]

/** Preserve the paid supplier plate and its actual middle frames before any
 * local routes, labels, portraits, or narration can hide a model defect. */
export async function collectHistoricalMapVideoPlateEvidence(videoUrl: string, root = process.cwd()) {
  return collectVideoEvidence({ url: videoUrl, frameFractions: fractions }, root)
}

export function historicalMapVideoReviewFrames(evidence: unknown) {
  const report = object(evidence)
  if (!Array.isArray(report.frames) || !Array.isArray(report.frameTimes)
    || report.frames.length !== fractions.length + 2 || report.frameTimes.length !== report.frames.length
    || typeof report.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(report.sha256)
    || typeof report.evidenceUrl !== 'string' || typeof report.url !== 'string') {
    throw new Error('HISTORICAL_MAP_VIDEO_EVIDENCE_INVALID: 原片采证不完整')
  }
  const urls = report.frames as unknown[], times = report.frameTimes as unknown[]
  return urls.slice(1, -1).map((url, index) => ({ url, second: times[index + 1] }))
}

export function buildHistoricalMapVideoReviewPrompt(evidence: unknown, shot: unknown) {
  const report = object(evidence), script = object(shot)
  const frames = historicalMapVideoReviewFrames(evidence)
  const context = { sourceVideoUrl: report.url, sourceVideoSha256: report.sha256, evidenceUrl: report.evidenceUrl, frames,
    approvedPlate: { visualPrompt: script.visualPrompt, lastFramePrompt: script.lastFramePrompt, videoPrompt: script.videoPrompt } }
  return `【历史地图供应商原片中间帧独立审核】\n这些附件依次是可灵原视频在 12.5% 至 87.5% 的实际中间帧，尚未叠加本地地名、路线、人物肖像或旁白。逐张只按像素审核，不用提示词承诺代替观察。\n${JSON.stringify(context)}\n任何人物、头像、玩具兵偶、可读字、伪字、地名、字幕、箭头、路线线条均须拒绝；这些元素只允许在审核通过后由本地确定性图层添加。地理底片还应保持山河与方位连续。模糊处拒绝，不漏看边角。只返回 JSON：{"version":"historical-map-video-review-v1","passed":false,"sourceVideoSha256":"原片完整 SHA256","evidenceUrl":"采证报告地址","frames":[{"url":"采证帧地址","second":0,"bakedPeople":false,"unreadableText":false,"observedLabels":[],"routeMarksVisible":false,"geographyConsistent":true,"issues":[]}],"issues":[]}。frames 必须按全部七张附件顺序逐项给出，passed 只在全部无问题时为 true。`
}

export function validateHistoricalMapVideoReview(review: unknown, evidence: unknown) {
  const result = object(review), report = object(evidence), frames = historicalMapVideoReviewFrames(evidence)
  const fail = (reason: string): never => { throw new Error(`HISTORICAL_MAP_VIDEO_REJECTED: ${reason}`) }
  if (result.version !== 'historical-map-video-review-v1' || result.passed !== true
    || result.sourceVideoSha256 !== report.sha256 || result.evidenceUrl !== report.evidenceUrl
    || !Array.isArray(result.issues) || result.issues.length
    || !Array.isArray(result.frames) || result.frames.length !== frames.length) {
    fail('原片独立审核缺失、未通过或与采证不一致')
  }
  const reviewedFrames = result.frames as unknown[]
  for (const [index, expected] of frames.entries()) {
    const frame = object(reviewedFrames[index])
    if (frame.url !== expected.url || frame.second !== expected.second
      || frame.bakedPeople !== false || frame.unreadableText !== false
      || frame.routeMarksVisible !== false || frame.geographyConsistent !== true
      || !Array.isArray(frame.observedLabels) || frame.observedLabels.length
      || !Array.isArray(frame.issues) || frame.issues.length) {
      fail(`第 ${index + 1} 张中间帧出现人物、文字、路线或地理问题`)
    }
  }
  return { version: result.version as 'historical-map-video-review-v1', passed: true as const,
    sourceVideoSha256: result.sourceVideoSha256 as string, evidenceUrl: result.evidenceUrl as string,
    reviewedFrames: frames, reviewerScope: 'supplier-clean-plate-middle-frames' as const }
}
