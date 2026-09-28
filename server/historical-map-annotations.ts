import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createReadStream, readFileSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { isPublicInternetUrl } from './web-sources.ts'
import { parseFfmpegMetadata, validateVideoMetadata } from './video-inspection.ts'
import { videoDimensions, type VideoResolution } from '../src/video-output-profile.ts'

const exec = promisify(execFile)
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
const directions = ['north', 'south', 'east', 'west'] as const
const colors = { blue: '#244f89', red: '#b73525', ochre: '#9b6a22' } as const
type Direction = typeof directions[number]
type RouteColor = keyof typeof colors
type Point = { x: number; y: number }
type Label = { text: string; x: number; y: number; sourceRef: string }
type Route = { id: string; party: string; direction: Direction; color: RouteColor; points: Point[];
  startSecond: number; endSecond: number; sourceRef: string }
type Relation = { type: 'follows' | 'approaches'; leaderRouteId: string; followerRouteId: string; direction: Direction }
export type HistoricalMapAnnotations = { version: 'historical-map-annotations-v1'; orientation: 'north-up';
  sourceRefs: string[]; labels: Label[]; routes: Route[]; relations?: Relation[] }
export type HistoricalMapAnnotationApproval = { status: 'approved'; annotationSha256: string;
  approvedSourceRefs: string[]; approvedLabels: string[]; approvedParties: string[]; approvedRouteIds: string[];
  reviewId: string; reviewExecutionId: string; sourceSha256: string; sceneSha256: string; signature: string }

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}
const invalid = (message: string): never => { throw Error(`MAP_ANNOTATIONS_INVALID: ${message}`) }
const unapproved = (message: string): never => { throw Error(`MAP_ANNOTATIONS_UNAPPROVED: ${message}`) }
function keys(value: Record<string, unknown>, allowed: string[], at: string) {
  const extra = Object.keys(value).filter(key => !allowed.includes(key))
  if (extra.length) invalid(`${at} 含未知字段 ${extra.join('、')}`)
}
function finite(value: unknown, at: string, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalid(`${at} 必须在 ${min}–${max} 范围内`)
  return value as number
}
function nonempty(value: unknown, at: string, maxLength = 64) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maxLength) invalid(`${at} 无效`)
  return value as string
}
function uniqueStrings(value: unknown, at: string) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim() || item !== item.trim())
    || new Set(value).size !== value.length) unapproved(`${at} 必须是唯一非空字符串列表`)
  return value as string[]
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export function historicalMapAnnotationSha256(plan: unknown): string {
  return createHash('sha256').update(canonical(plan)).digest('hex')
}
function sha256(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex') }
export function historicalMapSceneSha256(scene: unknown) { return sha256(scene) }
function keyPath(root: string) { return path.join(root, '.runtime/historical-map-approval.key') }
async function approvalKey(root: string) {
  const file = keyPath(root)
  try { return await readFile(file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  await mkdir(path.dirname(file), { recursive: true })
  try { await writeFile(file, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  return readFile(file)
}
function signedContent(approval: HistoricalMapAnnotationApproval) {
  const { signature: _signature, ...content } = approval
  void _signature
  return canonical(content)
}
function approvalSignature(approval: HistoricalMapAnnotationApproval, secret: Buffer) {
  return createHmac('sha256', secret).update(signedContent(approval)).digest('hex')
}
function verifySignature(approval: HistoricalMapAnnotationApproval, root: string) {
  const secret = (() => {
    try { return readFileSync(keyPath(root)) } catch { return unapproved('缺少本机独立审核签发密钥') }
  })()
  if (secret.length !== 32 || !/^[a-f0-9]{64}$/.test(approval.signature)) unapproved('独立审核签名无效')
  const actual = Buffer.from(approval.signature, 'hex')
  const expected = Buffer.from(approvalSignature(approval, secret), 'hex')
  if (!timingSafeEqual(actual, expected)) unapproved('独立审核签名不匹配')
}

function coordinate(point: unknown, at: string): Point {
  const p = object(point)
  keys(p, ['x', 'y'], at)
  return { x: finite(p.x, `${at}.x`, .02, .98), y: finite(p.y, `${at}.y`, .02, .98) }
}
function directionCoordinate(point: Point, direction: Direction) {
  return direction === 'south' ? point.y : direction === 'north' ? -point.y
    : direction === 'east' ? point.x : -point.x
}
function position(route: Route, time: number): Point {
  const progress = Math.max(0, Math.min(1, (time - route.startSecond) / (route.endSecond - route.startSecond)))
  const lengths = route.points.slice(1).map((point, index) => Math.hypot(point.x - route.points[index].x, point.y - route.points[index].y))
  let remaining = lengths.reduce((sum, length) => sum + length, 0) * progress
  for (let index = 0; index < lengths.length; index++) {
    if (remaining <= lengths[index] || index === lengths.length - 1) {
      const fraction = Math.max(0, Math.min(1, remaining / lengths[index]))
      return { x: route.points[index].x + (route.points[index + 1].x - route.points[index].x) * fraction,
        y: route.points[index].y + (route.points[index + 1].y - route.points[index].y) * fraction }
    }
    remaining -= lengths[index]
  }
  return route.points[0]
}

/** Approval must come from an independent, auditable reviewer. A writer's
 * self-declared label or source reference is never sufficient. */
function validateAnnotations(plan: unknown, approval: unknown, duration: number, root: string, checkSignature: boolean): HistoricalMapAnnotations {
  finite(duration, 'duration', 3, 15)
  const p = object(plan)
  keys(p, ['version', 'orientation', 'sourceRefs', 'labels', 'routes', 'relations'], 'mapAnnotations')
  if (p.version !== 'historical-map-annotations-v1' || p.orientation !== 'north-up') invalid('需要受支持的版本与上北下南方位')
  if (!Array.isArray(p.labels) || p.labels.length > 8 || !Array.isArray(p.routes) || p.routes.length > 8) {
    invalid('地名和路线各最多 8 个')
  }
  const sourceRefs = uniqueStrings(p.sourceRefs, 'sourceRefs')
  if (!sourceRefs.length || sourceRefs.some(ref => !/^\[史料\d+\]$/.test(ref))) invalid('必须至少绑定一条已批准史料编号')
  const rawLabels = p.labels as unknown[], rawRoutes = p.routes as unknown[]
  const a = object(approval)
  keys(a, ['status', 'annotationSha256', 'approvedSourceRefs', 'approvedLabels', 'approvedParties', 'approvedRouteIds', 'reviewId', 'reviewExecutionId', 'sourceSha256', 'sceneSha256', 'signature'], 'mapAnnotationApproval')
  if (a.status !== 'approved' || a.annotationSha256 !== historicalMapAnnotationSha256(plan)) unapproved('独立审核未通过或注释内容哈希不匹配')
  for (const field of ['reviewId', 'sourceSha256', 'sceneSha256']) {
    if (typeof a[field] !== 'string' || !/^[a-f0-9]{64}$/.test(a[field])) unapproved(`${field} 缺少审核证据指纹`)
  }
  if (typeof a.reviewExecutionId !== 'string' || !/^model-run-[\w-]+$/.test(a.reviewExecutionId)) unapproved('缺少独立审核模型执行记录')
  if (checkSignature) verifySignature(a as HistoricalMapAnnotationApproval, root)
  const approvedRefs = uniqueStrings(a.approvedSourceRefs, 'approvedSourceRefs')
  const approvedLabels = uniqueStrings(a.approvedLabels, 'approvedLabels')
  const approvedParties = uniqueStrings(a.approvedParties, 'approvedParties')
  const approvedRoutes = uniqueStrings(a.approvedRouteIds, 'approvedRouteIds')
  if (!approvedRefs.length || !sourceRefs.every(ref => approvedRefs.includes(ref)) || approvedRefs.length !== sourceRefs.length) {
    unapproved('史料批准清单与标注计划不一致')
  }
  const labels = rawLabels.map((value, index): Label => {
    const label = object(value), at = `labels[${index}]`
    keys(label, ['text', 'x', 'y', 'sourceRef'], at)
    const text = nonempty(label.text, `${at}.text`, 16)
    if (!/^[\p{Script=Han}\p{N}·（）()—－]{1,16}$/u.test(text)) invalid(`${at}.text 含非地名字符`)
    const sourceRef = nonempty(label.sourceRef, `${at}.sourceRef`)
    if (!approvedLabels.includes(text) || !sourceRefs.includes(sourceRef)) unapproved(`${text} 地名或出处未获独立批准`)
    return { text, x: finite(label.x, `${at}.x`, .08, .92), y: finite(label.y, `${at}.y`, .08, .92), sourceRef }
  })
  if (new Set(labels.map(label => label.text)).size !== labels.length) invalid('地名不能重复')
  const routes = rawRoutes.map((value, index): Route => {
    const route = object(value), at = `routes[${index}]`
    keys(route, ['id', 'party', 'direction', 'color', 'points', 'startSecond', 'endSecond', 'sourceRef'], at)
    const id = nonempty(route.id, `${at}.id`), party = nonempty(route.party, `${at}.party`)
    const sourceRef = nonempty(route.sourceRef, `${at}.sourceRef`)
    if (!approvedRoutes.includes(id) || !approvedParties.includes(party) || !sourceRefs.includes(sourceRef)) {
      unapproved(`${id} 的路线、势力或出处未获独立批准`)
    }
    if (!directions.includes(route.direction as Direction) || typeof route.color !== 'string' || !(route.color in colors)) invalid(`${at} 方位或颜色无效`)
    if (!Array.isArray(route.points) || route.points.length < 2 || route.points.length > 16) invalid(`${at}.points 必须有 2–16 个点`)
    const points = (route.points as unknown[]).map((point, pointIndex) => coordinate(point, `${at}.points[${pointIndex}]`))
    const direction = route.direction as Direction
    for (let pointIndex = 1; pointIndex < points.length; pointIndex++) {
      const distance = Math.hypot(points[pointIndex].x - points[pointIndex - 1].x, points[pointIndex].y - points[pointIndex - 1].y)
      if (distance < .025 || directionCoordinate(points[pointIndex], direction) < directionCoordinate(points[pointIndex - 1], direction) - .015) {
        invalid(`${at} 路线出现重叠点或逆向折返`)
      }
    }
    if (directionCoordinate(points.at(-1)!, direction) - directionCoordinate(points[0], direction) < .12) invalid(`${at} 行进方向不清楚`)
    const startSecond = finite(route.startSecond, `${at}.startSecond`, 0, duration)
    const endSecond = finite(route.endSecond, `${at}.endSecond`, 0, duration)
    if (endSecond - startSecond < .2) invalid(`${at} 路线绘制时间太短`)
    return { id, party, direction, color: route.color as RouteColor, points, startSecond, endSecond, sourceRef }
  })
  if (new Set(routes.map(route => route.id)).size !== routes.length) invalid('路线 id 不能重复')
  const relations = p.relations === undefined ? undefined : (() => {
    if (!Array.isArray(p.relations) || p.relations.length > 8) invalid('路线关系最多 8 条')
    return (p.relations as unknown[]).map((value, index): Relation => {
      const relation = object(value), at = `relations[${index}]`
      keys(relation, ['type', 'leaderRouteId', 'followerRouteId', 'direction'], at)
      if (!['follows', 'approaches'].includes(String(relation.type)) || !directions.includes(relation.direction as Direction)) invalid(`${at} 类型或方位无效`)
      const leaderRouteId = nonempty(relation.leaderRouteId, `${at}.leaderRouteId`)
      const followerRouteId = nonempty(relation.followerRouteId, `${at}.followerRouteId`)
      const leader = routes.find(route => route.id === leaderRouteId), follower = routes.find(route => route.id === followerRouteId)
      if (!leader || !follower || leader === follower || leader.direction !== relation.direction || follower.direction !== relation.direction) {
        invalid(`${at} 双方路线与同一行进方向必须一致`)
      }
      const ahead = leader!, behind = follower!
      const direction = relation.direction as Direction
      const start = Math.max(ahead.startSecond, behind.startSecond)
      const end = Math.min(ahead.endSecond, behind.endSecond)
      if (end - start < .2) invalid(`${at} 缺少可比较的共同时段`)
      const gap = (time: number) => directionCoordinate(position(ahead, time), direction) - directionCoordinate(position(behind, time), direction)
      const gaps = [start, (start + end) / 2, end].map(gap)
      if (gaps.some(value => value < -.001) || gaps[0] < .025) invalid(`${at} 追随者越过了前方势力`)
      if (relation.type === 'approaches' && gaps.at(-1)! > gaps[0] - .015) invalid(`${at} 未呈现追近变化`)
      return { type: relation.type as Relation['type'], leaderRouteId, followerRouteId, direction }
    })
  })()
  return { version: 'historical-map-annotations-v1', orientation: 'north-up', sourceRefs, labels, routes, ...(relations ? { relations } : {}) }
}
export function validateHistoricalMapAnnotations(plan: unknown, approval: unknown, duration: number, root = process.cwd()): HistoricalMapAnnotations {
  return validateAnnotations(plan, approval, duration, root, true)
}

/** The independent review is bound to the exact approved scene and saved
 * citations before the server signs a certificate that paid media can trust. */
export async function issueHistoricalMapAnnotationApproval(input: { plan: unknown; review: unknown;
  historicalSources: unknown; approvedScene: unknown; reviewExecutionId: string }, root = process.cwd()): Promise<HistoricalMapAnnotationApproval> {
  const { plan, historicalSources, approvedScene } = input
  const review = object(input.review), scene = object(approvedScene), sources = object(historicalSources)
  if (review.decision !== 'pass' || !Array.isArray(review.issues) || review.issues.length
    || !Array.isArray(review.evidence) || !review.evidence.length
    || review.evidence.some(item => typeof item !== 'string' || !item.trim())) unapproved('缺少独立审核通过、无问题结论及可审计证据')
  const refs = uniqueStrings(review.approvedSourceRefs, '审核批准史料')
  const labels = uniqueStrings(review.approvedLabels, '审核批准地名')
  const parties = uniqueStrings(review.approvedParties, '审核批准势力')
  const ids = uniqueStrings(review.approvedRouteIds, '审核批准路线')
  if (!Array.isArray(sources.citations) || !sources.citations.length || !Array.isArray(scene.requiredBeats)
    || scene.animationStyle !== 'historical_map' || !['episode_opening', 'context_bridge', 'payoff'].includes(String(scene.editorialRole))) {
    unapproved('缺少已审定的历史地图场景或保存史料')
  }
  if (!/^model-run-[\w-]+$/.test(input.reviewExecutionId)) unapproved('缺少已持久化的独立审核模型执行 ID')
  const hasRouteObligation = (scene.requiredBeats as unknown[]).some(beat =>
    /(?:追[击赶逐近]|逃|撤[退离走]|退[兵军]|行军|进军|南下|北上|东进|西进)/.test(typeof beat === 'string' ? beat : canonical(beat)))
  if (hasRouteObligation && (!Array.isArray(object(plan).routes) || !(object(plan).routes as unknown[]).length)) {
    unapproved('本镜 requiredBeats 含追逃或行军路线义务，不能提交空路线图层')
  }
  const citations = (sources.citations as unknown[]).map(object)
  for (const ref of refs) {
    const index = /^\[史料(\d+)\]$/.exec(ref)?.[1]
    const citation = citations.find(item => String(item.index) === index)
    if (!citation || typeof citation.content !== 'string' || !citation.content.trim()
      || typeof scene.historicalBasis !== 'string' || !scene.historicalBasis.includes(ref)) {
      unapproved(`${ref} 未绑定本镜已批准的史料正文`)
    }
  }
  const geographicText = canonical({ contextPayload: scene.contextPayload, historicalBasis: scene.historicalBasis,
    requiredBeats: scene.requiredBeats, title: scene.title })
  for (const label of labels) if (!geographicText.includes(label)) unapproved(`${label} 未出现在已审定场景的地理内容中`)
  for (const party of parties) if (!geographicText.includes(party)) unapproved(`${party} 未出现在已审定场景的叙事内容中`)
  const planRecord = object(plan), planLabels = Array.isArray(planRecord.labels) ? planRecord.labels.map(value => object(value).text) : []
  const planRoutes = Array.isArray(planRecord.routes) ? planRecord.routes.map(object) : []
  const exact = (left: unknown[], right: string[]) => left.length === right.length && new Set(left).size === left.length
    && left.every(value => typeof value === 'string' && right.includes(value))
  const planRefs = Array.isArray(planRecord.sourceRefs) ? planRecord.sourceRefs : []
  if (!exact(planRefs, refs) || !exact(planLabels, labels) || !exact([...new Set(planRoutes.map(route => route.party))], parties)
    || !exact(planRoutes.map(route => route.id), ids)) unapproved('独立审核清单与结构化注释不完全一致')
  const approval: HistoricalMapAnnotationApproval = { status: 'approved', annotationSha256: historicalMapAnnotationSha256(plan),
    approvedSourceRefs: refs, approvedLabels: labels, approvedParties: parties, approvedRouteIds: ids,
    reviewId: sha256(review), reviewExecutionId: input.reviewExecutionId,
    sourceSha256: sha256(historicalSources), sceneSha256: historicalMapSceneSha256(approvedScene), signature: '' }
  validateAnnotations(plan, approval, Number(scene.targetDuration), root, false)
  approval.signature = approvalSignature(approval, await approvalKey(root))
  return approval
}

function escapeXml(value: string) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!) }
function routePath(route: Route, time: number, width: number, height: number) {
  if (time < route.startSecond) return ''
  const end = position(route, time)
  const elapsed = Math.max(0, Math.min(1, (time - route.startSecond) / (route.endSecond - route.startSecond)))
  const total = route.points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - route.points[index].x, point.y - route.points[index].y), 0)
  const visible = total * elapsed
  let distance = 0
  const points = [route.points[0]]
  for (let index = 1; index < route.points.length; index++) {
    const previous = route.points[index - 1], point = route.points[index]
    const length = Math.hypot(point.x - previous.x, point.y - previous.y)
    if (distance + length < visible - .000001) points.push(point)
    else { points.push(end); break }
    distance += length
  }
  const stroke = colors[route.color], scale = Math.min(width / 1280, height / 720)
  const pairs = points.map(point => [point.x * width, point.y * height])
  const d = pairs.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const [x, y] = pairs.at(-1)!
  if (elapsed < .005) return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(5 * scale).toFixed(1)}" fill="${stroke}" stroke="#fff5dc" stroke-width="${(2 * scale).toFixed(1)}"/>`
  const previous = pairs.at(-2)!, angle = Math.atan2(y - previous[1], x - previous[0])
  const tip = 11 * scale, wing = 5.5 * scale
  const ax = x - Math.cos(angle) * tip + Math.sin(angle) * wing, ay = y - Math.sin(angle) * tip - Math.cos(angle) * wing
  const bx = x - Math.cos(angle) * tip - Math.sin(angle) * wing, by = y - Math.sin(angle) * tip + Math.cos(angle) * wing
  return `<path d="${d}" fill="none" stroke="#fff4d8" stroke-width="${(10 * scale).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/>`
    + `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${(5.2 * scale).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<path d="M${x.toFixed(1)} ${y.toFixed(1)}L${ax.toFixed(1)} ${ay.toFixed(1)}L${bx.toFixed(1)} ${by.toFixed(1)}Z" fill="${stroke}"/>`
}
export function historicalMapAnnotationSvg(plan: HistoricalMapAnnotations, time: number, width: number, height: number) {
  const fontSize = Math.max(16, Math.round(width * .022))
  const labels = plan.labels.map(label => {
    const x = label.x * width, y = label.y * height
    const labelWidth = Math.max(fontSize * 2, (Array.from(label.text).length + 1) * fontSize)
    return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><rect x="${(-labelWidth / 2).toFixed(1)}" y="${(-fontSize * .95).toFixed(1)}" width="${labelWidth.toFixed(1)}" height="${(fontSize * 1.35).toFixed(1)}" rx="${(fontSize * .15).toFixed(1)}" fill="#fff5db" fill-opacity=".88" stroke="#775d3a" stroke-width="1.5"/><text text-anchor="middle" dominant-baseline="central" font-family="Songti SC,STSong,Noto Serif CJK SC,serif" font-size="${fontSize}" font-weight="600" fill="#33291f">${escapeXml(label.text)}</text></g>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${plan.routes.map(route => routePath(route, time, width, height)).join('')}${labels}</svg>`
}

function localGenerated(url: string, root: string, extension: RegExp) {
  if (!/^\/generated\/[\w.-]+$/.test(url) || !extension.test(url)) invalid('底图素材必须是本地已保存的 /generated 文件')
  return path.join(root, 'public', url)
}
async function localVideo(url: string, root: string) {
  if (url.startsWith('/generated/')) return localGenerated(url, root, /\.mp4$/)
  if (!isPublicInternetUrl(url)) invalid('视频底片必须是供应商公开文件或本地生成文件')
  const directory = path.join(root, 'public/generated'); await mkdir(directory, { recursive: true })
  const destination = path.join(directory, `historical-map-base-${createHash('sha256').update(url).digest('hex')}.mp4`)
  try { await access(destination); return destination } catch { /* Download once. */ }
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
  const body = response.body
  if (!response.ok || !body) invalid(`视频底片下载失败 HTTP ${response.status}`)
  const chunks: Uint8Array[] = []; let bytes = 0
  for await (const chunk of body!) {
    bytes += chunk.length
    if (bytes > 250 * 1024 * 1024) invalid('视频底片超过 250MB')
    chunks.push(chunk)
  }
  const temporary = destination + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, Buffer.concat(chunks)); await rename(temporary, destination)
  return destination
}
async function fileSha256(file: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function composeHistoricalMapAnnotationFrame(imageUrl: string, plan: unknown, approval: unknown,
  time: number, duration: number, root = process.cwd()) {
  const annotations = validateHistoricalMapAnnotations(plan, approval, duration, root)
  finite(time, 'time', 0, duration)
  const source = localGenerated(imageUrl, root, /\.(?:png|jpe?g|webp)$/i)
  const bytes = await readFile(source), metadata = await sharp(bytes, { failOn: 'error' }).metadata()
  if (!metadata.width || !metadata.height) invalid('地图底片尺寸不可读')
  const overlay = await sharp(Buffer.from(historicalMapAnnotationSvg(annotations, time, metadata.width, metadata.height))).png().toBuffer()
  const key = createHash('sha256').update(JSON.stringify({ version: 1, sourceSha256: createHash('sha256').update(bytes).digest('hex'), annotations, time })).digest('hex')
  const directory = path.join(root, 'public/generated'); await mkdir(directory, { recursive: true })
  const filename = `historical-map-annotated-${key}.png`, destination = path.join(directory, filename)
  try { await access(destination) } catch {
    const temporary = destination + '.' + randomUUID() + '.tmp'
    await sharp(bytes).composite([{ input: overlay }]).png().toFile(temporary)
    await rename(temporary, destination)
  }
  return { url: `/generated/${filename}`, width: metadata.width, height: metadata.height, time,
    route: 'historical-map-annotations-v1' as const, annotationSha256: historicalMapAnnotationSha256(plan) }
}

/** Map motion stays in the supplier's clean plate. Deterministic local route
 * drawing and approved geographic labels are composited before portraits and
 * independent narration; source environmental audio remains audible. */
export async function composeHistoricalMapAnnotationsVideo(videoUrl: string, plan: unknown, approval: unknown,
  duration: number, aspectRatio: string, root = process.cwd(), resolution: VideoResolution = '720p') {
  const annotations = validateHistoricalMapAnnotations(plan, approval, duration, root)
  const [width, height] = videoDimensions(resolution, aspectRatio)
  const source = await localVideo(videoUrl, root)
  const probe = await exec(ffmpeg, ['-hide_banner', '-i', source, '-f', 'null', '-'], { maxBuffer: 4 * 1024 * 1024, timeout: 120000 })
  validateVideoMetadata(parseFfmpegMetadata(probe.stderr), duration, aspectRatio, true)
  const sourceSha256 = await fileSha256(source)
  const key = createHash('sha256').update(JSON.stringify({ version: 1, sourceSha256, annotations, duration, aspectRatio, resolution })).digest('hex')
  const directory = path.join(root, 'public/generated'); await mkdir(directory, { recursive: true })
  const filename = `historical-map-annotated-${key}.mp4`, destination = path.join(directory, filename)
  try { await access(destination) } catch {
    const frameDir = await mkdtemp(path.join(os.tmpdir(), 'historical-map-overlay-'))
    const temporary = destination + '.' + randomUUID() + '.tmp.mp4'
    try {
      const frameCount = Math.ceil(duration * 24)
      for (let frame = 0; frame < frameCount; frame++) {
        const svg = historicalMapAnnotationSvg(annotations, frame / 24, width, height)
        await sharp(Buffer.from(svg)).png().toFile(path.join(frameDir, `frame-${String(frame).padStart(5, '0')}.png`))
      }
      await exec(ffmpeg, ['-hide_banner', '-xerror', '-i', source, '-framerate', '24', '-i', path.join(frameDir, 'frame-%05d.png'),
        '-t', String(duration), '-filter_complex', `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=24[bg];[1:v]format=rgba[annotation];[bg][annotation]overlay=shortest=1:format=auto,format=yuv420p[vout]`,
        '-map', '[vout]', '-map', '0:a:0', '-r', '24', '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', '-movflags', '+faststart', temporary],
      { maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000 })
      await rename(temporary, destination)
    } finally { await rm(frameDir, { recursive: true, force: true }); await rm(temporary, { force: true }) }
  }
  const decoded = await exec(ffmpeg, ['-hide_banner', '-xerror', '-i', destination, '-f', 'null', '-'], { maxBuffer: 4 * 1024 * 1024, timeout: 120000 })
  const metadata = validateVideoMetadata(parseFfmpegMetadata(decoded.stderr), duration, aspectRatio, true)
  return { url: `/generated/${filename}`, sourceVideoUrl: videoUrl, annotationSha256: historicalMapAnnotationSha256(plan),
    metadata, width, height, fps: 24, environmentalTrack: 'preserved', route: 'historical-map-annotations-v1' as const }
}
