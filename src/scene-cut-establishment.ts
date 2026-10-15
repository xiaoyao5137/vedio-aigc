type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}

/** A tableau that must already be legible in frame zero is an observation
 * obligation, not a transformation with an unfinished starting pose. */
export function sceneCutEstablishmentBeat(beat: unknown) {
  const b = object(beat), completion = object(b.completion)
  if (b.kind !== 'action' || completion.requiredThisClip !== true) return false
  const anchor = typeof completion.evidenceAnchor === 'string' && completion.evidenceAnchor.trim()
    ? completion.evidenceAnchor.trim()
    : typeof b.textOrVocalization === 'string'
      ? b.textOrVocalization.split(/[。；\n]/u)[0].trim() : ''
  const finalState = typeof completion.finalState === 'string' ? completion.finalState : ''
  // Descriptions such as “shoulders already straight” state a pose at t=0.
  // Keep active “straighten the body” verbs disallowed, while recognizing the
  // completed adjective when an already-bound tableau is explicitly shown.
  const activeAnchor = anchor.replace(/(?:肩背|背脊|身体|躯干)挺直/gu, '')
  return /(?:交代|呈现|建立|展示|显示|清楚看见|清楚可见)/u.test(finalState)
    && /(?:站在|立于|坐在|位于|摆着|被缚|已缚|守住|保持)/u.test(anchor)
    && !/(?:抬手|举手|挥手|合拢|封住|封堵|缚住|绑住|收紧|拉紧|系结|打结|踏稳|挺直|直起|起身|站起|走近|走到|走向|走去|押送|迈步|起步|跨过|跨入|停在|停步|停下|收步|俯身|伸手|递出|接过)/u.test(activeAnchor)
}
