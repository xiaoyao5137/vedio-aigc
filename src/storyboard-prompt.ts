import { SANGUO_STORYBOARD_PROMPT_BEFORE_AUDIO_LINE_BINDING } from './legacy-storyboard-audio-prompt.ts'
import { ANIMATION_STYLE_PROMPT } from './animation-shot.ts'
import { SANGUO_DRAMATIC_EXPRESSION_STORYBOARD_PROMPT } from './dramatic-expression.ts'
import { refreshSandTableWritingPrompt, SANGUO_SAND_TABLE_WRITING_PROMPT } from './sand-table-contract.ts'
export { SANGUO_STORYBOARD_PROMPT_BEFORE_AUDIO_LINE_BINDING } from './legacy-storyboard-audio-prompt.ts'

/** Exact clauses identify managed writer text without replacing custom surroundings. */
export const STORYBOARD_AUDIO_COVERAGE_BEFORE_LINE_BINDING = `- coveredBeatIds完整有序覆盖scene.requiredBeats；beatDramaturgy逐项继承function与stateChange。大纲每个 observable.visual/audio 锚点和每个 mustShow 短锚点都必须原样承接，不得用同义或更具体的词替换锚点里的字（只可在锚点前后补充细节）：beatDramaturgy.visual/audio 至少各有一条逐项包含对应 observable 锚点的连续原文；同一锚点短语还必须作为连续子串原样写进 visualPrompt/videoPrompt（visual 与 mustShow）或 audioText（audio）的对应时间段/语句正文里，让角色在画面内真正做出该动作、说出该台词。不能把义务只写在说明、引用、镜头标题或末帧中，也不能只在 beatDramaturgy 声明却不实拍。不够15秒要连续拆段，不能删剧情或用提及人物代替出场。`
export const STORYBOARD_AUDIO_COVERAGE_LINE_BINDING = `- coveredBeatIds完整有序覆盖scene.requiredBeats；beatDramaturgy逐项继承function与stateChange。大纲每个 observable.visual/audio 锚点和每个 mustShow 短锚点都必须原样承接，不得用同义或更具体的词替换锚点里的字（只可在锚点前后补充细节）：beatDramaturgy.visual/audio 逐项保留对应 observable 锚点的连续完整原文，audio每条完整原义务至少有一项完整声明，不因台词拆行而拆散原锚点声明。visual 与 mustShow 锚点还须作为连续子串原样写进 visualPrompt/videoPrompt 的对应时间段。audioText中同一角色的原台词可在自然停顿处分行；除各行说话人标签与换行外，正文按序连接必须完整保留原台词，不改字序或说话归属，每行在videoPrompt独立时间段逐字绑定。让角色在画面内真正做出原动作、说出完整台词；不能把义务只写在说明、引用、镜头标题或末帧中，也不能只在 beatDramaturgy 声明却不实拍。不够15秒要连续拆段，不能删剧情或用提及人物代替出场。`
export const STORYBOARD_DIALOGUE_BEFORE_LINE_BINDING = `- 一句对白至多6秒；每行“汉字全名：完整台词”，在独立时间段内逐字写“全名开口说出：台词”。同区间只一个说话人，不加无声口型，不把道具放嘴前。旁白用audioType=旁白，人物不作说话口型。旁白/对白不可竞争同一时间，不足则拆段。`
export const STORYBOARD_DIALOGUE_LINE_BINDING = `- 每行对白至多6秒；较长原台词按自然停顿拆为同角色多行，每行“汉字全名：该行完整台词”，在独立时间段内逐字写“全名开口说出：该行台词”。分行正文按序连接保留完整原台词，beatDramaturgy.audio仍逐项保留完整原义务，不要求整条长锚点挤入一个6秒区间；拆行后重新计算换行停顿与总时长。同区间只一个说话人，不加无声口型，不把道具放嘴前。旁白用audioType=旁白，人物不作说话口型。旁白/对白不可竞争同一时间，不足则拆段。`

const EDITORIAL_STORYBOARD_FIELDS_BEFORE = '"contentContractVersion":"cinematic-v1","dramaticSceneId":"scene.dramaticSceneId","id":"当前scene.id","title":"镜头标题","duration":8,'
const EDITORIAL_STORYBOARD_FIELDS_SCHEMA120 = '"contentContractVersion":"cinematic-v1","dramaticSceneId":"scene.dramaticSceneId","id":"当前scene.id","title":"镜头标题","editorialRole":"原样继承scene.editorialRole","visualTreatment":"原样继承scene.visualTreatment","duration":8,'
const PRIOR_EDITORIAL_STORYBOARD_FIELDS = '"contentContractVersion":"cinematic-v1","dramaticSceneId":"scene.dramaticSceneId","id":"当前scene.id","title":"镜头标题","editorialRole":"原样继承scene.editorialRole","visualTreatment":"原样继承scene.visualTreatment","animationStyle":"animated时原样继承scene.animationStyle","animationAesthetic":"animated时原样继承scene.animationAesthetic","duration":8,'
const EDITORIAL_STORYBOARD_FIELDS = PRIOR_EDITORIAL_STORYBOARD_FIELDS.replace('"duration":8,', '"mapAnnotations":{"version":"historical-map-annotations-v1","orientation":"north-up","sourceRefs":["本镜已批准史料编号"],"labels":[],"routes":[]},"duration":8,')
const EDITORIAL_CHARACTER_LIST_FIELDS = ' "initialCharacters":["首帧可见人物"],"enteringCharacters":[],"endCharacters":["尾帧可见人物"],'
const PHYSICAL_ILLUSTRATION_LAYER_FIELD = ' "illustrationLayers":[{"characterName":"仅character_illustration填写且必须对应人物资产","x":0.7,"y":0.52,"scale":0.24,"enterStart":0.2,"enterDuration":0.6,"enterFromX":0.76,"enterFromY":0.54,"exitStart":7.3,"exitDuration":0.5}],'
const EDITORIAL_ILLUSTRATION_LAYER_FIELD = ' "illustrationLayers":[{"characterName":"character_illustration或historical_map静态肖像填写，须对应具名人物资产","x":0.7,"y":0.52,"scale":0.24,"enterStart":0.2,"enterDuration":0.6,"enterFromX":0.76,"enterFromY":0.54,"exitStart":7.3,"exitDuration":0.5}],'
const EDITORIAL_CHARACTER_ENTRY_RULE_BEFORE_LAYER_LAYOUT = '- initialCharacters与enteringCharacters.name合计恰好为characters，无重复。真正入画者使用{name,startSecond,endSecond,path}并在对应区间写全名从path连续走入，进入完成后才说话；已经同场但先前位于画外的人因反打显现，不是假定走入场地。'
const EDITORIAL_CHARACTER_ENTRY_RULE = '- live_action 中 initialCharacters 与 enteringCharacters.name 合计恰好为 characters，无重复。character_illustration 以及 historical_map 地图上的静态肖像由 illustrationLayers 的 characterName 绑定人物资产；图层淡入不是人物走入地图，勿列为真人 enteringCharacters。地图底片不画人物，肖像只在后期叠加。真正真人入画者才使用{name,startSecond,endSecond,path}并在对应区间写全名从path连续走入，进入完成后才说话；已经同场但先前位于画外的人因反打显现，不是假定走入场地。'
const PHYSICAL_CHARACTER_ENTRY_RULE = '- live_action 中 initialCharacters 与 enteringCharacters.name 合计恰好为 characters，无重复。character_illustration 中由 illustrationLayers 的 characterName 与未使用图层入场的 initialCharacters 共同覆盖 characters，不要再把图层淡入重复写成真人 enteringCharacters 走入路径。真正真人入画者才使用{name,startSecond,endSecond,path}并在对应区间写全名从path连续走入，进入完成后才说话；已经同场但先前位于画外的人因反打显现，不是假定走入场地。'
const EDITORIAL_STORYBOARD_RULE_BEFORE_LAYER_LAYOUT = '- editorialRole、visualTreatment 以及 animated 模式的 animationStyle/animationAesthetic 必须逐字继承当前scene。动画镜头可用于片头、片中、payoff及任意场间衔接，但必须完成本段声画义务，不得只是装饰。character_illustration 和 historical_tableau 使用二维插画口播：audioType=旁白，人物插画内部的姿态、表情、嘴部和衣物从头到尾不变，不承载人物动作、对白或口型表演；允许整个人物插画图层淡入、平移、缩放、淡出并放在合适的历史背景上，historical_tableau 允许整幅定格画面轻微二维移动或渐变；背景事实由画外旁白讲清。其他无人物动画可使用空人物数组，shotIntent.viewpointCharacter固定为“观众”。地名年代必须由旁白清楚说出，不依赖生成画面中的可读文字。'
const PRIOR_EDITORIAL_STORYBOARD_RULE = '- editorialRole、visualTreatment 以及 animated 模式的 animationStyle/animationAesthetic 必须逐字继承当前scene。三国动画仅用于 episode_opening/context_bridge/payoff 的 historical_map 历史地理地图；其余人物剧情为真人实景。地图只表现有来源的地理、势力和路线；可按 scene.cast 在后期叠加一至两幅静态具名人物肖像，shot.characters/presentCharacters/illustrationLayers 与资产姓名一致。肖像人物不表演、不说话、不动嘴，audioType=旁白。地图 visualPrompt/videoPrompt/lastFramePrompt 及首尾底图只写地图本身，不写肖像姓名、肖像动作或绘制指令；不要把肖像图层列为 requiredBeats 的史实动作锚点。人物位置、尺寸、淡入和淡出只在 illustrationLayers 中编排，x/y/enterFromX/enterFromY 是0–1画幅归一化中心坐标，scale是人物层占画幅宽度比例0.1–0.46，所有时间在本镜duration内。没有肖像时 illustrationLayers=[]，shotIntent.viewpointCharacter=“观众”。character_illustration 和 historical_tableau 的旧记录继续按原二维静态插画规则读取，前者人物图层内部静止，后者整幅画定格。地名年代由旁白清楚说出；必要的已核对地图短标记可以存在，但不生成字幕或依赖可读文字理解剧情。'
const EDITORIAL_STORYBOARD_RULE = PRIOR_EDITORIAL_STORYBOARD_RULE
  .replace('地图只表现有来源的地理、势力和路线', '地图底片只表现有来源的山川、道路、城址和边界；地名、势力标记、路线与箭头另写入 mapAnnotations 并待独立审核批准')
  .replace('地图 visualPrompt/videoPrompt/lastFramePrompt 及首尾底图只写地图本身，不写肖像姓名、肖像动作或绘制指令', '地图 visualPrompt/videoPrompt/lastFramePrompt 及首尾底图只写无字、无箭头、无人物的地图本身，不写图层文字、路线、肖像姓名、肖像动作或绘制指令')
  .replace('必要的已核对地图短标记可以存在，但不生成字幕或依赖可读文字理解剧情', '必要的已核对地图短标记只从 mapAnnotations 本地叠加，图像和视频模型不生成文字、箭头、字幕或依赖可读文字理解剧情')
const PHYSICAL_EDITORIAL_STORYBOARD_RULE = '- editorialRole、visualTreatment 以及 animated 模式的 animationStyle/animationAesthetic 必须逐字继承当前scene。动画镜头可用于片头、片中、payoff及任意场间衔接，但必须完成本段声画义务，不得只是装饰。character_illustration 和 historical_tableau 使用二维插画口播：audioType=旁白，人物插画内部的姿态、表情、嘴部和衣物从头到尾不变，不承载人物动作、对白或口型表演；允许整个人物插画图层淡入、平移、缩放、淡出并放在合适的历史背景上，historical_tableau 允许整幅定格画面轻微二维移动或渐变；背景事实由画外旁白讲清。character_illustration 必须为每个 characters 人物输出唯一 illustrationLayers 项，x/y/enterFromX/enterFromY 是0–1画幅归一化中心坐标，scale是人物层占画幅宽度比例0.1–0.46，所有进退场时间必须落在本镜duration内；位置、大小和时序按叙事关系设计，不按人数机械排队。其他动画的 illustrationLayers=[]。其他无人物动画可使用空人物数组，shotIntent.viewpointCharacter固定为“观众”。地名年代必须由旁白清楚说出，不依赖生成画面中的可读文字。'
const EDITORIAL_STORYBOARD_VISUAL_BEFORE = '画面：全部${input.aspect_ratio}，真人实景、自然光、东汉服化道，无现代物件、字幕、水印或可读文字。人物资产只锁定脸部/体型/服饰，不继承三视图纯色背景。首尾帧各为单一时刻的全画幅，不得拼贴、分栏或重复人物。'
const EDITORIAL_STORYBOARD_VISUAL_SCHEMA120 = '画面：全部${input.aspect_ratio}。visualTreatment=live_action 时使用真人实景、自然光、东汉服化道；animated_map 时使用写实古地图/沙盘质感与清晰区域高亮；historical_montage 时使用统一写实史料绘卷质感，禁止卡通人物和游戏CG。所有模式均无现代物件、水印或依赖可读文字才能理解的关键信息，人物资产只锁定脸部/体型/服饰，不继承三视图纯色背景。首尾帧各为单一时刻的全画幅，不得拼贴、分栏或重复人物。'
const PRIOR_EDITORIAL_STORYBOARD_VISUAL = '画面：全部${input.aspect_ratio}。visualTreatment=live_action 时使用真人实景、自然光、东汉服化道；三国 historical_map 使用全画幅古代历史地理地图，山川、河流、道路、城址与区域关系可辨，二维设色和路线按史料变化，不出现盘框、砂土、模型城堡或玩具兵偶。静态具名人物肖像只由后期按 illustrationLayers 覆盖在地图上，生成首尾帧及地图视频底片时不画人物、不烘焙人像。character_illustration 的旧记录仍以不含人物的背景底板承载独立人物图层；historical_tableau 画中人物定格。地图肖像内部不走路、转身、说话、改口型、视线、衣物或肢体姿态。旧 animated_map 仍按 historical_map 地图动态表现。所有模式均无现代物件、字幕、标题、水印或依赖可读文字才能理解的关键信息。'
const EDITORIAL_STORYBOARD_VISUAL = PRIOR_EDITORIAL_STORYBOARD_VISUAL
  .replace('二维设色和路线按史料变化', '二维地理底色按史料变化，文字与路线只在批准的 mapAnnotations 图层变化')
  .replace('生成首尾帧及地图视频底片时不画人物、不烘焙人像', '生成首尾帧及地图视频底片时不画人物、不烘焙人像、文字、标注、路线线条或箭头')
const PHYSICAL_EDITORIAL_STORYBOARD_VISUAL = '画面：全部${input.aspect_ratio}。visualTreatment=live_action 时使用真人实景、自然光、东汉服化道；visualTreatment=animated 时严格执行 animationStyle 与 animationAesthetic，允许考据准确的人物插画但禁止低幼卡通、Q版、现代动漫符号和游戏CG。character_illustration 的 visualPrompt 写不含人物的历史背景底板，videoPrompt 各时间段明确“人物插画内部保持静止”，只编排整个人物图层的淡入、平移、缩放、停留或淡出；人物图层可大可小并按叙事关系放置。historical_tableau 的画中人物保持定格，仅允许整幅画轻微二维移动或渐变。camera=固定机位；不得写人物走路、转身、说话、口型、视线变化、衣物飘动或肢体动作。旧 animated_map 仍按历史地图动态表现。所有模式均无现代物件、水印或依赖可读文字才能理解的关键信息。'

export function refreshStoryboardSandTablePrompt(prompt: string): string {
  let next = prompt
  for (const [prior, current] of [
    [PHYSICAL_EDITORIAL_STORYBOARD_RULE, EDITORIAL_STORYBOARD_RULE],
    [PRIOR_EDITORIAL_STORYBOARD_RULE, EDITORIAL_STORYBOARD_RULE],
    [PHYSICAL_EDITORIAL_STORYBOARD_VISUAL, EDITORIAL_STORYBOARD_VISUAL],
    [PRIOR_EDITORIAL_STORYBOARD_VISUAL, EDITORIAL_STORYBOARD_VISUAL],
    [PRIOR_EDITORIAL_STORYBOARD_FIELDS, EDITORIAL_STORYBOARD_FIELDS],
    [PHYSICAL_CHARACTER_ENTRY_RULE, EDITORIAL_CHARACTER_ENTRY_RULE],
    [PHYSICAL_ILLUSTRATION_LAYER_FIELD, EDITORIAL_ILLUSTRATION_LAYER_FIELD],
    ['"visualPrompt":"开场静态实景、可见人物汉字全名、稳定外观、构图和持物"', '"visualPrompt":"真人镜写开场实景与可见人物；历史地图镜只写无字、无箭头、无人物的地理底板"'],
    ['"visualPrompt":"真人镜写开场实景与可见人物；历史地图镜只写无人物的地理底板、区域和路线"', '"visualPrompt":"真人镜写开场实景与可见人物；历史地图镜只写无字、无箭头、无人物的地理底板"'],
    ['"lastFramePrompt":"单一时间点的末帧实际预期：可见人物全名、最终站位持物"', '"lastFramePrompt":"真人镜写人物末帧；历史地图镜只写无字、无箭头、无人物的地理底板结果"'],
    ['"lastFramePrompt":"真人镜写人物末帧；历史地图镜只写无人物地图的区域与路线结果"', '"lastFramePrompt":"真人镜写人物末帧；历史地图镜只写无字、无箭头、无人物的地理底板结果"'],
  ]) if (next.split(prior).length === 2) next = next.replace(prior, () => current)
  return refreshSandTableWritingPrompt(next, EDITORIAL_STORYBOARD_RULE)
}

/** Refresh the editorial grammar inside either dynamic-v1 or duration-v2 managed prompts. */
export function refreshStoryboardEditorialPrompt(prompt: string): string {
  let next = prompt.replace(PRIOR_EDITORIAL_STORYBOARD_FIELDS, EDITORIAL_STORYBOARD_FIELDS)
    .replace(EDITORIAL_STORYBOARD_FIELDS_BEFORE, EDITORIAL_STORYBOARD_FIELDS)
    .replace(EDITORIAL_STORYBOARD_FIELDS_SCHEMA120, EDITORIAL_STORYBOARD_FIELDS)
    .replace(EDITORIAL_STORYBOARD_RULE_BEFORE_LAYER_LAYOUT, EDITORIAL_STORYBOARD_RULE)
    .replace(PRIOR_EDITORIAL_STORYBOARD_RULE, EDITORIAL_STORYBOARD_RULE)
  if (!next.includes('"illustrationLayers"')) next = next.replace(EDITORIAL_CHARACTER_LIST_FIELDS,
    `${EDITORIAL_CHARACTER_LIST_FIELDS}\n${EDITORIAL_ILLUSTRATION_LAYER_FIELD}`)
  if (!next.includes(EDITORIAL_STORYBOARD_RULE)) {
    const priorRule = /^- editorialRole 与 visualTreatment 必须逐字继承当前scene。.*$/m
    next = priorRule.test(next)
      ? next.replace(priorRule, EDITORIAL_STORYBOARD_RULE)
      : next.replace('- 本镜属于完整戏scene.dramaticUnitId。', `${EDITORIAL_STORYBOARD_RULE}\n- 本镜属于完整戏scene.dramaticUnitId。`)
  }
  if (!next.includes(ANIMATION_STYLE_PROMPT)) next = next.replace(`${EDITORIAL_STORYBOARD_RULE}\n`, `${EDITORIAL_STORYBOARD_RULE}\n${ANIMATION_STYLE_PROMPT}\n`)
  next = next.replace(EDITORIAL_STORYBOARD_VISUAL_BEFORE, EDITORIAL_STORYBOARD_VISUAL)
    .replace(EDITORIAL_STORYBOARD_VISUAL_SCHEMA120, EDITORIAL_STORYBOARD_VISUAL)
    .replace(PRIOR_EDITORIAL_STORYBOARD_VISUAL, EDITORIAL_STORYBOARD_VISUAL)
    .replace(EDITORIAL_CHARACTER_ENTRY_RULE_BEFORE_LAYER_LAYOUT, EDITORIAL_CHARACTER_ENTRY_RULE)
  return next
}

/** The shot writer consumes approved dramaturgy; it does not invent a new episode. */
export const SANGUO_CINEMATIC_STORYBOARD_PROMPT = `你是写实历史短剧的分镜导演。为《\${input.episode_title}》当前拍摄短段写一个可执行的中文分镜。先阅读已批准的整场戏与人物状态，只拍分配给本段的动作、对白和关系变化，不重演前镜已经完成的事。

${SANGUO_DRAMATIC_EXPRESSION_STORYBOARD_PROMPT}

${SANGUO_SAND_TABLE_WRITING_PROMPT}

本集改编边界：\${input.adaptation_policy}
史料层级：\${input.source_level}
本镜创作职责及人物状态：\${dramaContext}
上述人物诉求、策略属于有边界的表演设计，不可升格为史载核心动机。对白要完成试探、争取、婉拒、反制、招揽等具体行动。人物对对方的行动作出应对，镜头突出这次应对改变了什么。必要背景可以用简短旁白，不让人物互讲双方已知的百科信息，不为每段强造争吵、反转或笑点。

只输出完整JSON，使用以下字段，不输出分析过程：
{
 "contentContractVersion":"cinematic-v1","dramaticSceneId":"scene.dramaticSceneId","id":"当前scene.id","title":"镜头标题","editorialRole":"原样继承scene.editorialRole","visualTreatment":"原样继承scene.visualTreatment","animationStyle":"animated时原样继承scene.animationStyle","animationAesthetic":"animated时原样继承scene.animationAesthetic","mapAnnotations":{"version":"historical-map-annotations-v1","orientation":"north-up","sourceRefs":["本镜已批准史料编号"],"labels":[],"routes":[]},"duration":8,
 "pacing":{"version":"dynamic-v1","actionSeconds":1,"reactionSeconds":0.7},
 "shotIntent":{"viewpointCharacter":"本镜关注人物；无人编辑镜头固定为观众","purpose":"承接哪项具体行动或信息变化","cameraReason":"为什么此时采用这一景别和机位"},
 "beatDramaturgy":[{"beatId":"本段节拍id","function":"原节拍function","stateChange":"原节拍stateChange","visual":["实际画面动作短语"],"audio":["实际对白内容或为空数组"]}],
 "storyProgress":{"unitId":"scene.dramaticUnitId","status":"complete或continuing","actionResult":"本镜动作结果","response":"本镜实际回应或信息呈现","pendingActions":[]},
 "characters":["本段可见或行动人物全名"],"presentCharacters":["本场仍在场人物，包含画外人物"],
 "initialCharacters":["首帧可见人物"],"enteringCharacters":[],"endCharacters":["尾帧可见人物"],
 "illustrationLayers":[{"characterName":"character_illustration或historical_map静态肖像填写，须对应具名人物资产","x":0.7,"y":0.52,"scale":0.24,"enterStart":0.2,"enterDuration":0.6,"enterFromX":0.76,"enterFromY":0.54,"exitStart":7.3,"exitDuration":0.5}],
 "worldState":{"settingId":"scene.settingId","characters":[{"name":"每个在场人物","position":{"status":"unknown"},"heldProps":{"status":"unknown"},"pendingAction":{"status":"unknown"}}]},
 "continuity":{"mode":"scene_cut","previousShotId":"第一镜为空，否则上镜id","bridgeType":"opening","bridgeAnchor":""},
 "coveredBeatIds":["本段全部requiredBeats.id"],
 "visualPrompt":"真人镜写开场实景与可见人物；历史地图镜只写无字、无箭头、无人物的地理底板","camera":"机位、景别、视线轴线与运镜","mood":"符合本场力度与变化的具体情绪",
 "firstFrameMode":"reference","lastFramePrompt":"真人镜写人物末帧；历史地图镜只写无字、无箭头、无人物的地理底板结果",
 "videoPrompt":"3–6个从0连续覆盖到duration的时间区间：主动作、完整台词、必要回应和有意义的变化，最多650字符",
 "audioType":"对白","audioText":"角色全名：完整台词",
 "historicalBasis":"沿用[史料N]事实依据","adaptationBoundary":"本镜对白动作的拟制范围，不改变主体因果"
}

剧情与覆盖：
${STORYBOARD_AUDIO_COVERAGE_LINE_BINDING}
${EDITORIAL_STORYBOARD_RULE}
${ANIMATION_STYLE_PROMPT}
- 本镜属于完整戏scene.dramaticUnitId。closesUnit=false时continuing，列明后段待完成事项；true时complete且pendingActions为空。每段完成自己的completionCriteria；不要求本段提前演完分配给后段的反制。普通礼貌点头不能替代核心答复。介绍段以具体信息呈现和处境变化完成，不强造对手。
- 人物仅使用已批准身份和表演设计；未知人物核心动机仍未知。史料未写普通对白不等于禁止拟制，拟制也不能替换史载行动主体、因果、年代或结局。引用保持来源编号，不把歌谣的转述者写成作者。

机位与连续：
- continuity.mode三种：tail_continuation为同画面续拍，firstFrameMode=reuse_previous_tail、bridgeType=same_frame；coverage_cut为同场反打/反应镜，firstFrameMode=reference、bridgeType=cut；scene_cut为真换时空，firstFrameMode=reference、bridgeType=cut，第一镜bridgeType=opening。
- 根据scene.continuityMode及已批准机位意图选择；同一戏可coverage_cut，不可假装已闭合来换镜头。tail_continuation时visualPrompt原样复制上一镜lastFramePrompt静态正文，initialCharacters等于上一镜endCharacters。coverage_cut需保持同一unit/setting/现场人物和实际世界状态，camera说明视线和轴线，不能重演已完成动作。正常场景切换必须有剧情联系；视线匹配、动作匹配或声音桥要写出两镜都有的锚点。
- worldState只记开场已经有证据的世界状态。逐字段继承上一镜可信投影的shot_script.worldState；其中unknown必须保持unknown，不得凭附件图片、尾帧描述或拟拍动作升级为observed。observed字段原样继承value/evidence；画面左/右可以用于构图，但不是人物在场景中的世界位置。普通反打导致屏幕左右改变不等于人物换位。
- characters列本段真正可见/行动者；presentCharacters还包含仍在现场但本镜画外的角色。endCharacters仅列末帧可见者，不能为保持全员同框而把反应特写改成双人站桩；画外角色不自动离场，未知持物不能凭空补造。每段最多2个需要新完整身份参考的人物。
${EDITORIAL_CHARACTER_ENTRY_RULE}
- 对本段原已要求的状态变化，沿用已批准机位意图和视线轴线，选择能看清相关身体部位、持物归属与变化方向的景别、角度，避免衣物或遮挡使动作过程无法辨认。不为质检新增微动作或夸大原动作幅度，不把计划中的可观察性写成实际已观察证据。

时间与声音：
- 普通预算：speechSeconds=台词汉字数/4.5+逗号分号数*0.15+句末标点数*0.25+换行次数*0.2；仅计算audioText实际说话正文，不计说话人标签，换行次数为非空台词行数减1且不小于0。actionSeconds是不能与对白并行的必要动作秒数，reactionSeconds=0.3–1.2。未提供activityWindows且无performanceBeats时，duration=max(3,ceil(speechSeconds+actionSeconds+reactionSeconds+0.3))，上限15。按必要内容定时长，不凑满15秒，不加速或删词。
- 若pacing声明activityWindows:[{kind:"speech或action或reaction",startSecond,endSecond}]，即使performanceBeats未提供或为空，也必须校验：起止为有限数值，0<=startSecond<endSecond；speech/action/reaction各类窗口合计分别对应speechSeconds/actionSeconds/reactionSeconds，同类窗口不得重叠。plannedEndSecond取所有activityWindows与performanceBeats的最晚endSecond，duration=max(3,ceil(plannedEndSecond+0.3))，上限15。跨类并行按区间并集消除重复计时，但并集长度不能抹去时间偏移或空档；不得靠未解释空等延长影片。活动结束时刻与整数片长不同，不能把活动窗强行拉长到duration。
${STORYBOARD_DIALOGUE_LINE_BINDING}
- 原剧情或已声明动作有“说完后、接稳后、转身后”等先后依赖时，在videoPrompt写清前置事件、可观察起始状态、连续完成区间与完成后的状态；后续动作不得在前置事件尚未结束时宣称完成。“说完后”的动作区间从最后一句speech窗口结束之后安排，按原动作实际需要预留独立完成时间，动作完成后再留0.3秒剪辑余量；不能把只够说话的区间同时当作说完后的动作时间。完整保留台词、原动作和自然幅度，超过15秒就连续拆段，不暗改台词或裁剪动作。时间预算只说明计划可执行，不能据此认定实片动作已完成或新增验收义务。
- 有明确选择推进的沉默允许audioType=环境声、audioText=""，保留真实环境声，人物不作语言口型。不得用空台词替代本来必须说出的叙事信息。
- 确需超过自然反应预算的无声表演，pacing增加performanceBeats:[{id,purpose,stateChange,evidenceAnchor,startSecond,endSecond,overlapWith:[]}]，并提供合法activityWindows。每类窗口合计对应相应预算，performance与并行动作重叠的部分只算一次，按上述最晚plannedEndSecond加0.3秒取整。evidenceAnchor为videoPrompt对应时间段内实际发生的动作短语。撤回招呼、转身作出选择可以是表演；重复静帧、仅写紧张/悲伤不能。不得靠新增空等窗口延长影片。
- videoPrompt的3–6段覆盖0至duration且连续无重叠；表演在片尾可继续自然微动，仅留0.3秒剪辑余量。音轨不新增可辨语言，不拉长尾音填充。

${EDITORIAL_STORYBOARD_VISUAL}

上一镜承接信息（第一镜为空）：
上一镜id：\${loop.previous.shot_script.id}
上一镜尾帧人物：\${loop.previous.shot_script.endCharacters}
上一镜静态尾帧：\${loop.previous.shot_script.lastFramePrompt}
上一镜动作声音：\${loop.previous.shot_script.videoPrompt}
上一镜实际尾帧可用：\${loop.previous.last_frame.available}
上一镜开场继承用的可信世界状态（unknown不是已采证事实）：\${loop.previous.shot_script.worldState}

当前场景：\${scene}

史料原文：
\${historical_sources.text}
【真实离场与画外】presentCharacters列本镜过程中实际在场参与者；characters只列本镜可见或行动者。反打裁切造成画外不能声明离场。真正离开同场空间时，可在continuity.exitingCharacters增加[{"name":"本镜人物","startSecond":起秒,"endSecond":止秒,"path":"离开实际场所的路径","evidenceAnchor":"时间轴中原样出现的走出院门等真实离场动作"}]，endSecond不得超过duration-0.3，退出者不能列入endCharacters。末尾场内名单由presentCharacters减明确退出者形成；下一镜仅在实际成片证明离场过程后才能删名。新入场沿用enteringCharacters及完整动作时间。单纯走出画框或切为他人特写不构成离场。
`

/** Schema112/113 added only the two audio clauses to the frozen schema111
 * writer. Keep that migration identity independent of current state guidance. */
export const SANGUO_STORYBOARD_PROMPT_BEFORE_TRUSTED_TAIL_STATE = SANGUO_STORYBOARD_PROMPT_BEFORE_AUDIO_LINE_BINDING
  .replace(STORYBOARD_AUDIO_COVERAGE_BEFORE_LINE_BINDING, STORYBOARD_AUDIO_COVERAGE_LINE_BINDING)
  .replace(STORYBOARD_DIALOGUE_BEFORE_LINE_BINDING, STORYBOARD_DIALOGUE_LINE_BINDING)
