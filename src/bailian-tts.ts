import catalog from './bailian-voice-catalog.json' with { type: 'json' }

export const bailianVoiceCatalog = catalog
export function bailianVoiceOptions(model: string) {
  return catalog.voices.filter(voice => voice.model === model).map(voice => ({ ...voice,
    label: [voice.name, voice.gender, voice.age ? `${voice.age}岁` : '', voice.trait, voice.language].filter(Boolean).join(' · '),
  }))
}
