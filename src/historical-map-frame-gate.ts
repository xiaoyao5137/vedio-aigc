/** Actual-image acceptance before any paid historical-map video request. The
 * vision report is evidence, never authority to change an approved shot. */
export const HISTORICAL_MAP_FRAME_GATE_VERSION = 'historical-map-frame-gate-v1'
export const HISTORICAL_MAP_FIRST_FRAME_GATE_VERSION = 'historical-map-first-frame-gate-v1'
export const HISTORICAL_MAP_ANNOTATION_REVIEW_PROMPT = `【历史地图标注独立审核，付费图片前】
审核本镜已写出的 mapAnnotations，不能创建新标签、新军队、新路线或替作者补充方向。地图标注计划：\${shot_script.mapAnnotations}。本镜已批准场景：\${scene}。可用史料及出处：\${historical_sources.citations}。
逐条核对 labels 的文字/位置/sourceRef、routes 的 party、起终点、方向、颜色、路径和起止秒数，核对北向、地理连续性及 requiredBeats 里的追逃路线是否有对应批准路线；不得用近现代地图、未证实地名、推测行军方向补空白。计划没有文字或路线时允许空数组，但有追逃路线义务时不能空。地图上的静态人物肖像只属 illustrationLayers，不可冒充行军势力。
仅输出 JSON {"decision":"pass或revise","approvedSourceRefs":[],"approvedLabels":[],"approvedParties":[],"approvedRouteIds":[],"issues":[],"evidence":[]}。decision=pass 仅在每项都有可查证来源、无 issues、且批准清单逐项精确覆盖计划时使用；不确定则 revise 并写明证据缺口。不要输出 annotationSha256，服务端根据独立报告和原计划计算。`
export const HISTORICAL_MAP_FIRST_FRAME_REVIEW_PROMPT = `【历史地图首帧实际图片审核，尾帧付费前】
附件只有实际首帧。只按像素审核，不能依据提示词承诺推定合格。已批准无人物地图底片：\${shot_script.visualPrompt}。实际采证：\${map_first_evidence.items}。采证报告地址：\${map_first_evidence.evidenceUrl}。
任何烘焙人物、肖像、头像、角标、文字（含地名、伪字、字幕）、箭头或路线线条均拒绝，因为文字与路线由已批准 mapAnnotations 在本地叠加。穷尽 observedLabels 中所有可见文字，格式必须是字符串数组；不可辨文字写入 issues 并设 unreadableText=true。每条箭头仍单独报告实际起终点和方向，便于指出违约；routes 项必须使用样例字段，不另起 id/color/assessment 字段。evidenceUrl 必须逐字复制上述采证报告地址。模糊处按未通过。只返回与下列结构一致的 JSON，frames 恰好一项，role=first：
{"version":"historical-map-frame-review-v1","passed":false,"evidenceUrl":"采证报告地址","frames":[{"role":"first","sourceUrl":"原图URL","evidenceReferenceImage":"采证图片URL","bakedPeople":false,"unreadableText":false,"observedLabels":[],"approvedLabels":[],"routeMarksVisible":false,"routes":[],"hardChecks":{"peopleFree":true,"labelsApproved":true,"routesCorrect":true,"geographyConsistent":true},"issues":[]}],"issues":[]}。passed 仅在全部硬项真实通过且 issues 为空时为 true。`
export const HISTORICAL_MAP_FRAME_REVIEW_PROMPT = `【历史地图首尾帧实际图片审核】
附件严格按 imageEvidence.items 的 first、end 顺序，逐张看实际像素，不依据生成提示词推定画面合格。只审核无人物的历史地理地图底片；后期 illustrationLayers 静态肖像不应已画在这两张底片中。
已批准的地图底片要求：首帧 \${shot_script.visualPrompt}；尾帧 \${shot_script.lastFramePrompt}；过程 \${shot_script.videoPrompt}。
实际采证：\${map_frame_evidence.items}；采证报告：\${map_frame_evidence.evidenceUrl}。
逐帧穷尽观察：①任何人物、肖像、头像、人物角标、玩具兵偶或照片贴片均算 bakedPeople=true；②逐字列出所有可见文字为 observedLabels（含角落、模糊和疑似错字），看不清时 unreadableText=true；所有文字均不应出现在底片上，地名将由已批准 mapAnnotations 本地叠加；③每条可见路线/箭头单独列出起点、终点和实际方向，红/蓝等每条箭头都要独立判断；所有路线线条与箭头均不应烘焙在底片上，也由 mapAnnotations 本地叠加；④同一地理范围的山河、城址、边界、方位连续。任何不确定项按未通过。
只返回 JSON：{"version":"historical-map-frame-review-v1","passed":false,"evidenceUrl":"采证报告地址","frames":[{"role":"first","sourceUrl":"原图URL","evidenceReferenceImage":"采证缩略图URL","bakedPeople":false,"unreadableText":false,"observedLabels":[],"approvedLabels":[],"routeMarksVisible":false,"routes":[],"hardChecks":{"peopleFree":true,"labelsApproved":true,"routesCorrect":true,"geographyConsistent":true},"issues":[]},{"role":"end","sourceUrl":"原图URL","evidenceReferenceImage":"采证缩略图URL","bakedPeople":false,"unreadableText":false,"observedLabels":[],"approvedLabels":[],"routeMarksVisible":false,"routes":[],"hardChecks":{"peopleFree":true,"labelsApproved":true,"routesCorrect":true,"geographyConsistent":true},"issues":[]}],"issues":[]}。若有箭头，routeMarksVisible=true 并在 routes 中逐条填写实际方向与起终点，issues 指明违约。passed 只有两帧全部硬项通过且 issues 为空时才为 true。绝不因提示词正确而把实际错图判通过。`

type Value = Record<string, unknown>
const isObject = (value: unknown): value is Value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Self-contained body: the exact same evaluator is embedded in the workflow
 * code node, and can also be exercised directly by tests. */
export function validateHistoricalMapFrameReview(review: unknown, evidence: unknown, shot: unknown, prior?: unknown) {
  const fail = (reason: string): never => { throw new Error('HISTORICAL_MAP_FRAME_REJECTED: ' + reason) }
  const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const r = obj(review), e = obj(evidence), s = obj(shot)
  const plan = [s.visualPrompt, s.lastFramePrompt, s.videoPrompt].filter(value => typeof value === 'string').join('\n')
  const count = Array.isArray(e.items) ? e.items.length : 0
  if (r.version !== 'historical-map-frame-review-v1' || r.passed !== true || !Array.isArray(r.issues) || r.issues.length
    || ![1, 2].includes(count) || !Array.isArray(r.frames) || r.frames.length !== count
    || typeof e.evidenceUrl !== 'string' || !e.evidenceUrl.startsWith('/generated/image-evidence-')
    || r.evidenceUrl !== e.evidenceUrl || !plan.trim()) fail('报告未通过、缺失、与采证不一致或缺少已批准地图描述')
  const directions: Record<string, RegExp> = {
    north: /(?:北上|北行|向北|往北|朝北|以北|北向)/,
    south: /(?:南下|南行|向南|往南|朝南|以南|南向)/,
    east: /(?:东进|东行|向东|往东|朝东|以东|东向)/,
    west: /(?:西进|西行|向西|往西|朝西|以西|西向)/,
    northeast: /(?:东北|北东)/,
    northwest: /(?:西北|北西)/,
    southeast: /(?:东南|南东)/,
    southwest: /(?:西南|南西)/,
  }
  const reviewedFrames = r.frames as unknown[]
  const evidenceItems = e.items as unknown[]
  const certified: Array<{ role: string; sourceUrl: string; evidenceReferenceImage: string; fingerprint: string }> = []
  for (const [index, role] of ['first', 'end'].slice(0, count).entries()) {
    const frame = obj(reviewedFrames[index]), image = obj(evidenceItems[index]), checks = obj(frame.hardChecks)
    const sourceUrl = String(image.url ?? ''), referenceImage = String(image.referenceImage ?? '')
    const fingerprint = referenceImage.match(/^\/generated\/image-evidence-([0-9a-f]{24})\.jpg$/)?.[1] ?? ''
    if (frame.role !== role || image.role !== role || !sourceUrl || !fingerprint || image.decoded !== true
      || frame.sourceUrl !== sourceUrl || frame.evidenceReferenceImage !== referenceImage) fail(role + ' 原图或采证指纹不匹配')
    if (frame.bakedPeople !== false || frame.unreadableText !== false
      || !['peopleFree', 'labelsApproved', 'routesCorrect', 'geographyConsistent'].every(key => checks[key] === true)
      || !Array.isArray(frame.issues) || frame.issues.length) fail(role + ' 实际像素的人物、字形、路线或地理硬项未通过')
    if (!Array.isArray(frame.observedLabels) || !Array.isArray(frame.approvedLabels)
      || frame.observedLabels.some(value => typeof value !== 'string' || !value.trim())
      || frame.approvedLabels.some(value => typeof value !== 'string' || !value.trim() || !plan.includes(value.trim()))) {
      fail(role + ' 可见地图文字未完整核对批准底片')
    }
    const observedLabels = frame.observedLabels as unknown[]
    const approvedLabels = frame.approvedLabels as unknown[]
    const approved = new Set(approvedLabels.map(value => String(value).trim()))
    if (observedLabels.length || approvedLabels.length || observedLabels.some(value => !approved.has(String(value).trim()))) {
      fail(role + ' 底片烘焙了文字；地名和势力标记须由已批准地图图层合成')
    }
    if (typeof frame.routeMarksVisible !== 'boolean' || !Array.isArray(frame.routes)
      || (frame.routeMarksVisible && !frame.routes.length) || (!frame.routeMarksVisible && frame.routes.length)) {
      fail(role + ' 路线观察缺失或自相矛盾')
    }
    if (frame.routeMarksVisible || (frame.routes as unknown[]).length) fail(role + ' 底片烘焙了路线；箭头须由已批准地图图层合成')
    for (const raw of frame.routes as unknown[]) {
      const route = obj(raw), quote = String(route.sourceQuote ?? '').trim()
      const approvedDirection = String(route.approvedDirection ?? ''), observedDirection = String(route.observedDirection ?? '')
      if (!quote || !plan.includes(quote) || !(approvedDirection in directions)
        || !directions[approvedDirection].test(quote) || observedDirection !== approvedDirection
        || route.matchesApprovedRoute !== true
        || !['Start', 'End'].every(suffix => typeof route['approved' + suffix] === 'string'
          && String(route['approved' + suffix]).trim().length > 0
          && typeof route['observed' + suffix] === 'string'
          && route['observed' + suffix] === route['approved' + suffix])) {
        fail(role + ' 路线起终点或箭头方向与批准描述不一致')
      }
    }
    certified.push({ role, sourceUrl, evidenceReferenceImage: referenceImage, fingerprint })
  }
  if (count === 2) {
    const first = obj(prior), accepted = Array.isArray(first.frames) ? obj(first.frames[0]) : {}
    if (first.version !== 'historical-map-first-frame-gate-v1' || first.passed !== true
      || !Array.isArray(first.frames) || first.frames.length !== 1
      || accepted.role !== 'first' || accepted.sourceUrl !== certified[0].sourceUrl
      || accepted.evidenceReferenceImage !== certified[0].evidenceReferenceImage
      || accepted.fingerprint !== certified[0].fingerprint) fail('首帧采证与付费前审核凭证不一致')
  }
  return { version: count === 1 ? 'historical-map-first-frame-gate-v1' : 'historical-map-frame-gate-v1', passed: true, evidenceUrl: e.evidenceUrl,
    frames: certified, reviewedAt: 'source-bound-image-review' }
}

/** The server compares this certificate with the exact images in the current
 * video request, including the content-derived image-evidence fingerprint. */
export function validateHistoricalMapFrameCertificate(certificate: unknown, firstUrl: unknown, endUrl: unknown): void {
  if (!isObject(certificate) || certificate.version !== HISTORICAL_MAP_FRAME_GATE_VERSION || certificate.passed !== true
    || !Array.isArray(certificate.frames) || certificate.frames.length !== 2
    || typeof certificate.evidenceUrl !== 'string' || !/^\/generated\/image-evidence-[0-9a-f]{24}\.json$/.test(certificate.evidenceUrl)) {
    throw new Error('HISTORICAL_MAP_FRAME_GATE_REQUIRED: 历史地图首尾帧缺少实际图片验收凭证')
  }
  const urls = [firstUrl, endUrl]
  for (const [index, role] of ['first', 'end'].entries()) {
    const frame = certificate.frames[index]
    if (!isObject(frame) || frame.role !== role || typeof urls[index] !== 'string' || !urls[index]
      || frame.sourceUrl !== urls[index] || typeof frame.evidenceReferenceImage !== 'string'
      || typeof frame.fingerprint !== 'string'
      || frame.evidenceReferenceImage !== `/generated/image-evidence-${frame.fingerprint}.jpg`
      || !/^[0-9a-f]{24}$/.test(frame.fingerprint)) {
      throw new Error(`HISTORICAL_MAP_FRAME_GATE_MISMATCH: ${role} 实际图片 URL 或采证指纹与验收凭证不符`)
    }
  }
}

// Some bundlers add __name around nested function expressions before
// Function#toString. Keep old code-node snapshots executable during migration.
const embeddedReviewPrelude = 'const __name = (value) => value; '
export const HISTORICAL_MAP_FIRST_FRAME_GATE_CODE = `${embeddedReviewPrelude}return (${validateHistoricalMapFrameReview.toString()})(params.review, params.evidence, params.shot)`
export const HISTORICAL_MAP_FRAME_GATE_CODE = `${embeddedReviewPrelude}return (${validateHistoricalMapFrameReview.toString()})(params.review, params.evidence, params.shot, params.prior)`

type Param = { id: string; name: string; englishName?: string; type: string; required: boolean; value: string }
type Node = { id: string; kind: string; prompt: string; title?: string; resultVar?: string; code?: string; modelId?: string; outputMode?: string;
  params?: Param[]; uploads?: unknown[]; loop?: unknown; parentId?: string; childIds?: string[]; position?: { x: number; y: number };
  runIf?: { path: string; equals: unknown }; request?: { url: string; method: 'POST' | 'GET' } }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges?: Array<{ id: string; from: string; to: string }> }
const p = (id: string, name: string, type: string, value: string): Param => ({ id, name, englishName: name, type, required: true, value })
const branchFlag = { path: 'first_frame_branch.animationStyle', equals: 'historical_map' }

export function upgradeHistoricalMapFrameGate<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 151) return workflow
  const find = (id: string) => workflow.nodes.find(node => node.id === id)
  const owner = find('sanguo-scene-loop'), branch = find('sanguo-first-frame-branch')
  const first = find('sanguo-animated-map-first-frame'), end = find('sanguo-end-frame'), video = find('sanguo-video')
  if (!owner || !branch || !first || !end || !video || !Array.isArray(owner.childIds)
    || !Array.isArray(first.params) || !Array.isArray(end.params) || !Array.isArray(video.params)
    || !first.position || !end.position || !Array.isArray(workflow.edges)) return workflow
  const annotationIds = ['sanguo-map-annotation-review', 'sanguo-map-annotation-approval']
  const firstIds = ['sanguo-map-first-evidence', 'sanguo-map-first-review', 'sanguo-map-first-accept']
  const endIds = ['sanguo-map-end-evidence', 'sanguo-map-end-review', 'sanguo-map-end-accept']
  const ids = [...annotationIds, ...firstIds, ...endIds]
  const already = ids.every(id => Boolean(find(id)))
  const frameCount = [...firstIds, ...endIds].filter(id => Boolean(find(id))).length
  const annotationCount = annotationIds.filter(id => Boolean(find(id))).length
  if (![0, firstIds.length + endIds.length].includes(frameCount) || ![0, annotationIds.length].includes(annotationCount)) return workflow
  const reviewerModel = find('sanguo-character-review')?.modelId || find('sanguo-media-review')?.modelId || 'codex-local-vision'
  const common = { uploads: [], loop: first.loop, parentId: first.parentId, runIf: branchFlag }
  const candidates = [
    { ...common, id: annotationIds[0], title: '历史地图标注独立审核', kind: 'text', resultVar: 'map_annotation_review',
      modelId: reviewerModel, outputMode: 'json', prompt: HISTORICAL_MAP_ANNOTATION_REVIEW_PROMPT,
      params: [p('map-annotation-temperature', 'temperature', 'number', '0'),
        p('map-review-plan', 'plan', 'json', '${shot_script.mapAnnotations}'),
        p('map-review-sources', 'historicalSources', 'json', '${historical_sources}'),
        p('map-review-scene', 'approvedScene', 'json', '${scene}')],
      position: { x: branch.position?.x ?? first.position.x - 250, y: first.position.y + 260 } },
    { ...common, id: annotationIds[1], title: '历史地图标注来源验收', kind: 'http', resultVar: 'map_annotation_approval',
      prompt: '服务端核对独立审核、史料出处和完整标注对象哈希；有缺口即停止。',
      request: { url: '/api/historical-map-annotation-approval', method: 'POST' },
      params: [p('map-annotation-plan', 'plan', 'json', '${shot_script.mapAnnotations}'),
        p('map-annotation-review', 'review', 'json', '${map_annotation_review}'),
        p('map-annotation-sources', 'historicalSources', 'json', '${historical_sources}'),
        p('map-annotation-scene', 'approvedScene', 'json', '${scene}')],
      position: { x: first.position.x - 110, y: first.position.y + 260 } },
    { ...common, id: firstIds[0], title: '历史地图首帧实际采证', kind: 'http', resultVar: 'map_first_evidence',
      prompt: '解码首帧实际图片并绑定原图 URL 与内容指纹。', request: { url: '/api/image-evidence', method: 'POST' },
      params: [p('map-first-items', 'items', 'json', '[{"role":"first","url":"${first_frame.url}"}]')],
      position: { x: first.position.x + 110, y: first.position.y + 200 } },
    { ...common, id: firstIds[1], title: '历史地图首帧画面审核', kind: 'text', resultVar: 'map_first_review', modelId: reviewerModel,
      outputMode: 'json', prompt: HISTORICAL_MAP_FIRST_FRAME_REVIEW_PROMPT,
      params: [p('map-first-review-images', 'reviewImages', 'json', '${map_first_evidence.reviewImages}'), p('map-first-temperature', 'temperature', 'number', '0'),
        p('map-first-review-evidence', 'evidence', 'json', '${map_first_evidence}'), p('map-first-review-shot', 'shot', 'json', '${shot_script}')],
      position: { x: first.position.x + 330, y: first.position.y + 200 } },
    { ...common, id: firstIds[2], title: '历史地图首帧付费前验收', kind: 'http', resultVar: 'map_first_gate',
      prompt: '服务端核对原图和审核报告并签发首帧凭证；首帧违约时停止，不购买尾帧。',
      request: { url: '/api/historical-map-frame-approval', method: 'POST' },
      params: [p('map-first-review', 'review', 'json', '${map_first_review}'), p('map-first-evidence', 'evidence', 'json', '${map_first_evidence}'),
        p('map-first-shot', 'shot', 'json', '${shot_script}')], position: { x: first.position.x + 550, y: first.position.y + 200 } },
    { ...common, id: endIds[0], title: '历史地图首尾帧实际采证', kind: 'http', resultVar: 'map_frame_evidence',
      prompt: '解码首尾帧实际图片并绑定原图 URL 与内容指纹。', request: { url: '/api/image-evidence', method: 'POST' },
      params: [p('map-frame-items', 'items', 'json', '[{"role":"first","url":"${first_frame.url}"},{"role":"end","url":"${end_frame.url}"}]')],
      position: { x: end.position.x + 260, y: end.position.y + 200 } },
    { ...common, id: endIds[1], title: '历史地图首尾帧画面审核', kind: 'text', resultVar: 'map_frame_review', modelId: reviewerModel,
      outputMode: 'json', prompt: HISTORICAL_MAP_FRAME_REVIEW_PROMPT,
      params: [p('map-frame-review-images', 'reviewImages', 'json', '${map_frame_evidence.reviewImages}'), p('map-frame-temperature', 'temperature', 'number', '0'),
        p('map-frame-review-evidence', 'evidence', 'json', '${map_frame_evidence}'), p('map-frame-review-shot', 'shot', 'json', '${shot_script}'),
        p('map-frame-review-prior', 'prior', 'json', '${map_first_gate}')],
      position: { x: end.position.x + 520, y: end.position.y + 200 } },
    { ...common, id: endIds[2], title: '历史地图首尾帧付费前验收', kind: 'http', resultVar: 'map_frame_gate',
      prompt: '服务端复核首尾原图、独立报告、地理连续性及首帧凭证并签发最终凭证；违约时不购买视频。',
      request: { url: '/api/historical-map-frame-approval', method: 'POST' },
      params: [p('map-frame-review', 'review', 'json', '${map_frame_review}'), p('map-frame-evidence', 'evidence', 'json', '${map_frame_evidence}'),
        p('map-frame-shot', 'shot', 'json', '${shot_script}'), p('map-first-gate', 'prior', 'json', '${map_first_gate}')],
      position: { x: end.position.x + 780, y: end.position.y + 200 } },
  ] as unknown as N[]
  const added = candidates.filter(node => !find(node.id))
  const gateParam = { ...p('map-frame-gate', 'mapFrameGate', 'json', '${map_frame_gate}'), required: false }
  const firstImageParams = [
    { ...p('map-first-plan', 'mapAnnotations', 'json', '${shot_script.mapAnnotations}'), required: false },
    { ...p('map-first-annotation-approval', 'mapAnnotationApproval', 'json', '${map_annotation_approval}'), required: false },
    { ...p('map-first-approved-scene', 'mapApprovedScene', 'json', '${scene}'), required: false },
    { ...p('map-first-duration', 'mapDuration', 'number', '${shot_script.duration}'), required: false },
    { ...p('map-first-role', 'mapEditorialRole', 'text', '${shot_script.editorialRole}'), required: false },
  ]
  const endImageParams = [
    { ...p('map-end-first-gate', 'mapFirstGate', 'json', '${map_first_gate}'), required: false },
    { ...p('map-end-shot', 'mapShot', 'json', '${shot_script}'), required: false },
    { ...p('map-end-role', 'mapEditorialRole', 'text', '${shot_script.editorialRole}'), required: false },
  ]
  const annotationParams = [
    { ...p('map-annotation-plan-video', 'mapAnnotations', 'json', '${shot_script.mapAnnotations}'), required: false },
    { ...p('map-annotation-approval-video', 'mapAnnotationApproval', 'json', '${map_annotation_approval}'), required: false },
    { ...p('map-shot-video', 'mapShot', 'json', '${shot_script}'), required: false },
  ]
  const nodes = workflow.nodes.map(node => {
    const managed = candidates.find(candidate => candidate.id === node.id)
    const runIf = ids.includes(node.id) && node.runIf?.path === 'first_frame_branch.shouldReviewHistoricalMapFrames'
      ? branchFlag : node.runIf
    if (managed && [annotationIds[0], firstIds[1], endIds[1]].includes(node.id) && node.kind === 'text') {
      const existing = new Set((node.params ?? []).map(item => item.englishName || item.name))
      const params = [...(node.params ?? []), ...(managed.params ?? []).filter(item => !existing.has(item.englishName || item.name))]
      const marker = node.id === firstIds[1]
        ? 'passed 仅在全部硬项真实通过且 issues 为空时才为 true。'
        : node.id === endIds[1] ? '绝不因提示词正确而把实际错图判通过。' : ''
      const prompt = marker && node.prompt.startsWith(node.id === firstIds[1] ? '【历史地图首帧实际图片审核' : '【历史地图首尾帧实际图片审核】')
        && node.prompt.split(marker).length === 2
        ? managed.prompt + node.prompt.split(marker)[1] : node.prompt
      if (JSON.stringify(params) === JSON.stringify(node.params ?? []) && prompt === node.prompt && runIf === node.runIf) return node
      return { ...node, params, prompt, runIf }
    }
    if (managed && [firstIds[2], endIds[2]].includes(node.id) && node.kind === 'code'
      && typeof node.code === 'string' && node.code.includes('HISTORICAL_MAP_FRAME_REJECTED')) {
      const rest = { ...node }
      delete rest.code
      return { ...rest, kind: 'http', request: { url: '/api/historical-map-frame-approval', method: 'POST' },
        prompt: managed.prompt, params: node.params, runIf } as N
    }
    if (runIf !== node.runIf) return { ...node, runIf }
    if (node.id === owner.id) {
      const without = node.childIds!.filter(id => !ids.includes(id))
      const afterBranch = without.indexOf(branch.id)
      // The existing unpaid tail-extraction branch is ordered before newly
      // appended review nodes by the route sorter. Keep childIds in that same
      // order so saved loop snapshots can be recovered without reordering runs.
      const tailIndex = without.indexOf('sanguo-first-frame-tail')
      const annotationAfter = tailIndex > afterBranch ? tailIndex : afterBranch
      const beforeFirst = annotationAfter >= 0
        ? [...without.slice(0, annotationAfter + 1), ...annotationIds, ...without.slice(annotationAfter + 1)] : [...without, ...annotationIds]
      const afterFirst = beforeFirst.indexOf(first.id)
      const beforeEnd = afterFirst >= 0
        ? [...beforeFirst.slice(0, afterFirst + 1), ...firstIds, ...beforeFirst.slice(afterFirst + 1)] : [...beforeFirst, ...firstIds]
      const afterEnd = beforeEnd.indexOf(end.id)
      const childIds = afterEnd >= 0 ? [...beforeEnd.slice(0, afterEnd + 1), ...endIds, ...beforeEnd.slice(afterEnd + 1)] : [...beforeEnd, ...endIds]
      return childIds.join('|') === node.childIds!.join('|') ? node : { ...node, childIds }
    }
    if (node.id === first.id || node.id === end.id) {
      const present = new Set((node.params ?? []).map(item => item.englishName || item.name))
      const additions = (node.id === first.id ? firstImageParams : endImageParams)
        .filter(item => !present.has(item.englishName || item.name))
      return additions.length ? { ...node, params: [...(node.params ?? []), ...additions] } : node
    }
    if (node.id === video.id) {
      const present = new Set((node.params ?? []).map(item => item.englishName || item.name))
      const additions = [...annotationParams, gateParam].filter(item => !present.has(item.englishName || item.name))
      return additions.length ? { ...node, params: [...(node.params ?? []), ...additions] } : node
    }
    return node
  })
  const routeIds = ['sg-e-map-annotation-review', 'sg-e-map-annotation-approval', 'sg-e-map-annotation-first', 'sg-e-map-annotation-first-evidence',
    'sg-e-map-first-evidence', 'sg-e-map-tail-evidence', 'sg-e-map-first-evidence-review', 'sg-e-map-first-review-accept',
    'sg-e-map-first-accept-end', 'sg-e-map-end-evidence', 'sg-e-map-end-evidence-review', 'sg-e-map-end-review-accept', 'sg-e-map-end-accept-video']
  const routePairs = [[branch.id, annotationIds[0]], [annotationIds[0], annotationIds[1]], [annotationIds[1], first.id],
    [annotationIds[1], firstIds[0]], [first.id, firstIds[0]], ['sanguo-first-frame-tail', firstIds[0]], [firstIds[0], firstIds[1]],
    [firstIds[1], firstIds[2]], [firstIds[2], end.id], [end.id, endIds[0]], [endIds[0], endIds[1]],
    [endIds[1], endIds[2]], [endIds[2], video.id]]
  const edges = [...workflow.edges.filter(edge => !routeIds.includes(edge.id) && !(edge.from === end.id && edge.to === video.id))]
  for (const [index, [from, to]] of routePairs.entries()) edges.push({ id: routeIds[index], from, to })
  if (already && (workflow.schemaVersion ?? 0) >= 153 && nodes.every((node, index) => node === workflow.nodes[index])
    && JSON.stringify(edges) === JSON.stringify(workflow.edges)) return workflow
  return { ...workflow, schemaVersion: Math.max(153, workflow.schemaVersion ?? 0), nodes: [...nodes, ...added], edges } as W
}
