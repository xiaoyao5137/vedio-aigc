import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { detectVerticalTriptych, extractAllThreeViewReferences, extractFrontViewReference, extractThreeViewPanel, prepareThreeViewFrontReference, prepareThreeViewVideoReferences, validateThreeViewReference } from '../server/image-references.ts'
import { buildKlingVideoRequest, klingThreeViewVideoPrompt } from '../server/model-adapters.ts'

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

test('multiple character sheets use text-to-image instead of leaking any portrait board layout', async () => {
  const first = await horizontalSheet()
  const second = await verticalSheet()
  const params = await prepareThreeViewFrontReference({
    referenceMode: 'three-view-front',
    referenceImages: [first, second].map((sheet) => `data:image/png;base64,${sheet.toString('base64')}`),
    referenceBindings: [{ characterName: '许劭' }, { characterName: '求评者' }],
  })
  assert.equal((params.referenceImages as string[]).length, 0)
  assert.deepEqual(params.referenceDiagnostics, {
    requestedSheets: 2,
    extractedPanels: 2,
    sentImages: 0,
    omittedPanels: 2,
    composition: 'text-only-multi-character',
  })
  assert.match(String(params.negativePrompt), /纵向三段式/)
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

test('tail-frame layout inspection detects unequal and low-contrast triptych seams', async () => {
  const triptych = await sharp({ create: { width: 300, height: 900, channels: 3, background: '#ffffff' } })
    .composite([
      { input: await solid(300, 290, { r: 40, g: 40, b: 40 }), top: 0, left: 0 },
      { input: await solid(300, 330, { r: 46, g: 46, b: 46 }), top: 290, left: 0 },
      { input: await solid(300, 280, { r: 210, g: 210, b: 210 }), top: 620, left: 0 },
    ])
    .png()
    .toBuffer()
  const result = await detectVerticalTriptych(`data:image/png;base64,${triptych.toString('base64')}`)
  assert.equal(result.detected, true)
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

test('principle-accepted four-view identity sheets remain complete through the video request without invented angles', async () => {
  // record-6btn9f accepted a front/side/side/back sheet as a layout advisory.
  // Its four columns cannot safely be divided into the legacy three thirds.
  const fourColumns = await sharp({ create: { width: 1200, height: 300, channels: 3, background: '#ffffff' } })
    .composite(await Promise.all(['#cc2222', '#22cc22', '#22cc22', '#2222cc'].map(async (background, index) => ({
      input: await sharp({ create: { width: 300, height: 300, channels: 3, background } }).png().toBuffer(), top: 0, left: index * 300,
    })))).png().toBuffer()
  const original = `data:image/png;base64,${fourColumns.toString('base64')}`
  const other = `data:image/png;base64,${(await horizontalSheet()).toString('base64')}`
  const input = { qualityMode: 'principle-v1', referenceMode: 'three-view-all', referenceImages: [original, other],
    referenceBindings: [{ characterName: '乡人张三', continuityKey: 'zhang' }, { characterName: '乡人李四', continuityKey: 'li' }],
    characters: ['乡人张三', '乡人李四'], initialCharacters: ['乡人张三'], presentCharacters: ['乡人张三', '乡人李四'],
    referenceImage: 'https://example.com/actual-tail.jpg', duration: 7, pacingVersion: 'duration-v2', sound: 'on' }
  const before = structuredClone(input)
  const prepared = await prepareThreeViewVideoReferences(input, async () => { throw new Error('complete references require no layout inference request') })
  assert.deepEqual(input, before)
  assert.deepEqual(prepared.referenceImages, [original, other])
  assert.deepEqual(prepared.referenceBindings, input.referenceBindings)
  assert.equal(prepared.referenceMode, 'identity-sheet')
  assert.deepEqual(prepared.referenceDiagnostics, { requestedSheets: 2, extractedPanels: 0, sentImages: 2,
    composition: 'whole-identity-sheets', layoutVerified: false })
  const prompt = klingThreeViewVideoPrompt('【场景与开场实景】乡人张三在街市唱谣，乡人李四在旁听。', prepared)
  assert.match(prompt, /乡人张三：@参考附件1（完整原参考图）.*乡人李四：@参考附件2（完整原参考图）/)
  assert.match(prompt, /该具名人物的多个视角参考，不代表多个独立真人/)
  assert.match(prompt, /同一具名角色在成片中只能对应一个人，不得复制参考视图为多个同人/)
  assert.match(prompt, /本镜可见或行动人物：\["乡人张三","乡人李四"\].*开场人物：\["乡人张三"\].*场内人物（可在画外）：\["乡人张三","乡人李四"\]/)
  assert.doesNotMatch(prompt, /@参考附件\d[正侧背]面|每组三张/)
  const request = buildKlingVideoRequest({ id: 'kling', provider: 'Kling', capability: 'video', settings: {} }, prompt, prepared)
  assert.deepEqual(request.image_list, [{ image_url: original.split(',')[1] }, { image_url: other.split(',')[1] },
    { image_url: input.referenceImage, type: 'first_frame' }])
  assert.match(String(request.prompt), /乡人张三：<<<image_1>>>.*乡人李四：<<<image_2>>>/)
  const imagePrepared = await prepareThreeViewFrontReference({ ...input, referenceMode: 'three-view-front' })
  assert.deepEqual(imagePrepared.referenceImages, [original, other])
  assert.equal(imagePrepared.referenceMode, 'identity-sheet')
})

test('principle reference preparation keeps all bound identities and rejects mismatched or silently truncated inputs', async () => {
  const referenceImages = ['a', 'b', 'c'].map(id => `https://example.com/${id}.png`)
  const prepared = await prepareThreeViewVideoReferences({ qualityMode: 'principle-v1', referenceMode: 'three-view-all', referenceImages,
    referenceBindings: referenceImages.map((_, index) => ({ characterName: `乡人${index + 1}` })) })
  assert.deepEqual(prepared.referenceImages, referenceImages)
  await assert.rejects(() => prepareThreeViewVideoReferences({ qualityMode: 'principle-v1', referenceImages, referenceBindings: [{}] }), /绑定数量不匹配/)
  await assert.rejects(() => prepareThreeViewVideoReferences({ qualityMode: 'principle-v1', referenceImages: Array.from({ length: 8 }, (_, i) => `https://example.com/${i}.png`) }), /不能静默裁切或丢弃人物/)
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
