import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesStoryVideoModelContract, storyVideoModelContract } from '../src/story-media-retake-model.ts'

const model = () => ({ id: 'keling3', provider: 'Kling', capability: 'video', settings: {
  secretKey: 'secret', image: 'https://media.invalid/frame.png?Signature=private', imageTail: '',
  externalTaskId: '', endpoint: 'https://api.example.invalid/v1/videos', model: 'kling-v3',
  mode: 'std', resolution: '720p', duration: '14', cfgScale: '0.5', aspectRatio: '9:16',
  negativePrompt: '无文字', apiKey: 'secret', accessKey: 'secret',
} })

test('video model contract omits credentials and legacy signed media while retaining generation defaults', () => {
  const contract = storyVideoModelContract(model())
  assert.ok(contract)
  assert.deepEqual(Object.keys(contract.settings), Object.keys(contract.settings).sort())
  assert.equal(contract.id, 'keling3')
  assert.equal(contract.provider, 'Kling')
  assert.equal(contract.capability, 'video')
  assert.equal(contract.settings.model, 'kling-v3')
  assert.equal(contract.settings.duration, '14')
  assert.doesNotMatch(JSON.stringify(contract), /Signature|private|apiKey|accessKey|secretKey|imageTail|externalTaskId/)
})

test('model equality ignores object key order but rejects target and generation-setting drift', () => {
  const current = model()
  const pinned = storyVideoModelContract(current)
  assert.ok(pinned)
  const reverseSettings = Object.fromEntries(Object.entries(pinned.settings).reverse())
  assert.equal(matchesStoryVideoModelContract(current, { settings: reverseSettings,
    capability: 'video', provider: 'Kling', id: 'keling3' }), true)
  assert.equal(matchesStoryVideoModelContract({ ...current, provider: 'Other' }, pinned), false)
  assert.equal(matchesStoryVideoModelContract({ ...current, settings: { ...current.settings, model: 'kling-v4' } }, pinned), false)
  assert.equal(matchesStoryVideoModelContract({ ...current, settings: { ...current.settings, mode: 'pro' } }, pinned), false)
  assert.equal(matchesStoryVideoModelContract({ ...current, settings: { ...current.settings, resolution: '4k' } }, pinned), false)
  assert.equal(matchesStoryVideoModelContract({ ...current, settings: { ...current.settings, duration: '15' } }, pinned), false)
  assert.equal(matchesStoryVideoModelContract(current, { ...pinned, settings: { ...pinned.settings,
    apiKey: 'leak' } }), false)
})

test('unsafe endpoint and unknown generation setting fail closed', () => {
  const current = model()
  assert.equal(storyVideoModelContract({ ...current, settings: { ...current.settings,
    endpoint: 'https://user:password@api.example.invalid/v1/videos' } }), undefined)
  assert.equal(storyVideoModelContract({ ...current, settings: { ...current.settings,
    endpoint: 'https://api.example.invalid/v1/videos?token=secret' } }), undefined)
  assert.equal(storyVideoModelContract({ ...current, settings: { ...current.settings,
    unsupportedGenerationOption: 'on' } }), undefined)
})
