/** A visible reaction can change body state just like an action. */
export function sceneCutVisualChangeRequired(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const beat = value as { kind?: unknown; completion?: unknown }
  const completion = beat.completion && typeof beat.completion === 'object'
    && !Array.isArray(beat.completion) ? beat.completion as {
      requiredThisClip?: unknown; modality?: unknown } : {}
  return completion.requiredThisClip === true
    && (beat.kind === 'action' || beat.kind === 'reaction' && completion.modality === 'visual')
}
