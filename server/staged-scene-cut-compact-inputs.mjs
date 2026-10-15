/** Deterministic, source-bound JPEG transport for Kling inputs. Original
 * approved PNGs are never modified; end guide is already a small JPEG. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const SHA = /^[a-f0-9]{64}$/
const invalid = message => { throw Error(`STAGED_COMPACT_INPUT_INVALID: ${message}`) }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const imagePath = (root, url) => {
  if (typeof url !== 'string' || !/^\/generated\/[\w.-]+\.(?:png|jpg|jpeg)$/i.test(url)
    || url.includes('..')) invalid('generated image URL invalid')
  return path.join(root, 'public', url.slice(1))
}

export const COMPACT_JPEG_OPTIONS = Object.freeze({ quality: 92,
  chromaSubsampling: '4:4:4', progressive: false, mozjpeg: false })
export const COMPACT_INPUT_LIMITS = Object.freeze({ first_frame: 650000,
  identity_1: 250000, identity_2: 250000, total: 1100000 })
export const COMPACT_RETAKE_INPUT_LIMITS = Object.freeze({
  end_frame: 650000, total: 1750000 })

async function rgbMetrics(source, derived) {
  const first = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const second = await sharp(derived).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  if (first.info.width !== second.info.width || first.info.height !== second.info.height
    || first.info.channels !== 3 || second.info.channels !== 3
    || first.data.length !== second.data.length) invalid('decoded JPEG dimensions or channels changed')
  let squared = 0, absolute = 0, maxChannelDelta = 0
  for (let index = 0; index < first.data.length; index++) {
    const delta = first.data[index] - second.data[index]
    squared += delta * delta
    absolute += Math.abs(delta)
    maxChannelDelta = Math.max(maxChannelDelta, Math.abs(delta))
  }
  const mse = squared / first.data.length
  return { psnrDb: Math.round(10 * Math.log10(255 * 255 / mse) * 1000) / 1000,
    meanAbsoluteChannelDelta: Math.round(absolute / first.data.length * 1000) / 1000,
    maxChannelDelta }
}

export async function deriveCompactInputs(assets, root = process.cwd()) {
  if (assets?.length !== 3
    || assets.map(asset => asset.role).join(',') !== 'first_frame,identity_1,identity_2')
    invalid('expected approved first frame and both approved identity sources')
  const entries = [], buffers = []
  for (const asset of assets) {
    if (!SHA.test(asset.sha256 ?? '')) invalid(`${asset.role} source SHA missing`)
    const source = await readFile(imagePath(root, asset.url))
    if (sha256(source) !== asset.sha256) invalid(`${asset.role} approved source bytes changed`)
    const sourceMeta = await sharp(source).metadata()
    if (sourceMeta.format !== 'png' || sourceMeta.width < 1000 || sourceMeta.height < 700
      || sourceMeta.width / sourceMeta.height < 1.7
      || sourceMeta.width / sourceMeta.height > 1.81)
      invalid(`${asset.role} approved image format or dimensions changed`)
    if (sourceMeta.hasAlpha) {
      const alpha = await sharp(source).extractChannel('alpha').raw().toBuffer()
      if (alpha.some(value => value !== 255)) invalid(`${asset.role} has non-opaque alpha; JPEG would alter composite`)
    }
    const jpeg = await sharp(source).jpeg(COMPACT_JPEG_OPTIONS).toBuffer()
    const jpegMeta = await sharp(jpeg).metadata()
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpegMeta.format !== 'jpeg'
      || jpegMeta.isProgressive || jpegMeta.width !== sourceMeta.width
      || jpegMeta.height !== sourceMeta.height
      || jpeg.length > COMPACT_INPUT_LIMITS[asset.role])
      invalid(`${asset.role} compact JPEG format, dimensions, or size invalid`)
    const metrics = await rgbMetrics(source, jpeg)
    const minimumPsnr = asset.role === 'first_frame' ? 40 : 42
    if (metrics.psnrDb < minimumPsnr || metrics.meanAbsoluteChannelDelta > 2)
      invalid(`${asset.role} compact JPEG decoded visual fidelity below threshold`)
    const digest = sha256(jpeg)
    const url = `/generated/staged-compact-${asset.role}-${asset.sha256.slice(0, 16)}-q92-${digest.slice(0, 16)}.jpg`
    entries.push({ role: asset.role,
      source: { url: asset.url, sha256: asset.sha256, byteLength: source.length,
        format: 'png', width: sourceMeta.width, height: sourceMeta.height },
      transport: { url, sha256: digest, byteLength: jpeg.length,
        format: 'jpeg', width: jpegMeta.width, height: jpegMeta.height,
        progressive: false }, metrics })
    buffers.push(jpeg)
  }
  const totalBytes = buffers.reduce((sum, bytes) => sum + bytes.length, 0)
  if (totalBytes > COMPACT_INPUT_LIMITS.total) invalid('compact three-image payload exceeds byte bound')
  return { version: 'staged-compact-jpeg-transport-v1',
    encoder: { library: 'sharp', sharpVersion: sharp.versions.sharp,
      quality: 92, chromaSubsampling: '4:4:4', progressive: false },
    entries, totalBytes, buffers }
}

/** Re-derives each JPEG and verifies the current content-addressed files. */
export async function verifyCompactInputs(transport, root = process.cwd()) {
  if (transport?.version !== 'staged-compact-jpeg-transport-v1'
    || transport.encoder?.library !== 'sharp'
    || transport.encoder?.quality !== 92
    || transport.encoder?.chromaSubsampling !== '4:4:4'
    || transport.encoder?.progressive !== false
    || transport.entries?.length !== 3) invalid('compact transport policy changed')
  const derived = await deriveCompactInputs(transport.entries.map(entry => ({
    role: entry.role, url: entry.source.url, sha256: entry.source.sha256 })), root)
  for (const [index, entry] of transport.entries.entries()) {
    const expected = derived.entries[index]
    if (JSON.stringify(entry) !== JSON.stringify(expected)) invalid(`${entry.role} JPEG derivation receipt changed`)
    const file = await readFile(imagePath(root, entry.transport.url))
    if (!file.equals(derived.buffers[index]) || sha256(file) !== entry.transport.sha256)
      invalid(`${entry.role} compact JPEG current bytes changed`)
  }
  if (transport.totalBytes !== derived.totalBytes) invalid('compact payload byte total changed')
  return true
}

export async function saveCompactInputs(transport, buffers, root = process.cwd()) {
  if (transport?.entries?.length !== 3 || buffers?.length !== 3) invalid('compact assets incomplete')
  for (const [index, entry] of transport.entries.entries()) {
    const bytes = buffers[index]
    if (!Buffer.isBuffer(bytes) || sha256(bytes) !== entry.transport.sha256
      || bytes.length !== entry.transport.byteLength)
      invalid(`${entry.role} compact buffer does not match plan`)
    const filename = imagePath(root, entry.transport.url)
    try { await writeFile(filename, bytes, { flag: 'wx' }) }
    catch (error) {
      if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(bytes))
        invalid(`${entry.role} existing compact file differs`)
    }
  }
  return verifyCompactInputs(transport, root)
}

/** A retake has a separately certified target guide. Keep v1 derivation
 * byte-for-byte stable for the already submitted three-image request. */
export async function deriveCompactInputsWithEndFrame(assets,
  root = process.cwd()) {
  if (assets?.length !== 4
    || assets.map(asset => asset.role).join(',')
      !== 'first_frame,identity_1,identity_2,end_frame')
    invalid('retake requires approved first frame, two identities and target end guide')
  const first = await deriveCompactInputs(assets.slice(0, 3), root)
  const asset = assets[3]
  if (!SHA.test(asset.sha256 ?? '')) invalid('end_frame source SHA missing')
  const source = await readFile(imagePath(root, asset.url))
  if (sha256(source) !== asset.sha256) invalid('end_frame source bytes changed')
  const sourceMeta = await sharp(source).metadata()
  if (sourceMeta.format !== 'png' || sourceMeta.width !== 1280
    || sourceMeta.height !== 720)
    invalid('end_frame guide PNG format or dimensions changed')
  if (sourceMeta.hasAlpha) {
    const alpha = await sharp(source).extractChannel('alpha').raw().toBuffer()
    if (alpha.some(value => value !== 255))
      invalid('end_frame has non-opaque alpha')
  }
  const jpeg = await sharp(source).jpeg(COMPACT_JPEG_OPTIONS).toBuffer()
  const jpegMeta = await sharp(jpeg).metadata()
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpegMeta.format !== 'jpeg'
    || jpegMeta.isProgressive || jpegMeta.width !== 1280
    || jpegMeta.height !== 720
    || jpeg.length > COMPACT_RETAKE_INPUT_LIMITS.end_frame)
    invalid('end_frame compact JPEG format, dimensions, or size invalid')
  const metrics = await rgbMetrics(source, jpeg)
  if (metrics.psnrDb < 40 || metrics.meanAbsoluteChannelDelta > 2)
    invalid('end_frame decoded visual fidelity below threshold')
  const digest = sha256(jpeg)
  const url = `/generated/staged-compact-end_frame-${asset.sha256.slice(0, 16)}-q92-${digest.slice(0, 16)}.jpg`
  const entry = { role: 'end_frame',
    source: { url: asset.url, sha256: asset.sha256, byteLength: source.length,
      format: 'png', width: 1280, height: 720 },
    transport: { url, sha256: digest, byteLength: jpeg.length,
      format: 'jpeg', width: 1280, height: 720, progressive: false }, metrics }
  const totalBytes = first.totalBytes + jpeg.length
  if (totalBytes > COMPACT_RETAKE_INPUT_LIMITS.total)
    invalid('compact four-image payload exceeds byte bound')
  return { version: 'staged-compact-jpeg-transport-v2',
    encoder: first.encoder, entries: [...first.entries, entry], totalBytes,
    buffers: [...first.buffers, jpeg] }
}

export async function verifyCompactInputsWithEndFrame(transport,
  root = process.cwd()) {
  if (transport?.version !== 'staged-compact-jpeg-transport-v2'
    || transport.encoder?.library !== 'sharp'
    || transport.encoder?.quality !== 92
    || transport.encoder?.chromaSubsampling !== '4:4:4'
    || transport.encoder?.progressive !== false
    || transport.entries?.length !== 4) invalid('retake compact policy changed')
  const derived = await deriveCompactInputsWithEndFrame(
    transport.entries.map(entry => ({ role: entry.role,
      url: entry.source.url, sha256: entry.source.sha256 })), root)
  for (const [index, entry] of transport.entries.entries()) {
    if (JSON.stringify(entry) !== JSON.stringify(derived.entries[index]))
      invalid(`${entry.role} retake JPEG derivation receipt changed`)
    const bytes = await readFile(imagePath(root, entry.transport.url))
    if (!bytes.equals(derived.buffers[index])
      || sha256(bytes) !== entry.transport.sha256)
      invalid(`${entry.role} retake compact JPEG changed`)
  }
  if (transport.totalBytes !== derived.totalBytes)
    invalid('retake compact payload total changed')
  return true
}

export async function saveCompactInputsWithEndFrame(transport, buffers,
  root = process.cwd()) {
  if (transport?.entries?.length !== 4 || buffers?.length !== 4)
    invalid('retake compact assets incomplete')
  for (const [index, entry] of transport.entries.entries()) {
    const bytes = buffers[index]
    if (!Buffer.isBuffer(bytes) || sha256(bytes) !== entry.transport.sha256
      || bytes.length !== entry.transport.byteLength)
      invalid(`${entry.role} retake compact buffer differs`)
    const filename = imagePath(root, entry.transport.url)
    try { await writeFile(filename, bytes, { flag: 'wx' }) }
    catch (error) {
      if (error.code !== 'EEXIST' || !(await readFile(filename)).equals(bytes))
        invalid(`${entry.role} existing retake JPEG differs`)
    }
  }
  return verifyCompactInputsWithEndFrame(transport, root)
}
