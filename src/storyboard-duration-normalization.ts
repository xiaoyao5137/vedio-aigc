import { durationCanonicalJson, estimateSpeechDuration, resolveDurationPolicy } from './duration-policy.ts'
import { compileDurationSchedule } from './duration-schedule.ts'
import { normalizeDurationStoryboardDraft } from './workflow-core.ts'
import { allowsEmptyEditorialCast } from './history-drama.ts'
import { isStaticIllustrationStyle } from './animation-shot.ts'

type Value = Record<string, unknown>
export type StoryboardDurationNormalizationChange = {
  path: string; before: unknown; after: unknown
  source: 'writer-format' | 'actorless-editorial-format' | 'static-illustration-actor-binding' | 'audio-track-format' | 'shared-speech-policy' | 'unknown-state-format' | 'compiled-duration-range'
  removed?: boolean
}
const record = (value: unknown): value is Value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Normalize only fresh writer metadata. Content, source allocation, actor
 * identity, dependencies and overlap permissions remain authored obligations;
 * the complete validator must still approve the resulting candidate. */
export function normalizeRawStoryboardDurationCandidate(output: unknown, options: { scene?: Value; timingPolicy?: unknown; qualityDisposition?: unknown } = {}) {
  if (!record(output) || !record(output.pacing) || output.pacing.version !== 'duration-v2'
    || output.scheduleHash !== undefined || output.pacing.scheduleHash !== undefined) return undefined
  const changes: StoryboardDurationNormalizationChange[] = []
  const candidate = structuredClone(normalizeDurationStoryboardDraft(output))
  const pacing = candidate.pacing as Value
  const originalBeats = Array.isArray(output.pacing.beats) ? output.pacing.beats : []
  const beats = Array.isArray(pacing.beats) ? pacing.beats : []
  const hasScriptedVoice = beats.some(beat => record(beat) && (beat.kind === 'speech' || beat.kind === 'vocalization'))
  // "无对白" describes the absence of dialogue, but it is not one of the
  // provider/validator track enums. When the structured beats and transcript
  // independently prove there is no scripted voice, project it to the canonical
  // ambient track locally. This is metadata normalization, not a content edit.
  if (!hasScriptedVoice && (typeof candidate.audioText !== 'string' || !candidate.audioText.trim())
    && typeof candidate.audioType === 'string' && /^(?:无对白|无台词|无声|无|静音|环境音|纯环境音|none|silent)$/i.test(candidate.audioType.trim())) {
    changes.push({ path: 'audioType', before: candidate.audioType, after: '环境声', source: 'audio-track-format' })
    candidate.audioType = '环境声'
  }
  const actorlessEditorial = Boolean(options.scene && allowsEmptyEditorialCast(options.scene)
    && Array.isArray(candidate.characters) && candidate.characters.length === 0
    && Array.isArray(candidate.presentCharacters) && candidate.presentCharacters.length === 0)
  const staticIllustration = Boolean(options.scene
    && isStaticIllustrationStyle(options.scene.visualTreatment, options.scene.animationStyle))
  const candidateCharacters = Array.isArray(candidate.characters)
    ? candidate.characters.filter((name): name is string => typeof name === 'string' && Boolean(name.trim())) : []
  for (const [index, beat] of beats.entries()) {
    const original = originalBeats[index]
    if (!record(beat) || !record(original)) continue
    if (actorlessEditorial && (beat.kind === 'action' || beat.kind === 'reaction') && beat.actorIds === undefined) {
      beat.actorIds = []
      changes.push({ path: `pacing.beats[${index}].actorIds`, before: undefined, after: [], source: 'actorless-editorial-format' })
    }
    if (staticIllustration && (beat.kind === 'action' || beat.kind === 'reaction')
      && Array.isArray(beat.actorIds) && beat.actorIds.length === 0) {
      const bindingText = [beat.textOrVocalization, beat.performanceInstruction,
        record(beat.completion) ? beat.completion.evidenceAnchor : undefined].filter(value => typeof value === 'string').join('；')
      const named = candidateCharacters.filter(name => bindingText.includes(name))
      if (named.length === 1) {
        beat.actorIds = named
        changes.push({ path: `pacing.beats[${index}].actorIds`, before: [], after: named,
          source: 'static-illustration-actor-binding' })
      }
    }
    for (const field of ['textOrVocalization', 'performanceInstruction', 'resources']) {
      if (durationCanonicalJson(beat[field]) !== durationCanonicalJson(original[field])) changes.push({
        path: `pacing.beats[${index}].${field}`, before: original[field], after: beat[field], source: 'writer-format',
        ...(!Object.hasOwn(beat, field) ? { removed: true } : {}),
      })
    }
  }
  let policy: ReturnType<typeof resolveDurationPolicy> | undefined
  try {
    policy = resolveDurationPolicy(options.timingPolicy ?? pacing.timingPolicy)
    if (options.timingPolicy && pacing.timingPolicy
      && durationCanonicalJson(policy) !== durationCanonicalJson(resolveDurationPolicy(pacing.timingPolicy))) policy = undefined
  } catch { /* Policy errors remain the full validator's responsibility. */ }
  if (policy) for (const [index, beat] of beats.entries()) {
    if (!record(beat) || beat.kind !== 'speech' || typeof beat.textOrVocalization !== 'string' || !beat.textOrVocalization.trim()
      || !record(beat.durationEstimate)) continue
    const style = beat.deliveryStyle
    if (style !== 'dialogue' && style !== 'narration' && style !== 'chant' && style !== 'singing') continue
    const estimate = beat.durationEstimate
    if (![estimate.lower, estimate.expected, estimate.upper].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) continue
    let base: ReturnType<typeof estimateSpeechDuration>
    try { base = estimateSpeechDuration(beat.textOrVocalization, style, policy) } catch { continue }
    if (!base.characters) continue
    const lower = Math.max(Number(estimate.lower), base.lower)
    const expected = Math.max(Number(estimate.expected), base.expected, lower)
    const upper = Math.max(Number(estimate.upper), base.upper, expected)
    for (const [field, value] of Object.entries({ lower, expected, upper })) {
      if (estimate[field] === value) continue
      changes.push({ path: `pacing.beats[${index}].durationEstimate.${field}`, before: estimate[field], after: value, source: 'shared-speech-policy' })
      estimate[field] = value
    }
  }
  if (record(candidate.worldState) && Array.isArray(candidate.worldState.characters)) {
    for (const [index, character] of candidate.worldState.characters.entries()) {
      if (!record(character)) continue
      for (const field of ['position', 'heldProps', 'pendingAction']) {
        const state = character[field]
        if (!record(state) || state.status !== 'unknown' || !Object.hasOwn(state, 'value')) continue
        changes.push({ path: `worldState.characters[${index}].${field}.value`, before: state.value, after: undefined,
          removed: true, source: 'unknown-state-format' })
        delete state.value
      }
    }
  }
  // A caller must supply a validated single-scene/partition scope. Never infer
  // a smaller approved scene from the candidate's own coveredBeatIds.
  if (policy && options.scene && Number.isInteger(candidate.duration) && Number(candidate.duration) >= policy.minimumProviderDuration) {
    try {
      const compiled = compileDurationSchedule({ ...candidate, duration: policy.minimumProviderDuration },
        { scene: options.scene, timingPolicy: options.timingPolicy, qualityDisposition: options.qualityDisposition, selectDuration: true })
      const minimum = compiled.timingEstimate.requiredDuration
      const maximum = Math.min(policy.maximumProviderDuration, minimum + policy.maxConservativeExtraSeconds)
      const duration = Math.max(minimum, Math.min(maximum, Number(candidate.duration)))
      if (candidate.duration !== duration) {
        changes.push({ path: 'duration', before: candidate.duration, after: duration, source: 'compiled-duration-range' })
        candidate.duration = duration
      }
    } catch {
      // Coverage, actor resources, mixed tracks and >15 s content still fail in
      // the full validator; no budget or source obligation is removed here.
    }
  }
  return changes.length ? { candidate, changes } : undefined
}
