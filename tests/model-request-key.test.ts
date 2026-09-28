import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInflightModelRequests, modelRequestFingerprint } from '../server/model-request-key.ts'
import { resolveCodexTextConfig } from '../server/codex-text.ts'

test('large prompts and references retain a stable fingerprint after log redaction', () => {
  const request = { model: { id: 'video', settings: { endpoint: 'https://example.test', apiKey: 'secret' } }, prompt: '文'.repeat(12000), params: { image: 'data:image/png;base64,' + 'A'.repeat(20000), duration: 15 } }
  const fingerprint = modelRequestFingerprint(request)
  assert.equal(fingerprint.length, 64)
  assert.equal(fingerprint, modelRequestFingerprint({ ...request, params: { duration: 15, image: request.params.image } }))
  assert.notEqual(fingerprint, modelRequestFingerprint({ ...request, prompt: request.prompt + '修复' }))
})

test('simultaneous resume shares one submission; failure releases the entry', async () => {
  const share = createInflightModelRequests()
  let submissions = 0
  const execute = async () => { submissions++; await new Promise(resolve => setTimeout(resolve, 10)); return { taskId: 'one-paid-task' } }
  const [a, b] = await Promise.all([share('same-run:video:fingerprint', execute), share('same-run:video:fingerprint', execute)])
  assert.equal(submissions, 1)
  assert.equal(a, b)
  await assert.rejects(share('failed', async () => { throw new Error('transport') }), /transport/)
  assert.equal(await share('failed', async () => 'resumed'), 'resumed')
})

test('writer sampling changes invalidate checkpoints without binding them to credentials', () => {
  const request = { model: { id: 'text', settings: { temperature: '0.7', maxTokens: '8192', apiKey: 'one' } }, prompt: 'outline', params: {} }
  assert.notEqual(modelRequestFingerprint(request), modelRequestFingerprint({ ...request, model: { ...request.model, settings: { ...request.model.settings, temperature: '0' } } }))
  assert.equal(modelRequestFingerprint(request), modelRequestFingerprint({ ...request, model: { ...request.model, settings: { ...request.model.settings, apiKey: 'two' } } }))
})

test('explicit API protocol changes invalidate checkpoints while absent protocol preserves legacy identity', () => {
  const request = { model: { id: 'legacy-text', provider: 'Anthropic', capability: 'text', settings: {
    endpoint: 'https://gateway.test/v1/messages', model: 'selected-model', maxTokens: '2048', temperature: '0.7', apiKey: 'test-secret',
  } }, prompt: 'Review original images.', params: { reviewImages: ['/generated/frame-1.jpg', '/generated/frame-2.jpg'] }, operation: 'history.media-review' }
  const before = structuredClone(request), fingerprint = modelRequestFingerprint(request)
  // Captured with the pre-protocol fingerprint implementation. Adding an
  // undefined field must not invalidate already-persisted resumable checkpoints.
  assert.equal(fingerprint, '6fd883ec04f5bbff950d3f4bf6e1c063e4dc314cea96e599da815f3a00d85daa')
  const messages = { ...request, model: { ...request.model, settings: { ...request.model.settings, apiProtocol: 'anthropic-messages' } } }
  assert.notEqual(modelRequestFingerprint(messages), fingerprint)
  assert.notEqual(modelRequestFingerprint(messages), modelRequestFingerprint({ ...messages,
    model: { ...messages.model, settings: { ...messages.model.settings, apiProtocol: 'openai-responses' } } }))
  assert.equal(modelRequestFingerprint(messages), modelRequestFingerprint({ ...messages,
    model: { ...messages.model, settings: { ...messages.model.settings, apiKey: 'rotated-secret' } } }))
  assert.deepEqual(request, before)
})

test('explicit stream mode invalidates checkpoints while undefined preserves the legacy fingerprint', () => {
  const request = { model: { id: 'legacy-text', provider: 'Anthropic', capability: 'text', settings: {
    endpoint: 'https://gateway.test/v1/messages', model: 'selected-model', maxTokens: '2048', temperature: '0.7', apiKey: 'test-secret',
  } }, prompt: 'Review original images.', params: { reviewImages: ['/generated/frame-1.jpg', '/generated/frame-2.jpg'] }, operation: 'history.media-review' }
  const before = structuredClone(request), fingerprint = modelRequestFingerprint(request)
  assert.equal(fingerprint, '6fd883ec04f5bbff950d3f4bf6e1c063e4dc314cea96e599da815f3a00d85daa')
  const configured = (stream: string) => ({ ...request, model: { ...request.model, settings: { ...request.model.settings, stream } } })
  assert.notEqual(modelRequestFingerprint(configured('false')), fingerprint)
  assert.notEqual(modelRequestFingerprint(configured('true')), fingerprint)
  assert.notEqual(modelRequestFingerprint(configured('false')), modelRequestFingerprint(configured('true')))
  assert.equal(modelRequestFingerprint(configured('false')), modelRequestFingerprint({ ...configured('false'),
    model: { ...request.model, settings: { ...request.model.settings, stream: 'false', apiKey: 'rotated-secret' } } }))
  assert.notEqual(modelRequestFingerprint({ ...request, params: { ...request.params, stream: false } }), fingerprint)
  assert.notEqual(modelRequestFingerprint({ ...request, params: { ...request.params, stream: false } }),
    modelRequestFingerprint({ ...request, params: { ...request.params, stream: true } }))
  assert.deepEqual(request, before)
})

test('editing a saved model provider, capability or executable cannot reuse its previous checkpoint', () => {
  const request = { model: { id: 'saved-model', provider: 'Codex', capability: 'text',
    settings: { model: 'selected-model', transport: 'cli', executablePath: '/opt/codex' } }, prompt: '检查原始帧。', params: { reviewImages: ['/generated/frame.jpg'] } }
  const before = structuredClone(request), fingerprint = modelRequestFingerprint(request)
  for (const model of [
    { ...request.model, provider: 'Anthropic' },
    { ...request.model, capability: 'image' },
    { ...request.model, settings: { ...request.model.settings, transport: 'http' } },
    { ...request.model, settings: { ...request.model.settings, executablePath: '/another/codex' } },
  ]) assert.notEqual(modelRequestFingerprint({ ...request, model }), fingerprint)
  assert.deepEqual(request, before)
})

test('configured model, reasoning and timeout settings participate in request identity', () => {
  const request = { model: { id: 'saved-model', provider: 'Codex', capability: 'text', settings: { model: 'selected-model' } },
    prompt: 'Evaluate the attached evidence.', params: {} }
  const fingerprint = modelRequestFingerprint(request)
  for (const [key, value] of Object.entries({ model: 'another-model', reasoning: 'high', reasoningEffort: 'high', reasoning_effort: 'high',
    model_reasoning_effort: 'high', timeoutMs: '90000', taskTimeoutMs: '120000', pollIntervalMs: '1000', maxTokens: '4096', temperature: '0' })) {
    assert.notEqual(modelRequestFingerprint({ ...request, model: { ...request.model, settings: { ...request.model.settings, [key]: value } } }), fingerprint, key)
  }
  for (const params of [{ model: 'another-model' }, { reasoningEffort: 'high' }, { timeoutMs: 90000 }]) {
    assert.notEqual(modelRequestFingerprint({ ...request, params }), fingerprint, 'per-call override ' + JSON.stringify(params))
  }
})

test('output schema and output bounds changes invalidate a saved model checkpoint', () => {
  const request = { model: { id: 'saved-model', provider: 'Codex', capability: 'text',
    settings: { model: 'selected-model', executablePath: '/opt/codex', outputSchema: '{"type":"object","required":["passed"]}', maxStdoutBytes: '8192', maxStderrBytes: '1024' } },
    prompt: 'Evaluate the attached evidence.', params: {} }
  const fingerprint = modelRequestFingerprint(request)
  for (const [key, value] of Object.entries({ outputSchema: '{"type":"object","required":["decision"]}', maxStdoutBytes: '16384', maxStderrBytes: '2048' })) {
    assert.notEqual(modelRequestFingerprint({ ...request, model: { ...request.model, settings: { ...request.model.settings, [key]: value } } }), fingerprint, key)
  }
  for (const params of [{ outputSchema: { type: 'object', required: ['decision'] } }, { maxStdoutBytes: 16384 }, { maxStderrBytes: 2048 }]) {
    assert.notEqual(modelRequestFingerprint({ ...request, params }), fingerprint)
  }
})

test('Codex executable fallback matches actual precedence without leaking environment changes to concurrent tests', () => {
  const environmentBefore = process.env.VIDEO_AIGC_CODEX_CLI
  // Environment mutation happens only in a disposable child process; other
  // test files or concurrently running requests never observe these values.
  const result = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
    import { modelRequestFingerprint as fingerprint } from ${JSON.stringify(new URL('../server/model-request-key.ts', import.meta.url).href)};
    const original = process.env.VIDEO_AIGC_CODEX_CLI;
    const base = { model: { id: 'same-model', provider: 'Codex', capability: 'text', settings: { model: 'chosen-model' } }, prompt: 'audit', params: {} };
    const configured = path => ({ ...base, model: { ...base.model, settings: { ...base.model.settings, executablePath: path } } });
    const overridden = { ...configured('/configured/codex'), params: { executablePath: '/per-call/codex' } };
    const otherProvider = { ...base, model: { ...base.model, provider: 'Anthropic' } };
    let results;
    try {
      process.env.VIDEO_AIGC_CODEX_CLI = '/environment/one';
      const first = fingerprint(base), explicit = fingerprint(configured('/configured/codex')), override = fingerprint(overridden), other = fingerprint(otherProvider);
      results = { matchesExplicitEnvironment: first === fingerprint(configured('/environment/one')),
        emptySettingsUseEnvironment: first === fingerprint(configured('')) && first === fingerprint(configured('   ')),
        configuredPathTrims: fingerprint(configured(' /configured/codex ')) === explicit };
      process.env.VIDEO_AIGC_CODEX_CLI = '/environment/two';
      Object.assign(results, { environmentChangeInvalidates: first !== fingerprint(base), explicitIgnoresEnvironment: explicit === fingerprint(configured('/configured/codex')),
        overrideIgnoresEnvironment: override === fingerprint(overridden), otherProviderIgnoresEnvironment: other === fingerprint(otherProvider),
        blankOverrideUsesEnvironment: fingerprint({ ...configured('/configured/codex'), params: { executablePath: '' } }) === fingerprint({ ...base, params: { executablePath: '' } }) });
      delete process.env.VIDEO_AIGC_CODEX_CLI;
      results.defaultMatchesExplicitCodex = fingerprint(base) === fingerprint(configured('codex'));
    } finally {
      if (original === undefined) delete process.env.VIDEO_AIGC_CODEX_CLI;
      else process.env.VIDEO_AIGC_CODEX_CLI = original;
    }
    results.environmentRestored = process.env.VIDEO_AIGC_CODEX_CLI === original;
    console.log(JSON.stringify(results));
  `], { env: { ...process.env, VIDEO_AIGC_CODEX_CLI: '/isolated-test/original' }, encoding: 'utf8' })) as Record<string, boolean>
  for (const [caseName, passed] of Object.entries(result)) assert.equal(passed, true, caseName)
  assert.equal(process.env.VIDEO_AIGC_CODEX_CLI, environmentBefore)
})

test('identity is canonical, leaves frozen request payloads intact and ignores credential rotation', () => {
  const settings = Object.freeze({ model: 'selected-model', reasoningEffort: 'high', timeoutMs: '90000', executablePath: '/opt/codex',
    apiKey: 'private-one', accessKey: 'access-one', secretKey: 'secret-one', authorization: 'bearer-one', authToken: 'token-one' })
  const params = Object.freeze({ reviewImages: Object.freeze(['/generated/frame-0.jpg', '/generated/frame-1.jpg']),
    detail: Object.freeze({ rows: 2, columns: 2 }) })
  const request = Object.freeze({ model: Object.freeze({ id: 'saved-model', provider: 'Codex', capability: 'text', settings }),
    prompt: '逐项审核。', params, operation: 'quality.requirement-review' })
  const before = structuredClone(request), fingerprint = modelRequestFingerprint(request)
  const reordered = { ...request, model: { ...request.model, settings: Object.fromEntries(Object.entries(settings).reverse()) },
    params: { detail: { columns: 2, rows: 2 }, reviewImages: [...params.reviewImages] } }
  assert.equal(modelRequestFingerprint(reordered), fingerprint)
  assert.equal(modelRequestFingerprint({ ...request, model: { ...request.model, settings: { ...settings,
    apiKey: 'private-two', accessKey: 'access-two', secretKey: 'secret-two', authorization: 'bearer-two', authToken: 'token-two' } } }), fingerprint)
  assert.match(fingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(request, before)
})

test('a relocated known app CLI has the same effective request identity as the adapter without changing submitted configuration', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'video-aigc-codex-fingerprint-'))
  try {
    const resources = path.join(directory, 'ChatGPT.app', 'Contents', 'Resources')
    const legacy = path.join(resources, 'codex')
    const bundled = path.join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex')
    await mkdir(path.dirname(bundled), { recursive: true })
    await writeFile(bundled, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    await writeFile(legacy, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const request = { model: { id: 'saved-model', provider: 'Codex', capability: 'text', settings: { executablePath: legacy } }, prompt: 'audit', params: {} }
    const before = structuredClone(request), original = modelRequestFingerprint(request)
    assert.equal(resolveCodexTextConfig(request.model).executablePath, legacy, 'an existing configured binary remains authoritative')
    await rm(legacy)
    const relocated = modelRequestFingerprint(request)
    assert.equal(resolveCodexTextConfig(request.model).executablePath, bundled)
    assert.notEqual(relocated, original, 'changing the actually executed path invalidates old identity')
    assert.equal(relocated, modelRequestFingerprint({ ...request, model: { ...request.model, settings: { executablePath: bundled } } }))
    assert.deepEqual(request, before)
    await chmod(bundled, 0o600)
    assert.equal(resolveCodexTextConfig(request.model).executablePath, legacy, 'a non-executable candidate cannot replace the configured CLI')
    assert.equal(modelRequestFingerprint(request), original)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('media dedup preserves ordered source inputs, operation and explicit resume identity', async () => {
  const request = { model: { id: 'video', provider: 'Kling', capability: 'video',
    settings: { model: 'kling-v3', endpoint: 'https://video.test', taskTimeoutMs: '900000' } },
    prompt: 'Continue this scene.', params: { referenceImages: ['first-image', 'second-image'], duration: 14, sound: 'on' }, operation: 'video.generate' }
  const fingerprint = modelRequestFingerprint(request)
  assert.equal(modelRequestFingerprint({ ...request, params: { sound: 'on', duration: 14, referenceImages: [...request.params.referenceImages] } }), fingerprint)
  assert.notEqual(modelRequestFingerprint({ ...request, params: { ...request.params, referenceImages: [...request.params.referenceImages].reverse() } }), fingerprint)
  assert.notEqual(modelRequestFingerprint({ ...request, operation: 'video.inspect' }), fingerprint)
  const resume = { ...request, params: { ...request.params, resumeTaskId: 'existing-paid-task', resumeQueryMode: 'omni' } }
  const resumeFingerprint = modelRequestFingerprint(resume)
  assert.notEqual(resumeFingerprint, fingerprint)
  assert.notEqual(modelRequestFingerprint({ ...resume, params: { ...resume.params, resumeTaskId: 'another-paid-task' } }), resumeFingerprint)
  const share = createInflightModelRequests()
  let calls = 0
  const execute = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { taskId: 'existing-paid-task' } }
  const results = await Promise.all([share('same-run:' + resumeFingerprint, execute), share('same-run:' + modelRequestFingerprint(structuredClone(resume)), execute)])
  assert.equal(calls, 1);assert.equal(results[0], results[1])
})
