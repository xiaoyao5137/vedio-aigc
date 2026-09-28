import test from 'node:test'
import assert from 'node:assert/strict'
import { assertModelProviderAllowed } from '../server/provider-policy.ts'

test('Ofox is blocked even when configured under an Anthropic or OpenAI provider name', () => {
  for (const provider of ['Anthropic', 'OpenAI', 'Custom']) {
    assert.throws(() => assertModelProviderAllowed({ provider, settings: { endpoint: 'https://api.ofox.ai/anthropic/v1/messages' } }), /MODEL_PROVIDER_DISABLED/)
  }
  assert.throws(() => assertModelProviderAllowed({ provider: 'Ofox', settings: { endpoint: 'https://example.test' } }), /MODEL_PROVIDER_DISABLED/)
  assert.doesNotThrow(() => assertModelProviderAllowed({ provider: 'Kling', settings: { endpoint: 'https://api-beijing.klingai.com/v1/images/generations' } }))
})
