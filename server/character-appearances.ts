import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { isPublicInternetUrl } from './web-sources.ts'
import { extractTextResponse, normalizeStructuredTextOutput } from '../src/workflow-core.ts'
import { characterVisualContextFrom, characterVisualContextSignature } from '../src/character-visual-context.ts'

type Value = Record<string, unknown>
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex')

export async function observeCharacterAsset(asset: Value, generate: (prompt: string, frames: string[]) => Promise<unknown>, options: {
  expectedDesign?: string; root?: string; loadImage?: (url: string) => Promise<Buffer>
} = {}) {
  const url = String(asset.url ?? asset.uri ?? asset.threeViewUrl ?? '')
  const sourceFingerprint = fingerprint(url)
  const visualContext = characterVisualContextFrom(asset)
  const version = visualContext ? 'actual-reference-v2-age-context' : 'actual-reference-v1'
  const visualContextHash = visualContext ? fingerprint(characterVisualContextSignature(visualContext)) : undefined
  const expectedDesignHash = options.expectedDesign ? fingerprint(options.expectedDesign) : undefined
  const metadata = asset.metadata as Value | undefined
  const cached = metadata?.visualProfile as Value | undefined
  if (cached?.version === version && cached.sourceFingerprint === sourceFingerprint && typeof cached.appearance === 'string'
    && (!expectedDesignHash || cached.expectedDesignHash === expectedDesignHash)
    && (!visualContextHash || cached.visualContextHash === visualContextHash)) return cached
  if (!url) throw new Error('人物参考缺少图片URL')
  const root = options.root ?? process.cwd()
  const load = options.loadImage ?? (async (uri: string) => {
    if (/^\/generated\/[\w.-]+\.(?:png|jpg|jpeg|webp)$/i.test(uri)) return readFile(path.join(root, 'public', uri))
    if (!isPublicInternetUrl(uri)) throw new Error('人物参考只接受已归档图片或公开HTTP图片')
    const response = await fetch(uri, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`人物参考下载失败 HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 20 * 1024 * 1024) throw new Error('人物参考超过20MB')
    return bytes
  })
  const bytes = await load(url)
  const image = await sharp(bytes).resize({ width: 1600, height: 1000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()
  const imagePath = `/generated/appearance-${sourceFingerprint.slice(0, 24)}.jpg`
  await mkdir(path.join(root, 'public/generated'), { recursive: true })
  await writeFile(path.join(root, 'public', imagePath), image)
  const prompt = `只观察附件实际图像。这是角色“${String(asset.characterName ?? asset.name)}”的三视图；姓名仅用于资产绑定，不是外貌证据。忽略任何旧文字描述，不能凭姓名猜脸、衣色、胡须或年龄。
返回JSON {"valid":true或false,"appearance":"80至200字，实际可见的脸型、须发、冠帽具体形状、衣袍颜色/领口/纹样、内外层、腰带和下裳；只写稳定外观，不写三视图排版、当前姿势、场景、情绪、动作和手持剧情道具，不推测精确年龄","matchesDesign":true或false,"issues":["明确问题"]${visualContext ? ',"visualContextEvidence":{"ageStage":"child|adolescent|young_adult|adult|mature|elderly|unknown","hair":"dark|graying|white|unknown","facialHair":"dark|graying|white|none|unknown"}' : ''}}。
valid表示真人历史电影人物、同一身份的正面/侧面/背面、稳定服装一致；三次出现是三视图，不是三个角色。不能因为纯色背景/中性站姿/没有剧情道具而拒绝。设计没有规定的衣带色差、绑腿实现细节和细微脸型差异不构成冲突，例如“裤脚束于小腿”允许布条束缚，未指定麻绳颜色允许黄褐色；只报告与明确设计要求相反的可见特征，不添加设计中没有的禁止项。
${options.expectedDesign ? `另对照期望的稳定外观：${options.expectedDesign}。仅核对年龄大类、性别、胡须、衣袍主色/款式与冠帽形状，不检查设计文本混入的动作场景。青/蓝灰等光照微差可接受；明显不同的服装或身份不可接受。matchesDesign如不符必须false。` : '本次没有指定外观预期，matchesDesign填true；如实描述图片，不提出换装或重设计建议。'}
${visualContext ? 'visualContextEvidence仅观察实际图片，不能复制设计年龄或由姓名推算岁数。相邻成年人阶段不能可靠区分时ageStage填unknown，不作精确年龄鉴定；明显儿童、少年或衰老才明确分类。头发与胡须分开观察，被冠帽遮住、无法判断时填unknown，黑发黑须要求与明确白发白须相反时matchesDesign必须false。' : ''}`
  const raw = await generate(prompt, [imagePath])
  const observed = normalizeStructuredTextOutput(raw, extractTextResponse(raw), 'json') as Value
  if (typeof observed.valid !== 'boolean' || typeof observed.matchesDesign !== 'boolean' || typeof observed.appearance !== 'string' || observed.appearance.trim().length < 20 || !Array.isArray(observed.issues)) {
    throw new Error('CHARACTER_APPEARANCE_REVIEW_INVALID: 缺少图片实际外观证据，不能因此重买人物图')
  }
  if (!observed.valid || (options.expectedDesign && !observed.matchesDesign)) throw new Error(`CHARACTER_APPEARANCE_REJECTED: ${JSON.stringify(observed.issues)}`)
  const visualContextEvidence = observed.visualContextEvidence as Value | undefined
  if (visualContext && (!visualContextEvidence || !['child', 'adolescent', 'young_adult', 'adult', 'mature', 'elderly', 'unknown'].includes(String(visualContextEvidence.ageStage))
    || !['dark', 'graying', 'white', 'unknown'].includes(String(visualContextEvidence.hair)) || !['dark', 'graying', 'white', 'none', 'unknown'].includes(String(visualContextEvidence.facialHair)))) {
    throw new Error('CHARACTER_APPEARANCE_REVIEW_INVALID: 年龄与须发缺少实际图像观察，不能据设计文案宣布符合')
  }
  if (visualContextEvidence && visualContext) {
    for (const key of ['hair', 'facialHair'] as const) {
      const wanted = visualContext.appearanceConstraints?.[key], actual = visualContextEvidence[key]
      if (wanted && wanted !== 'unknown' && actual !== 'unknown' && wanted !== actual) throw new Error(`CHARACTER_APPEARANCE_REJECTED: 实际${key}=${actual}，与明确要求${wanted}相反`)
    }
    if (visualContext.age.stage !== 'elderly' && visualContext.age.stage !== 'unknown' && visualContextEvidence.ageStage === 'elderly') throw new Error('CHARACTER_APPEARANCE_REJECTED: 当前剧情要求非老年形象，实际图片明显老年')
  }
  return { version, sourceFingerprint, expectedDesignHash, ...(visualContextHash ? { visualContextHash, visualContextEvidence } : {}), appearance: observed.appearance.trim(), referenceImage: imagePath,
    reviewedAt: new Date().toISOString(), scope: 'actual-reference-image-observation' }
}
