import type { DurationBeat } from '../../src/duration-schedule.ts'

/** Reduced timing-bearing fields from the failed lm6wks video request. The
 * authored 1.5-second entrance is an estimate; its compiled upper window is 2.
 * No provider URL, credential, execution snapshot, or generated media is used. */
export function emptyOpeningShot() {
  const actor = '房植门生', path = '从街市右侧沿街道走入画面中央'
  const audioText = '建宁初年,桓帝即位。帝昔为蠡吾侯时,曾受学于甘陵人周福,即位后擢福为尚书。同郡河南尹房植,有名当朝'
  const beats: DurationBeat[] = [
    { id: 'beat-pacing-01', sourceBeatId: 'beat-01', actorIds: [actor], kind: 'action', textOrVocalization: path,
      dependsOn: [], overlapAllowedWith: ['beat-pacing-02'], resources: ['body'],
      durationEstimate: { lower: 1, expected: 1.5, upper: 2, source: '步行进入画面的基础动作时间', confidence: 'high' },
      completion: { requiredThisClip: true, finalState: actor + '已从街市右侧走入画面中央', modality: 'visual', evidenceAnchor: actor + '行走街市' },
      timingConstraint: { mode: 'reference' } },
    { id: 'beat-pacing-02', sourceBeatId: 'beat-01', actorIds: ['旁白'], kind: 'speech', deliveryStyle: 'narration', textOrVocalization: audioText,
      dependsOn: [], overlapAllowedWith: ['beat-pacing-01'], resources: ['voice'],
      durationEstimate: { lower: 9.7, expected: 10.656, upper: 14.381, source: '实际候选的旁白预算', confidence: 'high' },
      completion: { requiredThisClip: true, finalState: '旁白完整说出背景信息', modality: 'audio', evidenceAnchor: audioText },
      timingConstraint: { mode: 'reference' } },
  ]
  return { duration: 15, coveredBeatIds: ['beat-01'], characters: [actor], presentCharacters: [actor],
    initialCharacters: [] as string[], enteringCharacters: [{ name: actor, startSecond: 0, endSecond: 1.5, path }],
    audioType: '旁白', audioText, videoPrompt: '', pacing: { version: 'duration-v2', beats } }
}
