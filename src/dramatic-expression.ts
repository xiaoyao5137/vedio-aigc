const PHYSICAL_MAP_OPENING_RULE = '开场的沙盘或实景信息只讲看懂本集选择所必需的一句局势，并用正在改变的路线、人物风险或异常动作提出问题。若主要是解释地形、双方位置或进军路线，开场用一个短段的实体沙盘；若这些信息能从交锋中听懂，就直接从主视角人物或对手的真人行动切入。真人开场必须让这个行动人物在首段面临阻力或作出可见选择，不能拍空院、空廊、静立队列再用旁白介绍主角。若先展示对手，下一短段就接入主视角人物，不再独立拍只为说明目的地的押送、开门、带路或空景；确有新危险、关系或人物选择的行动不受此限。对于“已俘”“已抵达”等前提，优先在交锋现场用人物状态和一句话交代，不必把没有新戏的路程逐段重演。沙盘在后面确需解释地理因果时仍可出现，并保持本作已批准的实体沙盘质感。'
const HISTORICAL_MAP_OPENING_RULE = '开场的历史地图或实景信息只讲看懂本集选择所必需的一句局势，并用正在改变的路线、人物风险或异常动作提出问题。若主要是解释地形、双方位置或进军路线，开场用一个短段的古代历史地理地图；若这些信息能从交锋中听懂，就直接从主视角人物或对手的真人行动切入。真人开场必须让这个行动人物在首段面临阻力或作出可见选择，不能拍空院、空廊、静立队列再用旁白介绍主角。若先展示对手，下一短段就接入主视角人物，不再独立拍只为说明目的地的押送、开门、带路或空景；确有新危险、关系或人物选择的行动不受此限。对于“已俘”“已抵达”等前提，优先在交锋现场用人物状态和一句话交代，不必把没有新戏的路程逐段重演。历史地图在后面确需解释地理因果时仍可出现，并保持本作古代历史地理地图质感。'
const PHYSICAL_MAP_REVIEW_RULE = '留意开场是否用实景空院、空廊、静立队列配旁白介绍主角，或连续用行路、开门等没有新压力的短段，迟迟不让本集实际行动人物进入；若有这种具体问题，定位短段原文并建议从人物面对的阻力切入，或在确需地理信息时用一段实体沙盘。也留意只为把下一场道具送到目的地而独立成段、下场又重复呈现的过桥镜头，建议并入相邻人物戏。沙盘可以简明建立时地，不凭“没有人物”四字就否定必要的历史信息镜头。'
const HISTORICAL_MAP_REVIEW_RULE = '留意开场是否用实景空院、空廊、静立队列配旁白介绍主角，或连续用行路、开门等没有新压力的短段，迟迟不让本集实际行动人物进入；若有这种具体问题，定位短段原文并建议从人物面对的阻力切入，或在确需地理信息时用一段古代历史地理地图。也留意只为把下一场道具送到目的地而独立成段、下场又重复呈现的过桥镜头，建议并入相邻人物戏。历史地图可以简明建立时地，不凭“没有人物”四字就否定必要的历史信息镜头。'

/** Replace only the two known map-presentation sentences in persisted prompts. */
export function refreshDramaticExpressionMapPrompt(prompt: string): string {
  let next = prompt
  for (const [prior, current] of [
    [PHYSICAL_MAP_OPENING_RULE, HISTORICAL_MAP_OPENING_RULE],
    [PHYSICAL_MAP_REVIEW_RULE, HISTORICAL_MAP_REVIEW_RULE],
  ]) if (next.split(prior).length === 2) next = next.replace(prior, () => current)
  return next
}

/** Shared editorial instructions. Use the existing cinematic-v1 sound/image
 * contract so the shot writer receives performed beats, not new metadata. */
export const SANGUO_DRAMATIC_EXPRESSION_OUTLINE_PROMPT = `【影视表达与现代汉语·大纲】
本系列要有鲜明的影视剧情和轻松易懂的语言。在史实主体、因果、先后、结果与本集改编边界内，让多个实际行动人物和多场完整戏呈现不同的性格、处境与情绪变化；不要只增强主角或开场，也不要连续用介绍、禀报、表态、点头代替人物互相影响。
先在完整戏层面安排轻重、张弛和情绪起落，再拆拍摄短段。主动寻找幽默、感人、冲突和反差的机会，采用符合本集事件的组合，形成铺垫、回应及后果；不是每场都凑齐四类，也不以固定数量、额外支线或改写史实来填配额。悲剧可以有生活趣味和温情，幽默之后仍要承接人物面对的真实代价。
${HISTORICAL_MAP_OPENING_RULE}
历史地图必须承担本集行动或结果离不开的地理信息：例如两地相对位置、行进路线、险阻如何限制选择，或势力分布如何改变局面。先问“删掉地图、用人物在行动中一句话交代时地后，观众会不会失去理解因果所必需的空间关系”；若不会，就从人物遇到压力、作出选择或与人交锋的真人实景开场。单一城址高亮、只报年代地点或给地图设色，不构成地图的叙事必要性；不得用地图之后再接无新压力的空帐/空景，把人物冲突延后。确有必要的地图，在 observable.visual 写清具体地理关系与变化，在 purpose 写清它帮助观众理解的当集选择或后果，不拿抽象设色充当路线或因果。
先找出本集史料确有的行动、约束和结果，再选一位或数位实际行动人物作观众的情感入口。对主要人物戏逐场问：此刻他要保住谁或什么、别人或局势怎样施压、他采取了什么与自己性格相符的办法、谁因此作出具体回应、局面或关系发生了什么变化。把答案落实到连续的 requiredBeats.observable.visual/audio；仅在 goal、concern、purpose、mood 里写“紧张”“温情”或“内心挣扎”不算拍出来。无需为信息开场或纯环境承接硬造人物对手。
按事件自身的因果安排压力梯度：危险可以靠近、退路可以收窄、人物可以作出有代价的选择，但决定性行动的效果不能在之前的铺垫镜头里先演完。若先写了对手已经退缩、关系已经和解或危机已经解除，后续关键喊话、让步或援手就失去可见的转折；应在既有史实边界内区分“仍在试探/逼近”和“行动后真正改变”，不要凭空增加敌人、事故或背叛。相邻短段也要有信息、压力、策略或关系上的增量，避免连续几镜只换机位重复勒马、点头、回望或口头表态。
连续同场问答、同一个人忍痛或服从等短段，逐段核对前段实际声画已建立的状态：新段必须新增可见压力、当场可选行动、他人的反制/回应，或导致不同后果。只换问法、机位、道具，反复包扎或忍痛而人物选择与关系不变，不算增量；合并进相邻段，或在史实与改编范围内改成真正有新选择和回应的一段。必要的沉默或身体动作可以保留，但要让观众看见它改变了谁的行动或理解，不能靠 purpose/stateChange 宣称推进。
史料中的“十余”“数十”“约”“余”等约数只能按原有精度叙述，不把它们改成“十二”“三十”等精确史实。镜头确需调度可数群演时，具体演员数只是拟制的拍摄安排；剧中旁白、对白、historicalLocks 和剧情结果仍保留史料约数，不宣称来源确定了镜头内恰好多少人。
跨空间承接优先用剪辑、声音先入或下一段开始时的可见状态完成。只有承接动作自身改变压力、关系或信息时才单独成段；只为搬运下一场道具、押送、开门或行路的过桥镜头并入相邻人物戏，不能把“下一场要用这个物件”当作剧情增量。
同一场连续问答先用必要的空间镜头交代谁控制局面、人物站位和关键持物，再按本段真正发生的提问、顶回去、犹豫或改判选择承接方式。动作必须跨段保持同一画面时用 tail_continuation；若说话权或受压者的反应成为新信息，可用同场 coverage_cut 让观众看清这次变化，例如保留视线轴线的反打、过肩或更近的景别。不要把“同场连续”误写成所有短段都固定同一双人全景；也不为凑机位变化强切、凭镜头伪造关系变化。每个切换都沿用已批准的人物站位、持物、束缚和未完成动作，不能让画外人物无故离场。
- 幽默：来自人物认真应对却碰到尴尬、各有打算的错位、嘴硬与实际反应的差别、试探和机智接话。写出笑意如何被铺垫、谁怎样回应、局面如何变化；不能只写“搞笑”“众人笑”，不能靠穿越梗、羞辱弱者或把历史人物降成固定蠢角。
- 感人：让观众看见具体顾虑、处境、照顾或选择的代价。用留给对方的东西、没说完的话、一个被接住的举动等符合事件的声画表达，给回应留时间；不要用哭喊、煽情旁白、音乐或“很感动”代替关系的实际变化，不虚构死亡、亲属或重大牺牲。
- 冲突：各方当场想要什么、为什么不能同时得到、怎样试探/阻拦/反制、选择造成什么后果要可见可听。允许安静但锋利的拒绝、话锋变化与权力压力，也允许合乎事件的激烈交锋；避免每次都靠大吼、拍桌或两人轮流讲道理。
- 反差：利用史料允许的身份与处境、表面自信与当场窘迫、硬话与具体关照、胜势与代价等差别。先建立观众预期，再以动作或接话兑现；不能靠突然变性格、凭空揭露阴谋或无因果反转制造反差。
人物要有各自的应对方式。characterDramas.goal/concern/leverage/tactic 写具体的争取、顾虑、筹码和反应差异，speechStyle 写可执行的说话习惯：直来直去、先客气再拒绝、短句试探、嘴硬后收口等，并在真实对白里体现。表现差异是 performance 范围的场面拟制，不能据此推定史料未知的核心私下动机；没有依据时仍标 unknown。匿名群演也能通过原事件中的接话和动作显出生活感，不凭空命名或扩充角色。
在本集 adaptationSpace 与声音制作边界允许、有史实处境支持、且能帮助观众理解当场选择时，才使用克制的主角画外心声或回望式旁白；把它写进本段真实 observable.audio，明确声源和时长，并让画面中另有能印证或反驳它的动作/回应。心声只表达表演层面的即时顾虑，不冒充史载原话、未知私下政治动机或画内人物已经说出口的话；不为每场强加旁白，也不让旁白重复解释观众已经看到的动作。自然幽默同样应从人物应对与处境错位生长：先有可懂的铺垫，再有克制的接话、反应或短暂闹剧，最后仍回到事件后果；没有合适机会可以没有笑点。
所有新写的对白、旁白、开场/转场 narration 和口头解释，默认使用自然的现代汉语：短句、清楚的主语和指代、能一遍听懂的词。保留“喏”等有时代辨识度的短语及必要称谓，但不要把整段对白写成文言文、奏章或史书转述。拟制句“吾等岂能坐视百姓受苦？”可表达为“百姓都这样了，我们还能不管吗？”；身份分寸由称谓、语气和应对方式体现，不靠堆叠“吾、汝、此乃、何以、岂可”或官样长句。现代汉语不等于现代网络流行语；不用当代制度、物件或时代外知识制造笑料。
史料正文、sourceRefs、引证 quote 与 historicalLocks 的事实含义保持准确，不能把白话改写冒充史料原文。剧情确须呈现的原歌谣、谶语、诏令或有辨识度的史载短句可保留原文，在其前后用自然白话或当场回应帮助理解，不把整段史料直接当角色台词。拟制标记只放 adaptationBoundary，不进入实际音轨。
以上设计落在现有字段：dramaticScenes 的 tactics/turn/result 体现互相影响，scenes.purpose 与 requiredBeats.function/stateChange 说明本段作用，requiredBeats.observable.visual/audio 写出实际动作、完整台词和对方回应，mustShow 从这些真实动作取短锚点。不要添加新的顶层字段，也不能只在幕后写“幽默/感人/冲突/反差”而声画仍是平铺直叙。情绪需要的动作、停顿和回应计入自然时长，超15秒按原内容连续拆段，不能挤成加速对白。
这是新大纲的创作要求；已有候选的局部纠错仍只改被点名缺陷及直接依赖，不能借风格升级改写未授权范围。输出前只按实际声画读一遍：人物是否说得明白、说得不同？关键戏是否有铺垫、接招和变化？整集是否始终一个情绪和一套表态？在首次创作或获准的重构范围内补足。
【影视表达与现代汉语·大纲结束】`

export const SANGUO_DRAMATIC_EXPRESSION_STORYBOARD_PROMPT = `【影视表达与现代汉语·分镜】
将已批准的完整戏、人物 speechStyle 和本段 requiredBeats 的幽默、温情、冲突或反差拍成真实声画。根据这场戏的力度安排表演、视点与节奏：幽默让铺垫后的接话/反应落地，感人让具体关照和被关照者的回应可见，冲突突出试探/反制/选择，反差先让预期清楚再呈现变化。反应镜、动作停顿或声音先行都应服务本段已经批准的内容；不要只给 mood 填“克制”，也不让每个角色都叹气、点头、怒吼或机械站立。
逐项对照当前段的 observable 声画与相邻段的已完成状态：把当场目标、受到的阻力、人物的应对和对方反应分配给可见动作、完整台词、反应镜与自然停顿。若本段只是铺垫，保留压力和未完成的选择；不能提前拍出后段决定性行动才造成的退缩、和解或脱险。若大纲本身已经让结果提前发生，应指出上游需要局部修复的原句与场次，分镜不能暗改批准节拍或凭机位、音乐、台词标签伪造因果变化。
人物调度、景别和语气要体现各自处境与应对差异；真实完成动作及完整台词后给必要回应留自然时间。不得为每镜强塞笑点、哭戏或反转，不虚构新节拍、关系、动机、道具或音轨内容，不重演前镜已完成的铺垫。
真人同场戏先承接已批准的 continuityMode、上一镜实际尾帧和视线轴线，再选能看清本段新增信息的景别：建立束缚、站位或多人动作可用全景；问答转向某人时，让说话者的口型、被问者的反应或决定发生处可见。coverage_cut 只有在本段已有应对变化、且不丢失关键动作时才用反打、过肩或近一些的景别；cameraReason 要说出它比沿用前镜全景多揭示了哪项本段可见变化。tail_continuation 首帧严格复用尾帧，不偷换机位；只有已批准的动作确实需要时才在同一连续镜头内轻微调整构图，不能遮断必须看清的绳索、持物、人物动作或位置关系。连续几段都用固定双人全景时，先核对这是否为动作完整性或新压力所需；若已批准的提问、反制、决断仍被同一构图掩没，应在下一段允许的 coverage_cut 中局部调整，不改本段承接模式、对白或节拍。
语言现代化在上游大纲完成。本节点逐字保留已批准 observable.audio 的完整台词、原歌谣、说话人和先后，不能擅自把古句换成白话、添解释性台词或删“喏”；如旧大纲仍晦涩，保留原义务并给出需回大纲重做的建议。新写的表演说明和建议用清楚的现代汉语。现代汉语对白仍配东汉人物、服化道和行为，不出现当代梗或现代物件。
情绪不能只存在于 shotIntent/mood/beatDramaturgy 的说明中：本段获准的实际动作、台词及回应必须进入可执行声画正文，duration-v2 用绑定 sourceBeatId 的 pacing.beats 的 textOrVocalization/performanceInstruction 承载，再由程序编译时间窗口。按真实内容预算，不用加速、删词、延长尾音或超限来补表演时间；超15秒保留原义务连续拆段。纠错仅在当前反馈授权范围内进行，不能借影视化润色改变其他已批准内容。
【影视表达与现代汉语·分镜结束】`

export const DRAMATIC_EXPRESSION_TEXT_REVIEW_PROMPT = `【影视表达建议】
在 warnings 中提出有当前声画原文定位的创作建议：新拟制对白及 narration 是否自然易懂，多个行动人物是否说话和应对不同，完整戏的幽默/温情/冲突/反差是否有具体铺垫、动作、接话、回应和局面变化，整集是否长期只有介绍/表态/点头或同一情绪。只依据候选实际 observable/audioText/videoPrompt/pacing 正文，不把 purpose、mood 或“感人”等标签当作实现证据。建议写明当前 itemId、path、quote、problem 和局部改善方向；没有确切依据不编造建议。
${HISTORICAL_MAP_REVIEW_RULE}
对每个 historical_map 信息镜头，核对 observable.visual/audio 是否给出本集下一步选择或结果不可替代的地理关系；只标一个地名、城址变色、报时地而不显示路线、阻隔或势力间空间关系，不能因“地图可建立时地”就认为影视表达已合格。先定位该地图与相邻承接场的实际声画原句，判断删掉地图、在人物行动中交代一句时地后是否仍能完整理解本集因果。只有地图与相邻段重复说明或连续占用开场、延迟实际行动人物进入，且地图没有独立地理因果或时代空间信息增量，才在 warnings 写 code="unnecessary_map"、itemId=地图场 id、relatedItemId=相邻承接场 id、evidence 两条分别引用地图场和相邻承接场实际声画、problem 同时说明无独立空间增量及两场造成的重复或延迟、repair 给出合并或真人开场的局部做法；单个短地图紧接有压力或选择的真人冲突，只能按具体情况给普通建议，不能据地图短促或无人而给此 code。不要误伤有路线、疆域、险阻等实际空间因果的地图。
连续同场问答或同状态苦情段，逐段比较 observable/audioText/videoPrompt 的前后状态：新压力、可选行动、反制/回应或关系后果实际发生了什么？只换问法、机位、道具、再次忍痛，且观众没有获得新信息或看见选择变化时，在 warnings 写 code="repeated_action_without_delta"、itemId=后一场 id、relatedItemId=前一场 id、evidence 两条分别引用前后两场实际声画、problem 说明为何后场没有新增压力/选择/回应、repair 建议合并或在原史事边界内给出新的当场选择；若新段确有拒绝、让步、距离改变所造成的风险或关系变化，不按相似动作词定错，可建议节奏压缩。
上述两种强证据 warning 的格式是 {"code":"unnecessary_map|repeated_action_without_delta","itemId":"当前地图场或后一场 id","relatedItemId":"相邻承接场或前一场 id","evidence":[{"itemId":"第一场 id","path":"scenes.N.requiredBeats.M.observable.visual.K","quote":"该路径内逐字原句"},{"itemId":"第二场 id","path":"scenes.N.requiredBeats.M.observable.audio.K","quote":"该路径内逐字原句"}],"problem":"具体缺口","repair":"局部修改建议"}。两个 path 都从当前候选根开始，必须分别落到对应场景真实可见可听正文；可按实际内容改用 visual/audio 的索引路径，单分镜才可用 videoPrompt/audioText。不能用 purpose、stateChange、mood、人物名或其他元数据充当声画证据；找不到相邻两场可绑定的逐字原句时只给普通建议，不能填这两个 code 或伪造 quote。
史源若只给“十余”“数十”“约”等约数，逐场核对候选是否把它写成确定的历史数字；在 historicalLocks、旁白或对白中声称精确数目且无独立来源时，必须在 warnings 中引用史源原文和候选原句，提示不能把约数冒充史载精确数字。仅因镜头调度出现可数的群演，不把合理拍摄人数当成史实错误；若剧本写“十二名亲兵”而源只写“十余人”，提示改回约数或明确只是拟制调度，避免观众将制作选择误读为史载精确人数。
先按镜头顺序查看同一冲突的压力、人物选择和对手反应是否逐步变化：若后段关键行动之前，候选声画已把同一种退缩、停步、和解或脱险演完，在 warnings 中分别定位前后两处 itemId/path/quote（可写两条建议），并建议回大纲调整分配；若只是相似动作但分别承担新的信息或策略，不凭关键词判重复。再看关系中的具体关照是否得到对方回应、人物说话方式是否可辨；只能对本集事件实际适合的情绪提建议，不给幽默/温情/闹剧规定数量。
对连续真人同场短段，若候选 camera、visualPrompt、videoPrompt 均维持相同固定双人全景，且已批准的应对或态度变化因景别过远不可辨、也没有其他可见的新动作或压力，可定位两段原文提出有动机的局部景别或视点建议；若大纲锁定 tail_continuation 且不能在连续镜头内完成，就建议回大纲评估下一段 coverage_cut，分镜不可自行改 continuityMode。必要的动作全貌、人物站位、束缚状态或正在变化的压力需要宽景时应保留，不按连续全景数量判失败，也不凭 shotIntent 的“特写”字样认定成片已拍到反应。
这些是必须有据、可执行的影视表达 warnings，不新增原则错误、情绪类型配额或逐镜笑点门槛，也不因“不够搞笑/感人”阻断或自动重写。当前 principle-v1 的 pass 只表示未发现其列出的史实原则错误，不能据此宣称地图必要性、剧情节奏或感染力已验收。史载原歌谣、必要短句与“喏”等时代短语不按文言缺陷处理。新语言现代化应定位到大纲；分镜保留已批准台词，不能要求下游擅自改字、补新剧情或删除原动作。未分配某种情绪的短段无需重复整场义务。
【影视表达建议结束】`

export const DRAMATIC_EXPRESSION_MEDIA_REVIEW_PROMPT = `【影视表达实际素材建议】
现代汉语清晰度与人物接话只根据当前实际 ASR/音频证据判断，具体表演和回应只根据当前真实采样帧判断；剧本的“幽默/感人/反差”标签不能证明成片有效。可在 warnings 中定位实际台词或帧，建议改善听懂程度、人物应对差异和获准的情绪落点。抽帧或 ASR 不足以证明笑点时机、完整表演、情绪感染力或口型时明确未确认，不宣称连续审看或人工听审。
若采样帧和 ASR 足以比较同一场前后段，留意决定性行动之前是否已出现同样的结果，以及人物具体关照之后是否有可观察回应；只针对实际观察到的重复或缺口建议回相应上游节点局部调整。采样不足时标未确认，不能把剧本承诺当成成片证据。
对已批准为“说完后”才发生的反应，结合可靠的实际语音边界与其后的采样帧，核对人物在真实台词结束后是否还有可见回应时间；若台词占满原留给反应的区间，而实际帧也未见获准回应，定位该句的 ASR 时段、相应帧与原节拍，建议从分镜时长或对应片段局部重做。只有时间偏移或抽帧未见动作时先记为待核，不能据此断言口型、发音错误或动作绝对没有发生。
如果实际连续采样足以显示相邻真人镜头始终是相同远景，本段获准的关键应对在画面里难以看清，且没有其他可见的新动作或压力，可以注明 segmentIndex、相应帧和被埋没的动作，建议上游分镜按同场连续与轴线选择更有用的景别；抽帧不足以判定镜头运动、剪辑节奏或表演感染力时写未确认。真实动作必须保持全貌或清楚呈现新压力的宽景不作为瑕疵。
不要求每镜搞笑、哭泣或反转，不因风格偏好触发原则拒绝、自动重拍或新剧情。史载原歌谣、必要短句与时代短语保留；已批准对白的现代化建议指向上游大纲及相关依赖，不能要求只改音轨破坏原片绑定。
【影视表达实际素材建议结束】`

export const DRAMATIC_EXPRESSION_EPISODE_REVIEW_PROMPT = `【整集影视表达建议】
按实际提供的有序片段、ASR 和采样帧，检查多个行动人物是否有说话/应对差异、完整戏是否有可见可听的铺垫与回应、整集是否有符合事件的幽默/温情/冲突/反差和张弛变化。有依据的建议写在 warnings，定位 segmentIndex 及实际 ASR 原句或帧；没有依据时说明观察边界。不能仅凭计划认定感人/搞笑效果，也不能凭零散抽帧声称看过完整场面或整集。
重点核对高潮行动前后的实际局面是否不同、主角关系有无由具体行为呈现的变化，以及连续片段是否只是重复同一种追赶、停顿或表态；反复出现同类画面但各自推进压力或策略时如实说明其新信息，不按动作词统计“无趣”。未提供完整播放证据时，笑点节奏、感染力与整集情绪曲线仍待人工验收。
这些建议不新增阻断项、四种情绪配额或逐片笑点要求，不自动重拍。必要原歌谣、史载短句和时代短语可以保留；语言难懂的建议指向上游大纲与关联片段，保留现有素材和批准台词。
【整集影视表达建议结束】`

export type DramaticExpressionStage = 'outline' | 'storyboard'

function refreshReviewPrompt(prompt: string, stage: 'text' | 'media' | 'episode'): string {
  const body = stage === 'text' ? DRAMATIC_EXPRESSION_TEXT_REVIEW_PROMPT
    : stage === 'media' ? DRAMATIC_EXPRESSION_MEDIA_REVIEW_PROMPT : DRAMATIC_EXPRESSION_EPISODE_REVIEW_PROMPT
  const section = stage === 'text' ? /【影视表达建议】[\s\S]*?【影视表达建议结束】/g
    : stage === 'media' ? /【影视表达实际素材建议】[\s\S]*?【影视表达实际素材建议结束】/g
      : /【整集影视表达建议】[\s\S]*?【整集影视表达建议结束】/g
  let found = false
  const refreshed = prompt.replace(section, () => {
    if (found) return ''
    found = true
    return body
  })
  if (found) return refreshed
  // Instructions precede the current candidate/media rather than becoming part
  // of their evidence body. Preserve the input placeholders and custom text.
  const inputs = prompt.indexOf('\n【当前候选') >= 0 ? prompt.indexOf('\n【当前候选') : prompt.indexOf('\n${')
  return inputs >= 0 ? prompt.slice(0, inputs) + '\n' + body + prompt.slice(inputs) : prompt + '\n' + body
}

/** Replace the owned section in place and remove duplicate owned sections.
 * Surrounding custom text and ${path} references remain byte-for-byte. */
export function refreshDramaticExpressionPrompt(prompt: string, stage: DramaticExpressionStage): string {
  const body = stage === 'outline' ? SANGUO_DRAMATIC_EXPRESSION_OUTLINE_PROMPT : SANGUO_DRAMATIC_EXPRESSION_STORYBOARD_PROMPT
  const section = stage === 'outline'
    ? /【影视表达与现代汉语·大纲】[\s\S]*?【影视表达与现代汉语·大纲结束】/g
    : /【影视表达与现代汉语·分镜】[\s\S]*?【影视表达与现代汉语·分镜结束】/g
  let found = false
  const refreshed = prompt.replace(section, () => {
    if (found) return ''
    found = true
    return body
  })
  return found ? refreshed : prompt + '\n\n' + body
}

/** Config-only migration; frozen execution candidates and media are untouched. */
export function upgradeDramaticExpression<N extends { id: string; prompt: string }, W extends { id: string; schemaVersion?: number; nodes: N[] }>(workflow: W): W {
  // Earlier upgrades include version-sensitive content fixes. This layer runs
  // last in App hydration and must not jump over them when called directly.
  if (workflow.id !== 'wf-sanguo-history-drama' || (workflow.schemaVersion ?? 0) < 144) return workflow
  let changed = false
  const nodes = workflow.nodes.map(node => {
    const stage = node.id === 'sanguo-scene-outline' ? 'outline' : node.id === 'sanguo-shot-script' ? 'storyboard' : undefined
    const reviewStage = ['sanguo-scene-outline-review', 'sanguo-shot-script-review'].includes(node.id) ? 'text'
      : node.id === 'sanguo-media-review' ? 'media' : node.id === 'sanguo-episode-review' ? 'episode' : undefined
    if (!stage && !reviewStage) return node
    const prompt = stage ? refreshDramaticExpressionPrompt(node.prompt, stage) : refreshReviewPrompt(node.prompt, reviewStage!)
    if (prompt === node.prompt) return node
    changed = true
    return { ...node, prompt }
  })
  return changed || (workflow.schemaVersion ?? 0) < 145
    ? { ...workflow, schemaVersion: Math.max(145, workflow.schemaVersion ?? 0), nodes } : workflow
}
