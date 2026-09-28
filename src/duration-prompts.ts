import { SANGUO_CINEMATIC_STORYBOARD_PROMPT } from './storyboard-prompt.ts'

export const DURATION_WRITER_CONTRACT = `时间与声音（duration-v2）：
本轮共享策略完整对象：\${params.timingPolicy}
- pacing.version 必须为 duration-v2。不要输出 dynamic-v1 actionSeconds/reactionSeconds/activityWindows/performanceBeats。用 pacing.beats 逐项描述真正要执行的声音和动作；程序根据依赖、主体资源、保守预算编译时间轴，禁止把多个动作压成统一0.7秒反应。
- pacing.timingPolicy 使用本轮 params.timingPolicy 的完整值，不改阈值。对白/旁白/吟诵/歌唱分别用 deliveryStyle=dialogue/narration/chant/singing，歌谣不可套4.5字/秒快读。每个 speech 必须绑定 audioText 中同说话人的完整一行；长台词只按自然停顿拆行，原正文和说话归属不变。
- beats 格式：{id,sourceBeatId,actorIds,kind:"action|reaction|speech|vocalization",deliveryStyle:"dialogue|narration|chant|singing",textOrVocalization,performanceInstruction,dependsOn:[],overlapAllowedWith:[],resources:["body"],durationEstimate:{lower,expected,upper,source,confidence:"low|medium|high"},completion:{requiredThisClip:true,finalState,modality:"visual|audio|audio-visual",evidenceAnchor},timingConstraint:{mode:"reference"}}。仅 speech 需要 deliveryStyle 和可选 performanceInstruction；action/reaction 的真实动作正文必须写非空 textOrVocalization，不能只放在 performanceInstruction。resources 可省略让程序按类型分配，主动声明时必须为非空有效资源数组，speech 通常使用 voice；每个字段是实际契约而非写解释。sourceBeatId 属于本段 requiredBeats；speech.textOrVocalization 仅写实际发声原文，speech.performanceInstruction 保存“哼唱歌谣”等原表演动作；所有原声画锚点必须在对应节拍的 textOrVocalization/performanceInstruction/evidenceAnchor 中原样出现，不能删动作或只声明完成态。
- durationEstimate 的上下界是秒，0<lower<=expected<=upper；source 写估计依据，不能声称不存在的实测/P90。身体进入位置、发声启动、尾音、拿起/递出/接住/收手、群体回应按实际动作分开，完成后再留 timingPolicy 的可读余量。duration 初选为完整内容上界加余量向上取整，程序允许有依据的一个整数秒保守余量；不固定9或15秒、不填站桩。
- dependsOn 写必须先完成的 beat.id；“说完后/接住后/转身后”必须依赖，不可假装并行。同一人可边走边说时，双方 overlapAllowedWith 都列对方id，动作 resources=["body"]，发声 resources=["voice"]；资源冲突不可并行，未声明并行按顺序执行。不同人同时说不同台词禁止重叠，合唱同一句可用同一 speech 的多人 actorIds。
- actorIds 通常用 characters/presentCharacters 全名。无人编辑镜头（scene.cast为空且允许空人物的 episode_opening/context_bridge/payoff）中，地图高亮、空景运镜、光影或环境变化等无人物 action/reaction 必须写 actorIds=[]，不得为满足字段凭空添加群众或角色。有人物的实拍场景中，仅逐字复用当前 requiredBeat.setting、且正文只表达全景/空镜/环境建立的独立 action 可写 actorIds=[]；人物、群众、持物、回应或原声画锚点动作仍须绑定已批准人物或 actorGroup，不能借环境镜头豁免。画外旁白仍单列 speech、deliveryStyle=narration、actorIds=["旁白"]。原场已有无名群众用 pacing.actorGroups:[{id,label,memberDescription}] 声明群体，actorIds 引用 group.id；群体不是新具名历史人物，不要求给每人生成三视图。visualPrompt 明确群众原本所在位置，避免凭空出现。需要回应的群众不能同时被写为禁止发声。
- 无词哼唱必须单列 kind=vocalization、非空 textOrVocalization 和非零预算，同时填 vocalization:{vocalizationType,actorGroup,expectedAudibility,melodyRelation,completionCue}；这类声音不塞进汉字对白清单，不以空text逃避声音验收。若要完整复唱，必须用 speech 和完整台词预算；短促无词同曲调回应才可用短声部。不要添加原剧情没有的群众语言。
- timingConstraint.mode=reference 表示导演建议时间；用户明确要求的精确时刻才设 hard，并填 notBeforeSecond/deadlineSecond。前置动作和本镜截止始终是硬条件，不能为过关降级。视频实际延迟执行时通过实际证据定位，不把计划当成已发生。
- 保持 videoPrompt 为简明导演草稿，完整保留原声画义务；最终时间窗口由程序从 beats 编译，不自行附加和结构化排程相矛盾的“仅主角发声/立即结束/固定静止尾部”。无词群众和主唱使用各自声明窗口。
- 超过供应商15秒上限，使用既有 {segments:[...]} 按完整节拍拆段、原音画锚点保持有序覆盖，后段正确承接已完成动作；不得钳到15秒、加速、删词或让末动作凭空完成。
`

export const DURATION_ACTOR_IDS_CONTRACT_BEFORE_ACTORLESS_EDITORIAL = '- actorIds 用 characters/presentCharacters 全名。原场已有无名群众用 pacing.actorGroups:[{id,label,memberDescription}] 声明群体，actorIds 引用 group.id；群体不是新具名历史人物，不要求给每人生成三视图。visualPrompt 明确群众原本所在位置，避免凭空出现。需要回应的群众不能同时被写为禁止发声。'
export const DURATION_ACTOR_IDS_CONTRACT_BEFORE_SETTING_ESTABLISHMENT = '- actorIds 通常用 characters/presentCharacters 全名。无人编辑镜头（scene.cast为空且允许空人物的 episode_opening/context_bridge/payoff）中，地图高亮、空景运镜、光影或环境变化等无人物 action/reaction 必须写 actorIds=[]，不得为满足字段凭空添加群众或角色；画外旁白仍单列 speech、deliveryStyle=narration、actorIds=["旁白"]。其余 action/reaction 仍须绑定已批准人物。原场已有无名群众用 pacing.actorGroups:[{id,label,memberDescription}] 声明群体，actorIds 引用 group.id；群体不是新具名历史人物，不要求给每人生成三视图。visualPrompt 明确群众原本所在位置，避免凭空出现。需要回应的群众不能同时被写为禁止发声。'
export const DURATION_ACTOR_IDS_CONTRACT = '- actorIds 通常用 characters/presentCharacters 全名。无人编辑镜头（scene.cast为空且允许空人物的 episode_opening/context_bridge/payoff）中，地图高亮、空景运镜、光影或环境变化等无人物 action/reaction 必须写 actorIds=[]，不得为满足字段凭空添加群众或角色。有人物的实拍场景中，仅逐字复用当前 requiredBeat.setting、且正文只表达全景/空镜/环境建立的独立 action 可写 actorIds=[]；人物、群众、持物、回应或原声画锚点动作仍须绑定已批准人物或 actorGroup，不能借环境镜头豁免。画外旁白仍单列 speech、deliveryStyle=narration、actorIds=["旁白"]。原场已有无名群众用 pacing.actorGroups:[{id,label,memberDescription}] 声明群体，actorIds 引用 group.id；群体不是新具名历史人物，不要求给每人生成三视图。visualPrompt 明确群众原本所在位置，避免凭空出现。需要回应的群众不能同时被写为禁止发声。'

/** Keep the historic managed prompt immutable for old execution snapshots. */
export const DURATION_STORYBOARD_PROMPT = SANGUO_CINEMATIC_STORYBOARD_PROMPT
  .replace('"pacing":{"version":"dynamic-v1","actionSeconds":1,"reactionSeconds":0.7}', '"pacing":{"version":"duration-v2","timingPolicy":"使用params.timingPolicy完整对象","actorGroups":[],"beats":[]}')
  .replace(/时间与声音：[\s\S]*?\n画面：/, DURATION_WRITER_CONTRACT + '\n画面：')

export const DURATION_VIDEO_ENDING = '严格执行声明的各声部、动作依赖及表演方式，完整说完原文并完成群众或对手回应。剪辑余量用于看清动作结果，允许自然呼吸微动；不得在最后引入新的必需动作，不要求静止或转向镜头摆拍。'

export const DURATION_REFERENCE_REVIEW = `\n【duration-v2时间解释】仅当原要求携带 timingConstraint.mode=reference 时，起止是导演参考窗，按原sourceBeatId和sourceQuote核对同素材实际发生事件；使用eventSearchRanges内实帧，保留原引文，分别核查硬先后和deadline。hard及历史未分类时间窗仍按原范围验收。参考窗之外发生不等于缺失；全片没采到过程也不能自行判confirmed。无词哼唱仅凭图片不可验证，其声音义务由独立音频证据完成。`;

export const DURATION_MEDIA_REVIEW_TIMING = `【声音与节奏】
【duration-v2成片时长契约】
本镜共享策略：\${shot_script.pacing.timingPolicy}；编译声部窗口：\${shot_script.pacing.speechWindows}。按每个speech的deliveryStyle选择timingPolicy.speech[deliveryStyle]，区分dialogue/narration/chant/singing。referenceRate只用于规划，不是实片统一语速下限；不能把吟诵或歌唱按对白速度判拖慢。
speechChecks逐metrics.speech原text填assessment=natural/slow/uncertain，reason引用该声部beatId/deliveryStyle以及elapsed/allowedSpan/timingAssessment。allowedSpan来自该声部已编译窗口的end-start，不能另用统一汉字/秒重算或删去表演启动、停顿、尾音预算；measurementToleranceSeconds仅处理测量不确定性，不重复加入预算。within-allowance不得slow；outside-allowance仍须可靠边界及确证声音缺陷；边界或对齐不可靠、临界差异保持uncertain。ASR字形/同音字、覆盖率或低概率不独证错音/漏词，ASR不证明逐帧口型。
无词kind=vocalization不进入有词speechChecks，仍须durationCompletion中的独立音频证据。未听证的群众哼唱、声部归属或同曲调关系保持uncertain，不能由静帧、空ASR或主唱完整推定完成。
tailTimingCheck.assessment使用metrics.tailTiming程序值，reason引数值及scope。它仅描述有词人声结束后的余量，不表示所有动作与声部已经完成。主唱之后原要求中的反应、群体发声或其他必需动作不属于idle；较长voice-tail或tailTiming=uncertain本身不能触发空等缺陷或裁尾。
pacingReview需passed及非空reason；lastMeaningfulActionSecond有限且在[0,duration]，reason定位实际动作、回应及声部结束证据，不抄计划。performanceChecks按原beat.id覆盖，无节拍[]；evidence非空，0≤startSecond<endSecond≤duration。observed须observedStateChange及≥2变化区间实帧；单帧/计划/裁剪不证明变化；确证无推进incomplete，漏采unobservable。
先逐个确认completion.requiredThisClip=true节拍的全部必要模态完成。completionUpper取这些节拍实际observedEnd.upper的最大值；收尾必须保留completionUpper + timingPolicy.endingReadabilityReserve，本镜余量为\${shot_script.pacing.timingPolicy.endingReadabilityReserve}秒，不扣测量容差。任何必需动作或声音未完成/未知时，不能计算可裁尾点或宣称尾部空等，保留原片并走完成证据门禁。
仅全部必需节拍已有完成证据后，才用实际片长减completionUpper与maxIdleTailSeconds判断空等，裁点不得早于上述完成上界加共享余量；不得以主唱ASR结束代替群众回应结束，也不得裁掉尚需看清的动作结果。裁尾尚未实施并重新采证前不得宣称素材已accepted，不能消除未完成或未知。
【duration-v2成片时长契约结束】
`

/** Replace the managed timing section only; historical canonical text stays immutable. */
export function refreshDurationMediaReviewPrompt(prompt: string): string {
  const section = /【声音与节奏】[\s\S]*?(?=【cinematic-v1条件】)/g
  if ([...prompt.matchAll(section)].length !== 1) throw Error('DURATION_MIGRATION_CONFLICT: 成片审核缺少唯一受管理声音与节奏段')
  return prompt.replace(section, () => DURATION_MEDIA_REVIEW_TIMING)
}

export const DURATION_SCRIPT_REVIEW = `\n【duration-v2分镜审核契约】
仅当当前候选 pacing.version=duration-v2 时：审核当前结构化结果及其编译后的 videoPrompt。raw/text 是保存的模型原稿，不是当前执行版本；问题证据必须逐字引用当前字段，声画问题优先引用当前 videoPrompt、audioText 或 beatDramaturgy 的具体声画路径。新版执行正文也可引用 pacing.beats.0.textOrVocalization 或 pacing.beats.0.performanceInstruction 这类真实存在的完整叶子路径，并将 beatId 绑定该节拍的原 sourceBeatId；不得用 pacing.beats 整体数组、预算或完成态元数据代替实际声画正文。
speech 是有词台词，必须完整保留在 audioText 并绑定说话人；kind=vocalization 是独立无词声部，其 textOrVocalization、actorIds、非零预算以及 vocalization 内的可听性、曲调和完成提示共同表达声音义务，不能要求把无词哼唱硬塞进汉字对白 audioText。完整复唱有词歌谣仍必须使用 speech 与完整原文。
对照原 requiredBeats 核查动作、主体和同时性。“边走边唱”必须实际重叠，“先入场再边走边唱”须保持原义，“走完才唱”属于真实语义缺失；预算够长不能替代剧情忠实。声称两个动作没有同时发生时，应核对当前 pacing.schedule 的时间交集并列出实际区间，不能忽略已有重叠。时序要求必须引用原剧情依据：原文未要求“从首帧开始”“全程覆盖”“贯穿入场”，不得自行把普通同时性扩大为这些额外硬条件；原文明确要求时则必须保留。区分真实动作正文与入画准备，但不能用短暂擦边重叠冒充完整的组合表演。结构化完成态不是实片完成证据。`
