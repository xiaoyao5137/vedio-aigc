import sharp from 'sharp'

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024

function decodeImageDataUrl(value: string) {
  const match = value.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s)
  if (!match) throw new Error('三视图参考图不是有效的图片 data URL')
  return Buffer.from(match[1], 'base64')
}

async function readReferenceImage(value: string, fetchImpl: typeof fetch) {
  if (value.startsWith('data:image/')) return decodeImageDataUrl(value)
  if (!/^https?:\/\//i.test(value)) throw new Error('三视图拆分仅支持 HTTP(S) URL 或图片 data URL')
  const response = await fetchImpl(value, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`三视图参考图下载失败：HTTP ${response.status}`)
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_REFERENCE_BYTES) throw new Error('三视图参考图超过 20MB 限制')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength > MAX_REFERENCE_BYTES) throw new Error('三视图参考图超过 20MB 限制')
  return bytes
}

/**
 * Character sheets in this app use a stable FRONT · SIDE · BACK order. Generated
 * portrait sheets may be stacked vertically; uploaded sheets are normally horizontal.
 * The first panel is therefore the frontal identity reference in either layout.
 */
export type CharacterView = 'front' | 'side' | 'back'

async function threeViewGeometry(source: Buffer) {
  const image = sharp(source, { failOn: 'error' })
  const metadata = await image.metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width < 3 || height < 3) throw new Error('三视图参考图尺寸无效')
  const vertical = height > width * 1.25
  const panelWidth = vertical ? width : Math.floor(width / 3)
  const panelHeight = vertical ? Math.floor(height / 3) : height
  if (panelWidth < 64 || panelHeight < 64) throw new Error('三视图目标区域过小，无法作为人物参考')
  return { vertical, panelWidth, panelHeight }
}

async function horizontalThreeViewGeometry(source: Buffer) {
  const image = sharp(source, { failOn: 'error' })
  const metadata = await image.metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width < 3 || height < 3) throw new Error('三视图参考图尺寸无效')
  const aspectRatio = width / height
  if (aspectRatio < 1.5) {
    throw new Error(`三视图必须是单行水平结构，当前画布为 ${width}×${height}，禁止正方形、竖版或上下分层结构`)
  }
  const panelWidth = Math.floor(width / 3)
  if (panelWidth < 64 || height < 64) throw new Error('三视图目标区域过小，无法作为人物参考')
  return { width, height, aspectRatio, panelWidth, panelHeight: height }
}

async function extractPanel(source: Buffer, view: CharacterView) {
  const { vertical, panelWidth, panelHeight } = await threeViewGeometry(source)
  const panelIndex = view === 'side' ? 1 : view === 'back' ? 2 : 0
  const panel = await sharp(source, { failOn: 'error' })
    .extract({
      left: vertical ? 0 : panelWidth * panelIndex,
      top: vertical ? panelHeight * panelIndex : 0,
      width: panelWidth,
      height: panelHeight,
    })
    .png()
    .toBuffer()
  return `data:image/png;base64,${panel.toString('base64')}`
}

async function normalizedPanelPixels(source: Buffer, view: CharacterView) {
  const panel = await extractPanel(source, view)
  return sharp(decodeImageDataUrl(panel)).resize(64, 64, { fit: 'fill' }).greyscale().raw().toBuffer()
}

function meanAbsoluteDifference(left: Buffer, right: Buffer) {
  let total = 0
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index])
  return total / left.length
}

async function repeatedRowDifference(source: Buffer, width: number, height: number) {
  const halfHeight = Math.floor(height / 2)
  if (halfHeight < 1) return Number.POSITIVE_INFINITY
  const regions = await Promise.all([0, height - halfHeight].map((top) => sharp(source, { failOn: 'error' })
    .extract({ left: 0, top, width, height: halfHeight })
    .resize(96, 48, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer()))
  return meanAbsoluteDifference(regions[0], regions[1])
}

export async function extractThreeViewPanel(value: string, view: CharacterView, fetchImpl: typeof fetch = fetch) {
  const source = await readReferenceImage(value, fetchImpl)
  return extractPanel(source, view)
}

export async function extractAllThreeViewReferences(value: string, fetchImpl: typeof fetch = fetch) {
  const source = await readReferenceImage(value, fetchImpl)
  return Promise.all((['front', 'side', 'back'] as CharacterView[]).map((view) => extractPanel(source, view)))
}

export function extractFrontViewReference(value: string, fetchImpl: typeof fetch = fetch) {
  return extractThreeViewPanel(value, 'front', fetchImpl)
}

export async function validateThreeViewReference(value: string, fetchImpl: typeof fetch = fetch) {
  const source = await readReferenceImage(value, fetchImpl)
  const geometry = await horizontalThreeViewGeometry(source)
  const [front, side, back] = await Promise.all((['front', 'side', 'back'] as CharacterView[])
    .map((view) => normalizedPanelPixels(source, view)))
  const differences = {
    frontToSide: meanAbsoluteDifference(front, side),
    frontToBack: meanAbsoluteDifference(front, back),
    sideToBack: meanAbsoluteDifference(side, back),
  }
  if (Object.values(differences).some((difference) => difference < 0.75)) {
    throw new Error('三视图存在重复或近乎相同的分区，未形成有效的正面、侧面、背面视图')
  }
  const topToBottom = await repeatedRowDifference(source, geometry.width, geometry.height)
  if (topToBottom < 1) {
    throw new Error('三视图疑似由上下两行重复画面组成，必须改为仅一行的正面、侧面、背面三列结构')
  }
  return {
    valid: true,
    layout: 'horizontal-single-row',
    width: geometry.width,
    height: geometry.height,
    aspectRatio: geometry.aspectRatio,
    differences: { ...differences, topToBottom },
  }
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * Reject the exact equal-height montage layout repeatedly produced when a visual
 * identity board leaks into a portrait request. Both seams must occur at the
 * one-third boundaries and be much sharper than normal adjacent-row changes.
 */
export async function detectVerticalTriptych(value: string, fetchImpl: typeof fetch = fetch) {
  const source = await readReferenceImage(value, fetchImpl)
  const { data, info } = await sharp(source, { failOn: 'error' })
    .resize({ width: 256, withoutEnlargement: false })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.height < 12) return { detected: false, boundaryScores: [], baseline: 0 }
  const rowScores: number[] = []
  for (let row = 1; row < info.height; row += 1) {
    let difference = 0
    const currentOffset = row * info.width
    const previousOffset = (row - 1) * info.width
    for (let column = 0; column < info.width; column += 1) {
      difference += Math.abs(data[currentOffset + column] - data[previousOffset + column])
    }
    rowScores.push(difference / info.width)
  }
  const baseline = median(rowScores)
  const boundaryScores = [1, 2].map((part) => {
    const boundary = Math.round(info.height * part / 3)
    return Math.max(...[-1, 0, 1].map((offset) => rowScores[boundary + offset - 1] ?? 0))
  })
  const detected = boundaryScores.every((score) => score >= 4 && score >= baseline * 2.5)
  return { detected, boundaryScores, baseline }
}

export async function prepareThreeViewFrontReference(params: Record<string, unknown>, fetchImpl: typeof fetch = fetch) {
  const match = typeof params.referenceMode === 'string' && params.referenceMode.match(/^three-view-(front|side|back)$/)
  if (!match) return params
  const references = Array.isArray(params.referenceImages) ? params.referenceImages : [params.referenceImages]
  const sheets = references.flat(Infinity).filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  if (!sheets.length) return params
  const bindings = Array.isArray(params.referenceBindings) ? params.referenceBindings : []
  if (bindings.length && bindings.length !== sheets.length) {
    throw new Error(`人物参考绑定数量不匹配：${sheets.length} 张三视图仅收到 ${bindings.length} 个角色绑定`)
  }
  const panels = await Promise.all(sheets.map((sheet) => extractThreeViewPanel(sheet.trim(), match[1] as CharacterView, fetchImpl)))
  // Kling's standard image endpoint accepts one reference image. Combining several
  // portraits into a single board teaches the model a multi-panel composition, so
  // a multi-character scene must use only its primary (first-listed) identity here.
  // The video node still receives each character reference independently.
  const referenceImages = panels.slice(0, 1)
  return {
    ...params,
    referenceImages,
    referenceDiagnostics: {
      requestedSheets: sheets.length,
      extractedPanels: panels.length,
      sentImages: referenceImages.length,
      omittedPanels: Math.max(0, panels.length - referenceImages.length),
      composition: panels.length === 1 ? 'single-panel' : 'primary-panel',
    },
  }
}

export async function prepareThreeViewVideoReferences(params: Record<string, unknown>, fetchImpl: typeof fetch = fetch) {
  if (params.referenceMode !== 'three-view-all') return params
  const references = Array.isArray(params.referenceImages) ? params.referenceImages.flat(Infinity) : [params.referenceImages]
  const sheets = references.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  if (!sheets.length) return params
  const bindings = Array.isArray(params.referenceBindings) ? params.referenceBindings : []
  if (bindings.length && bindings.length !== sheets.length) {
    throw new Error(`视频人物参考绑定数量不匹配：${sheets.length} 张三视图仅收到 ${bindings.length} 个角色绑定`)
  }
  if (sheets.length > 2) {
    throw new Error(`当前视频人物参考模式最多支持 2 个人物的完整三视图，实际收到 ${sheets.length} 人；请拆分镜头或调整参考策略`)
  }
  const derived: string[] = []
  for (const sheet of sheets) {
    const views = await extractAllThreeViewReferences(sheet.trim(), fetchImpl)
    derived.push(...views)
  }
  return {
    ...params,
    referenceImages: derived,
    referenceDiagnostics: {
      requestedSheets: sheets.length,
      extractedPanels: derived.length,
      sentImages: derived.length,
      composition: 'three-view-groups',
    },
  }
}
