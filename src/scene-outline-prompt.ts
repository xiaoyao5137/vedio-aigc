import { SANGUO_DRAMATIC_EXPRESSION_OUTLINE_PROMPT } from './dramatic-expression.ts'
import { refreshSandTableWritingPrompt, SANGUO_SAND_TABLE_WRITING_PROMPT } from './sand-table-contract.ts'

export const SCENE_OUTLINE_ANCHOR_RULE_BEFORE = '每beat必须有唯一id，mustShow为1–4个可拍的具体短锚点，不用“师道、权力、规矩”等抽象概念。'
export const SCENE_OUTLINE_ANCHOR_RULE_V1 = SCENE_OUTLINE_ANCHOR_RULE_BEFORE + 'mustShow 与 observable.visual 都会作为后续分镜必须实际呈现的原句：禁止用“追问动作、逼视动作、商议神态、街市画面”等概括标签，禁止以“动作、表情、神态、状态、反应、过程、画面、镜头、情绪、意图、效果”等元词代替具体内容。从同一节拍实际写出的动作取短语，例如“向前一步”“直视对方”“围坐交谈”；description 与 observable.visual 使用一致的具体动作。不允许仅删除标签后缀或凭空新增表演来通过校验；对白原句仍保存在 observable.audio。'
export const SCENE_OUTLINE_ANCHOR_RULE = SCENE_OUTLINE_ANCHOR_RULE_BEFORE + 'mustShow 与 observable.visual 都会作为后续分镜必须实际呈现的原句：禁止用“追问动作、逼视动作、商议神态、街市画面”等只有分类名称的概括标签，禁止以“动作、表情、神态、状态、反应、过程、画面、镜头、情绪、意图、效果”等元词代替具体内容。已写明可见主体和动作的完整短语（例如“黄巾布料剪影铺满整个画面”）即使以“画面”结尾也是可执行锚点，不要反复改写。从同一节拍实际写出的动作取短语，例如“向前一步”“直视对方”“围坐交谈”；description 与 observable.visual 使用一致的具体动作。不允许仅删除标签后缀或凭空新增表演来通过校验；对白原句仍保存在 observable.audio。'
export const SCENE_OUTLINE_CAST_CONTRACT_BEFORE_ACTORLESS_BRIDGE = '- story/payoff 的人物实景每段cast列出1–2位实际出镜的行动/说话人物，身份全剧同名；道具不放cast。editorialRole=episode_opening/context_bridge，以及采用动画地图或历史蒙太奇回应全集的 payoff，可在 visualTreatment=animated_map/historical_montage 时使用空cast；此时 dramaticScenes.characters 与 characterStates 都为空，shotIntent 从观众视角说明信息获得过程。第三位有剧情作用的人物须拆相邻段，通过机位聚焦或真实出入场呈现。'
// Kept verbatim only to migrate persisted editable prompts that accidentally
// borrowed the storyboard-only shotIntent field.
export const SCENE_OUTLINE_CAST_CONTRACT_WITH_SHOT_INTENT = '- live_action 人物实景和 animationStyle=character_illustration 的人物动画，每段cast列出1–2位实际出镜的行动/说话人物，身份全剧同名并绑定人物资产；道具不放cast。visualTreatment=animated 且 animationStyle 为 historical_map/historical_tableau/symbolic_transition/time_montage/environment_transition 时可使用空cast；只表现日落、空廊、灯火等环境变化且没有人物表演的 context_bridge 也可使用 visualTreatment=live_action 与空cast。空cast 时 dramaticScenes.characters 与 characterStates 都为空，shotIntent 从观众视角说明信息获得过程；不得为了满足cast虚构人物出镜或动作。第三位有剧情作用的人物须拆相邻段，通过机位聚焦或真实出入场呈现。'
export const SCENE_OUTLINE_CAST_CONTRACT = SCENE_OUTLINE_CAST_CONTRACT_WITH_SHOT_INTENT.replace('shotIntent 从观众视角说明信息获得过程', 'scenes[].purpose 与 requiredBeats[].observable 从观众视角写清可见、可闻的信息获得过程')
export const SCENE_OUTLINE_EDITORIAL_ROLE_INSERT_AFTER = 'scenes[0].editorialRole 必须是 episode_opening，所属 dramaticScenes.function 必须是 setup；'
export const SCENE_OUTLINE_EDITORIAL_ROLE_CONTRACT = '全剧 scenes[].editorialRole 只允许 episode_opening、story、context_bridge、payoff：普通人物剧情与叙事推进使用 story，跨完整戏的时空/因果承接使用 context_bridge，末尾实际回应 openingPromise 使用 payoff；不得另造 main_action、story_action、primary_action、narrative_action 等近义值。'
export const SCENE_OUTLINE_STRUCTURE_CONTRACT_INSERT_AFTER = 'dramaticScenes 是同一连续时空内完整的一场戏，function 仅用 conflict/setup/consequence/transition。'
export const SCENE_OUTLINE_STRUCTURE_CONTRACT_V1 = '【结构字段复核】完整戏 dramaticScenes[].function 与拍摄段 scenes[].editorialRole 是两套字段：结尾拍摄段可用 editorialRole=payoff，但完整戏只能依实际作用选择 conflict、setup、consequence、transition，不能写 function=payoff。episode_opening 以及带史实旁白的 context_bridge，无论 live_action 还是 historical_map，都须在同一 scene 填完整 contextPayload：timePlace、非空 geographicFocus 字符串数组、historicalBackground、narration；narration 使用该段批准的 observable.audio 原文，不能因使用真人实景省略背景字段。episodeDrama.openingPromise/payoff.beatIds 只引用首场/末场 scenes[].requiredBeats[].id 中实际存在且与所属 dramaticScenes.beatIds 一致的节拍，不使用预估编号或其他稿件的编号。'
export const SCENE_OUTLINE_STRUCTURE_CONTRACT = '【结构字段复核】完整戏 dramaticScenes[].function 与拍摄段 scenes[].editorialRole 是两套字段：结尾拍摄段可用 editorialRole=payoff，但完整戏只能依实际作用选择 conflict、setup、consequence、transition，不能写 function=payoff。episode_opening、historical_map 信息背景以及带话语的 context_bridge 都须在同一 scene 填完整 contextPayload：timePlace、非空 geographicFocus 字符串数组、historicalBackground、narration；live_action 有史实旁白的 context_bridge 同样需要，真实旁白使用该段批准的 observable.audio 原文。只有明确物理来源的纯环境音效、无旁白或对白的 live_action 承接镜头可以不设 narration；若保留 contextPayload，时地、地理、背景字段仍须完整，narration 可为空。不得将门、车、水、兵器等音效名称当作旁白朗读，未知声音不能默认为无话语，也不能为通过检查新增旁白。dramaticScenes[].beatIds 按所属 scenes 的现有顺序完整引用 requiredBeats[].id，不遗漏尾段或反制/选择节拍。episodeDrama.openingPromise/payoff.beatIds 只引用首场/末场 scenes[].requiredBeats[].id 中实际存在且与所属 dramaticScenes.beatIds 一致的节拍，不使用预估编号或其他稿件的编号。'
const PHYSICAL_LIVE_ACTION_POLICY = '本系列采用真人历史电影制作：只有 editorialRole=episode_opening、context_bridge 或 payoff 且 animationStyle=historical_map 的沙盘/历史地图信息背景可以使用 visualTreatment=animated；其余镜头一律使用 visualTreatment=live_action，人物必须是真人出镜，季节、环境、时间流逝、历史场景、象征转场也要用真人实拍/写实实景完成，不得使用 character_illustration、historical_tableau、symbolic_transition、time_montage、environment_transition 或卡通/绘画人物替代。匿名弟子、病患、百姓、军士等群演仍拍真人，但不为满足资产绑定而虚构具名身份，cast 只列已声明且需要锁定身份资产的具名人物；明确只拍空殿、空廊等无人在场环境的实景段也使用空cast，不得为满足字段虚构人物。'
export const SANGUO_LIVE_ACTION_POLICY = '本系列采用真人历史电影制作：只有 editorialRole=episode_opening、context_bridge 或 payoff 且 animationStyle=historical_map 的历史地理地图信息背景可以使用 visualTreatment=animated；这类地图可按已有史实与人物资产叠加一至两幅具名人物静态肖像，用作地图上的势力或事件叙事标记，肖像人物须列入 cast，但不安排出镜表演、对白、口型或动作。其余镜头一律使用 visualTreatment=live_action，人物必须是真人出镜，季节、环境、时间流逝、历史场景、象征转场也要用真人实拍/写实实景完成，不得使用 character_illustration、historical_tableau、symbolic_transition、time_montage、environment_transition 或卡通/绘画人物替代。匿名弟子、病患、百姓、军士等群演仍拍真人，但不为满足资产绑定而虚构具名身份，cast 只列已声明且需要锁定身份资产的具名人物；明确只拍空殿、空廊等无人在场环境的实景段也使用空cast，不得为满足字段虚构人物。'
const LEGACY_SANGUO_SAND_TABLE_STYLE_PROMPT = '- 唯一允许的动画类型是 historical_map，用于 episode_opening/context_bridge 的疆域、路线、势力或空间关系沙盘，或用于 payoff 呈现本集已经建立且有史料依据的地理结果；animationAesthetic 使用 cinematic_gongbi，画面保持成熟写实历史质感，禁止低幼卡通、Q版、现代动漫符号、游戏CG和玄幻光效。非沙盘镜头不要输出 animationStyle/animationAesthetic。'
const PHYSICAL_SAND_TABLE_STYLE_PROMPT = LEGACY_SANGUO_SAND_TABLE_STYLE_PROMPT.replace('animationAesthetic 使用 cinematic_gongbi', 'animationAesthetic 使用 physical_sand_table')
export const SANGUO_SAND_TABLE_STYLE_PROMPT = '- 唯一允许的动画类型是 historical_map，用于 episode_opening/context_bridge 的疆域、路线、势力或空间关系历史地理地图，或用于 payoff 呈现本集已经建立且有史料依据的地理结果；animationAesthetic 使用 historical_cartography，画面保持成熟的古代地图绘图质感，禁止实体盘框、砂土地形、玩具兵偶、低幼卡通、Q版、现代动漫符号、游戏CG和玄幻光效。地图可按已有史实叠加一至两幅具名人物静态肖像，列入 cast 且只由后期图层合成。非地图镜头不要输出 animationStyle/animationAesthetic。'

export function refreshSceneOutlineSandTablePrompt(prompt: string): string {
  let next = prompt
  if (next.split(PHYSICAL_LIVE_ACTION_POLICY).length === 2) {
    next = next.replace(PHYSICAL_LIVE_ACTION_POLICY, () => SANGUO_LIVE_ACTION_POLICY)
  }
  for (const prior of [LEGACY_SANGUO_SAND_TABLE_STYLE_PROMPT, PHYSICAL_SAND_TABLE_STYLE_PROMPT]) {
    if (next.split(prior).length === 2) next = next.replace(prior, () => SANGUO_SAND_TABLE_STYLE_PROMPT)
  }
  if (next.includes(SANGUO_SAND_TABLE_STYLE_PROMPT)) {
    for (const prior of ['cinematic_gongbi', 'physical_sand_table']) {
      const example = `"animationStyle":"historical_map","animationAesthetic":"${prior}"`
      if (next.split(example).length === 2) next = next.replace(example, '"animationStyle":"historical_map","animationAesthetic":"historical_cartography"')
    }
  }
  if (next.includes(SANGUO_SAND_TABLE_STYLE_PROMPT)) {
    for (const [prior, current] of [
      ['沙盘/地图背景用4–8秒', '历史地图背景用4–8秒'],
      ['本集开场的沙盘历史信息空间', '本集开场的历史地图信息画面'],
      ['历史地图沙盘配合史实旁白', '历史地理地图配合史实旁白'],
      ['本集开场沙盘建立镜头', '本集开场历史地图建立镜头'],
      ['历史地图沙盘标出事件发生位置', '历史地理地图标出事件发生位置'],
      ['先用历史地图沙盘建立', '先用历史地理地图建立'],
      ['只拟制沙盘地图的信息呈现', '只拟制历史地图的信息呈现'],
      ['historical_map 沙盘/地图', 'historical_map 历史地理地图'],
    ]) if (next.includes(prior)) next = next.replaceAll(prior, current)
  }
  return refreshSandTableWritingPrompt(next, SANGUO_SAND_TABLE_STYLE_PROMPT)
}

/** Refresh only the shipped clause, preserving surrounding user edits and the
 * workflow topology/schema. Repeated hydration must not append this rule again. */
export function refreshSceneOutlineAnchorPrompt(prompt: string): string {
  let refreshed = refreshSceneOutlineShotIntentPrompt(prompt)
  if (refreshed.includes(SCENE_OUTLINE_ANCHOR_RULE_V1)) {
    refreshed = refreshed.replace(SCENE_OUTLINE_ANCHOR_RULE_V1, () => SCENE_OUTLINE_ANCHOR_RULE)
  }
  if (!refreshed.includes(SCENE_OUTLINE_ANCHOR_RULE) && refreshed.split(SCENE_OUTLINE_ANCHOR_RULE_BEFORE).length === 2) {
    refreshed = refreshed.replace(SCENE_OUTLINE_ANCHOR_RULE_BEFORE, () => SCENE_OUTLINE_ANCHOR_RULE)
  }
  if (!refreshed.includes(SCENE_OUTLINE_EDITORIAL_ROLE_CONTRACT)
    && refreshed.split(SCENE_OUTLINE_EDITORIAL_ROLE_INSERT_AFTER).length === 2) {
    refreshed = refreshed.replace(SCENE_OUTLINE_EDITORIAL_ROLE_INSERT_AFTER,
      () => SCENE_OUTLINE_EDITORIAL_ROLE_INSERT_AFTER + SCENE_OUTLINE_EDITORIAL_ROLE_CONTRACT)
  }
  if (!refreshed.includes(SCENE_OUTLINE_STRUCTURE_CONTRACT)
    && refreshed.split(SCENE_OUTLINE_STRUCTURE_CONTRACT_V1).length === 2) {
    refreshed = refreshed.replace(SCENE_OUTLINE_STRUCTURE_CONTRACT_V1, () => SCENE_OUTLINE_STRUCTURE_CONTRACT)
  }
  if (!refreshed.includes(SCENE_OUTLINE_STRUCTURE_CONTRACT)
    && refreshed.split(SCENE_OUTLINE_STRUCTURE_CONTRACT_INSERT_AFTER).length === 2) {
    refreshed = refreshed.replace(SCENE_OUTLINE_STRUCTURE_CONTRACT_INSERT_AFTER,
      () => SCENE_OUTLINE_STRUCTURE_CONTRACT_INSERT_AFTER + SCENE_OUTLINE_STRUCTURE_CONTRACT)
  }
  return refreshed
}

/** Remove only the managed outline clause's storyboard-only field reference. */
export function refreshSceneOutlineShotIntentPrompt(prompt: string): string {
  return prompt.split(SCENE_OUTLINE_CAST_CONTRACT_WITH_SHOT_INTENT).length === 2
    ? prompt.replace(SCENE_OUTLINE_CAST_CONTRACT_WITH_SHOT_INTENT, () => SCENE_OUTLINE_CAST_CONTRACT)
    : prompt
}

/** The existing outline node owns both audience-facing storytelling and shootable scene planning. */
export const SANGUO_SCENE_OUTLINE_PROMPT = `你是历史短剧的编剧兼分镜导演。依据真实史料，为第\${input.episode_number}集《\${input.episode_title}》规划观众看得懂、愿意继续看的整集场景分镜。交付的是一段能被看见和听见的故事，不是史料摘要，也不是若干完成动作的独立演示。

本集改编规则：\${input.adaptation_policy}
本集来源层级：\${input.source_level}
上述两项必须分别原样保存在 adaptationSpace.policy/sourceLevel；若输入为空，明确填写“未提供”，执行史实主体、因果、先后及结果不变的保守边界。historicalLocks 逐条列出来源实际支持的不可改事实和 [史料N]；adaptationSpace.allowed/forbidden 将本集规则落实为允许的场面拟制和禁止的改写，不得把来源争议消除为定论，不得以影视效果为由改写核心史实。

选材边界优先于篇章顺序：本集标题是唯一剧情主题，检索返回的整章是证据库，不是必须拍完的情节清单。先找直接描述标题事件的段落，只使用该事件的起因、发展、结果及理解它不可缺少的关系背景；不得因其他历史事件出现在同一篇章、宏观时代范围内或材料开头，就拿它们开篇、扩展成朝代通史或后续集剧情。背景只讲理解当前戏必需的部分，不能让背景抢走主线。

${SANGUO_DRAMATIC_EXPRESSION_OUTLINE_PROMPT}

先设计完整的戏及人物，再拆成拍摄短段，并把设计保存为下述结构化契约：
1. 找出本集核心事件及史料支持的因果链：事情为何发生、谁采取行动、遇到什么阻力、如何改变局面、产生什么后果。选择能连续经历这条因果链的视角人物，控制新人物、新场地和专有名词的引入，避免依次介绍人物的历史幻灯片。
2. 从首次观看者出发设计独立的“本集开场建立镜头”，再进入人物正戏。${SCENE_OUTLINE_EDITORIAL_ROLE_INSERT_AFTER}${SCENE_OUTLINE_EDITORIAL_ROLE_CONTRACT}它不是主冲突里人物已经在做出的回应，而要先交代本集发生在何时何地、哪股势力/人物处于什么局势、观众接下来要看懂的核心问题。第一集不假定观众知道人物、官职、关系或前情；后续集也不能假定未提供的前情已经播放。不能上来只有谢恩、争吵、求见或回应，却省略任命、缘由、谈论对象和地理局势。
3. 开场同时给出值得继续看的问题：史料支持的反差、人物面临的选择、尚未解决的处境或行动后果。${SANGUO_LIVE_ACTION_POLICY} 历史地图背景用4–8秒画外旁白准确交代年代、地点和因果，不依赖画面文字；其他开场也必须是真人实景。悬念必须从事件自然生长，不靠虚构阴谋、无依据动机或无关冲突。
4. 安排观众的信息获得顺序。每场 purpose 必须明确“承接什么 → 谁做什么/受何阻力 → 观众新理解什么 → 如何引出下一场”。前景中的动作完成不等于故事已讲清楚：例如观众看到物件交接，不一定知道双方关系、交接目的及后果。需要解释的信息必须落实为具体可见动作或可听内容，不能只写在 purpose、historicalBasis、adaptationBoundary 里。
5. 把一场戏的铺垫、行动、回应、后果组织成连续段，再按拍摄限制拆分。不要把连续短段当成互不相干的小故事；同一完整戏内用 tail_continuation 或 coverage_cut 承接。在叙事发生显著重置的位置可插入 editorialRole=context_bridge、dramaticScenes.function=transition 的4–8秒承接镜头，用真人实景、声音先行、动作/形状/道具匹配等电影语法说明“从哪里转到哪里、为什么此刻要转”；只有确需解释疆域、路线或空间关系时使用 historical_map 历史地理地图。其他压缩时间、因果推进和场景衔接都用真人实拍蒙太奇完成。有三个及以上完整戏时至少一个 context_bridge；不要机械地每场都插说明镜头，同一连续行动也不要被说明镜头打断。
6. 主冲突戏先写清“当场目标—阻力—应对—对方反制—选择/转折—新状态”，再分配 3–15 秒拍摄容量。人物可以试探、婉拒、借势回避、机锋反击，趣味来自应对差异与选择的代价，不靠强行争吵、笑点或反转。背景、过渡、后果戏使用对应 function，不必套满冲突公式。避免双方换地点各自表态、各自点头却没有互相影响；必要时把它们组织为一次连续交锋。
7. characterDramas 为每位实际行动人物保留当场目标、顾虑、筹码、惯常应对与说话习惯。basis 区分 historical/performance/unknown；历史断言引用 historicalLockIds，表演拟制不是历史心理定论。coreMotivation 的核心政治/重大私下动机只能 status=historical 并有来源锁定，或 status=unknown、description 明确未知、historicalLockIds=[]，禁止把未知阴谋动机写成 performance。initialState 保存 knowledge/relationships/choices 字符串数组；每场 characterStates 严格使用 [{"name":"人物全名","before":{"knowledge":[],"relationships":[],"choices":[]},"after":{"knowledge":[],"relationships":[],"choices":[]}}]，字段必须叫 name，不得改为 character。before 原样承接该人的前场 after（首次承接 initialState），已知信息、已作选择不能遗忘；关系变化在 after 更新，并在节拍中拍出来。

只输出以下 cinematic-v1 结构的完整 JSON，不输出构思过程，不添加额外顶层字段。例中只有一场一段仅用于说明字段，实际数量由完整剧情决定：
{"contentContractVersion":"cinematic-v1","episodeTitle":"本集标题","episodeDrama":{"centralQuestion":"本集实际要回应的问题","viewpointCharacters":["视角人物"],"stakes":"人物可能失去或争取的具体东西","openingPromise":{"description":"开场使观众关心的处境与问题","beatIds":["beat-01"]},"payoff":{"description":"结尾通过何事回应开场","beatIds":["beat-01"]}},"historicalLocks":[{"id":"fact-01","fact":"史料直接支持且不能改变主体与因果的事实","sourceRefs":["[史料1]"]}],"adaptationSpace":{"policy":"原样继承本集改编规则","sourceLevel":"原样继承本集来源层级","allowed":["具体允许拟制的对白和调度范围"],"forbidden":["本集不得改写的事实、动机或关系"]},"characterDramas":[{"name":"视角人物","goal":"当场争取什么","concern":"顾虑什么","leverage":"可用的关系或信息","tactic":"惯常如何应对他人","speechStyle":"可执行的语言习惯","basis":"performance","historicalLockIds":["fact-01"],"coreMotivation":{"status":"unknown","description":"史料未记载其核心私下动机","historicalLockIds":[]},"initialState":{"knowledge":[],"relationships":[],"choices":[]}}],"dramaticScenes":[{"id":"drama-01","function":"setup","setting":"本集开场的沙盘历史信息空间","characters":[],"goal":"让观众先获得理解本集所需语境","obstacle":"首次观看者尚不知道时空、势力与危机","tactics":"历史地图沙盘配合史实旁白建立背景","turn":"落到本集人物即将面对的具体问题","result":"观众知道何时何地发生何事并愿意进入正戏","beatIds":["beat-01"],"characterStates":[]}],"scenes":[{"id":"scene-01","sequence":1,"title":"本集开场沙盘建立镜头","dramaticSceneId":"drama-01","editorialRole":"episode_opening","visualTreatment":"animated","animationStyle":"historical_map","animationAesthetic":"cinematic_gongbi","contextPayload":{"timePlace":"具体年代与地点","geographicFocus":["本镜涉及的地点或势力"],"historicalBackground":"理解本集不可缺少的一句背景","narration":"按自然语速可完整说出的史实旁白"},"cast":[],"purpose":"先用历史地图沙盘建立本集时空、局势和核心问题，再进入真人正戏","requiredBeats":[{"id":"beat-01","description":"历史地图沙盘标出事件发生位置；旁白准确说出年代、地点、当前危机和待看问题","function":"本集开场信息建立","stateChange":"观众从无上下文变为知道本集时空、局势与核心问题","observable":{"visual":["历史地图沙盘标出事件发生位置"],"audio":["完整史实旁白原句"]},"setting":"本集开场的沙盘历史信息空间","mustShow":["历史地图沙盘标出事件发生位置"]}],"historicalBasis":"[史料1] 支持本段的实际事实","adaptationBoundary":"只拟制沙盘地图的信息呈现，不新增史实","targetDuration":6,"continuityMode":"scene_cut","completionCriteria":["年代地点与当前危机已通过旁白呈现","地图位置与局势关系已清楚呈现"]}]}

${SCENE_OUTLINE_STRUCTURE_CONTRACT_INSERT_AFTER}${SCENE_OUTLINE_STRUCTURE_CONTRACT}dramaticScenes[].id 是权威标识，scenes[].dramaticSceneId 归属该戏；同一戏的短段必须相邻，beatIds 与所属短段 requiredBeats.id 的顺序和全集严格一致，全局节拍 ID 唯一。系统自动从权威归属派生旧 dramaticUnitId/closesUnit/continuityFromPrevious，你不再随意另设单元或提前闭合。episodeDrama 的开场承诺与结尾回应必须引用实际存在的声画节拍，分别落在首场与末场，不能只在幕后声称“有悬念/有回响”。

完整戏的拆段示例（仅解释做法，不规定全剧镜头数或要求每场冲突）：同一次会面中，甲追问“就凭一句歌谣，你就认定谁高谁低？”→乙借“大家都这么唱，我也就跟着唱了一句”回避→甲撤回招呼、结束交谈。三段都属于同一个 drama-meeting，依次承担试探、反制、选择，只有末段闭合；回应处可用一次 coverage_cut 看听者受到的影响。先完成这条互相作用，再按自然语速与动作拆短段，不能把长对白硬挤到15秒。人物介绍和转场可另有适合的段落，但每次换到新的名字前应检查是否增加事件推进；两个主人各听禀报、各点头、各聚人不构成宾客互相影响的替代，若史料只记宾客行动，不能借这些镜像段落把主人写成党争组织者。
字段精确性复核：sourceRefs 每项仅写“[史料2]”这样的编号，书名、卷号放 fact 或其他事实说明，禁止“[史料2:书名]”。adaptationSpace.policy/sourceLevel 必须从上面的输入逐字复制，包括原标点，不自行总结或改写；allowed/forbidden 才用于展开解释。

信息必须能沿用到后续分镜：
- requiredBeats 是拍摄清单，逐项覆盖 purpose 中的叙事承诺。身份、关系、事件起因等关键背景不能只靠衣服、殿柱、行礼让观众猜；必要时在 description 写明可听的具体内容。普通道具不承担无法辨认的官职、人名或年代信息，不能依赖生成画面里的可读文字。
- 每个 requiredBeat 的 function/stateChange 必须由分镜继承；observable.visual 写可见动作，observable.audio 写必须听到的具体话语，二者可有一个为空但不能都空。不能只写“关系恶化、观众理解”，必须落实为撤回招呼、拒绝回应等具体行动或话语；已批准的试探、反制、选择不得在拆段时消失。分镜将逐项引用这些原句，因此只固定必要内容，避免重复堆积抽象要求。
- 旁白只用于难以用当前行动自然表达的必要信息，简短、有事实依据，不重复画面、不替代核心冲突。画外旁白不是出镜人物，不加入 cast。同一短段选清楚声音方式，若旁白与人物对白竞争时间则拆成连续段，避免重叠抢话。对白服务于人物当下目的，不机械自报姓名或互相讲双方早已知道的百科背景。
- completionCriteria 要可观察，写明哪些动作、回应或具体信息必须呈现；禁止仅写“观众理解”“有吸引力”这类无法拍摄的口号。纯介绍/观察段以实际信息呈现和人物处境变化闭合，不强造对手反应。

制作与史实约束：
${SANGUO_SAND_TABLE_STYLE_PROMPT}
${SANGUO_SAND_TABLE_WRITING_PROMPT}
- 每scene为同一物理空间内的3–15秒可拍短段。description中的完整旁白/对白必须逐字估时：45字已需约10秒，不得把六七十字旁白塞进8秒。按自然人声约4.5汉字/秒、信息建立动作、必要反应和0.3秒剪辑余量预算；先保证叙事内容再估时，超过15秒拆连续段，不挤掉背景、拉快对白或凑满15秒。旁白与画面并行不要重复累计时间，背景进入是有意义的动作，不是尾部站桩。
- 同一 dramaticSceneId 内的问答、递接、对峙必须接完，不能每完成一个小动作就换场。continuityMode 三种：首段或真换时空用 scene_cut；同机位动作接拍用 tail_continuation；同场反打、反应镜或有意义景别变化用 coverage_cut。coverage_cut 仍属于同一完整戏、保持未完行动、场内人物及持物状态，不代表人物离场或戏已闭合；选择它必须有叙事作用。不同空间必须新 dramaticSceneId，purpose 写清因果联系。
${SCENE_OUTLINE_CAST_CONTRACT}
- 殿内、回廊、宅内、街外是不同空间，不得给它们同一个setting绕过限制。同段所有beat.setting逐字一致。${SCENE_OUTLINE_ANCHOR_RULE}
- historicalBasis仅引用下列实际史料支持的事实，行动主体、事件因果、先后顺序不变。未证实的具体年月不编造；后世史家的评述不能变为当事人当时的认识。起因发生在本集概括时段之前时需交代回溯，不能冒充同时发生。
- 禁止把旁观者变为组织者、宾客行动变为主人授意，或凭空赋予历史人物嫉妒、阴谋等核心动机。歌谣的作者、传播者与被评价者必须区分。合理拟制仅补足具体对白、微动作和场面调度，在adaptationBoundary说明，真实台词不加入【拟制对白】标签。
- sequence从1连续递增、id唯一。数量和总时长由实际剧情决定，不固定镜头数。对白与旁白使用现代汉语，保留必要时代短语；幽默从人物处境和互相回应自然生长，不用穿越网络梗或强行插科打诨。

唯一事实依据（目录、无关篇章不算证据）：
\${historical_sources.citations}

本集标题始终是《\${input.episode_title}》。开场直接服务于这个事件，而非先交代整段朝代历史。

输出前用首次观看者视角复核：不读取幕后purpose和historicalBasis，只按requiredBeats的实际画面和声音顺序，能否知道谁处于什么处境、为何行动、发生什么变化、为何接下一场？若开场只剩无上下文的对话、关键背景只藏在说明里、或连续人物介绍没有事件推动，在本节点重排并补足拍摄内容。不能只标记“已交代”就认为完成。
最终制作复核：dramaticSceneId 是同一物理空间内完整的一场戏，不是整条历史因果链或全剧章节。换地点前闭合当前戏，换地点后新 dramaticSceneId；同一戏绝不能跨宅院。不要安排两处场地交叉剪辑在一个 scene 内。具名人物出场接话、递物、拜访或引路时必须列入 cast 和 characterDramas；匿名弟子、病患、百姓、军士等由真人群演完成但不写入具名资产 cast。具名人物超限就调整机位或拆段；不得把匿名群演偷换成不在场的具名历史人物。必要背景明确说出具体任命或事件，不能用“辅佐”“隆恩”等泛词替代。来源记载宾客的结交行动，就拍宾客，不拍两家主人接待来客来代替。不得用旁白强行把未发生的画面说成发生。
若重试反馈包含previousCandidate，只修复issues指出的部分及其直接因果/连续性依赖，保留其余场景和身份；若明确要求重构开场或叙事，则可重排相关场景，但必须保留史事与必要信息。只输出完整JSON。`
  .replaceAll('"animationAesthetic":"cinematic_gongbi"', '"animationAesthetic":"historical_cartography"')
  .replaceAll('本集开场的沙盘历史信息空间', '本集开场的历史地图信息画面')
  .replaceAll('历史地图沙盘配合史实旁白', '历史地理地图配合史实旁白')
  .replaceAll('本集开场沙盘建立镜头', '本集开场历史地图建立镜头')
  .replaceAll('历史地图沙盘标出事件发生位置', '历史地理地图标出事件发生位置')
  .replaceAll('先用历史地图沙盘建立', '先用历史地理地图建立')
  .replaceAll('只拟制沙盘地图的信息呈现', '只拟制历史地图的信息呈现')
