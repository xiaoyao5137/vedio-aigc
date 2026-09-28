#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'

const directory = path.resolve('logs/zhangfei-jiangzhou-identity-20260928')
const outFile = path.join(directory, 'mirrored-candidate.json')
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex')

const existing = await fs.access(outFile).then(async () => JSON.parse(await fs.readFile(outFile, 'utf8'))).catch(() => null)
if (existing?.body?.items?.[0]?.url) {
  console.log(JSON.stringify({ status: 'mirror-reused', path: outFile, localUri: existing.body.items[0].url }))
  process.exit(0)
}
const generated = JSON.parse(await fs.readFile(path.join(directory, 'generated-candidate-2.json'), 'utf8'))
const observed = JSON.parse(await fs.readFile(path.join(directory, 'actual-appearance-2.json'), 'utf8'))
const ledger = JSON.parse(await fs.readFile(path.join(directory, 'image-request-ledger-2.json'), 'utf8'))
if (generated.body?.generatedCount !== 1 || observed.status >= 400 || observed.body?.items?.length !== 1 || ledger.length !== 1) {
  throw Error('第二张候选、实图观察或唯一图片账本尚未通过，拒绝镜像')
}
const candidate = generated.body.items[0]
const originalUri = String(candidate.url ?? '')
if (!/^https:\/\//.test(originalUri) || observed.body.items[0].url !== originalUri
  || observed.body.items[0].metadata?.visualProfile?.sourceFingerprint !== sha(originalUri)) throw Error('候选 URL 与实图观察来源不一致')
const response = await fetch(originalUri, { signal: AbortSignal.timeout(120_000) })
if (!response.ok) throw Error(`生成原图读取失败 HTTP ${response.status}`)
const bytes = Buffer.from(await response.arrayBuffer())
if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw Error('生成原图大小无效')
const image = await sharp(bytes, { failOn: 'error' }).metadata()
if (image.format !== 'png' || !image.width || !image.height) throw Error('生成原图不是可解码 PNG')
const contentSha256 = sha(bytes)
const localUri = `/generated/character-portrait-${contentSha256.slice(0, 32)}.png`
const localPath = path.join(process.cwd(), 'public', localUri)
await fs.mkdir(path.dirname(localPath), { recursive: true })
const previous = await fs.readFile(localPath).catch(() => null)
if (previous && sha(previous) !== contentSha256) throw Error('同名本地人物图字节与来源不符')
if (!previous) await fs.writeFile(localPath, bytes, { flag: 'wx' })
const sourceMediaProvenance = { version: 'generated-media-mirror-v1', localUri, originalUri,
  originalUriFingerprint: sha(originalUri), contentSha256, bytes: bytes.length,
  width: image.width, height: image.height, sourceModelExecutionId: ledger[0].id,
  sourceTaskId: ledger[0].task_id, mirroredAt: new Date().toISOString() }
const item = { ...candidate, url: localUri,
  metadata: { ...candidate.metadata, visualContextImageFingerprint: sha(localUri),
    visualProfile: undefined, sourceMediaProvenance } }
const result = { at: new Date().toISOString(), status: 200, body: { ...generated.body, items: [item],
  generated: [item], urls: [localUri], byCharacter: { 张飞: item } } }
await fs.writeFile(outFile, JSON.stringify(result, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ status: 'mirrored', path: outFile, localUri, contentSha256, bytes: bytes.length,
  size: [image.width, image.height], sourceModelExecutionId: ledger[0].id }))
