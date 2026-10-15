/** Browser-safe, exact node contracts for the source-bound fresh first frame.
 * The server separately checks the signed DB ancestry before any paid call. */
import { SCENE_CUT_FIRST_FRAME_PROMPT_V178 } from './scene-cut-geometry-guide-workflow.ts'
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } from './scene-cut-action-start-workflow.ts'
import { SCENE_CUT_FIRST_FRAME_PROMPT_V176 } from './scene-cut-closure-start-layout-workflow.ts'

export const A8B6_FRESH_V2_FRAME_ID = 'record-4x5m31-a8b6-fresh-first-frame-v2'
export const A8B6_FRESH_V2_FRAME_VERSION = 'scene-cut-a8b6-fresh-first-frame-v2'
export const A8B6_FRESH_V2_FIRST_FRAME_PROMPT = `${SCENE_CUT_FIRST_FRAME_PROMPT_V178}\n
【A8B6 新首帧身份修复·独立生成】两张冻结人物身份板仍是唯一具名人物依据；旧失败首帧与旧视频不作为本次图像参考，也不复制其中任何人脸或衣摆。严颜须发按其冻结原三视图的实际深浅与成熟年龄绘制，保留原图自然灰度，不把旧失败图中颏须下半段与两鬓泛白、额眉及面颊皱纹加深复制到新图，也不要求纯黑。严颜灰褐外袍、连续深色内摆、裤靴三层按同一人设正面图腰带到鞋底的相对地标绘制：外摆约在0.69–0.72、内摆约在0.84–0.86，鞋靴露出保留原图短段；透视和衣褶可自然变化，不把深色内摆整体拉到旧失败图约0.89–0.90而显著压缩露靴。张飞脸、发冠、衣甲和身形也只取自己的冻结板。保留已批准14秒分镜的 t=0：张飞手未举、军士尚未合拢、严颜双腕分开未缚，唯一持绳者的手、松弛工作段和真实自由端可见，张飞与严颜仍有走近空间。输出一张完整写实首帧，不提前画后续8–14秒动作。`

export const A8B6_FRESH_V2_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 新首帧独立身份核验】本图是新付费生成，不继承旧首帧的任何通过结论。严颜冻结三视图仍是脸型、须发自然深浅、皱纹年龄、外袍/连续内摆/裤靴比例的唯一依据。逐像素报告新图是否复制了旧失败图的灰白颏须/两鬓或过重皱纹，以及是否把深色内摆整体下拉、压缩露靴。不要把“必须纯黑”当作身份要求；自然灰度按原图。也须按上文完整核对 setting、全部人物、动作起点、军士脚和持绳端、背景字形及全部衣甲，不能只因上述两处改善就通过。`

export const A8B6_FRESH_FRAME_ID = 'record-4x5m31-a8b6-fresh-first-frame-v3'
export const A8B6_FRESH_FRAME_VERSION = 'scene-cut-a8b6-fresh-first-frame-v3'
export const A8B6_FRESH_FIRST_FRAME_PROMPT = `${A8B6_FRESH_V2_FIRST_FRAME_PROMPT}\n
【仅修本次实审两处失败】严颜须发与额眼皮肤只沿冻结身份板原像素：颏须和两鬓以原板深色主体及其本来少量自然灰丝为准，脸型和细纹按板，不增加整片浅灰颏须或加重额头、眼周皱纹。左后近身合拢军士是严颜身侧下一步靠近的必要执行者，应站在严颜袍身轮廓外；其两侧髋、双膝、两条承重腿、双靴与各自接地点均有可视分离，零秒没有迈步或向前跨。最左侧远处背景守兵不能代替这名近身执行者的起点证明。右侧唯一持绳军士仍只持一根松绳；严颜双腕仍分开未缚。不要把上次失败图用作参考，保持冻结板的服装层次、深色内摆与露靴比例。`
export const A8B6_FRESH_REVIEW_PROMPT = `${A8B6_FRESH_V2_REVIEW_PROMPT}\n
【本次新增实审焦点】独立核严颜颏须、两鬓、额眼纹理与冻结原板的实际深浅和年龄；自然灰丝允许，不要求纯黑。逐人区分最左侧背景守兵与严颜左后近身合拢军士；后者两侧髋、双膝、双靴和接地点须各有可见正证，能排除零秒迈步。若被严颜袍身遮挡无法排除，则 b01-close 起点和全部必要动作起点不通过。仍审原合同其余所有项目，不能因两处改善而自动通过。`

export const A8B6_FRESH_EDIT_FRAME_ID = 'record-4x5m31-a8b6-fresh-first-frame-v4-edit'
export const A8B6_FRESH_EDIT_FRAME_VERSION = 'scene-cut-a8b6-fresh-first-frame-v4-edit'
export const A8B6_FRESH_EDIT_FIRST_FRAME_PROMPT = `【A8B6 十四秒新首帧·受管局部编辑】
仅当服务端为本次请求验签并附上三张精确来源的参考图时执行编辑：第1张张飞、第2张严颜是冻结三视图原图裁出的身份板，是脸、须发、衣甲和连续下摆的唯一人物依据；第3张是 v3 独立图审已拒绝的完整首帧，只供保留其已经核对正确的江州街景、斜侧机位、张飞和严颜相对站位、唯一持绳者、未缚双腕、绳端与衣装层次。第3张的人脸和被遮挡的军士腿脚没有身份或动作起点效力，不得照抄；旧图不是已批准首帧。仅修两处已记录的失败：
一、严颜颏须按第2张原板的实际深灰褐主体与少量自然灰丝、尖形和宽度重绘；不复制第3张较大亮灰蓬松须区，也不强行画纯黑。额眼皮肤、两鬓按原板真实像素的成熟年龄，不添加更重皱纹或额外白发。张飞依第1张保持原容貌。
二、严颜左后近身、下一步要合拢缺口的军士保持原批准的同侧、侧后景深，但整个人向严颜袍身轮廓外侧错开足够横向距离；靠袍侧和外侧的髋、双膝、两条腿、双靴与各自接地点都须在袍外形成清楚可辨的独立像素，不被严颜衣袍、另一人、兵器或景物遮住。零秒仍原地承重、未前跨、未伸手，目标身前缺口仍敞开。画面最左侧远景守兵只是背景，不能替代该近身执行者。右侧唯一持绳军士完整入画，保留一根松绳的真实自由端；严颜双腕分开未缚。
其余已通过的场所、人物数、左右关系、衣甲、严颜外摆与深色内摆和露靴比例、无字背景和起点关系保持。不得增加道具、第二根绳、旗幡或台词，不提前执行 0–14 秒后续动作。新图必须重新全项采证、独立模型审图和签首帧证书。输出单幅真实感 16:9 首帧，不输出拼贴、标线或说明文字。
以下是获批分镜零秒起点的完整通用要求：
${SCENE_CUT_FIRST_FRAME_PROMPT_V176}`
export const A8B6_FRESH_EDIT_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 v4 编辑图独立全项审核】第1、2张冻结身份板是唯一具名人物身份依据；编辑所用 v3 拒绝图只约束已通过的构图与道具，不继承旧审核通过项。逐像素检查严颜颏须深浅、灰丝面积、尖形与宽度、额眼皮肤及两鬓；自然灰度允许，不要求纯黑。明确区分最左远景守兵和严颜左后近身合拢者，后者两侧髋、双膝、两条腿、双靴及各自接地点须在严颜袍外有可见正证，能排除零秒已迈步。按原 v174 全合同独立审核动作起点、身份、衣摆/露靴、唯一松绳和自由端、场所及全部已批准人物，任一项不确定即不通过。`

export const A8B6_FRESH_V4_REVIEW_RETRY_ID = 'record-k0rkqe'
export const A8B6_FRESH_V5_EDIT_FRAME_ID = 'record-4x5m31-a8b6-fresh-first-frame-v5-edit'
export const A8B6_FRESH_V5_RUNTIME_RETRY_ID = 'record-4x5m31-a8b6-fresh-first-frame-v5-runtime-retry'
export const A8B6_FRESH_V5_EDIT_FRAME_VERSION = 'scene-cut-a8b6-fresh-first-frame-v5-edit'
export const A8B6_FRESH_V5_EDIT_FIRST_FRAME_PROMPT = `【A8B6 十四秒新首帧·第二次受管局部编辑】
服务端只可附三张已验签参考：第1张张飞、第2张严颜为冻结三视图原图裁出的身份板，仍是脸、须发、衣甲和下摆的唯一人物依据；第3张为 v4 独立实图审核已拒绝的首帧，仅供沿用已经核对合格的街景、机位、人物左右关系、严颜脸须自然深浅、连续双层袍摆与露靴比例、右侧唯一持绳者的一根松绳及真实自由端、双腕未缚状态。第3张未获首帧批准，尤其其左后近身军士一侧髋膝被严颜遮挡的像素不得照抄，也不能变成人物身份依据。
只做已记录的局部空间修正：严颜左后近身、在0–2.5秒后才合拢缺口的军士，仍在严颜同侧、同一景深和相同守位职责，整个人横向退到严颜左臂和袍身外轮廓之外。旧图该军士中心约画幅宽度0.60、严颜左外轮廓约0.62；可将军士中心移到画幅宽度约0.49–0.52，在军士和严颜之间留下至少约5%画宽的可见背景带，但最终以完整双腿的实际可视分离为准。在他与严颜之间保持一条从两人髋部经过双大腿、双膝延伸到双靴的连续可见背景空隙；他自己的左右髋、两条完整大腿、两侧膝、两条小腿、双靴、鞋底接地点必须独立成像，不能被严颜手臂、衣袍、别的军士、兵器或景物覆盖。他零秒双脚着地、重心安定、没有抬足前跨、未伸手，身前缺口仍敞开，后续仍有合拢路径。最左侧远景守兵仅为背景，不能冒充这名近身执行者；不新增第三名近身操作者。
保留 v4 其余画面中已通过的张飞与严颜容貌、年龄、衣甲、绳端和起点，不扩大严颜颏须或增加灰白，不重新排列右侧持绳军士；具名人物仍以两冻结板为准。严颜双腕分开未缚，张飞未举手，未有人先行合拢。不增加道具、第二根绳、旗幡、文字或台词，不提前执行本镜0–14秒的后续动作。输出单幅真实感16:9首帧，不输出拼贴、标线或说明文字。新图必须再次全项采证、独立模型审图和签首帧证书。
以下是获批分镜零秒起点的完整通用要求：
${SCENE_CUT_FIRST_FRAME_PROMPT_V176}`
export const A8B6_FRESH_V5_EDIT_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 v5 编辑图独立全项审核】第1、2张冻结身份板仍为具名人物身份唯一依据。v4 拒图是布局参考，不继承旧图任何通过结论。逐像素识别严颜左后近身合拢军士与最左远景守兵；对近身者核实两侧髋、完整双大腿、双膝、双小腿、双靴和接地点均在严颜左臂及袍侧外清楚可见，军士与严颜之间从髋到靴有连续背景空隙；不能只凭一条承重腿、远景兵或缺口仍开推断另一腿未前跨。仍按原 v174 全合同独立审具名人物脸须年龄、双层下摆及露靴、唯一松绳自由端、地点和所有动作起点。任何项不确定即不通过。`

export const A8B6_FRESH_V6_EDIT_FRAME_ID = 'record-4x5m31-a8b6-fresh-first-frame-v6-edit'
export const A8B6_FRESH_V6_EDIT_FRAME_VERSION = 'scene-cut-a8b6-fresh-first-frame-v6-edit'
export const A8B6_FRESH_V6_EDIT_FIRST_FRAME_PROMPT = `【A8B6 十四秒新首帧·受管局部编辑第六版】
服务端只附三张签名来源参考：第1张张飞、第2张严颜为冻结三视图原图裁出的身份板，是具名人物脸、须发、发冠、衣甲和连续双层下摆的唯一依据；第3张为 v5 独立实图审核已拒绝的完整首帧，仅供保留本次已实见正确的江州街道和斜侧机位、张飞与严颜左右关系、两名近身军士的已分开守位、右侧一根松绳及自由端、严颜双腕分开未缚和衣摆露靴比例。第3张未经首帧批准，人物身份和左下地面纹理不得照抄。
仅修两个已记录的局部失败，其他构图和动作起点保持：
一、严颜脸和下颌须必须按第2张冻结身份板原像素重绘。其颏须以板中深褐黑主体、少量自然灰丝、窄而尖的轮廓为准；收窄 v5 第3张灰白蓬松的下颌须区域，降低过亮灰白面积，不增加纯黑块。额部、眉眼与两鬓按原板成熟但不额外衰老的纹理，不复制 v5 偏重的额眼皱纹；不改变严颜脸型、发冠、灰褐袍与深色内摆。张飞继续严格依第1张板。
二、清理 v5 第3张左下角张飞左靴左上方碎石地面被实审指出的浅白色横排水印样笔画和拟字形，只用与周边一致的不规则砂石、碎木、阴影自然填满该局部。张飞左右靴的外轮廓和各自鞋底接地点保持不动。地面以及建筑、旗面、服装、兵器均无可辨字形、标记、字幕或水印；不通过模糊一片遮盖，也不添加新的符号。
严颜左后近身合拢军士仍保持 v5 已通过的横向分离：其双侧髋、完整双大腿、双膝、双小腿、双靴及鞋底接地点在严颜左臂/袍侧外独立可见，两人髋到靴之间保持连续背景空隙；不得因修脸/地面又把他推回严颜身后。两名近身军士零秒仍双脚着地未起步，张飞手未举，缺口仍开；右侧唯一持绳者的一根松绳和真实自由端继续可见，严颜双腕仍未缚。保留已正确的衣甲、下摆和露靴，人物数、道具数与终点空间不变。不得提前执行本镜0–14秒后续动作或添加对白。输出单幅真实感16:9首帧，不输出拼贴、标线或说明文字。新图需重新全项采证、独立模型审图和签首帧证书。
以下是获批分镜零秒起点的完整通用要求：
${SCENE_CUT_FIRST_FRAME_PROMPT_V176}`
export const A8B6_FRESH_V6_EDIT_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 v6 编辑图独立全项审核】第1、2张冻结身份板是具名人物唯一身份依据；v5 拒图仅供布局参照，不继承任何通过结论。逐像素核严颜脸型、眉眼、额纹、两鬓及窄尖深褐颏须自然灰度，不能把脸更老或胡须成片灰白；核左下张飞左靴上方碎石地面与全景其余区域，任何实见可辨文字、拟字、水印均拒绝。并再次核左后近身合拢军士双侧髋、双大腿、双膝、双靴和与严颜间连续背景缝、右侧唯一松绳自由端、未缚双腕、人物衣甲/双层下摆及全部已批准动作起点。依据完整原 v174 合同独立判定，任一项不确定即不通过。`

export const A8B6_FRESH_V7_EDIT_FRAME_ID = 'record-4x5m31-a8b6-fresh-first-frame-v7-edit'
export const A8B6_FRESH_V7_EDIT_FRAME_VERSION = 'scene-cut-a8b6-fresh-first-frame-v7-edit'
export const A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT = `【A8B6 十四秒新首帧·严颜身份局部编辑第七版】
服务端按签名顺序提供四张参考。第1张张飞冻结身份板，第2张严颜冻结身份板；第4张是从第2张板按固定裁切框截取的严颜脸部原像素局部，未重画、未插值，它与第2张共同作为严颜脸、下颌须和额眼纹理的身份权威。第3张是 v6 已被独立审核拒绝的完整首帧，只能作为江州街道、斜侧全景、四名前景人物站位和已解决动作起点的布局参考；绝不从第3张复制严颜脸须或额眼皱纹。
唯一需要修正的是严颜脸部身份年龄感。按第2和第4张的实际像素重建同一张脸：维持板中成熟而非额外衰老的额头与眼周纹理、脸型、两鬓及发冠；颏须主体为窄尖深褐黑，只有板上实际少量自然灰丝，绝无 v6 第3张颏须中段和两侧的成片浅灰或横向蓬松外扩。不要把胡须涂成无纹理纯黑，也不要改严颜上衣、腰腹甲、前垂甲片、双层下摆及露靴比例。张飞仅按第1张板保持身份。
严格保留 v6 已实见正确的全景其余像素与动作起点：张飞未举手且双脚接地；严颜双腕分开未缚；左后近身军士的双侧髋、完整双大腿、双膝、双小腿、双靴和鞋底接地点独立可见，与严颜袍侧从髋到靴保有连续背景缝；右侧军士仍持唯一一根松绳、环垂和一个自由端；身前缺口未封，二军士未起步。保持 v6 已清洁的左下砂石，不出现可辨文字、拟字或水印。建筑、日光、机位、人物数量和站位、衣甲道具都不重排。不得提前执行本镜0–14秒后续动作、添加对白或拼贴说明。输出单幅真实感16:9首帧；新图必须重新全项采证、独立模型审图并签首帧证书。
以下是获批分镜零秒起点的完整通用要求：
${SCENE_CUT_FIRST_FRAME_PROMPT_V176}`
export const A8B6_FRESH_V7_EDIT_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 v7 编辑图独立全项审核】第1张张飞身份板、第2张严颜身份板及其第4张同源原像素脸部裁片为具名身份唯一依据；第3张 v6 拒图仅供布局，不继承任何通过结论。逐像素独立核严颜脸型、额眉眼纹、两鬓与深褐窄尖颏须，若仍有超出冻结板的成片浅灰、蓬松外扩或更老纹理，则 castAndIdentity=false。重新核其余完整 v174 合同：左后军士双髋腿膝靴与连续背景缝、唯一松绳自由端、未缚双腕、张飞未举手、衣甲/下摆/露靴、左下砂石无拟字及全部零秒起点。任一项不确定即不通过。`

export const A8B6_FRESH_V8_EDIT_FRAME_ID = 'record-4x5m31-a8b6-fresh-first-frame-v8-edit'
export const A8B6_FRESH_V8_EDIT_FRAME_VERSION = 'scene-cut-a8b6-fresh-first-frame-v8-edit'
export const A8B6_FRESH_V8_EDIT_FIRST_FRAME_PROMPT = `【A8B6 十四秒新首帧·严颜脸区遮挡来源编辑第八版】
服务端按签名顺序附五张图：第1张张飞冻结身份板；第2张严颜冻结身份板；第3张是 V7 已拒绝全景的确定性布局图，其严颜脸须及额眼区域已被不透明矩形遮住，只供江州街景、机位、四人站位、近卫双腿/背景缝、唯一松绳、双腕未缚、衣甲和地面布局，不能提供严颜脸部身份信息；第4张是 V4 全景原像素严颜头脸裁片，当时真实独立审核的身份项通过，但整图因近卫遮足拒绝，故仅作低优先级外观辅助，不能替代身份板；第5张是从第2张冻结严颜板按签名框取得的原像素脸裁片，与第2张共同是严颜脸、额眼、须发的唯一身份权威。五图中的旧全景均不是获批首帧。
仅在第3张被遮挡的严颜脸区重建与第2、5张同一人的成熟面容：额眉眼周的纹路、两鬓和窄尖下颏须依冻结原像素；深褐主体与板上少量自然灰丝同在，不在下唇两侧扩成片状浅灰或横向蓬松。第4张只帮助确定该人贴合全景光照与头部视角；若与冻结板冲突，必须服从第2、5张。保持第3张未遮挡区域的构图和已实审通过的身体、脚位、绳端、衣摆、左下自然碎石；遮挡矩形本身不得出现在成品。张飞未举手，严颜双腕分开未缚，二军士未起步，身前缺口仍开。不得加人、道具、旗字、对白、拼贴或提前执行后续动作。输出单幅完整写实16:9零秒首帧，再按完整合同独立采证和审签。
以下是获批分镜零秒起点的完整通用要求：
${SCENE_CUT_FIRST_FRAME_PROMPT_V176}`
export const A8B6_FRESH_V8_EDIT_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 v8 五参考图独立全项审核】第1、2张冻结人物身份板及第5张严颜同源原像素脸裁片是具名身份唯一权威；第4张 V4 严颜头脸只作低优先级角度/光照辅助；第3张 V7 脸区遮挡图只能证明布局，不能给严颜脸投票。候选图严颜额眉眼、两鬓及窄尖深褐颏须必须按冻结板独立逐像素判定，若仍有下唇两侧成片浅灰、横向蓬度或过重额眼纹则 castAndIdentity=false。重新核完整 v174 合同：环境与人物数、近卫双髋腿膝双靴和连续背景缝、右侧唯一松绳端、双腕未缚、张飞未举手、衣甲及双层下摆/露靴、左下无拟字和全部零秒动作起点。不得继承旧图的通过项；任一不确定即不通过。`

const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value)
    .filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`
    : JSON.stringify(value ?? null)

/** Only these two exact prompt+marker contracts survive the ordinary schema
 * refresh. All other idle and failed nodes continue using current workflow. */
export function preservesA8B6FreshManagedNode(run: { node: { id: string;
  prompt?: unknown; params?: Array<{ name?: string; englishName?: string;
    type?: string; value?: string }> }; sourceBoundNodeOverride?: unknown },
  baseNode: { id: string; prompt?: unknown; params?: Array<{ name?: string;
    englishName?: string; type?: string; value?: string }> }) {
  const override = run.sourceBoundNodeOverride as Record<string, unknown> | undefined
  const marker = override?.marker as Record<string, unknown> | undefined
  const version = override?.version
  const contract = version === A8B6_FRESH_FRAME_VERSION
    ? { first: A8B6_FRESH_FIRST_FRAME_PROMPT,
      review: A8B6_FRESH_REVIEW_PROMPT }
    : version === A8B6_FRESH_EDIT_FRAME_VERSION
      ? { first: A8B6_FRESH_EDIT_FIRST_FRAME_PROMPT,
        review: A8B6_FRESH_EDIT_REVIEW_PROMPT }
      : version === A8B6_FRESH_V6_EDIT_FRAME_VERSION
        ? { first: A8B6_FRESH_V6_EDIT_FIRST_FRAME_PROMPT,
          review: A8B6_FRESH_V6_EDIT_REVIEW_PROMPT }
      : version === A8B6_FRESH_V7_EDIT_FRAME_VERSION
        ? { first: A8B6_FRESH_V7_EDIT_FIRST_FRAME_PROMPT,
          review: A8B6_FRESH_V7_EDIT_REVIEW_PROMPT }
      : version === A8B6_FRESH_V8_EDIT_FRAME_VERSION
        ? { first: A8B6_FRESH_V8_EDIT_FIRST_FRAME_PROMPT,
          review: A8B6_FRESH_V8_EDIT_REVIEW_PROMPT }
      : version === A8B6_FRESH_V5_EDIT_FRAME_VERSION
        ? { first: A8B6_FRESH_V5_EDIT_FIRST_FRAME_PROMPT,
          review: A8B6_FRESH_V5_EDIT_REVIEW_PROMPT }
      : version === A8B6_FRESH_V2_FRAME_VERSION
      ? { first: A8B6_FRESH_V2_FIRST_FRAME_PROMPT,
        review: A8B6_FRESH_V2_REVIEW_PROMPT } : undefined
  const expected = run.node.id === 'sanguo-scene-cut-first-frame'
    ? contract?.first : run.node.id === 'sanguo-scene-cut-review'
      ? contract?.review : undefined
  const markerParam = run.node.params?.filter(param =>
    param.name === 'sceneCutFreshImage') ?? []
  const expectedNode = { ...baseNode, prompt: expected,
    params: [...(baseNode.params ?? []),
      { name: 'sceneCutFreshImage', englishName: 'sceneCutFreshImage',
        type: 'json', value: canonical(marker) }] }
  if (!expected || !contract || !override || !marker) return false
  return Boolean(override.nodeId === run.node.id
    && marker.version === version
    && marker.sourceExecutionId === 'record-4x5m31-a8b6-timing-approval-v3'
    && marker.rejectedExecutionId === 'record-4x5m31-a8b6-frame-conflict-review-v1'
    && marker.workflowSchemaVersion === 180
    && marker.workflowNodesMd5 === '3ed9cf16e56b311458f4c6fa7e7f1e2e'
    && marker.workflowEdgesMd5 === '1d0a75acb3d4778a122a4cfd96a23b49'
    && (version !== A8B6_FRESH_FRAME_VERSION
      || marker.priorFreshExecutionId === A8B6_FRESH_V2_FRAME_ID)
    && (version !== A8B6_FRESH_EDIT_FRAME_VERSION
      || marker.priorFreshExecutionId === A8B6_FRESH_FRAME_ID)
    && (version !== A8B6_FRESH_V5_EDIT_FRAME_VERSION
      || marker.priorFreshExecutionId === A8B6_FRESH_V4_REVIEW_RETRY_ID)
    && (version !== A8B6_FRESH_V6_EDIT_FRAME_VERSION
      || marker.priorFreshExecutionId === A8B6_FRESH_V5_RUNTIME_RETRY_ID)
    && (version !== A8B6_FRESH_V7_EDIT_FRAME_VERSION
      || marker.priorFreshExecutionId === A8B6_FRESH_V6_EDIT_FRAME_ID)
    && (version !== A8B6_FRESH_V8_EDIT_FRAME_VERSION
      || marker.priorFreshExecutionId
        === 'record-4x5m31-a8b6-fresh-v7-dual-output-recovery')
    && run.node.prompt === expected && markerParam.length === 1
    && markerParam[0].type === 'json'
    && markerParam[0].englishName === 'sceneCutFreshImage'
    && markerParam[0].value === canonical(marker)
    && canonical(run.node) === canonical(expectedNode))
}
