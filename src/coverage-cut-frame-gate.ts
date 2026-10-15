/** A coverage cut changes camera position while carrying the actual prior
 * frame's cast, wardrobe and world state into a separately reviewed first frame. */
export const COVERAGE_CUT_FRAME_REVIEW_PROMPT = `【同场切镜新机位首帧独立实图审核】
只按附件实际像素审核，不凭生成提示词推定合格。附件顺序：前镜真实尾帧、拟用的新机位首帧、随后一至两张已选人物三视图。采证报告地址：\${coverage_evidence.evidenceUrl}；采证：\${coverage_evidence.items}。本镜已批准分镜：\${shot_script}。
核对新图确实改变机位或景别，却仍在同一侧轴线；本镜规定入画人物的左右关系、脸、冠帽、发须、衣甲、年龄、体格、武器与场景前后相接；规定须可见的束缚、道具归属、伤痕和位置等世界状态不得消失或反转。逐人对照前镜尾帧的世界空间位置、朝向、运动阶段及相互距离：被押行者不能回到出发位置或改为朝反方向行走，留在原地的人不能突然贴到押解队伍旁或接手绳索，原两名押解者不能变成一人或交换所夹持的上臂。新机位可以改变画面中的行走方向，但须用院门等固定地标证明世界空间行进方向仍连续；不能只凭画面左右变化判定倒走，也不能用提示词宣称连续来代替像素证据。违反这些关系时将 worldStateConsistent 或 boundAndPropsConsistent 置 false 并写入 issues。三视图只核身份和装束，不能把其中中性站姿当作表演。分镜明确允许因新景别处于画外的既有配角，不要求其在新画面中可见，也不能仅凭不可见就认定其消失或换装；须在 offscreenNotes 标记“未在新画面核实”，绝不能声称已从像素证实其仍在场、身份或装束不变。若规定入画人物或必须可见的束缚因裁切无法核实，不能判通过。若前镜画面与三视图冲突，明确指出，不自行决定覆盖已批准资产。不得修改原分镜对白与行动。
只返回 JSON：{"version":"coverage-cut-frame-review-v1","passed":false,"evidenceUrl":"上文给出的采证报告地址","frames":[{"role":"previous_tail","sourceUrl":"原图URL","evidenceReferenceImage":"采证附件URL"},{"role":"candidate_first","sourceUrl":"原图URL","evidenceReferenceImage":"采证附件URL"}],"assets":[{"characterName":"人物名","assetId":"已选资产ID","sourceUrl":"原图URL","evidenceReferenceImage":"采证附件URL"}],"hardChecks":{"newCameraPosition":false,"sameAxis":false,"leftRightConsistent":false,"identityConsistent":false,"wardrobeConsistent":false,"worldStateConsistent":false,"boundAndPropsConsistent":false,"allRequiredVisible":false},"offscreenNotes":[],"issues":[]}。passed 仅在八项对本镜规定入画人物和必须可见状态都由实际图片验证且 issues 为空时为 true；画外配角仅记入 offscreenNotes，不算已从像素验证；其余不确定按未通过。`

type Value = Record<string, unknown>
const object = (value: unknown): Value => value && typeof value === 'object' && !Array.isArray(value) ? value as Value : {}
function reject(reason: string): never { throw new Error(`COVERAGE_CUT_FRAME_REJECTED: ${reason}`) }

export function validateCoverageCutFrameReview(review: unknown, evidence: unknown, shot: unknown,
  previousTail: unknown, referenceBindings: unknown) {
  const r = object(review), e = object(evidence), tail = object(previousTail), s = object(shot)
  const bindings = Array.isArray(referenceBindings) ? referenceBindings.map(object) : []
  const items = Array.isArray(e.items) ? e.items.map(object) : []
  if (object(s.continuity).mode !== 'coverage_cut' || s.firstFrameMode !== 'reference'
    || r.version !== 'coverage-cut-frame-review-v1' || typeof r.passed !== 'boolean'
    || r.evidenceUrl !== e.evidenceUrl || typeof e.evidenceUrl !== 'string'
    || !/^\/generated\/image-evidence-[a-f0-9]{24}\.json$/.test(e.evidenceUrl)
    || !Array.isArray(r.issues) || !Array.isArray(r.offscreenNotes)
    || r.offscreenNotes.some(item => typeof item !== 'string')
    || !Array.isArray(r.frames) || r.frames.length !== 2
    || !Array.isArray(r.assets) || bindings.length < 1 || bindings.length > 2
    || r.assets.length !== bindings.length || items.length !== bindings.length + 2) reject('分镜、报告、原图或身份附件不完整')
  if (tail.available !== true || tail.source !== 'extracted-from-video'
    || typeof tail.url !== 'string' || !tail.url || tail.videoTailUrl !== tail.sourceUrl
    || !/^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(tail.url)) reject('前镜尾帧没有实际视频来源或未归档')
  const frameRoles = ['previous_tail', 'candidate_first']
  const certified: Array<{ role: string; sourceUrl: string; evidenceReferenceImage: string; fingerprint: string }> = []
  for (let index = 0; index < items.length; index++) {
    const expected = index < 2 ? object(r.frames[index]) : object(r.assets[index - 2])
    const image = items[index]
    const role = index < 2 ? frameRoles[index] : 'identity'
    const sourceUrl = String(image.url ?? ''), referenceImage = String(image.referenceImage ?? '')
    const fingerprint = referenceImage.match(/^\/generated\/image-evidence-([a-f0-9]{24})\.jpg$/)?.[1]
    if (image.role !== role || expected.role !== (index < 2 ? role : undefined)
      && index < 2 || expected.sourceUrl !== sourceUrl || expected.evidenceReferenceImage !== referenceImage
      || !fingerprint || image.decoded !== true
      || !/^\/generated\/[\w.-]+\.(?:png|jpe?g|webp)$/i.test(sourceUrl)) reject('附件次序、原图或采证指纹不一致')
    if (index >= 2) {
      const binding = bindings[index - 2]
      if (image.characterName !== binding.characterName || image.assetId !== binding.assetId
        || expected.characterName !== binding.characterName || expected.assetId !== binding.assetId
        || sourceUrl !== binding.url) reject('人物三视图身份或资产版本不一致')
    }
    certified.push({ role, sourceUrl, evidenceReferenceImage: referenceImage, fingerprint })
  }
  if (certified[0].sourceUrl !== tail.url || certified[1].sourceUrl === tail.url
    || certified[0].fingerprint === certified[1].fingerprint) reject('新机位首帧不能冒充前镜旧尾帧')
  const checks = object(r.hardChecks)
  const checkNames = ['newCameraPosition', 'sameAxis', 'leftRightConsistent', 'identityConsistent',
    'wardrobeConsistent', 'worldStateConsistent', 'boundAndPropsConsistent', 'allRequiredVisible']
  if (checkNames.some(key => typeof checks[key] !== 'boolean')
    || (r.passed === true && (r.issues as unknown[]).length > 0)
    || (r.passed === true && checkNames.some(key => checks[key] !== true))) {
    reject('实图审核结论与核查项不一致')
  }
  const qualityRisks = r.passed === true ? [] : [
    ...checkNames.filter(key => checks[key] === false).map(key => ({ code: 'coverage_cut_check_failed', check: key })),
    ...(r.issues as unknown[]).map(issue => ({ code: 'coverage_cut_review_issue', issue })),
  ]
  if (r.passed === false && qualityRisks.length === 0) reject('实图审核未通过但没有可标记的风险')
  return { version: 'coverage-cut-frame-gate-v1', passed: r.passed as boolean, evidenceUrl: e.evidenceUrl,
    reviewPassed: r.passed as boolean, qualityReview: { status: r.passed === true ? 'passed' : 'needs_attention',
      canProceed: r.passed as boolean, manualDecisionRequired: r.passed === false }, qualityRisks,
    offscreenNotes: r.offscreenNotes as string[],
    frames: certified.slice(0, 2), assets: certified.slice(2).map((item, index) => ({ ...item,
      characterName: bindings[index].characterName, assetId: bindings[index].assetId })) }
}

export const COVERAGE_CUT_PRECHECK_CODE = `const tail = params.previousLastFrame
const video = params.previousVideoShot
const bindings = params.referenceBindings
const images = params.referenceImages
if (!tail || typeof tail !== 'object' || tail.available !== true || tail.source !== 'extracted-from-video'
  || !tail.url || !video || video.decoded !== true || video.lastFrameUrl !== tail.url
  || video.extractedLastFrameUrl !== tail.url || !Array.isArray(video.frames)
  || video.frames[video.frames.length - 1] !== tail.url) {
  throw new Error('COVERAGE_SOURCE_INVALID: 前镜实际尾帧与已完成视频尾帧不一致')
}
if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 2
  || !Array.isArray(images) || images.length !== bindings.length
  || bindings.some((item, index) => !item || !item.assetId || !item.characterName
    || typeof images[index] !== 'string' || !images[index])) {
  throw new Error('COVERAGE_SOURCE_INVALID: 缺少一至两张所选人物三视图')
}
return { previousTail: { url: tail.url, videoTailUrl: video.lastFrameUrl, source: tail.source, available: true },
  referenceBindings: bindings.map((item, index) => ({ ...item, url: images[index] })) }`

export const COVERAGE_CUT_EVIDENCE_PLAN_CODE = `const sources = params.sources
const frame = params.frame
if (!sources || sources.version !== 'coverage-cut-sources-v1' || !sources.previousTail
  || !Array.isArray(sources.referenceBindings) || !frame || typeof frame.url !== 'string'
  || !/^\\/generated\\/[\\w.-]+\\.(?:png|jpe?g|webp)$/i.test(frame.url)
  || frame.url === sources.previousTail.url) throw new Error('COVERAGE_FRAME_INVALID: 新机位首帧未持久化或复用了旧尾帧')
return { items: [
  { role: 'previous_tail', url: sources.previousTail.url },
  { role: 'candidate_first', url: frame.url },
  ...sources.referenceBindings.map(item => ({ role: 'identity', characterName: item.characterName, assetId: item.assetId, url: item.url })),
] }`

export const COVERAGE_CUT_VIDEO_REFERENCES_CODE = `const branch = params.branch
const sources = params.sources
if (branch && branch.shouldGenerateCoverageFrame) {
  if (!sources || sources.version !== 'coverage-cut-sources-v1' || !Array.isArray(sources.referenceImages)
    || !Array.isArray(sources.referenceBindings) || sources.referenceImages.length !== sources.referenceBindings.length) {
    throw new Error('COVERAGE_SOURCE_INVALID: 视频人物身份未绑定已归档原图')
  }
  return { referenceImages: sources.referenceImages, referenceBindings: sources.referenceBindings,
    referenceMode: sources.referenceImages.length <= 2 ? 'three-view-all' : 'three-view-front' }
}
return branch && branch.referenceRequest ? branch.referenceRequest : { referenceImages: [], referenceBindings: [], referenceMode: '' }`

export const COVERAGE_CUT_FIRST_FRAME_PROMPT = `【真人同场切镜的新机位首帧】
前镜实际尾帧只用于承接现场站位、道具、绑绳、场景与摄影轴线；已选人物三视图分别用于具名人物的脸、年龄、发须、冠帽、衣甲与体格。尾帧里被裁切的主角不得由清晰可见的士兵或其他配角顶替。各附件与人物的对应关系以本次请求的具名身份说明为准。新图必须是同一场、同一轴线侧的新摄影机机位或景别，不能原样复制尾帧，也不能跨轴、倒转人物左右或改变束缚状态。切机位不等于重置表演：逐人沿用尾帧中的世界空间位置、身体朝向、运动阶段、彼此间距与接触关系；被押行者不得返回出发点，留在原地者不得靠近队伍或接手绑绳，押解者不得无故减少或换人。前镜若正朝院门行进，本镜零秒仍朝同一院门；新机位造成的屏幕方向变化只能由真实视角变化产生，门、院墙等地标关系须连续。首帧只呈现镜头切换的同一时刻，不提前执行本镜随后几秒的行走、对白或反应。新图构图：\${shot_script.visualPrompt}。机位：\${shot_script.camera}。世界状态：\${shot_script.worldState}。人物：\${shot_script.characters}。保留原有的绑绳、伤痕、武器和衣甲细节；表情与视线只做本镜已批准的开场动作。16:9 电影真人摄影，单一时刻，无文字、水印、三视图排版和额外人物。`

/** State only the zero-second pose; the authored visual prompt also describes
 * later actions, which an image model can otherwise complete prematurely. */
export function coverageCutOpeningStatePrompt(shot: Record<string, unknown>): string {
  const openingVisual = String(shot.visualPrompt ?? '').split(/本镜实际动作依次为[:：]/u)[0]
  const twoEscorts = /两名[^。；]*军士|军士[^。；]*两侧/u.test(openingVisual)
  const pacing = shot.pacing && typeof shot.pacing === 'object' ? shot.pacing as Record<string, unknown> : {}
  const beats = Array.isArray(pacing.beats) ? pacing.beats as Record<string, unknown>[] : []
  const deferredHands = beats.flatMap(beat => typeof beat.textOrVocalization === 'string'
    ? [...beat.textOrVocalization.matchAll(/([\p{Script=Han}]{1,6})原本张开的手掌攥紧/gu)].map(match => match[1]) : [])
  return `\n【零秒静态首帧】只画本镜对白和后续反应发生前的动作起点；“说完后”“随后”“再”等动作此时尚未开始，绝不提前呈现其完成态。与输入尾帧相比须明显移到已批准的新机位：在视线轴线同侧横移机位约一至两米，形成一眼可辨的新透视及背景相对位置，并让本镜说话者呈可见双眼与嘴唇的四分之三面部；不要只平移裁切原构图，仍保持人物左右与实际站位。切镜不是人物动作，承接尾帧时保持肩、肘、手臂的起始姿态和高度。匿名押解军士须戴军盔并与具名人物的脸、发须、衣甲明显不同；严禁把张飞或严颜复制成押解军士，每个具名人物在画面里恰好出现一次。凡本镜要求保留双腕束缚，必须把双腕、绳圈及押解者的真实接触关系完整画入，不能只画抓上臂来代替。${twoEscorts ? '本镜零秒必须采用足够宽的中全景：张飞、严颜与两名不同的戴盔军士四人全部完整入画，严颜处于两名军士之间，每名军士分别扣住其一侧上臂；严颜双腕和绳圈在画框内清楚可见，不能将严颜裁在画边，也不能把背景站岗军士冒充押解者。' : ''}${deferredHands.length ? [...new Set(deferredHands)].map(name => `${name}的上臂和前臂自然垂在身体旁、肘部不抬高，张开的手掌低垂于腰髋旁并从新机位入画，五指自然舒展且指缝可辨；不得握拳、屈肘向前伸手或遮挡手指。`).join('') : ''}`
}

/** Project only the opening composition into a still-image prompt. The full
 * approved storyboard and its later beat ledger remain intact for video. */
export function coverageCutImageShot(shot: Record<string, unknown>): Record<string, unknown> {
  const visualPrompt = typeof shot.visualPrompt === 'string' ? shot.visualPrompt : ''
  const camera = typeof shot.camera === 'string' ? shot.camera : ''
  // Storyboards use both "本镜实际动作依次为" and timed beats. Neither belongs
  // in a still-image request; the complete original remains available to video.
  const firstTimedBeat = /(?:^|[。；;\n])\s*\d+(?:[.．]\d+)?\s*[—–－-]\s*\d+(?:[.．]\d+)?\s*秒\s*[,，:：]/u
  const timed = firstTimedBeat.exec(visualPrompt)
  const action = /本镜实际动作依次为[:：]/u.exec(visualPrompt)
  const end = Math.min(timed?.index ?? visualPrompt.length, action?.index ?? visualPrompt.length)
  return { ...shot,
    visualPrompt: visualPrompt.slice(0, end).replace(/[。；;\s]+$/u, '').trim(),
    camera: camera.split(/命令后|对白后|对白结束后|随后/u)[0].trim(),
  }
}

type Param = { id: string; name: string; englishName?: string; type: string; required: boolean; value: string }
type Node = { id: string; kind: string; title?: string; resultVar?: string; modelId?: string; outputMode?: string;
  prompt?: string; code?: string; operation?: string; params?: Param[]; uploads?: unknown[]; loop?: unknown;
  acceptance?: { passedPath: string; retryFrom: string; maxAttempts: number; feedbackPath?: string };
  parentId?: string; childIds?: string[]; position?: { x: number; y: number }; runIf?: { path: string; equals: unknown };
  request?: { url: string; method: 'POST' | 'GET' } }
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[];
  edges: Array<{ id: string; from: string; to: string; branch?: 'true' | 'false' }> }
const p = (id: string, name: string, type: string, value: string): Param => ({ id, name, englishName: name, type, required: false, value })
const coverageIf = { path: 'first_frame_branch.shouldGenerateCoverageFrame', equals: true }

/** Pure migration for a future CAS deployment; callers decide when to persist.
 * Paid prefix in old executions is untouched, and partial legacy topology is refused. */
export function upgradeCoverageCutFrameWorkflow<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 154) return workflow
  // Schema 165+ routes coverage approval through the scene-cut opening gate.
  // Re-adding the old approval→router edge would bypass that gate and make
  // every hydration bump the version while the outer migration removes it.
  if ((workflow.schemaVersion ?? 0) >= 165
    && workflow.nodes.some(node => node.id === 'sanguo-scene-cut-source-archive')) return workflow
  const find = (id: string) => workflow.nodes.find(node => node.id === id)
  const owner = find('sanguo-scene-loop'), branch = find('sanguo-first-frame-branch'), video = find('sanguo-video')
  if (!owner?.childIds || !branch?.code || !video?.params || !branch.position || !video.position) return workflow
  const ids = ['sanguo-coverage-precheck', 'sanguo-coverage-source-archive', 'sanguo-coverage-first-frame',
    'sanguo-coverage-evidence-plan', 'sanguo-coverage-evidence', 'sanguo-coverage-review',
    'sanguo-coverage-approval', 'sanguo-video-reference-router']
  if (ids.some(id => find(id)) && !ids.every(id => find(id))) return workflow
  const marker = "const previousLastFrame = String(${loop.previous.last_frame.url} || '').trim()"
  if (!branch.code.includes(marker) && !branch.code.includes('const shouldGenerateCoverageFrame =')) return workflow
  const code = branch.code.includes('const shouldGenerateCoverageFrame =') ? branch.code : branch.code
    .replace(marker, `${marker}\nconst coverageContinuityMode = String(\${shot_script.continuity.mode} || '')`)
    .replace('const shouldGenerateAnimatedEndFrame =',
      "const shouldGenerateCoverageFrame = coverageContinuityMode === 'coverage_cut' && requestedMode === 'reference' && !isAnimatedShot\nconst shouldGenerateAnimatedEndFrame =")
    .replace('  shouldReusePreviousTail,\n  route:', '  shouldReusePreviousTail,\n  shouldGenerateCoverageFrame,\n  route:')
  if (!code.includes('  shouldGenerateCoverageFrame,\n  route:')) return workflow
  const common = { uploads: [], loop: branch.loop, parentId: 'sanguo-scene-loop', runIf: coverageIf }
  const nodes: N[] = [
    { ...common, id: ids[0], title: '同场切镜实际尾帧预检', kind: 'code', resultVar: 'coverage_precheck',
      prompt: '确认前镜真实视频尾帧、身份选择和最大两张三视图。', code: COVERAGE_CUT_PRECHECK_CODE,
      params: [p('cc-prev-tail', 'previousLastFrame', 'json', '${loop.previous.last_frame}'),
        p('cc-prev-video', 'previousVideoShot', 'json', '${loop.previous.video_shot}'),
        p('cc-bindings', 'referenceBindings', 'json', '${first_frame_branch.referenceRequest.referenceBindings}'),
        p('cc-images', 'referenceImages', 'json', '${first_frame_branch.referenceRequest.referenceImages}')],
      position: { x: branch.position.x + 140, y: branch.position.y + 400 } },
    { ...common, id: ids[1], title: '同场切镜原图归档', kind: 'http', resultVar: 'coverage_sources',
      prompt: '将前镜真实尾帧和已选人物三视图原图保存为内容哈希固定文件。',
      request: { url: '/api/coverage-cut-source-archive', method: 'POST' },
      params: [p('cc-archive-tail', 'previousTail', 'json', '${coverage_precheck.previousTail}'),
        p('cc-archive-bindings', 'referenceBindings', 'json', '${coverage_precheck.referenceBindings}')],
      position: { x: branch.position.x + 380, y: branch.position.y + 400 } },
    { ...common, id: ids[2], title: '同场切镜新机位首帧', kind: 'image', modelId: 'kling-image-3',
      operation: 'history.coverage-cut-first-frame', resultVar: 'first_frame', prompt: COVERAGE_CUT_FIRST_FRAME_PROMPT,
      params: [p('cc-frame-reference', 'referenceImage', 'image', '${coverage_sources.previousTail.url}'),
        p('cc-frame-sources', 'coverageSources', 'json', '${coverage_sources}'),
        p('cc-frame-identity-images', 'referenceImages', 'images', '${coverage_sources.referenceImages}'),
        p('cc-frame-identity-bindings', 'referenceBindings', 'json', '${coverage_sources.referenceBindings}'),
        p('cc-frame-edit', 'imageEdit', 'boolean', 'true'), p('cc-frame-ratio', 'aspectRatio', 'text', '16:9'),
        p('cc-frame-resolution', 'resolution', 'text', '1k'), p('cc-frame-count', 'n', 'number', '1'),
        p('cc-frame-single', 'singleFrame', 'boolean', 'true')],
      position: { x: branch.position.x + 620, y: branch.position.y + 400 } },
    { ...common, id: ids[3], title: '同场切镜采证清单', kind: 'code', resultVar: 'coverage_evidence_plan',
      prompt: '固定前镜尾帧、新首帧与原始三视图的采证顺序。', code: COVERAGE_CUT_EVIDENCE_PLAN_CODE,
      params: [p('cc-plan-sources', 'sources', 'json', '${coverage_sources}'),
        p('cc-plan-frame', 'frame', 'json', '${first_frame}')],
      position: { x: branch.position.x + 860, y: branch.position.y + 400 } },
    { ...common, id: ids[4], title: '同场切镜实图采证', kind: 'http', resultVar: 'coverage_evidence',
      prompt: '对真实尾帧、新机位首帧与所选三视图逐张解码采证。',
      request: { url: '/api/image-evidence', method: 'POST' },
      params: [p('cc-evidence-items', 'items', 'json', '${coverage_evidence_plan.items}')],
      position: { x: branch.position.x + 1100, y: branch.position.y + 400 } },
    { ...common, id: ids[5], title: '同场切镜独立画面审核', kind: 'text', resultVar: 'coverage_review',
      modelId: find('sanguo-character-review')?.modelId || find('sanguo-media-review')?.modelId || 'codex-local-vision',
      outputMode: 'json', prompt: COVERAGE_CUT_FRAME_REVIEW_PROMPT,
      acceptance: { passedPath: 'passed', retryFrom: 'sanguo-coverage-first-frame', maxAttempts: 3, feedbackPath: 'issues' },
      params: [p('cc-review-images', 'reviewImages', 'json', '${coverage_evidence.reviewImages}'),
        p('cc-review-evidence', 'evidence', 'json', '${coverage_evidence}'),
        p('cc-review-shot', 'shot', 'json', '${shot_script}'),
        p('cc-review-tail', 'previousTail', 'json', '${coverage_sources.previousTail}'),
        p('cc-review-bindings', 'referenceBindings', 'json', '${coverage_sources.referenceBindings}'),
        p('cc-review-temp', 'temperature', 'number', '0')],
      position: { x: branch.position.x + 1340, y: branch.position.y + 400 } },
    { ...common, id: ids[6], title: '同场切镜视频付费前验收', kind: 'http', resultVar: 'coverage_frame_gate',
      prompt: '只在独立实图审核及原图字节证明通过后签发视频凭证。',
      request: { url: '/api/coverage-cut-frame-approval', method: 'POST' },
      params: [p('cc-approve-review', 'review', 'json', '${coverage_review}'),
        p('cc-approve-evidence', 'evidence', 'json', '${coverage_evidence}'),
        p('cc-approve-shot', 'shot', 'json', '${shot_script}'),
        p('cc-approve-tail', 'previousTail', 'json', '${coverage_sources.previousTail}'),
        p('cc-approve-bindings', 'referenceBindings', 'json', '${coverage_sources.referenceBindings}')],
      position: { x: branch.position.x + 1580, y: branch.position.y + 400 } },
    { id: ids[7], title: '视频人物参考路由', kind: 'code', resultVar: 'coverage_video_references',
      prompt: '同场切镜使用已归档三视图；其余镜头保留原身份参考。', code: COVERAGE_CUT_VIDEO_REFERENCES_CODE,
      params: [p('cc-router-branch', 'branch', 'json', '${first_frame_branch}'),
        p('cc-router-sources', 'sources', 'json', '${coverage_sources}')],
      uploads: [], loop: branch.loop, parentId: 'sanguo-scene-loop',
      position: { x: video.position.x - 180, y: video.position.y + 400 } },
  ] as unknown as N[]
  const additions = nodes.filter(node => !find(node.id))
  const videoParams = video.params.map(param => param.englishName === 'referenceImages'
    ? { ...param, value: '${coverage_video_references.referenceImages}' }
    : param.englishName === 'referenceBindings'
      ? { ...param, value: '${coverage_video_references.referenceBindings}' }
      : param.englishName === 'referenceMode'
        ? { ...param, value: '${coverage_video_references.referenceMode}' } : param)
  const videoExtras = [p('cc-video-gate', 'coverageCutFrameGate', 'json', '${coverage_frame_gate}'),
    p('cc-video-tail', 'coveragePreviousTail', 'json', '${coverage_sources.previousTail}'),
    p('cc-video-shot', 'coverageShot', 'json', '${shot_script}')]
  for (const item of videoExtras) if (!videoParams.some(param => param.englishName === item.englishName)) videoParams.push(item)
  const nextNodes = workflow.nodes.map(node => node.id === branch.id ? (node.code === code ? node : { ...node, code }) as N
    : node.id === video.id ? { ...node, params: videoParams } as N
      : node.id === owner.id ? (() => {
        const without = node.childIds!.filter(id => !ids.includes(id))
        const beforeVideo = without.indexOf(video.id)
        const childIds = beforeVideo < 0 ? [...without, ...ids]
          : [...without.slice(0, beforeVideo), ...ids, ...without.slice(beforeVideo)]
        return (childIds.join('|') === node.childIds!.join('|') ? node : { ...node, childIds }) as N
      })() : node)
  const sequence = [branch.id, ...ids, video.id]
  // The router is the single path into paid video from this branch. Keeping
  // the former direct edge would make gate ordering depend on scheduler policy.
  const nextEdges = workflow.edges.filter(edge => !(edge.from === branch.id && edge.to === video.id
    && edge.branch === undefined))
  for (let index = 0; index < sequence.length - 1; index++) {
    const from = sequence[index], to = sequence[index + 1]
    if (!nextEdges.some(edge => edge.from === from && edge.to === to)) {
      nextEdges.push({ id: `sg-e-coverage-${index}`, from, to })
    }
  }
  if (additions.length === 0 && JSON.stringify(nextNodes) === JSON.stringify(workflow.nodes)
    && JSON.stringify(nextEdges) === JSON.stringify(workflow.edges)) return workflow
  // A newly created Sanguo graph also carries the managed final-speech /
  // dependent-reaction media policy from upgradePrincipleQuality.
  return { ...workflow, schemaVersion: Math.max(157, (workflow.schemaVersion ?? 154) + 1),
    nodes: [...nextNodes, ...additions], edges: nextEdges } as W
}
