import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import sharp from 'sharp'
import { callCodexImage, CodexImageError, resolveCodexImageConfig } from '../server/codex-image.ts'

const threadId = '01234567-89ab-cdef-0123-456789abcdef'
const config = () => resolveCodexImageConfig({ capability: 'image', settings: { executablePath: '/mock/codex', model: 'gpt-6-luna', timeoutMs: '1000' } })
const success = [
  { type: 'thread.started', thread_id: threadId }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'The image has been generated.' } },
  { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 10 } },
]

function mockProcess(action: (args: string[], options: SpawnOptionsWithoutStdio, child: ChildProcessWithoutNullStreams, input: string) => Promise<void>) {
  let calls = 0
  const spawn = (_executable: string, args: string[], options: SpawnOptionsWithoutStdio) => {
    calls++
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true } }) as unknown as ChildProcessWithoutNullStreams
    let input = ''
    child.stdin.on('data', chunk => { input += chunk.toString() })
    child.stdin.once('finish', () => { void action(args, options, child, input) })
    return child
  }
  return { spawn, get calls() { return calls } }
}

test('Codex image config keeps agent model separate from the built-in GPT Image model', () => {
  assert.equal(config().model, 'gpt-6-luna')
  assert.equal(resolveCodexImageConfig({ capability: 'image', settings: {} }).timeoutMs, 600_000)
  assert.throws(() => resolveCodexImageConfig({ capability: 'image', settings: { model: 'gpt-image-2' } }), /主代理模型/)
  assert.throws(() => resolveCodexImageConfig({ capability: 'image', settings: { model: 'openai/gpt-image-2' } }), /主代理模型/)
  assert.throws(() => resolveCodexImageConfig({ capability: 'image', settings: {} }, { n: 2 }), /仅支持生成1张/)
  assert.equal(resolveCodexImageConfig({ capability: 'image', settings: {} }, { size: '576x1024' }).size, '576x1024')
  assert.equal(resolveCodexImageConfig({ capability: 'image', settings: {} }, { singleFrame: 'true' }).singleFrame, true)
  assert.throws(() => resolveCodexImageConfig({ capability: 'image', settings: {} }, { size: '10x9999' }), /size/)
  assert.throws(() => resolveCodexImageConfig({ capability: 'image', settings: {} }, { referenceImages: Array(6).fill('x') }), /最多支持5张/)
  assert.throws(() => resolveCodexImageConfig({ capability: 'image', settings: {} }, { referenceImage: 'x' }), /不支持.*精确传递/)
  assert.throws(() => resolveCodexImageConfig({ capability: 'text', settings: {} }), /image 能力/)
})

test('Codex image stages four ordered JPEG references and saves an undistorted 576x1024 frame', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-image-references-'))
  const codexHome = path.join(root, 'codex-home')
  const referenceBytes = await Promise.all(['#123456', '#abcdef', '#654321', '#fedcba'].map(color =>
    sharp({ create: { width: 48, height: 64, channels: 3, background: color } }).jpeg().toBuffer()))
  const references = referenceBytes.map(bytes => ({ url: 'data:image/jpeg;base64,' + bytes.toString('base64') }))
  const configWithReferences = resolveCodexImageConfig({ capability: 'image', settings: {
    executablePath: '/mock/codex', model: 'gpt-6-luna', timeoutMs: '1000',
  } }, { referenceImages: references, size: '576x1024', singleFrame: true })
  const original = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#335577' } }).png().toBuffer()
  const mock = mockProcess(async (args, options, child, input) => {
    const paths = args.flatMap((arg, index) => arg === '-i' ? [args[index + 1]] : [])
    assert.equal(paths.length, 4)
    assert.ok(paths.every(filename => filename.startsWith(String(options.cwd) + path.sep)))
    for (let index = 0; index < paths.length; index++) assert.deepEqual(await readFile(paths[index]), referenceBytes[index])
    assert.match(input, /referenced_image_paths/)
    assert.match(input, /576x1024/)
    assert.match(input, /单幅完整画面/)
    for (const filename of paths) assert.ok(input.includes(filename))
    const folder = path.join(codexHome, 'generated_images', threadId)
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'exec-result.png'), original)
    child.stdout.end(Buffer.from(success.map(event => JSON.stringify(event)).join('\n') + '\n'))
    child.stderr.end(); child.emit('close', 0, null)
  })
  try {
    const result = await callCodexImage(configWithReferences, '矮脚蓝猫与柴犬', { spawn: mock.spawn,
      codexHome, outputRoot: root, env: { HOME: root, PATH: '/bin', CODEX_HOME: codexHome } })
    const saved = await readFile(path.join(root, 'public', result.body.data[0].url))
    const dimensions = await sharp(saved).metadata()
    assert.equal(dimensions.width, 576)
    assert.equal(dimensions.height, 1024)
    assert.equal((result.body.raw.outputSize as { method: string }).method, 'contain-over-blurred-background')
    assert.deepEqual((result.body.raw.outputSize as { source: unknown }).source, { width: 600, height: 600 })
    assert.equal((result.body.raw.references as unknown[]).length, 4)
    assert.equal(mock.calls, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex image rejects malformed references before starting a CLI process', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-image-bad-reference-'))
  const mock = mockProcess(async () => { throw new Error('Unexpected CLI invocation') })
  try {
    await assert.rejects(callCodexImage(resolveCodexImageConfig({ capability: 'image', settings: {
      executablePath: '/mock/codex', timeoutMs: '1000',
    } }, { referenceImages: [{ url: 'data:image/jpeg;base64,AAAA' }] }), '请生图', {
      spawn: mock.spawn, codexHome: root, outputRoot: root, env: { HOME: root, PATH: '/bin' },
    }), /CODEX_IMAGE_REFERENCE_INVALID/)
    assert.equal(mock.calls, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex image accepts only a complete CLI turn with one real PNG from the matching thread', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-image-test-'))
  const codexHome = path.join(root, 'codex-home')
  const png = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#3366aa' } }).png().toBuffer()
  const mock = mockProcess(async (args, options, child, input) => {
    assert.equal(options.shell, false)
    assert.ok(args.includes('--ignore-user-config') && args.includes('--ignore-rules') && args.includes('image_generation'))
    assert.ok(args.includes('shell_tool') && args.includes('unified_exec'))
    assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-luna')
    assert.match(input, /\$imagegen/)
    const folder = path.join(codexHome, 'generated_images', threadId)
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'exec-result.png'), png)
    child.stdout.end(Buffer.from(success.map(event => JSON.stringify(event)).join('\n') + '\n'))
    child.stderr.end(); child.emit('close', 0, null)
  })
  try {
    const result = await callCodexImage(config(), '白底蓝色方块', { spawn: mock.spawn, codexHome, outputRoot: root,
      env: { HOME: root, PATH: '/bin', CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-not-forwarded' } })
    assert.equal(result.status, 200)
    const url = result.body.data[0].url
    assert.match(url, /^\/generated\/image-[a-f0-9]+\.png$/)
    assert.deepEqual(await readFile(path.join(root, 'public', url)), png)
    assert.equal(result.body.raw.threadId, threadId)
    assert.equal(mock.calls, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex image accepts recovered transport diagnostics only after a complete turn and one decoded image', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-image-reconnect-'))
  const codexHome = path.join(root, 'codex-home')
  const png = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#3366aa' } }).png().toBuffer()
  const mock = mockProcess(async (_args, _options, child) => {
    const folder = path.join(codexHome, 'generated_images', threadId)
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'exec-result.png'), png)
    const events = [success[0], success[1],
      { type: 'error', message: 'Reconnecting... 1/5 (request timed out)' },
      { type: 'error', message: 'Reconnecting... 2/5 (workspace routing discovery timed out)' },
      { type: 'item.completed', item: { id: 'transport', type: 'error', message: 'Falling back from WebSockets to HTTPS transport. request timed out' } },
      success[2], success[3]]
    child.stdout.end(events.map(event => JSON.stringify(event)).join('\n') + '\n')
    child.stderr.end(); child.emit('close', 0, null)
  })
  try {
    const result = await callCodexImage(config(), '白底蓝色方块', { spawn: mock.spawn, codexHome, outputRoot: root,
      env: { HOME: root, PATH: '/bin', CODEX_HOME: codexHome } })
    assert.equal(result.status, 200)
    assert.deepEqual((result.body.raw.eventDiagnostics as Array<{ recoverable: boolean; message: string }>).map(row => row.recoverable), [true, true, true])
    assert.deepEqual(await readFile(path.join(root, 'public', result.body.data[0].url)), png)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex image retains bounded redacted diagnostics and rejects a fatal CLI error even if an image exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-image-error-diagnostic-'))
  const codexHome = path.join(root, 'codex-home')
  const mock = mockProcess(async (_args, _options, child) => {
    const folder = path.join(codexHome, 'generated_images', threadId)
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'exec-result.png'), await sharp({ create: { width: 64, height: 64,
      channels: 3, background: '#fff' } }).png().toBuffer())
    const events = [success[0], success[1],
      { type: 'error', message: 'authentication failed api_key=topsecret Bearer private-token sk-abcdefghijklmnopqrstuvwxyz https://example.test/?token=private /Users/test/private' },
      success[2], success[3]]
    child.stdout.end(events.map(event => JSON.stringify(event)).join('\n') + '\n')
    child.stderr.end(); child.emit('close', 0, null)
  })
  try {
    await assert.rejects(callCodexImage(config(), '请生图', { spawn: mock.spawn, codexHome, outputRoot: root,
      env: { HOME: root, PATH: '/bin', CODEX_HOME: codexHome } }), error => {
      assert.ok(error instanceof CodexImageError)
      assert.match(error.message, /CODEX_IMAGE_EVENT_FAILED/)
      const details = JSON.stringify(error.raw.eventDiagnostics)
      assert.match(details, /authentication failed/)
      assert.doesNotMatch(details, /topsecret|private-token|sk-abcdefghijklmnopqrstuvwxyz|token=private|\/Users\/test/)
      return true
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex image refuses a successful CLI exit without the generated image', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-image-missing-'))
  const mock = mockProcess(async (_args, _options, child) => {
    child.stdout.end(success.map(event => JSON.stringify(event)).join('\n') + '\n')
    child.stderr.end(); child.emit('close', 0, null)
  })
  try {
    await assert.rejects(callCodexImage(config(), '请生图', { spawn: mock.spawn, codexHome: root, outputRoot: root,
      env: { HOME: root, PATH: '/bin' } }), error => {
      assert.ok(error instanceof CodexImageError)
      assert.match(error.message, /CODEX_IMAGE_MISSING/)
      return true
    })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex image rejects shell activity even when an image file exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-image-tool-'))
  const mock = mockProcess(async (_args, _options, child) => {
    const folder = path.join(root, 'generated_images', threadId)
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'exec-result.png'), await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toBuffer())
    const events = [...success.slice(0, 2), { type: 'item.completed', item: { id: 'cmd', type: 'command_execution', command: 'fake' } }, ...success.slice(2)]
    child.stdout.end(events.map(event => JSON.stringify(event)).join('\n') + '\n')
    child.stderr.end(); child.emit('close', 0, null)
  })
  try {
    await assert.rejects(callCodexImage(config(), '请生图', { spawn: mock.spawn, codexHome: root, outputRoot: root,
      env: { HOME: root, PATH: '/bin' } }), /CODEX_IMAGE_UNEXPECTED_TOOL/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Codex image rejects a truncated PNG instead of recording a media success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-image-truncated-'))
  const mock = mockProcess(async (_args, _options, child) => {
    const folder = path.join(root, 'generated_images', threadId)
    await mkdir(folder, { recursive: true })
    const complete = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#42a' } }).png().toBuffer()
    await writeFile(path.join(folder, 'exec-result.png'), complete.subarray(0, 100))
    child.stdout.end(success.map(event => JSON.stringify(event)).join('\n') + '\n')
    child.stderr.end(); child.emit('close', 0, null)
  })
  try {
    await assert.rejects(callCodexImage(config(), '请生图', { spawn: mock.spawn, codexHome: root, outputRoot: root,
      env: { HOME: root, PATH: '/bin' } }), /CODEX_IMAGE_INVALID/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
