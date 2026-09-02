import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { detectVerticalTriptych, extractAllThreeViewReferences, extractFrontViewReference, extractThreeViewPanel, prepareThreeViewFrontReference, prepareThreeViewVideoReferences, validateThreeViewReference } from '../server/image-references.ts'

async function solid(width: number, height: number, color: { r: number; g: number; b: number }) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()
}

async function verticalSheet() {
  return sharp({ create: { width: 300, height: 900, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await solid(300, 300, { r: 240, g: 10, b: 10 }), top: 0, left: 0 },
      { input: await solid(300, 300, { r: 10, g: 240, b: 10 }), top: 300, left: 0 },
      { input: await solid(300, 300, { r: 10, g: 10, b: 240 }), top: 600, left: 0 },
    ])
    .png()
    .toBuffer()
}

async function horizontalSheet() {
  const panel = async (color: { r: number; g: number; b: number }) => sharp({ create: { width: 300, height: 300, channels: 3, background: color } })
    .composite([{ input: await solid(300, 150, { r: Math.floor(color.r / 2), g: Math.floor(color.g / 2), b: Math.floor(color.b / 2) }), top: 150, left: 0 }])
    .png()
    .toBuffer()
  return sharp({ create: { width: 900, height: 300, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await panel({ r: 240, g: 10, b: 10 }), top: 0, left: 0 },
      { input: await panel({ r: 10, g: 240, b: 10 }), top: 0, left: 300 },
      { input: await panel({ r: 10, g: 10, b: 240 }), top: 0, left: 600 },
    ])
    .png()
    .toBuffer()
}

async function assertFrontPanel(sheet: Buffer) {
  const dataUrl = `data:image/png;base64,${sheet.toString('base64')}`
  const extracted = await extractFrontViewReference(dataUrl)
  const image = sharp(Buffer.from(extracted.split(',')[1], 'base64'))
  const metadata = await image.metadata()
  assert.deepEqual([metadata.width, metadata.height], [300, 300])
  const { data } = await image.raw().toBuffer({ resolveWithObject: true })
  assert.ok(data[0] > 230)
  assert.ok(data[1] < 20)
  assert.ok(data[2] < 20)
}

test('three-view derivation extracts the frontal panel from vertical and horizontal sheets', async () => {
  await assertFrontPanel(await verticalSheet())
  await assertFrontPanel(await horizontalSheet())
})

test('three-view reference mode replaces the sheet with one derived front image', async () => {
  const sheet = await verticalSheet()
  const params = await prepareThreeViewFrontReference({
    referenceMode: 'three-view-front',
    referenceImages: [`data:image/png;base64,${sheet.toString('base64')}`],
  })
  assert.equal(Array.isArray(params.referenceImages), true)
  assert.match(String((params.referenceImages as string[])[0]), /^data:image\/png;base64,/)
})

test('multiple character sheets send only the primary portrait instead of leaking a board layout', async () => {
  const first = await horizontalSheet()
  const second = await verticalSheet()
  const params = await prepareThreeViewFrontReference({
    referenceMode: 'three-view-front',
    referenceImages: [first, second].map((sheet) => `data:image/png;base64,${sheet.toString('base64')}`),
    referenceBindings: [{ characterName: '许劭' }, { characterName: '求评者' }],
  })
  assert.equal((params.referenceImages as string[]).length, 1)
  assert.deepEqual(params.referenceDiagnostics, {
    requestedSheets: 2,
    extractedPanels: 2,
    sentImages: 1,
    omittedPanels: 1,
    composition: 'primary-panel',
  })
  const metadata = await sharp(Buffer.from(String((params.referenceImages as string[])[0]).split(',')[1], 'base64')).metadata()
  assert.deepEqual([metadata.width, metadata.height], [300, 300])
})

test('tail-frame layout inspection detects an equal-height vertical triptych', async () => {
  const triptych = await sharp({ create: { width: 300, height: 900, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await solid(300, 300, { r: 20, g: 20, b: 20 }), top: 0, left: 0 },
      { input: await solid(300, 300, { r: 220, g: 220, b: 220 }), top: 300, left: 0 },
      { input: await solid(300, 300, { r: 60, g: 60, b: 60 }), top: 600, left: 0 },
    ])
    .png()
    .toBuffer()
  const result = await detectVerticalTriptych(`data:image/png;base64,${triptych.toString('base64')}`)
  assert.equal(result.detected, true)
})

test('tail-frame layout inspection accepts a continuous portrait image', async () => {
  const portrait = await sharp({ create: { width: 300, height: 900, channels: 3, background: '#444444' } })
    .linear(0.6, 20)
    .png()
    .toBuffer()
  const result = await detectVerticalTriptych(`data:image/png;base64,${portrait.toString('base64')}`)
  assert.equal(result.detected, false)
})

test('character reference bindings must cover every supplied sheet', async () => {
  const sheet = await horizontalSheet()
  const dataUrl = `data:image/png;base64,${sheet.toString('base64')}`
  await assert.rejects(
    prepareThreeViewFrontReference({ referenceMode: 'three-view-front', referenceImages: [dataUrl, dataUrl], referenceBindings: [{ characterName: '许劭' }] }),
    /绑定数量不匹配/,
  )
})

test('three-view quality validation rejects duplicated panels', async () => {
  const duplicate = await solid(900, 300, { r: 120, g: 120, b: 120 })
  await assert.rejects(
    validateThreeViewReference(`data:image/png;base64,${duplicate.toString('base64')}`),
    /重复或近乎相同/,
  )
})

test('three-view quality validation rejects square and vertical layouts before accepting panel differences', async () => {
  const square = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await solid(300, 300, { r: 240, g: 10, b: 10 }), top: 0, left: 0 },
      { input: await solid(300, 300, { r: 10, g: 240, b: 10 }), top: 0, left: 300 },
      { input: await solid(300, 300, { r: 10, g: 10, b: 240 }), top: 300, left: 0 },
    ])
    .png()
    .toBuffer()
  await assert.rejects(
    validateThreeViewReference(`data:image/png;base64,${square.toString('base64')}`),
    /必须是单行水平结构/,
  )
  await assert.rejects(
    validateThreeViewReference(`data:image/png;base64,${(await verticalSheet()).toString('base64')}`),
    /必须是单行水平结构/,
  )
})

test('three-view quality validation rejects a wide board made from two repeated rows', async () => {
  const row = await horizontalSheet()
  const repeatedRows = await sharp({ create: { width: 900, height: 500, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await sharp(row).resize(900, 250, { fit: 'fill' }).png().toBuffer(), top: 0, left: 0 },
      { input: await sharp(row).resize(900, 250, { fit: 'fill' }).png().toBuffer(), top: 250, left: 0 },
    ])
    .png()
    .toBuffer()
  await assert.rejects(
    validateThreeViewReference(`data:image/png;base64,${repeatedRows.toString('base64')}`),
    /上下两行重复画面/,
  )
})

test('three-view quality validation records a horizontal single-row layout', async () => {
  const sheet = await horizontalSheet()
  const result = await validateThreeViewReference(`data:image/png;base64,${sheet.toString('base64')}`)
  assert.equal(result.valid, true)
  assert.equal(result.layout, 'horizontal-single-row')
  assert.equal(result.aspectRatio, 3)
})

test('three-view derivation can select side and back panels without sending the sheet layout', async () => {
  const sheet = await horizontalSheet()
  const dataUrl = `data:image/png;base64,${sheet.toString('base64')}`
  for (const [view, dominantChannel] of [['side', 1], ['back', 2]] as const) {
    const extracted = await extractThreeViewPanel(dataUrl, view)
    const { data } = await sharp(Buffer.from(extracted.split(',')[1], 'base64')).raw().toBuffer({ resolveWithObject: true })
    assert.ok(data[dominantChannel] > 230)
  }
})

test('video reference preparation expands one character sheet into three independent angles', async () => {
  const sheet = await verticalSheet()
  const dataUrl = `data:image/png;base64,${sheet.toString('base64')}`
  const extracted = await extractAllThreeViewReferences(dataUrl)
  assert.equal(extracted.length, 3)
  const params = await prepareThreeViewVideoReferences({ referenceMode: 'three-view-all', referenceImages: [dataUrl] })
  assert.equal((params.referenceImages as string[]).length, 3)
  assert.ok((params.referenceImages as string[]).every((value) => value.startsWith('data:image/png;base64,')))
})

test('video reference preparation rejects casts that would otherwise be silently truncated', async () => {
  const sheet = await horizontalSheet()
  const dataUrl = `data:image/png;base64,${sheet.toString('base64')}`
  await assert.rejects(
    prepareThreeViewVideoReferences({ referenceMode: 'three-view-all', referenceImages: [dataUrl, dataUrl, dataUrl] }),
    /最多支持 2 个人物/,
  )
})

test('three-view derivation rejects unsupported local paths instead of leaking the sheet layout', async () => {
  await assert.rejects(
    prepareThreeViewFrontReference({ referenceMode: 'three-view-front', referenceImages: ['/unsafe-sheet.png'] }),
    /仅支持 HTTP\(S\) URL 或图片 data URL/,
  )
})
