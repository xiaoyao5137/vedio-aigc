import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import { callCodexText, resolveCodexExecutablePath, resolveCodexTextConfig, CODEX_TEXT_LIMITS, CodexTextError, type CodexTextDependencies } from '../server/codex-text.ts'
import type { LoadedReviewImage } from '../server/review-images.ts'
import { extractTextResponse, normalizeStructuredTextOutput } from '../src/workflow-core.ts'

const model = { capability: 'text', settings: { executablePath: '/mock/codex', model: 'configured-model', reasoningEffort: 'high', timeoutMs: '1000' } }
const configuration = () => resolveCodexTextConfig(model)
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const successEvents = (text: string) => [
  { type: 'thread.started', thread_id: 'ephemeral-test' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text } },
  { type: 'turn.completed', usage: { input_tokens: 25, output_tokens: 10 } },
]
type Invocation = {
  executable: string; args: string[]; options: SpawnOptionsWithoutStdio; prompt: string
  child: ChildProcessWithoutNullStreams; signals: NodeJS.Signals[]
  complete: (events: unknown[], final?: string, exitCode?: number, trailingNewline?: boolean) => Promise<void>
}
function mockProcess(action: (invocation: Invocation) => Promise<void> | void, ignoreTerm = false) {
  const calls: Invocation[] = [], failures: unknown[] = []
  const dependencies: CodexTextDependencies = { killGraceMs: 5, env: { HOME: '/auth-home', PATH: '/bin', CODEX_HOME: '/auth-home/.codex',
    OPENAI_API_KEY: 'sk-should-not-inherit', OPENAI_BASE_URL: 'https://other-provider.invalid', CODEX_THREAD_ID: 'parent-task', HTTPS_PROXY: 'secret-proxy' },
    spawn: (executable, args, options) => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill(signal: NodeJS.Signals = 'SIGTERM') {
          invocation.signals.push(signal)
          if (!(ignoreTerm && signal === 'SIGTERM')) queueMicrotask(() => child.emit('close', null, signal))
          return true
        } }) as unknown as ChildProcessWithoutNullStreams
      const invocation: Invocation = { executable, args, options, child, prompt: '', signals: [],
        async complete(events, final, exitCode = 0, trailingNewline = true) {
          if (final !== undefined) await writeFile(args[args.indexOf('--output-last-message') + 1], final)
          const bytes = Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + (trailingNewline ? '\n' : ''))
          for (let i = 0; i < bytes.length; i += 7) child.stdout.write(bytes.subarray(i, i + 7))
          child.stdout.end(); child.stderr.end(); child.emit('close', exitCode, null)
        } }
      child.stdin.on('data', chunk => { invocation.prompt += chunk.toString() })
      child.stdin.once('finish', () => { Promise.resolve().then(() => action(invocation)).catch(error => { failures.push(error); child.emit('error', error) }) })
      calls.push(invocation)
      return child
    } }
  return { dependencies, calls, failures }
}

test('Codex options resolve explicit provider settings without guessing a model or passing unrelated parameters', () => {
  const source = Object.freeze({ capability: 'text', settings: Object.freeze({ ...model.settings }) })
  const params = Object.freeze({ reasoningEffort: 'ultra', timeoutMs: 2500, apiKey: 'not-used', temperature: 0, maxTokens: 999, arbitraryConfig: 'never-forward' })
  assert.deepEqual(resolveCodexTextConfig(source, params), { executablePath: '/mock/codex', model: 'configured-model', reasoningEffort: 'ultra', timeoutMs: 2500,
    maxStdoutBytes: CODEX_TEXT_LIMITS.stdoutBytes, maxStderrBytes: CODEX_TEXT_LIMITS.stderrBytes })
  const defaults = resolveCodexTextConfig({ capability: 'text', settings: {} })
  assert.equal(defaults.executablePath, process.env.VIDEO_AIGC_CODEX_CLI ?? 'codex'); assert.equal(defaults.timeoutMs, 180_000)
  assert.equal(Object.hasOwn(defaults, 'model'), false); assert.equal(Object.hasOwn(defaults, 'reasoningEffort'), false)
  assert.equal(source.settings.reasoningEffort, 'high'); assert.equal(params.apiKey, 'not-used')
  for (const invalid of [{ timeoutMs: 0 }, { timeoutMs: 'Infinity' }, { timeoutMs: CODEX_TEXT_LIMITS.timeoutMs + 1 }, { timeoutMs: 1.1 },
    { maxStdoutBytes: CODEX_TEXT_LIMITS.stdoutBytes + 1 }, { maxStderrBytes: 0 }, { executablePath: 'bad\npath' }, { model: 123 }, { reasoningEffort: 'invented' }]) {
    assert.throws(() => resolveCodexTextConfig(model, invalid), /CODEX_CONFIG_INVALID/)
  }
  assert.throws(() => resolveCodexTextConfig({ ...model, capability: 'video' }), /CODEX_CONFIG_INVALID/)
})

test('only an absent known old app executable resolves to an executable CLI in the same bundle, retaining provenance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-bundle-resolution-'))
  try {
    for (const name of ['ChatGPT.app', 'Codex.app']) {
      const resources = path.join(directory, name, 'Contents', 'Resources')
      const configured = path.join(resources, 'codex')
      const current = path.join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex')
      await mkdir(path.dirname(current), { recursive: true }); await writeFile(current, 'fixture-cli', { mode: 0o700 })
      assert.equal(resolveCodexExecutablePath(configured), current)
      const source = Object.freeze({ capability: 'text', settings: Object.freeze({ ...model.settings, executablePath: configured }) })
      const config = resolveCodexTextConfig(source)
      assert.equal(config.executablePath, current); assert.equal(config.configuredExecutablePath, configured)
      const mock = mockProcess(invocation => invocation.complete(successEvents('fixture answer'), 'fixture answer'))
      const result = await callCodexText(config, 'fixture request', [], mock.dependencies)
      assert.equal(mock.calls[0].executable, current)
      assert.deepEqual({ executablePath: current, configuredExecutablePath: configured, executableResolution: 'legacy-app-bundle' },
        Object.fromEntries(['executablePath', 'configuredExecutablePath', 'executableResolution'].map(key => [key, (result.body.raw.appliedConfig as Record<string, unknown>)[key]])))
      assert.equal(source.settings.executablePath, configured, 'model configuration is never rewritten')
      await writeFile(configured, 'old-fixture-cli', { mode: 0o600 })
      assert.equal(resolveCodexExecutablePath(configured), configured, 'an existing explicit old executable is not replaced, even when it cannot execute')
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('custom paths, inaccessible replacement files and cross-bundle targets do not fall back to another CLI', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-bundle-resolution-'))
  try {
    for (const name of ['ChatGPT.app', 'Codex.app', 'Custom.app']) {
      const configured = path.join(directory, name, 'Contents', 'Resources', 'codex')
      const candidate = path.join(path.dirname(configured), 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex')
      assert.equal(resolveCodexExecutablePath(configured), configured, 'missing replacement keeps the original hard-failure path')
      await mkdir(path.dirname(candidate), { recursive: true }); await writeFile(candidate, 'fixture-cli', { mode: 0o600 })
      assert.equal(resolveCodexExecutablePath(configured), configured, 'a non-executable candidate cannot be selected')
      await chmod(candidate, 0o700)
      if (name === 'Custom.app') assert.equal(resolveCodexExecutablePath(configured), configured, 'unknown explicit app paths remain exact')
      await rm(candidate); const external = path.join(directory, name + '-external-cli')
      await writeFile(external, 'external-fixture-cli', { mode: 0o700 }); await symlink(external, candidate)
      assert.equal(resolveCodexExecutablePath(configured), configured, 'same-layout symlinks to a different bundle are not trusted')
    }
    for (const configured of ['codex', '/custom/tool/codex', '/Applications/Other.app/Contents/Resources/codex', 'ChatGPT.app/Contents/Resources/codex']) {
      assert.equal(resolveCodexExecutablePath(configured), configured)
    }
    const source = { capability: 'text', settings: { ...model.settings, executablePath: path.join(directory, 'ChatGPT.app', 'Contents', 'Resources', 'codex') } }
    assert.equal(resolveCodexTextConfig(source, { executablePath: '/explicit/custom-cli' }).executablePath, '/explicit/custom-cli', 'per-call custom intent still wins')
    const mock = mockProcess(invocation => { invocation.child.emit('error', Error('fixture missing executable')) })
    await assert.rejects(callCodexText(resolveCodexTextConfig(source), 'fixture request', [], mock.dependencies), error => {
      assert.ok(error instanceof CodexTextError); assert.match(error.message, /CODEX_SPAWN_FAILED/)
      const applied = error.raw.appliedConfig as Record<string, unknown>
      assert.equal(applied.executablePath, source.settings.executablePath)
      assert.equal(applied.configuredExecutablePath, source.settings.executablePath)
      assert.equal(applied.executableResolution, 'configured'); return true
    })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('copies exact loaded image snapshots in order, labels crop provenance and applies isolated CLI arguments', async () => {
  const originalBytes = Buffer.from('already validated original JPEG bytes'), cropBytes = Buffer.from('already validated crop JPEG bytes')
  const frames: LoadedReviewImage[] = [
    { url: '/generated/frame.jpg', bytes: Buffer.from(originalBytes), kind: 'original', frameIndex: 4, label: '完整原帧4', sourceRect: { left: 0, top: 0, width: 1280, height: 720 } },
    { url: '/generated/frame.jpg', bytes: Buffer.from(cropBytes), kind: 'detail', frameIndex: 4, label: '原像素局部图4', sourceRect: { left: 20, top: 30, width: 200, height: 100 } },
  ]
  const answer = '  {"status":"unobservable","evidence":"嘴部可见，但静帧不证明发音。"}\n'
  const mock = mockProcess(async invocation => {
    assert.equal(invocation.options.shell, false); assert.equal(invocation.options.cwd, invocation.args[invocation.args.indexOf('-C') + 1])
    assert.deepEqual(invocation.options.env, { HOME: '/auth-home', PATH: '/bin', CODEX_HOME: '/auth-home/.codex' })
    assert.ok(invocation.args.includes('--ephemeral')); assert.ok(invocation.args.includes('--ignore-user-config')); assert.ok(invocation.args.includes('--ignore-rules'))
    assert.ok(invocation.args.includes('read-only')); assert.ok(invocation.args.includes('web_search="disabled"')); assert.ok(invocation.args.includes('project_doc_max_bytes=0'))
    for (const flag of ['apps', 'plugins', 'shell_tool', 'unified_exec', 'computer_use', 'browser_use', 'view_image', 'multi_agent', 'hooks']) {
      assert.ok(invocation.args.some((argument, index) => argument === '--disable' && invocation.args[index + 1] === flag))
    }
    assert.equal(invocation.args[invocation.args.indexOf('-m') + 1], 'configured-model')
    assert.ok(invocation.args.includes('model_reasoning_effort="high"'))
    assert.equal(invocation.args.includes('--output-schema'), false)
    assert.deepEqual(invocation.args.slice(-2), ['--', '-'])
    const filenames = invocation.args.flatMap((argument, index) => argument === '-i' ? [invocation.args[index + 1]] : [])
    assert.equal(filenames.length, 2)
    assert.deepEqual(await readFile(filenames[0]), originalBytes); assert.deepEqual(await readFile(filenames[1]), cropBytes)
    assert.match(invocation.prompt, /原像素局部图4/); assert.match(invocation.prompt, /不能替代原始全图或充当新的时间点/)
    assert.ok(invocation.prompt.indexOf('image-0.jpg') < invocation.prompt.indexOf('image-1.jpg'))
    await invocation.complete(successEvents(answer), answer)
  })
  const pending = callCodexText(configuration(), '逐项审核本次附件。', frames, mock.dependencies)
  frames[0].bytes.fill(1); frames[1].sourceRect!.left = 999
  const result = await pending
  assert.equal(result.status, 200); assert.equal(result.body.provider, 'Codex'); assert.equal(result.body.content[0].text, answer)
  const raw = result.body.raw
  assert.equal(raw.toolEventsObserved, 0); assert.deepEqual(raw.usage, { input_tokens: 25, output_tokens: 10 })
  const attachments = raw.attachments as Array<Record<string, unknown>>
  assert.equal(attachments[0].sha256, sha256(originalBytes)); assert.equal(attachments[1].sha256, sha256(cropBytes))
  assert.equal((attachments[1].sourceRect as { left: number }).left, 20)
  assert.deepEqual(mock.failures, []); assert.equal(mock.calls.length, 1)
  await assert.rejects(access(String(mock.calls[0].options.cwd)), /ENOENT/)
})

test('ordinary text remains untouched, while optional schema is validated and materialized per call', async () => {
  for (const schema of [undefined, { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }]) {
    const schemaBefore = structuredClone(schema), config = resolveCodexTextConfig({ capability: 'text', settings: { executablePath: '/mock/codex' } },
      schema ? { outputSchema: JSON.stringify(schema) } : {})
    const mock = mockProcess(async invocation => {
      assert.equal(invocation.args.includes('-m'), false, 'unconfigured model uses CLI built-in selection')
      assert.equal(invocation.args.some(argument => argument.startsWith('model_reasoning_effort=')), false)
      if (schema) assert.deepEqual(JSON.parse(await readFile(invocation.args[invocation.args.indexOf('--output-schema') + 1], 'utf8')), schema)
      else assert.equal(invocation.args.includes('--output-schema'), false)
      await invocation.complete(successEvents('plain text'), 'plain text', 0, false)
    })
    assert.equal((await callCodexText(config, 'plain text request', [], mock.dependencies)).body.content[0].text, 'plain text')
    assert.deepEqual(schema, schemaBefore)
  }
  for (const schema of ['{bad', [], null, {}, { type: 'made-up' }, { type: [] }, { type: 'object', properties: [] },
    { type: 'object', required: 'answer' }, { type: 'object', properties: { answer: { type: 9 } } }, { $ref: 'https://external.invalid/schema' }]) {
    assert.throws(() => resolveCodexTextConfig(model, { outputSchema: schema }), /CODEX_CONFIG_INVALID: outputSchema/)
  }
})

test('sequence PNG catalog snapshots every cell and never substitutes attachment numbers for evidence frame numbers', async () => {
  const bytes = Buffer.from('validated lossless PNG transport'), frames: LoadedReviewImage[] = [{ url: '/generated/a.jpg', bytes,
    kind: 'sequence-grid', mimeType: 'image/png', cells: [{ evidenceIndex: 12, nativeFrameIndex: 330, url: '/generated/a.jpg', time: 13.75, pts: 168960,
      timeBase: '1/12288', sourceSha256: 'a'.repeat(64), sourceRect: { left: 0, top: 0, width: 1280, height: 720 }, targetRect: { left: 0, top: 0, width: 1280, height: 720 } }] }]
  const mock = mockProcess(async invocation => {
    const filename = invocation.args[invocation.args.indexOf('-i') + 1]
    assert.match(filename, /image-0\.png$/);assert.deepEqual(await readFile(filename), bytes)
    assert.match(invocation.prompt, /cells.evidenceIndex/)
    await invocation.complete(successEvents('ok'), 'ok')
  })
  const pending = callCodexText(configuration(), '逐格观察。', frames, mock.dependencies)
  frames[0].cells![0].nativeFrameIndex = 999
  const result = await pending, attachment = (result.body.raw.attachments as Array<Record<string, unknown>>)[0]
  assert.equal(Object.hasOwn(attachment, 'frameIndex'), false)
  assert.equal((attachment.cells as Array<Record<string, unknown>>)[0].nativeFrameIndex, 330)
  assert.equal((attachment.cells as Array<Record<string, unknown>>)[0].evidenceIndex, 12)
  assert.deepEqual(mock.failures, [])
})

test('rejects any tool item, corrupt JSONL and unrecognized events, without retrying or keeping temporary files', async () => {
  for (const kind of ['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'todo_list', 'future_tool']) {
    const mock = mockProcess(async invocation => { await invocation.complete([{ type: 'turn.started' }, { type: 'item.started', item: { type: kind } }], 'not accepted') })
    await assert.rejects(callCodexText(configuration(), 'test', [], mock.dependencies), /CODEX_TOOL_EVENT/)
    assert.equal(mock.calls.length, 1); assert.ok(mock.calls[0].signals.includes('SIGTERM'))
    await assert.rejects(access(String(mock.calls[0].options.cwd)), /ENOENT/)
  }
  for (const output of ['{broken json}\n', '{"type":"future_event"}\n', 'not-json', '{"type":"item.completed","item":{}}\n']) {
    const mock = mockProcess(invocation => { invocation.child.stdout.write(output); invocation.child.emit('close', 0, null) })
    await assert.rejects(callCodexText(configuration(), 'test', [], mock.dependencies), /CODEX_(?:JSONL|EVENT)_INVALID/)
  }
})

test('timeout kills the child, escalates an ignored TERM and removes files before rejecting', async () => {
  const mock = mockProcess(() => {}, true)
  await assert.rejects(callCodexText({ ...configuration(), timeoutMs: 10 }, 'test', [], mock.dependencies), /CODEX_TIMEOUT/)
  assert.deepEqual(mock.calls[0].signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(mock.calls.length, 1); await assert.rejects(access(String(mock.calls[0].options.cwd)), /ENOENT/)
})

test('nonzero exit, failed/error events, incomplete turns and missing or empty final output cannot succeed', async () => {
  for (const [events, final, exit, expected] of [
    [successEvents('answer'), 'answer', 7, /CODEX_EXIT_FAILED/],
    [[{ type: 'turn.started' }, { type: 'turn.failed', error: { message: 'failure' } }], 'answer', 0, /CODEX_ERROR_EVENT/],
    [[{ type: 'error', message: 'authentication failed' }], 'answer', 0, /CODEX_ERROR_EVENT/],
    [[{ type: 'item.completed', item: { type: 'error', message: 'unexpected failure' } }], 'answer', 0, /CODEX_ERROR_EVENT/],
    [[{ type: 'turn.started' }], 'answer', 0, /CODEX_TURN_INCOMPLETE/],
    [successEvents('answer'), undefined, 0, /CODEX_FINAL_INVALID/],
    [successEvents('answer'), ' \n ', 0, /CODEX_EMPTY_FINAL/],
  ] as const) {
    const mock = mockProcess(invocation => invocation.complete([...events], final, exit))
    await assert.rejects(callCodexText(configuration(), 'test', [], mock.dependencies), expected)
    assert.equal(mock.calls.length, 1); await assert.rejects(access(String(mock.calls[0].options.cwd)), /ENOENT/)
  }
})

test('only exact recovered CLI diagnostics are permitted and remain auditable alongside the final success', async () => {
  const diagnostics = [
    { type: 'item.completed', item: { id: 'd1', type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.' } },
    { type: 'error', message: 'Reconnecting... 2/5 (request timed out)' },
    { type: 'item.completed', item: { id: 'd2', type: 'error', message: 'Falling back from WebSockets to HTTPS transport. request timed out' } },
  ]
  const mock = mockProcess(invocation => invocation.complete([...diagnostics, ...successEvents('recovered')], 'recovered'))
  const result = await callCodexText(configuration(), 'test', [], mock.dependencies)
  assert.deepEqual(result.body.raw.recoveredDiagnostics, diagnostics); assert.equal(result.body.raw.toolEventsObserved, 0)
  assert.equal((result.body.raw.events as unknown[]).length, diagnostics.length + 4)
  for (const events of [diagnostics, [{ type: 'error', message: 'Reconnecting... 6/5 (request timed out)' }],
    [{ type: 'error', message: 'Reconnecting... 2/5 (unauthorized)' }],
    [{ type: 'item.completed', item: { type: 'error', message: diagnostics[0].item!.message + ' Additional failure.' } }]]) {
    const failure = mockProcess(invocation => invocation.complete(events, 'not recovered'))
    await assert.rejects(callCodexText(configuration(), 'test', [], failure.dependencies), /CODEX_(?:TURN_INCOMPLETE|ERROR_EVENT)/)
  }
})

test('record-s24ke4 WebSocket reset reconnects and HTTPS recovery finish the same CLI invocation', async () => {
  const reason = 'stream disconnected before completion: Connection reset by peer (os error 54)'
  const diagnostics = [
    { type: 'error', message: `Reconnecting... 2/5 (${reason})` },
    { type: 'error', message: `Reconnecting... 5/5 (${reason})` },
    { type: 'item.completed', item: { id: 'https', type: 'error', message: `Falling back from WebSockets to HTTPS transport. ${reason}` } },
  ]
  const report = '{"version":"principle-review-v1","decision":"uncertain","issues":[],"warnings":["test report"]}'
  const mock = mockProcess(invocation => invocation.complete([...diagnostics, ...successEvents(report)], report))
  const result = await callCodexText(configuration(), 'review the existing media only', [], mock.dependencies)
  assert.equal(extractTextResponse(result.body), report)
  assert.deepEqual(result.body.raw.recoveredDiagnostics, diagnostics)
  assert.equal(mock.calls.length, 1, 'CLI reconnects without a second model invocation')
  assert.deepEqual(mock.calls[0].signals, [], 'recovery progress must not kill the CLI')
  assert.equal(result.body.raw.exitCode, 0)
})

test('socket-reset progress does not conceal terminal failure, authentication errors, missing output or deadline', async () => {
  const reason = 'stream disconnected before completion: Connection reset by peer (os error 54)'
  const progress = { type: 'error', message: `Reconnecting... 2/5 (${reason})` }
  for (const [events, final, exit, expected] of [
    [[progress], 'partial report', 0, /CODEX_TURN_INCOMPLETE/],
    [[progress, ...successEvents('report')], undefined, 0, /CODEX_FINAL_INVALID/],
    [[progress, ...successEvents('report')], 'report', 7, /CODEX_EXIT_FAILED/],
    [[progress, { type: 'turn.failed', error: { message: reason } }], 'report', 0, /CODEX_ERROR_EVENT/],
    [[{ type: 'error', message: reason }], 'report', 0, /CODEX_ERROR_EVENT/],
    [[{ type: 'error', message: `Reconnecting... 6/5 (${reason})` }], 'report', 0, /CODEX_ERROR_EVENT/],
    [[{ type: 'error', message: 'Reconnecting... 2/5 (unauthorized)' }], 'report', 0, /CODEX_ERROR_EVENT/],
    [[{ ...progress, error: { message: 'authentication failed' } }], 'report', 0, /CODEX_ERROR_EVENT/],
    [[{ type: 'error', message: `Reconnecting... 2/5 (${reason}; authentication failed)` }], 'report', 0, /CODEX_ERROR_EVENT/],
  ] as const) {
    const mock = mockProcess(invocation => invocation.complete([...events], final, exit))
    await assert.rejects(callCodexText(configuration(), 'test', [], mock.dependencies), expected)
    assert.equal(mock.calls.length, 1)
  }
  const stalled = mockProcess(invocation => { invocation.child.stdout.write(JSON.stringify(progress) + '\n') })
  await assert.rejects(callCodexText({ ...configuration(), timeoutMs: 10 }, 'test', [], stalled.dependencies), /CODEX_TIMEOUT/)
  assert.deepEqual(stalled.calls[0].signals, ['SIGTERM'])
})

test('output limits abort once and diagnostic errors redact synthetic credentials', async () => {
  for (const stream of ['stdout', 'stderr'] as const) {
    const mock = mockProcess(invocation => { invocation.child[stream].write(Buffer.alloc(65, 97)) })
    await assert.rejects(callCodexText({ ...configuration(), maxStdoutBytes: 64, maxStderrBytes: 64 }, 'test', [], mock.dependencies),
      new RegExp('CODEX_' + stream.toUpperCase() + '_TOO_LARGE'))
    assert.equal(mock.calls.length, 1)
  }
  const mock = mockProcess(invocation => {
    invocation.child.stderr.write('Bearer secret-in-stderr sk-test-secret12345')
    invocation.child.stdout.write(JSON.stringify({ type: 'error', message: 'Bearer secret-in-event', api_key: 'secret-field' }) + '\n')
  })
  await assert.rejects(callCodexText(configuration(), 'test', [], mock.dependencies), error => {
    assert.ok(error instanceof CodexTextError); assert.match(error.message, /CODEX_ERROR_EVENT/)
    assert.doesNotMatch(JSON.stringify(error.raw), /secret-in-stderr|sk-test-secret12345|secret-in-event|secret-field/)
    assert.match(JSON.stringify(error.raw), /REDACTED/); return true
  })
})

test('Codex envelopes never become business JSON when the final text is malformed', async () => {
  const mock = mockProcess(invocation => invocation.complete(successEvents('{"decision":'), '{"decision":'))
  const result = await callCodexText(configuration(), 'return JSON', [], mock.dependencies)
  assert.equal(result.body.type, 'message'); assert.equal(result.body.role, 'assistant')
  assert.equal(extractTextResponse(result.body), '{"decision":')
  assert.throws(() => normalizeStructuredTextOutput(result.body, extractTextResponse(result.body), 'json'), /JSON/)
  const plain = mockProcess(invocation => invocation.complete(successEvents('ordinary text'), 'ordinary text'))
  const textResult = await callCodexText(configuration(), 'write prose', [], plain.dependencies)
  assert.doesNotThrow(() => normalizeStructuredTextOutput(textResult.body, extractTextResponse(textResult.body), 'text'))
})

test('spawn failure and final output overflow retain diagnostics and clean temporary directories', async () => {
  let directory = '', attempts = 0
  await assert.rejects(callCodexText(configuration(), 'test', [], { spawn: (_command, _args, options) => {
    directory = String(options.cwd); attempts++; throw Error('untrusted executable failure text')
  } }), /CODEX_SPAWN_FAILED/)
  assert.equal(attempts, 1); await assert.rejects(access(directory), /ENOENT/)
  const oversized = mockProcess(invocation => invocation.complete(successEvents('too large'), 'a'.repeat(CODEX_TEXT_LIMITS.finalBytes + 1)))
  await assert.rejects(callCodexText(configuration(), 'test', [], oversized.dependencies), /CODEX_FINAL_TOO_LARGE/)
  await assert.rejects(access(String(oversized.calls[0].options.cwd)), /ENOENT/)
})
