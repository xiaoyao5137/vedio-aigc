type Value = Record<string, unknown>

/** The old text is kept verbatim so persisted managed prompts can be upgraded
 * without touching surrounding author instructions or frozen executions. */
export const LEGACY_SAND_TABLE_CONTRACT_PROMPT = '【实体沙盘表达合同 physical-sand-table-v1】historical_map 信息动画统一为可拍摄的实体微缩沙盘：可见低矮盘框、砂土颗粒与起伏微缩地形，采用自然光影和真实材料质感；道路与水道在地表连续可辨，必要的桥、城池或营地是有体积的小模型。涉及不同势力时用彼此可区分的无字微缩旗标或队伍表示，比例小于地形，阵营样式和地理朝向始终一致。先看清地点、双方相对位置与前后距离，再让相关微缩队伍沿原事件路线连续移动；运动起点、路径、终点和变化结果必须可追踪，并与原旁白对应。只呈现来源与本段已有事件，不新增军队、人物、战斗或地理结论；地形是示意，不伪称精确历史测绘。禁止两根巨大悬浮箭头、发光线条或抽象色块代替地形和队伍说明，禁止拼贴、分栏、真人变卡通及模型人物对白。旗标与沙盘无可读文字、地名、字幕、标题、水印或乱码；地名、年代与势力由原旁白解释，完整保留原台词、顺序、时间轴、人物关系和事件结果。'
const LEGACY_SAND_TABLE_WRITING_PROMPT = `本系列仅在 visualTreatment=animated/animated_map、animationStyle=historical_map 且 editorialRole=episode_opening/context_bridge/payoff 的历史地图信息镜头使用下列合同，其他人物和环境叙事继续真人实景；不把自定义的非串联动画强改成沙盘。此类新计划的 animationAesthetic 使用 physical_sand_table；旧 cinematic_gongbi 标签只作兼容，不能把实体沙盘画成平面工笔。${LEGACY_SAND_TABLE_CONTRACT_PROMPT}大纲 observable.visual/mustShow 与分镜 visualPrompt/videoPrompt/lastFramePrompt 写出本段具体地形、势力模型的区别、相对位置和路线变化，不以“地图解释局势”或大箭头标签代替可见内容。首帧呈现运动前的实体盘面，尾帧呈现同一盘面上的真实预期结果；光线、盘框、尺度、阵营样式和地理朝向保持一致。`

/** A sourced historical-geography illustration, not evidence that generated
 * media actually depicts accurate geography. Historical events and audio stay
 * anchored to the approved scene. */
export const SAND_TABLE_CONTRACT_VERSION = 'historical-cartography-v1'
const PREVIOUS_SAND_TABLE_PRESENTATION = 'historical_map 信息动画采用古代历史地理地图的二维绘图语言：全画幅古地图底图，清楚表现本段有史料依据的地域轮廓、山脉、河流、道路、城址与相对方位；按时代和地点选择合适的疆域、行政边界与地理标记，不把现代边界伪作当时版图，不伪称精确历史测绘。使用克制的宣纸、墨线、设色和地形晕染；地域着色、二维路线线条或贴合图面的箭头展示势力关系与行进方向，起点、途经和终点可追踪，不遮没地理。只在已经核对且确有必要时绘制简短地名、年代或势力地图标记，字形准确；旁白仍独立说清时地和因果，观众不靠认字也能理解。禁止实体盘框、砂土颗粒、玩具城堡、微缩兵偶、立体棋子、桌面摄影、游戏界面、悬浮三维箭头和抽象色块替代历史地理。允许在这类地图信息镜头中按已批准的具名人物资产叠加一至两幅静态人物肖像作为势力或事件的叙事标记：肖像不走动、不说话、不改姿态、表情或口型，仅整层淡入、平移、缩放、停留或淡出；地图首尾底图不烘焙人物，由后期按 illustrationLayers 合成。人物正戏仍为真人实景。只呈现来源与本段已有事件，不新增军队、人物、战斗或地理结论；完整保留原旁白、台词、顺序、时间轴、人物关系和事件结果。全片无字幕、台词文字、标题、水印或乱码；必要的地图标记不是字幕。'
export const PREVIOUS_SAND_TABLE_CONTRACT_PROMPT = `【历史地理地图表达合同 ${SAND_TABLE_CONTRACT_VERSION}】${PREVIOUS_SAND_TABLE_PRESENTATION}`
const PRIOR_BARE_PORTRAIT_RULE = '允许在这类地图信息镜头中按已批准的具名人物资产叠加一至两幅静态人物肖像作为势力或事件的叙事标记：肖像不走动、不说话、不改姿态、表情或口型，仅整层淡入、平移、缩放、停留或淡出；由后期按 illustrationLayers 合成。'
const BARE_PORTRAIT_RULE = '人物肖像仅由本地后期按已批准的具名人物资产和 illustrationLayers 图层叠加一至两幅，作为势力或事件的静态叙事标记；图像和视频模型不得绘制。肖像不走动、不说话、不改姿态、表情或口型，仅整层淡入、平移、缩放、停留或淡出。'
const PRIOR_BARE_SAND_TABLE_PRESENTATION = 'historical_map 信息动画采用古代历史地理地图的二维绘图语言：全画幅古地图底图，清楚表现本段有史料依据的地域轮廓、山脉、河流、道路、城址与相对方位；按时代和地点选择合适的疆域、行政边界，不把现代边界伪作当时版图，不伪称精确历史测绘。底片使用克制的宣纸、墨线、设色和地形晕染，只绘制山川、水系、道路、城址、地域边界和地理底色。势力关系、地名、年代、路线与箭头须先形成独立 mapAnnotations 并按史料审定，再由本地后期覆盖在无字、无箭头、无人物的地图底片上；每条路线有经批准的起点、终点、方向和阵营，不得反向或凭空添军。图像和视频模型不得烘焙任何可读或伪造文字、路线线条、箭头、势力标记、头像、肖像、微缩人物及字幕。允许在这类地图信息镜头中按已批准的具名人物资产叠加一至两幅静态人物肖像作为势力或事件的叙事标记：肖像不走动、不说话、不改姿态、表情或口型，仅整层淡入、平移、缩放、停留或淡出；由后期按 illustrationLayers 合成。禁止实体盘框、砂土颗粒、玩具城堡、微缩兵偶、立体棋子、桌面摄影、游戏界面、悬浮三维箭头和抽象色块替代历史地理。人物正戏仍为真人实景。只呈现来源与本段已有事件，不新增军队、人物、战斗或地理结论；完整保留原旁白、台词、顺序、时间轴、人物关系和事件结果。全片无字幕、台词文字、标题、水印或乱码；地图短标记由批准图层提供。'
export const SAND_TABLE_PRESENTATION = PRIOR_BARE_SAND_TABLE_PRESENTATION.replace(PRIOR_BARE_PORTRAIT_RULE, BARE_PORTRAIT_RULE)
export const PRIOR_BARE_SAND_TABLE_CONTRACT_PROMPT = `【历史地理地图表达合同 ${SAND_TABLE_CONTRACT_VERSION}】${PRIOR_BARE_SAND_TABLE_PRESENTATION}`
export const SAND_TABLE_CONTRACT_PROMPT = `【历史地理地图表达合同 ${SAND_TABLE_CONTRACT_VERSION}】${SAND_TABLE_PRESENTATION}`
const PREVIOUS_CARTOGRAPHY_WRITING_PROMPT = `本系列仅在 visualTreatment=animated/animated_map、animationStyle=historical_map 且 editorialRole=episode_opening/context_bridge/payoff 的历史地图信息镜头使用下列合同，其他人物和环境叙事继续真人实景；不把自定义的非串联动画改成地图。此类新计划的 animationAesthetic 使用 historical_cartography；旧 physical_sand_table、cinematic_gongbi 标签仅供旧记录读取，新计划不得再生成实体微缩沙盘。${PREVIOUS_SAND_TABLE_CONTRACT_PROMPT}大纲 observable.visual/mustShow 与分镜 visualPrompt/videoPrompt/lastFramePrompt 写明本段具体地理、势力相对位置及路线变化。若地图上需出现具名人物静态肖像，大纲 cast 列其姓名，分镜 characters/presentCharacters 与 illustrationLayers 按同名资产一一对应；visualPrompt 与首尾帧只描述无人物的地图底板，videoPrompt 写明人物图层出入时序且不请求视频模型绘制人物。没有肖像时 illustrationLayers=[]。首帧呈现变化前的地图底板，尾帧呈现同一地图底板上的预期地理结果；方位、比例、边界、地名及设色保持连续。`
const PRIOR_CARTOGRAPHY_WRITING_PROMPT = `本系列仅在 visualTreatment=animated/animated_map、animationStyle=historical_map 且 editorialRole=episode_opening/context_bridge/payoff 的历史地图信息镜头使用下列合同，其他人物和环境叙事继续真人实景；不把自定义的非串联动画改成地图。此类新计划的 animationAesthetic 使用 historical_cartography。${PREVIOUS_SAND_TABLE_CONTRACT_PROMPT}大纲 observable.visual/mustShow 与分镜 visualPrompt/videoPrompt/lastFramePrompt 只写本段具体地理、势力相对位置及路线变化，不把待后期叠加的肖像姓名或绘制指令写入这些地图底片提示，也不将肖像图层列作 requiredBeats 的史实动作锚点。若地图上需出现具名人物静态肖像，大纲 cast 列其姓名，分镜 characters/presentCharacters 与 illustrationLayers 按同名资产一一对应；人物位置、淡入、停留、淡出只写在 illustrationLayers 中，由后期合成，不请求图像或视频模型绘制人物。没有肖像时 illustrationLayers=[]。首帧呈现变化前的无人物地图底板，尾帧呈现同一无人物地图底板上的预期地理结果；方位、比例、边界、地名及设色保持连续。`
export const SANGUO_SAND_TABLE_WRITING_PROMPT = `本系列仅在 visualTreatment=animated/animated_map、animationStyle=historical_map 且 editorialRole=episode_opening/context_bridge/payoff 的历史地图信息镜头使用下列合同，其他人物和环境叙事继续真人实景；不把自定义的非串联动画改成地图。此类新计划的 animationAesthetic 使用 historical_cartography。${SAND_TABLE_CONTRACT_PROMPT}大纲 observable.visual/mustShow 可叙述史实路线，但分镜 visualPrompt/videoPrompt/lastFramePrompt 只描述无字、无箭头、无人物的古代历史地理底片，不要求图像或视频模型画地名、势力标记、路线或头像。分镜另输出 mapAnnotations={version:'historical-map-annotations-v1',orientation:'north-up',sourceRefs:['已批准史料编号'],labels:[],routes:[]}：sourceRefs 绑定本镜已批准史料；labels 项需有准确文字、归一化位置和史料 sourceRef；routes 项需有唯一 id、party、direction、color、归一化路径 points、startSecond/endSecond 和 sourceRef，起终点及方向由已批准来源支撑，按本镜时长编排。确无地名或路线的镜头可保留 labels=[]、routes=[]，但 sourceRefs 仍必须有据；涉及追逃路线的 requiredBeats 不能以空 routes 省略。缺乏来源的标注宁可不画，禁止猜地名与行军方向。该独立对象先经审核批准，再由本地后期叠加。若地图需具名静态肖像，大纲 cast 列其姓名，分镜 characters/presentCharacters 与 illustrationLayers 按同名资产一一对应；肖像位置、淡入、停留、淡出只写在 illustrationLayers，不列作 requiredBeats 的史实动作锚点；图像或视频模型不绘制肖像。没有肖像时 illustrationLayers=[]。首尾帧保持同一无字无箭头底板的方位、比例、山川、边界和设色连续。`
const PRIOR_BARE_CARTOGRAPHY_WRITING_PROMPT = SANGUO_SAND_TABLE_WRITING_PROMPT.replace(SAND_TABLE_CONTRACT_PROMPT, PRIOR_BARE_SAND_TABLE_CONTRACT_PROMPT)

/** Keep this historical name for callers that identify an informational map
 * insert. The visual no longer implies a physical sand tray. */
export function isHistoricalSandTable(value: Value): boolean {
  const treatment = String(value.visualTreatment ?? '')
  const style = String(value.animationStyle ?? (treatment === 'animated_map' ? 'historical_map' : ''))
  return ['animated', 'animated_map', 'historical_montage'].includes(treatment) && style === 'historical_map'
    && ['episode_opening', 'context_bridge', 'payoff'].includes(String(value.editorialRole ?? ''))
}

/** Normalize new plans while retaining the legacy aesthetic values as valid
 * schema values so previously saved executions can still be read. */
export function normalizeSandTableAesthetic<T extends Value>(value: T): T {
  if (!isHistoricalSandTable(value)) return value
  const aesthetic = String(value.animationAesthetic ?? '')
  if (aesthetic && !['historical_cartography', 'physical_sand_table', 'cinematic_gongbi', 'ink_wash', 'woodblock_print', 'shadow_puppet', 'painterly_2d'].includes(aesthetic)) return value
  if (value.visualTreatment === 'animated' && value.animationStyle === 'historical_map' && aesthetic === 'historical_cartography') return value
  return { ...value, visualTreatment: 'animated', animationStyle: 'historical_map', animationAesthetic: 'historical_cartography' }
}

/** Replace an exact shipped clause once; authored text elsewhere survives. */
export function refreshSandTableWritingPrompt(prompt: string, managedClause: string): string {
  let next = prompt
  for (const prior of [LEGACY_SAND_TABLE_WRITING_PROMPT, PREVIOUS_CARTOGRAPHY_WRITING_PROMPT,
    PRIOR_CARTOGRAPHY_WRITING_PROMPT, PRIOR_BARE_CARTOGRAPHY_WRITING_PROMPT]) {
    if (next.split(prior).length === 2) {
      next = next.replace(prior, () => next.includes(SANGUO_SAND_TABLE_WRITING_PROMPT) ? '' : SANGUO_SAND_TABLE_WRITING_PROMPT)
    }
  }
  const first = next.indexOf(SANGUO_SAND_TABLE_WRITING_PROMPT)
  if (first >= 0) {
    let duplicate = next.indexOf(SANGUO_SAND_TABLE_WRITING_PROMPT, first + SANGUO_SAND_TABLE_WRITING_PROMPT.length)
    while (duplicate >= 0) {
      next = next.slice(0, duplicate) + next.slice(duplicate + SANGUO_SAND_TABLE_WRITING_PROMPT.length)
      duplicate = next.indexOf(SANGUO_SAND_TABLE_WRITING_PROMPT, first + SANGUO_SAND_TABLE_WRITING_PROMPT.length)
    }
  }
  // A customized legacy rule is ambiguous; avoid appending a contradictory one.
  if (next.includes(LEGACY_SAND_TABLE_CONTRACT_PROMPT) || next.includes(PREVIOUS_SAND_TABLE_CONTRACT_PROMPT)
    || next.includes(PRIOR_BARE_SAND_TABLE_CONTRACT_PROMPT)) return next
  if (next.includes(SANGUO_SAND_TABLE_WRITING_PROMPT)) return next
  if (!managedClause || next.split(managedClause).length !== 2) return next
  return next.replace(managedClause, () => managedClause + '\n' + SANGUO_SAND_TABLE_WRITING_PROMPT)
}
