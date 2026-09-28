import { refreshFirstFramePromptScope, SANGUO_FIRST_FRAME_BRANCH_CODE } from './code-node-presets.ts'
import { LEGACY_SAND_TABLE_CONTRACT_PROMPT, PREVIOUS_SAND_TABLE_CONTRACT_PROMPT,
  PRIOR_BARE_SAND_TABLE_CONTRACT_PROMPT, SAND_TABLE_CONTRACT_PROMPT } from './sand-table-contract.ts'

export const ANIMATED_FRAME_OPERATION = 'history.animated-map-frame'
export const ANIMATED_MAP_FRAME_OPERATION = ANIMATED_FRAME_OPERATION
export const ANIMATED_MAP_IMAGE_MODEL_ID = 'kling-image-3'

const LEGACY_SAND_TABLE_FRAME_SCOPE = `仅当本镜是 historical_map 且 editorialRole=episode_opening/context_bridge/payoff 时：${LEGACY_SAND_TABLE_CONTRACT_PROMPT}此时上述通用插画与文字字形规则不能改变实体沙盘质感或允许沙盘文字。首尾帧各是同一盘面一个静态时刻，不在单张图里绘制运动残影、连续步骤或多个时刻；微缩旗队不是具名人物演员。`
const MIXED_SAND_TABLE_FRAME_SCOPE = `仅当本镜是 historical_map 且 editorialRole=episode_opening/context_bridge/payoff 时：${PREVIOUS_SAND_TABLE_CONTRACT_PROMPT}此时上述通用插画与文字字形规则不能改变实体沙盘质感或允许沙盘文字。首尾帧各是同一盘面一个静态时刻，不在单张图里绘制运动残影、连续步骤或多个时刻；微缩旗队不是具名人物演员。`
const LEGACY_SAND_TABLE_END_FRAME_CONTINUITY = '【沙盘首尾帧实物连续性】仅当本镜是 historical_map 且 editorialRole=episode_opening/context_bridge/payoff 时，把附件首帧中可见的盘框、地形、水道、城池、桥舟、营垒、微缩兵偶、旗杆和旗面逐件视为同一批实体道具。尾帧保留未被本镜明确移除的每件道具及其材质、形状、颜色、尺度、阵营和连接关系；只让分镜明确指定的实体沿指定路线改变位置，未指定移动的道具留在原位。旗标若附着于兵队或舟船，旗面、旗杆与载体必须一同移动；兵偶和舟船不能被凭空擦除，旗帜不能悬空或变成城牌、路牌，阵营颜色不能互换。尾帧必须能辨认移动后的完整实体及未移动的实体，不能只留下孤立旗标；只有分镜明确要求撤离、毁损或移除时才改变这些实体。'
const PREVIOUS_SAND_TABLE_FRAME_SCOPE = `仅当本镜是 historical_map 且 editorialRole=episode_opening/context_bridge/payoff 时：${PREVIOUS_SAND_TABLE_CONTRACT_PROMPT}首尾帧只生成无人物的历史地理地图底板；即使分镜声明了具名静态肖像，也由后期按 illustrationLayers 叠加，图像模型不得将人物画入地图。每帧是同一地理范围的一个静态时刻，不在单张图里绘制运动残影或多个时刻。允许已核对的必要地图短标记，禁止字幕和标题。`
const SAND_TABLE_FRAME_SCOPE = `仅当本镜是 historical_map 且 editorialRole=episode_opening/context_bridge/payoff 时：${SAND_TABLE_CONTRACT_PROMPT}首尾帧只生成同一地理范围、无人物的古代历史地理裸地图底板；山川、水系、道路、城址和边界清楚，地理朝向稳定。即使分镜有具名静态肖像，图像模型也不得将人物画入底片。地图底片不得烘焙任何文字、地名、伪字、字幕、路线线条、箭头、势力标记或人物角标；这些按已独立审核的 mapAnnotations 与 illustrationLayers 由本地后期叠加。每帧只呈现一个静态时刻，不绘制运动残影或多个时刻。`
const PRIOR_BARE_SAND_TABLE_FRAME_SCOPE = SAND_TABLE_FRAME_SCOPE.replace(SAND_TABLE_CONTRACT_PROMPT, PRIOR_BARE_SAND_TABLE_CONTRACT_PROMPT)
const PREVIOUS_SAND_TABLE_END_FRAME_CONTINUITY = '【历史地图首尾帧连续性】仅当本镜是 historical_map 且 editorialRole=episode_opening/context_bridge/payoff 时，以附件首帧的地理范围、方位、山川、水系、道路、城址、边界和设色为同一张地图的底板；尾帧只改变本镜已批准的区域着色、路线进度或地点标记，未指定变化的地理与地图短标记保持位置和字形。路线的起点、途经与终点连续可辨，不让城址、山河或边界无因漂移。首尾帧均不烘焙人物肖像；人物由后期图层合成。禁止字幕、标题、水印、盘框、玩具模型与伪字。'
export const SAND_TABLE_END_FRAME_CONTINUITY = '【历史地图首尾帧连续性】仅当本镜是 historical_map 且 editorialRole=episode_opening/context_bridge/payoff 时，以附件首帧的地理范围、方位、山川、水系、道路、城址、边界和设色为同一张无字裸地图底板；尾帧仅允许已批准的区域设色或地形可见状态变化，未指定变化的地理保持位置和比例。首尾帧均不烘焙人物肖像、地名、势力标记、路线线条或箭头；这些由 mapAnnotations 与 illustrationLayers 在本地后期合成。禁止字幕、标题、水印、盘框、玩具模型与伪字。'
const MANAGED_FIRST_FRAME_SCOPE = '根据系统整理后的首帧内容生成一张完整的 16:9 历史叙事动画首图：${first_frame_branch.framePrompt}'
const PREVIOUS_MANAGED_END_FRAME_SCOPE = '以附件中的动画首图为构图、角色身份和文字基准，生成本镜动作完成后的单一 16:9 尾帧：${shot_script.lastFramePrompt}'
const MANAGED_END_FRAME_SCOPE = '以附件中的动画首图为构图基准生成本镜单一 16:9 尾帧；historical_map 只继承同一地理底板，其他动画继续锁定角色身份：${shot_script.lastFramePrompt}'
const PREVIOUS_FIRST_FRAME_GENERAL_SCOPE = 'historical_map 强调疆域、路线与区域关系；character_illustration 只生成适合承载人物卡片的历史背景底板'
const FIRST_FRAME_GENERAL_SCOPE = 'historical_map 只绘制古代地理底板，路线、地名和人物均留给本地已批准图层；character_illustration 只生成适合承载人物卡片的历史背景底板'
const PREVIOUS_FIRST_FRAME_INTRO_SCOPE = '只呈现一个稳定的单一时刻，构图、角色身份、服饰、道具和时代环境必须清楚。'
const FIRST_FRAME_INTRO_SCOPE = '只呈现一个稳定的单一时刻。historical_map 的古代地理必须清楚；其他动画的构图、角色身份、服饰、道具和时代环境按分镜保持清晰。'
const PREVIOUS_FIRST_FRAME_TEXT_SCOPE = '画面中需要出现的中文只能逐字使用分镜中已有文字，使用规范简体中文和端正印刷字形；'
const FIRST_FRAME_TEXT_SCOPE = '非 historical_map 镜头若经分镜明确允许文字，只能逐字使用已有文字与规范简体字形；'
const PREVIOUS_END_FRAME_GENERAL_SCOPE = '保持首图的构图体系、美术语言、人物身份、时代服饰以及已有文字的字形、字号、位置和版式稳定，只改变分镜明确要求的动作结果、环境状态、区域高亮、路线进度、象征物或镜头景别。不得重绘、改写、增删或移动任何中文；'
const END_FRAME_GENERAL_SCOPE = 'historical_map 只保持首图的地理范围、方位、山川、水系、城址、边界和设色连续；不得在地图底片增添文字、路线、箭头或人物。其他动画保持首图的构图体系、美术语言、人物身份、时代服饰以及已有文字的字形、字号、位置和版式稳定，只改变分镜明确要求的动作结果、环境状态、象征物或镜头景别；其他动画不得重绘、改写、增删或移动已有中文；'

export function refreshAnimatedFrameSandTablePrompt(prompt: string): string {
  const isFirst = prompt.startsWith('【动画镜头首帧】')
  const isEnd = prompt.startsWith('【动画镜头目标尾帧】')
  const markers = isFirst ? [MANAGED_FIRST_FRAME_SCOPE]
    : isEnd ? [PREVIOUS_MANAGED_END_FRAME_SCOPE, MANAGED_END_FRAME_SCOPE] : []
  if (!markers.some(marker => prompt.split(marker).length === 2)) return prompt
  let next = prompt
  if (isEnd && next.split(PREVIOUS_MANAGED_END_FRAME_SCOPE).length === 2) {
    next = next.replace(PREVIOUS_MANAGED_END_FRAME_SCOPE, MANAGED_END_FRAME_SCOPE)
  }
  if (isFirst && next.split(PREVIOUS_FIRST_FRAME_GENERAL_SCOPE).length === 2) {
    next = next.replace(PREVIOUS_FIRST_FRAME_GENERAL_SCOPE, FIRST_FRAME_GENERAL_SCOPE)
  }
  if (isFirst && next.split(PREVIOUS_FIRST_FRAME_INTRO_SCOPE).length === 2) {
    next = next.replace(PREVIOUS_FIRST_FRAME_INTRO_SCOPE, FIRST_FRAME_INTRO_SCOPE)
  }
  if (isFirst && next.split(PREVIOUS_FIRST_FRAME_TEXT_SCOPE).length === 2) {
    next = next.replace(PREVIOUS_FIRST_FRAME_TEXT_SCOPE, FIRST_FRAME_TEXT_SCOPE)
  }
  if (isEnd && next.split(PREVIOUS_END_FRAME_GENERAL_SCOPE).length === 2) {
    next = next.replace(PREVIOUS_END_FRAME_GENERAL_SCOPE, END_FRAME_GENERAL_SCOPE)
  }
  if (next.split(PREVIOUS_SAND_TABLE_FRAME_SCOPE).length === 2) next = next.replace(PREVIOUS_SAND_TABLE_FRAME_SCOPE, SAND_TABLE_FRAME_SCOPE)
  if (next.split(PRIOR_BARE_SAND_TABLE_FRAME_SCOPE).length === 2) {
    next = next.replace(PRIOR_BARE_SAND_TABLE_FRAME_SCOPE,
      () => next.includes(SAND_TABLE_FRAME_SCOPE) ? '' : SAND_TABLE_FRAME_SCOPE)
  }
  if (next.split(PREVIOUS_SAND_TABLE_END_FRAME_CONTINUITY).length === 2) next = next.replace(PREVIOUS_SAND_TABLE_END_FRAME_CONTINUITY, SAND_TABLE_END_FRAME_CONTINUITY)
  if (next.split(LEGACY_SAND_TABLE_FRAME_SCOPE).length === 2) {
    next = next.replace(LEGACY_SAND_TABLE_FRAME_SCOPE, () => next.includes(SAND_TABLE_FRAME_SCOPE) ? '' : SAND_TABLE_FRAME_SCOPE)
  }
  if (next.split(MIXED_SAND_TABLE_FRAME_SCOPE).length === 2) {
    next = next.replace(MIXED_SAND_TABLE_FRAME_SCOPE, () => next.includes(SAND_TABLE_FRAME_SCOPE) ? '' : SAND_TABLE_FRAME_SCOPE)
  }
  if (next.split(LEGACY_SAND_TABLE_END_FRAME_CONTINUITY).length === 2) {
    next = next.replace(LEGACY_SAND_TABLE_END_FRAME_CONTINUITY,
      () => next.includes(SAND_TABLE_END_FRAME_CONTINUITY) ? '' : SAND_TABLE_END_FRAME_CONTINUITY)
  }
  if (next.includes(LEGACY_SAND_TABLE_CONTRACT_PROMPT) || next.includes(PREVIOUS_SAND_TABLE_CONTRACT_PROMPT)
    || next.includes(PRIOR_BARE_SAND_TABLE_CONTRACT_PROMPT)) return next
  // Some saved prompts already gained the new scope before the older physical
  // scope was removed. Keep the first exact managed copy and author text.
  const firstScope = next.indexOf(SAND_TABLE_FRAME_SCOPE)
  if (firstScope >= 0) {
    let duplicate = next.indexOf(SAND_TABLE_FRAME_SCOPE, firstScope + SAND_TABLE_FRAME_SCOPE.length)
    while (duplicate >= 0) {
      next = next.slice(0, duplicate) + next.slice(duplicate + SAND_TABLE_FRAME_SCOPE.length)
      duplicate = next.indexOf(SAND_TABLE_FRAME_SCOPE, firstScope + SAND_TABLE_FRAME_SCOPE.length)
    }
  }
  const firstEnd = next.indexOf(SAND_TABLE_END_FRAME_CONTINUITY)
  if (firstEnd >= 0) {
    let duplicate = next.indexOf(SAND_TABLE_END_FRAME_CONTINUITY, firstEnd + SAND_TABLE_END_FRAME_CONTINUITY.length)
    while (duplicate >= 0) {
      next = next.slice(0, duplicate) + next.slice(duplicate + SAND_TABLE_END_FRAME_CONTINUITY.length)
      duplicate = next.indexOf(SAND_TABLE_END_FRAME_CONTINUITY, firstEnd + SAND_TABLE_END_FRAME_CONTINUITY.length)
    }
  }
  if (!next.includes(SAND_TABLE_CONTRACT_PROMPT)) next += '\n本镜编辑职能：${shot_script.editorialRole}。\n' + SAND_TABLE_FRAME_SCOPE
  if (isEnd && !next.includes(SAND_TABLE_END_FRAME_CONTINUITY)) {
    next = next.includes(SAND_TABLE_FRAME_SCOPE)
      ? next.replace(SAND_TABLE_FRAME_SCOPE, SAND_TABLE_FRAME_SCOPE + '\n' + SAND_TABLE_END_FRAME_CONTINUITY)
      : next + '\n' + SAND_TABLE_END_FRAME_CONTINUITY
  }
  return next
}

export const ANIMATED_MAP_FIRST_FRAME_PROMPT = refreshAnimatedFrameSandTablePrompt(`【动画镜头首帧】
视觉类型：\${shot_script.animationStyle}；美术风格：\${shot_script.animationAesthetic}。旧 animated_map 按 historical_map 执行，旧 historical_montage 按 historical_tableau 执行。
根据系统整理后的首帧内容生成一张完整的 16:9 历史叙事动画首图：\${first_frame_branch.framePrompt}
只呈现一个稳定的单一时刻，构图、角色身份、服饰、道具和时代环境必须清楚。historical_map 强调疆域、路线与区域关系；character_illustration 只生成适合承载人物卡片的历史背景底板，不画任何人物，人物图层由系统另行放置、淡入、平移和淡出；historical_tableau 生成成熟历史叙事插画，画内人物姿态保持定格，系统只对整幅画做轻微二维缩放或渐变。不得设计人物走路、转身、说话、口型、表情或肢体表演。画面中需要出现的中文只能逐字使用分镜中已有文字，使用规范简体中文和端正印刷字形；严禁伪字、错字、乱码、字形粘连、缺笔、多笔、镜像文字及额外编造文字。非必要不在画面中生成文字，不添加字幕、标题、水印或界面文字。`)

const LEGACY_END_FRAME_VIDEO_SCOPE = '【本镜动画过程】${shot_script.videoPrompt}'
const STATIC_END_FRAME_VISUAL_SCOPE = '构图视角参考：${shot_script.camera}；只参考本镜最终构图，不展示运镜过程。'

export const ANIMATED_MAP_END_FRAME_PROMPT = refreshAnimatedFrameSandTablePrompt(`【动画镜头目标尾帧】
视觉类型：\${shot_script.animationStyle}；美术风格：\${shot_script.animationAesthetic}。
以附件中的动画首图为构图、角色身份和文字基准，生成本镜动作完成后的单一 16:9 尾帧：\${shot_script.lastFramePrompt}
${STATIC_END_FRAME_VISUAL_SCOPE}
保持首图的构图体系、美术语言、人物身份、时代服饰以及已有文字的字形、字号、位置和版式稳定，只改变分镜明确要求的动作结果、环境状态、区域高亮、路线进度、象征物或镜头景别。不得重绘、改写、增删或移动任何中文；严禁伪字、错字、乱码、字形粘连、缺笔、多笔和镜像文字。不添加字幕、标题、水印或界面文字。`)

type Param = { id: string; name: string; englishName?: string; type: string; required: boolean; value: string }
type Node = {
  id: string; title: string; kind: string; resultVar: string; prompt: string; modelId?: string; operation?: string
  params: Param[]; uploads: unknown[]; loop: { enabled: boolean; sourcePath: string; fallbackCount: number; itemVar: string }
  position: { x: number; y: number }; parentId?: string; childIds?: string[]; runIf?: { path: string; equals: unknown }; code?: string
}
type Workflow<N extends Node> = { id: string; schemaVersion?: number; nodes: N[]; edges: Array<{ id: string; from: string; to: string }> }

const loop = { enabled: false, sourcePath: '', fallbackCount: 1, itemVar: 'item' }
const param = (id: string, name: string, englishName: string, type: string, required: boolean, value: string): Param =>
  ({ id, name, englishName, type, required, value })

export const animatedMapFirstFrameNode: Node = {
  id: 'sanguo-animated-map-first-frame',
  title: '可灵动画镜头首帧',
  kind: 'image',
  operation: ANIMATED_FRAME_OPERATION,
  modelId: ANIMATED_MAP_IMAGE_MODEL_ID,
  resultVar: 'first_frame',
  prompt: ANIMATED_MAP_FIRST_FRAME_PROMPT,
  runIf: { path: 'first_frame_branch.shouldGenerateAnimatedFirstFrame', equals: true },
  params: [
    param('sg-amf-ratio', '画幅比例', 'aspectRatio', 'text', true, '16:9'),
    param('sg-amf-resolution', '清晰度', 'resolution', 'text', true, '1k'),
    param('sg-amf-count', '数量', 'n', 'number', true, '1'),
    param('sg-amf-reference', '首图生成参考（人物插画底板恒为空）', 'referenceImages', 'images', false, '${first_frame_branch.frameReferenceImages}'),
    param('sg-amf-treatment', '视觉处理', 'visualTreatment', 'text', true, '${shot_script.visualTreatment}'),
    param('sg-amf-style', '动画叙事类型', 'animationStyle', 'text', false, '${shot_script.animationStyle}'),
    param('sg-amf-aesthetic', '动画美术风格', 'animationAesthetic', 'text', false, '${shot_script.animationAesthetic}'),
    param('sg-amf-role', '帧角色', 'frameRole', 'text', true, 'first'),
    param('sg-amf-map-annotations', '历史地图已审标注计划', 'mapAnnotations', 'json', false, '${shot_script.mapAnnotations}'),
    param('sg-amf-map-approval', '历史地图标注独立审核凭证', 'mapAnnotationApproval', 'json', false, '${map_annotation_approval}'),
    param('sg-amf-map-duration', '历史地图分镜时长', 'mapDuration', 'number', false, '${shot_script.duration}'),
    param('sg-amf-map-role', '历史地图信息镜头职能', 'mapEditorialRole', 'text', false, '${shot_script.editorialRole}'),
  ],
  uploads: [], loop, parentId: 'sanguo-scene-loop', position: { x: 2890, y: 60 },
}

export const animatedMapEndFrameNode: Node = {
  id: 'sanguo-end-frame',
  title: '可灵动画镜头尾帧',
  kind: 'image',
  operation: ANIMATED_FRAME_OPERATION,
  modelId: ANIMATED_MAP_IMAGE_MODEL_ID,
  resultVar: 'end_frame',
  prompt: ANIMATED_MAP_END_FRAME_PROMPT,
  runIf: { path: 'first_frame_branch.shouldGenerateAnimatedEndFrame', equals: true },
  params: [
    param('sg-ef-first', '动画首图', 'referenceImage', 'image', true, '${first_frame.url}'),
    param('sg-ef-ratio', '画幅比例', 'aspectRatio', 'text', true, '16:9'),
    param('sg-ef-resolution', '清晰度', 'resolution', 'text', true, '1k'),
    param('sg-ef-count', '数量', 'n', 'number', true, '1'),
    param('sg-ef-treatment', '视觉处理', 'visualTreatment', 'text', true, '${shot_script.visualTreatment}'),
    param('sg-ef-style', '动画叙事类型', 'animationStyle', 'text', false, '${shot_script.animationStyle}'),
    param('sg-ef-aesthetic', '动画美术风格', 'animationAesthetic', 'text', false, '${shot_script.animationAesthetic}'),
    param('sg-ef-role', '帧角色', 'frameRole', 'text', true, 'end'),
    param('sg-ef-map-first-gate', '历史地图首帧实际图片凭证', 'mapFirstGate', 'json', false, '${map_first_gate}'),
    param('sg-ef-map-role', '历史地图信息镜头职能', 'mapEditorialRole', 'text', false, '${shot_script.editorialRole}'),
  ],
  uploads: [], loop, parentId: 'sanguo-scene-loop', position: { x: 3170, y: 60 },
}

export const animatedFirstFrameNode = animatedMapFirstFrameNode
export const animatedEndFrameNode = animatedMapEndFrameNode

/** Still-image inputs describe one visible state. Video timing and spoken
 * content remain in the storyboard for their own video/audio consumers.
 * Refresh only recognized managed fragments, including workflows already at
 * the current schema, without replacing any custom node configuration. */
export function refreshStaticBoundaryFrameScope<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 130) return workflow
  let changed = false
  const nodes = workflow.nodes.map(node => {
    if (node.id === 'sanguo-first-frame-branch' && node.kind === 'code' && typeof node.code === 'string') {
      const code = refreshFirstFramePromptScope(node.code)
      if (code !== node.code) { changed = true; return { ...node, code } }
    }
    if (node.id === 'sanguo-end-frame' && node.kind === 'image' && node.prompt.startsWith('【动画镜头目标尾帧】')
      && node.prompt.split(LEGACY_END_FRAME_VIDEO_SCOPE).length === 2) {
      changed = true
      return { ...node, prompt: node.prompt.replace(LEGACY_END_FRAME_VIDEO_SCOPE, STATIC_END_FRAME_VISUAL_SCOPE) }
    }
    return node
  })
  return changed ? { ...workflow, nodes } : workflow
}

/** Schema 131 generalizes the boundary-frame route from maps to every approved
 * animation style while retaining legacy ids, operation names and records. */
export function upgradeAnimatedShotStyles<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 130) return workflow
  const branch = workflow.nodes.find(node => node.id === 'sanguo-first-frame-branch')
  const first = workflow.nodes.find(node => node.id === 'sanguo-animated-map-first-frame')
  const end = workflow.nodes.find(node => node.id === 'sanguo-end-frame')
  const video = workflow.nodes.find(node => node.id === 'sanguo-video')
  if (branch?.kind !== 'code' || first?.kind !== 'image' || end?.kind !== 'image' || video?.kind !== 'video') return workflow
  const videoParams = video.params.map(item => (item.englishName || item.name) === 'endImage'
    ? { ...item, name: '动画镜头目标尾帧' } : item)
  const nodes = workflow.nodes.map(node => {
    if (node === branch) return { ...node, code: SANGUO_FIRST_FRAME_BRANCH_CODE } as N
    if (node === first) return { ...node, ...animatedMapFirstFrameNode, position: node.position } as N
    if (node === end) return { ...node, ...animatedMapEndFrameNode, position: node.position } as N
    if (node === video) return { ...node, params: videoParams } as N
    return node
  })
  return { ...workflow, schemaVersion: 131, nodes }
}

/** Schema 130 introduces one narrowly routed Kling image branch. Existing model
 * selections and all review/retry nodes remain untouched. */
export function upgradeAnimatedMapBoundaryFrames<N extends Node, W extends Workflow<N>>(workflow: W): W {
  if (workflow.id !== 'wf-sanguo-history-drama' || workflow.schemaVersion !== 129) return workflow
  const branch = workflow.nodes.find(node => node.id === 'sanguo-first-frame-branch')
  const end = workflow.nodes.find(node => node.id === 'sanguo-end-frame')
  const video = workflow.nodes.find(node => node.id === 'sanguo-video')
  const owner = workflow.nodes.find(node => node.id === 'sanguo-scene-loop')
  if (branch?.kind !== 'code' || end?.kind !== 'image' || video?.kind !== 'video' || owner?.kind !== 'loop') return workflow

  const first = { ...animatedMapFirstFrameNode, position: { x: end.position.x - 280, y: end.position.y } } as N
  const replacementEnd = { ...end, ...animatedMapEndFrameNode, position: end.position } as N
  const endImage = param('sg-v-end-image', '动画地图目标尾帧', 'endImage', 'image', false, '${end_frame.url}') as N['params'][number]
  const videoParams = [...video.params.filter(item => (item.englishName || item.name) !== 'endImage'), endImage]
  const nodes: N[] = []
  for (const node of workflow.nodes) {
    if (node.id === first.id) continue
    if (node === branch) nodes.push({ ...node, code: SANGUO_FIRST_FRAME_BRANCH_CODE } as N)
    else if (node === end) nodes.push(first, replacementEnd)
    else if (node === video) nodes.push({ ...node, params: videoParams } as N)
    else if (node === owner) {
      const children = node.childIds ?? []
      const without = children.filter(id => id !== first.id)
      const beforeEnd = without.indexOf(end.id)
      const childIds = beforeEnd >= 0
        ? [...without.slice(0, beforeEnd), first.id, ...without.slice(beforeEnd)]
        : [...without, first.id]
      nodes.push({ ...node, childIds } as N)
    } else nodes.push(node)
  }
  const managedIds = new Set(['sg-e-branch-animated-map-first', 'sg-e-animated-map-first-end', 'sg-e-animated-map-end-video'])
  const edges = [
    ...workflow.edges.filter(edge => !managedIds.has(edge.id)),
    { id: 'sg-e-branch-animated-map-first', from: branch.id, to: first.id },
    { id: 'sg-e-animated-map-first-end', from: first.id, to: end.id },
    { id: 'sg-e-animated-map-end-video', from: end.id, to: video.id },
  ]
  return { ...workflow, schemaVersion: 130, nodes, edges }
}
