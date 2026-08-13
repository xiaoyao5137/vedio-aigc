import test from 'node:test'
import assert from 'node:assert/strict'
import { sharedCredentialModelIds, syncSharedModelCredentials } from '../src/model-config.ts'

test('Qwen inherits the GPT Image API key when defaults are merged', () => {
  const models = syncSharedModelCredentials([
    { id: 'gpt-image-2', settings: { apiKey: 'gpt-shared-key' } },
    { id: 'qwen-image-3-pro', settings: { apiKey: '' } },
  ])
  assert.equal(models[1].settings.apiKey, 'gpt-shared-key')
  assert.deepEqual(sharedCredentialModelIds('qwen-image-3-pro'), ['gpt-image-2', 'qwen-image-3-pro'])
})

test('editing either Kling model synchronizes new and legacy credentials', () => {
  const models = syncSharedModelCredentials([
    { id: 'keling3', settings: { apiKey: 'old', accessKey: 'old-access', secretKey: 'old-secret' } },
    { id: 'kling-image-3', settings: { apiKey: 'new', accessKey: 'new-access', secretKey: 'new-secret' } },
  ], 'kling-image-3')
  assert.deepEqual(models[0].settings, { apiKey: 'new', accessKey: 'new-access', secretKey: 'new-secret' })
  assert.deepEqual(models[1].settings, { apiKey: 'new', accessKey: 'new-access', secretKey: 'new-secret' })
})
