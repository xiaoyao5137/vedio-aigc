type Value = Record<string, unknown>

function screenSide(text: string, name: string, names: string[]) {
  const start = text.indexOf(name)
  if (start < 0) return undefined
  const end = Math.min(text.length, ...names.filter(other => other !== name).map(other => text.indexOf(other, start + name.length)).filter(index => index >= 0))
  const side = '画面(?:中(?:间)?)?(?:偏)?([左右])(?:侧|方|边)?'
  // Only screen coordinates count. An actor's own right shoulder is not a
  // location, and neither are directions appearing in another actor's clause.
  return text.slice(Math.max(0, start - 20), start).match(new RegExp(`${side}[^，。；\\n]{0,8}$`))?.[1]
    ?? text.slice(start + name.length, end).split(/[；。\n]/)[0].match(new RegExp(`(?:位于|位居|处于|在|站立于|行至|走到|来到|坐于)${side}`))?.[1]
}

export function expectedCrossingPositions(shot: Value) {
  if (!/错身|擦身|侧身(?:而过|错过)/.test(String(shot.videoPrompt))) return []
  const names = Array.isArray(shot.endCharacters) ? shot.endCharacters.map(String) : []
  if (names.length !== 2) return []
  const positions = names.map(name => ({ name, from: screenSide(String(shot.visualPrompt), name, names), to: screenSide(String(shot.lastFramePrompt), name, names) }))
  return positions.every(position => position.from && position.to && position.from !== position.to) && positions[0].to !== positions[1].to ? positions : []
}

export function crossingPositionIssue(shot: Value, endingState: string) {
  const expected = expectedCrossingPositions(shot)
  for (const position of expected) {
    const actual = screenSide(endingState, position.name, expected.map(item => item.name))
    if (!actual) return `VIDEO_REVIEW_INVALID: 错身动作缺少${position.name}在实际尾帧的画面左右位置，不能仅凭人物在场判通过`
    if (actual !== position.to) return `VIDEO_QUALITY_REJECTED: 错身动作未完成：${position.name}应从画面${position.from}侧走到${position.to}侧，实际仍在${actual}侧。必须完成两人相向侧身走过、交换画面左右位置，各自看向离开方向，不能并排靠近停留。保留全部旁白和角色。`
  }
}

export function historicalCrossingIssue(shot: Value, video: Value | undefined) {
  if (!expectedCrossingPositions(shot).length) return undefined
  const review = video?.visualReview as Value | undefined
  const evidence = review?.endingStateEvidence as Value | undefined
  if (evidence?.method !== 'actual-tail-image' || !video?.lastFrameUrl || evidence.frame !== video.lastFrameUrl) return '错身动作缺少实际尾帧来源证据'
  return crossingPositionIssue(shot, String(review?.endingState ?? ''))
}
