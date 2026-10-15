/** Exact, browser-safe review contract for a deterministic local first frame. */
import { SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } from
  './scene-cut-action-start-workflow.ts'
import { A8B6_LOCAL_V8_REVIEW_IMAGE_DETAIL,
  A8B6_LOCAL_V9_REVIEW_IMAGE_DETAIL } from
  './scene-cut-a8b6-local-detail-review.ts'

export const A8B6_LOCAL_FRAME_ID = 'record-4x5m31-a8b6-local-face-v1'
export const A8B6_LOCAL_FRAME_VERSION = 'scene-cut-a8b6-local-first-frame-v1'
export const A8B6_LOCAL_V2_FRAME_ID = 'record-4x5m31-a8b6-local-face-v2'
export const A8B6_LOCAL_V2_FRAME_VERSION = 'scene-cut-a8b6-local-first-frame-v2'
export const A8B6_LOCAL_V3_FRAME_ID = 'record-4x5m31-a8b6-local-face-wall-v3'
export const A8B6_LOCAL_V3_FRAME_VERSION = 'scene-cut-a8b6-local-first-frame-v3'
export const A8B6_LOCAL_V4_FRAME_ID = 'record-4x5m31-a8b6-local-wall-v4'
export const A8B6_LOCAL_V4_FRAME_VERSION = 'scene-cut-a8b6-local-first-frame-v4'
export const A8B6_LOCAL_V5_FRAME_ID = 'record-4x5m31-a8b6-local-wall-v5'
export const A8B6_LOCAL_V5_FRAME_VERSION = 'scene-cut-a8b6-local-first-frame-v5'
export const A8B6_LOCAL_V6_FRAME_ID = 'record-4x5m31-a8b6-local-wall-v6'
export const A8B6_LOCAL_V6_FRAME_VERSION = 'scene-cut-a8b6-local-first-frame-v6'
export const A8B6_LOCAL_V7_FRAME_ID = 'record-4x5m31-a8b6-local-wall-v7'
export const A8B6_LOCAL_V7_FRAME_VERSION = 'scene-cut-a8b6-local-first-frame-v7'
export const A8B6_LOCAL_V8_FRAME_ID = 'record-4x5m31-a8b6-local-wall-v8'
export const A8B6_LOCAL_V8_FRAME_VERSION = 'scene-cut-a8b6-local-first-frame-v8'
export const A8B6_LOCAL_V9_FRAME_ID = 'record-4x5m31-a8b6-local-wall-v9'
export const A8B6_LOCAL_V9_FRAME_VERSION = 'scene-cut-a8b6-local-first-frame-v9'
export const A8B6_LOCAL_FRAME_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 本地派生首帧独立全项审核】本候选仅在严颜脸部小范围内由已拒绝的 V7 全景与曾在身份项通过的 V4 脸部来源按签名算法确定性合成；来源可追溯和区域外像素不变不代表画面合格。冻结的张飞、严颜身份板仍是具名人物外观唯一权威，V4 脸只能作来源和视角辅助。请直接看本次实图，独立逐像素判严颜额眉眼年龄感、脸型、两鬓及窄尖深褐颏须与板是否相符；不得因来源 V4 的历史身份项通过就继承结论。检查脸区边缘、发须纹理与光照是否自然，有无拼接缝或色块。
同时重新完成原 v174 的所有审核：江州街景和人物数、张飞身份与零秒手脚起点、严颜双腕未缚、左后近身军士双髋双腿双膝双靴及与严颜间连续背景缝、右侧唯一松绳与自由端、两人衣甲双层袍摆及露靴、左下及全景无字形水印、动作未提前执行。区域外像素锁定只证明未被算法改动，不能代替审核。任一项目不确定或不合格即拒绝，并给具体位置与证据。`
export const A8B6_LOCAL_V2_FRAME_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 局部脸像素来源第二版独立全项审核】本候选以前次已拒绝的 V7 全景为非脸布局来源，严颜脸部局部使用新的独立来源并以确定性区域合入；V7、前次本地候选和 V8 均不是获批首帧。冻结严颜三视图及其同源原像素脸裁片仍是脸型、额眉眼、两鬓与颏须的唯一身份权威，任何派生脸都须以这份原板实图判定。请核候选额眼成熟度、面颊下颌宽度、窄尖深褐颏须和仅原板比例的自然灰丝；尤其不能重现前次真实拒绝记录中较老额眼、宽脸和灰褐蓬散须。检查脸区几何透视、发须纹理、光照与边缘是否自然，不能把局部来源或像素不变证明当作通过证据。
完整重审原 v174 合同：江州街景与人物数，张飞身份与零秒手脚起点，严颜分开未缚双腕，左后近身军士双髋、双腿、双膝、双靴和连续背景缝，右侧唯一松绳及自由端，衣甲双层下摆与露靴，左下及全景无字形水印，所有后续动作均未在零秒提前发生。任一不确定或不合格即拒绝。`
export const A8B6_LOCAL_V3_FRAME_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 第三版局部来源首帧独立全项审核】本候选从已拒绝的 V2 首帧出发，仅墙体材质与严颜脸部两个有界区域产生新像素。签名来源和区域外像素不变只证明派生过程，不代表画面合格；V2 模型曾拒绝中央城门及两侧立柱的块石砌缝和严颜脸部身份。不得继承旧版任何通过项，也不得把局部来源图当成冻结人设。
请直接看本次实图，先核批准零秒场景要求的夯土墙面是否实见、中央城门与两侧立柱是否无明显块石轮廓或规则砌缝；新墙面与城门、木构、天空、人物边缘的光照和透视必须自然。严颜三视图及同源原像素脸裁片仍是身份唯一权威：核额眼纹理、面颊下颌宽度、窄尖深褐颏须及仅原板比例的自然灰丝；严查旧 V2 显老额眼与灰白外散须是否残留，有无双脸、拼接缝或色块。
完整重审原 v174 全项：张飞身份与零秒手脚起点、严颜双腕分开未缚、左后近身军士双髋腿膝靴及与严颜之间连续背景缝、右侧唯一松绳与自由端、人物数和衣甲双层下摆/露靴、地面及全景无字形水印、所有后续动作在零秒均未提前完成。任一项目不确定或不合格即拒绝，列出画面位置和实际证据。`
export const A8B6_LOCAL_V4_FRAME_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 第四版局部来源首帧独立全项审核】本候选从已拒绝的 V3 首帧出发，仅城墙及立柱的有界区域产生新像素。V3 真审核仍在中央城门墙面、左侧高立柱和右侧立柱发现规则块面与砌缝，故不得继承 V3 的任何通过结论；签名来源及区域外像素不变只证明派生过程，不代表本次画面合格。
请直接看本次实图，严格核城楼下方至门框上方的可见墙体、垛口、中央门洞两侧立柱和木构邻接处：是否连续呈自然夯土层理，且无明显单块石轮廓、重复水平砌缝或竖向灰缝。墙体、塔楼、天空、门洞木构、军士和其他前景人物边界须保持自然，无重影、拉伸或涂抹。严颜冻结三视图仍是身份唯一权威，需独立重核脸型、额眼、两鬓和窄尖深褐颏须；不可因为 V3 本项未列 issue 就自动放行。
完整重审原 v174 全项：张飞身份与零秒手脚起点、严颜双腕分开未缚、左后近身军士双髋双腿双膝双靴及与严颜之间连续背景缝、右侧唯一松绳与自由端、人物数与衣甲双层下摆及露靴、左下和全景无字形水印、所有后续动作在零秒均未提前完成。任何不确定或不合格项都应拒绝，并写出画面位置与实见证据。`
export const A8B6_LOCAL_V5_FRAME_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 第五版局部墙体首帧独立全项审核】V4 的同图独立审核实见左侧高立柱、右侧木构旁立柱及门洞侧边仍有规则块石砌缝，因此拒绝；V4 的节点执行因传输失败而未获审批。本候选以 V4 实图为底，仅在签名限定的墙体区域替换像素。来源、区域外像素锁定及 V4 审核中其他项目的结论均不代表本图合格，不得继承任何通过项。
请逐处看左侧高立柱、右侧木构旁立柱、门洞左右侧边、城楼下墙面和垛口，确认所有可见墙区为连续自然夯土或原土抹面，不能有矩形单块石轮廓、重复水平灰缝、短竖砌缝或砖石网格。核墙面与门洞木柱、横梁、天空、建筑及人物的遮挡、纹理、透视和光照边缘，无贴片、涂抹或错位；木结构必须仍清晰可辨。严颜冻结三视图仍是具名身份权威，独立检查脸型、额眼、两鬓和窄尖深褐颏须。
完整重审原 v174 全项：江州街景、人物数、张飞身份与零秒手脚起点、严颜双腕分开未缚、左后近身军士双髋双腿双膝双靴及与严颜之间的连续背景缝、右侧唯一松绳与自由端、衣甲双层下摆与露靴、左下和全景无字形水印、所有后续动作在零秒均未提前完成。任一项目不确定或不合格即拒绝，写明画面位置与实见证据。`
export const A8B6_LOCAL_V6_FRAME_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 第六版局部墙体首帧独立全项审核】V5 的真实独立审核拒绝了画面左侧高立柱上半段近水平暗分界连接短竖分界形成的疑似矩形块面，也无法排除右侧木构旁立柱及门洞两侧局部墙条的残余砌缝。本次候选从 V5 拒图出发，仅在签名限定的墙体区域替换像素。来源、区域外像素锁定和旧审核结论均不代表本图合格，不得继承任何通过项。
请逐处独立看左侧高立柱全高、右侧木构旁立柱、门洞左右侧边、城楼下墙面与垛口：可见墙区是否连续自然夯土或原土抹面，是否完全没有矩形单块石轮廓、重复水平暗砌缝、短竖灰缝或砖石网格。尤其辨认墙体自然土层与木柱、横梁、门洞阴影、遮挡边缘的区别；任何位置不能从实图确认土面连续性即拒绝。墙面与天空、木构、人物、地面边缘的光照和透视须自然，无贴片、涂抹、重影或错位，木结构保持清晰。严颜冻结三视图仍是具名身份唯一权威，须独立核脸型、额眼、两鬓及窄尖深褐颏须。
完整重审原 v174 全项：江州街景、人物数、张飞身份与零秒手脚起点、严颜双腕分开未缚、左后近身军士双髋双腿双膝双靴及与严颜之间连续背景缝、右侧唯一松绳及自由端、衣甲双层下摆和露靴、左下及全景无字形水印、所有后续动作在零秒均未提前完成。任一项目不确定或不合格即拒绝，写明画面位置与实见证据。`
export const A8B6_LOCAL_V7_FRAME_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 第七版局部墙体首帧独立全项审核】V6 真实独立审核已通过人物、动作起点和左侧高立柱等项目，但因门洞右侧及木框邻接的狭窄墙条、右侧木构旁立柱下段灰褐碎纹与暗边交叠，无法逐处确认土面连续性而拒绝。该审核没有断言那里存在砖石网格。本图从 V6 拒图出发，仅在签名限定墙体区域替换像素。旧审核、来源签名和区域外像素不变都不能代替本次实图审核；不得继承任何通过结论。
请重点逐处辨认右侧木构旁立柱从顶到底的全部可见土面，尤其下段与灰色基座、木构和地面邻接处；还要辨认门洞右侧及木框邻接的每条狭窄墙面。它们须实见连续自然夯土或原土抹面，且不得有矩形单块石轮廓、重复水平暗砌缝、短竖灰缝或砖石网格。若窄条、暗边、木构遮挡或像素不足导致任何可见墙区材质不能确认，必须拒绝。再独立核左侧高立柱全高、门洞左侧、城楼下墙面和垛口。墙体与木柱、横梁、天空、人物、地面的遮挡、纹理、透视和光照应自然，无贴片、涂抹、重影或错位，木结构仍清晰可辨。
完整重审原 v174 全项：江州街景与人物数、张飞身份及零秒手脚起点、严颜冻结三视图对应脸型额眼两鬓及窄尖深褐颏须、严颜双腕分开未缚、左后近身军士双髋双腿双膝双靴及与严颜之间连续背景缝、右侧唯一松绳与自由端、衣甲双层下摆及露靴、左下及全景无字形水印、后续动作在零秒均未提前完成。任一项目不确定或不合格即拒绝，写明画面位置及实见证据。`
export const A8B6_LOCAL_V8_FRAME_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 第八版局部墙体首帧独立全项审核】V7 真实独立审核因右侧木构旁立柱下段及门洞右侧狭窄墙条的材质仍不能确认而拒绝；这不是已证实的砖石网格。本候选从 V7 拒图出发，只在签名限定墙体区域替换像素。V7 的其他审核结论、来源签名和区域外像素不变均不代表本图合格，不得继承任何通过项。
本次附件保留完整首帧和原有身份参考，并额外附上从同一归档首帧 JPEG 按原生像素裁出的四块有重叠细节。细节只帮助辨认墙体与遮挡边界，不是新画面、独立来源或放宽审核的理由。必须以完整首帧判断整体场景，并用细节逐处复核右侧木构旁立柱全高、下段与基座或地面的交界、门洞右侧及木框邻接的所有可见狭窄墙条，再看左侧高立柱全高、门洞左侧、城楼下墙面和垛口。所有可见墙区须实见连续自然夯土或原土抹面，不得有矩形单块石轮廓、重复水平暗砌缝、短竖灰缝或砖石网格。木柱、横梁、灰色基座、人物遮挡与土墙须能清楚区分；墙面与木构、天空、人物及地面的纹理、透视、光照和遮挡边缘须自然，无贴片、涂抹、重影或错位。若任何可见墙区材质仍不能确认，必须拒绝。
完整独立重审原 v174 全项：江州街景与人物数、张飞冻结身份及零秒手脚起点、严颜冻结三视图对应的脸型额眼两鬓及窄尖深褐颏须、严颜双腕分开未缚、左后近身军士双髋双腿双膝双靴及与严颜之间连续背景缝、右侧唯一松绳与自由端、衣甲双层下摆及露靴、左下和全景无字形水印，后续动作在零秒均未提前完成。任一项目不确定或不合格即拒绝，并给出位置与实见证据。`
export const A8B6_LOCAL_V9_FRAME_REVIEW_PROMPT = `${SCENE_CUT_FRAME_REVIEW_PROMPT_V174}\n
【A8B6 第九版局部边缘首帧独立全项审核】V8 真实独立审核仅因完整帧最右缘 x1510..1535、y100..300 的灰褐短横斑无法区分木柱或土墙而拒绝；其他项目当时通过不能继承为本图结论。本候选从 V8 拒图出发，仅在签名限定区域替换像素。来源签名、区域外像素不变与旧审核都不能证明本次画面合格，必须独立看本次实图。
本次附件保留完整首帧和原有身份参考，并额外附上同一归档首帧 JPEG 的四块原生像素重叠裁片。先在完整帧核最右缘 x1510..1535、y100..300 是否清楚呈深棕连续纵向木纹，能与相邻夯土墙、门框阴影和画面边界分开；不能仅凭提示词认定那里是木柱。再用细节逐处看右侧木构旁立柱全高、下段与基座或地面交界、门洞右侧和木框旁全部可见窄墙条、左侧高立柱全高、门洞左侧、城楼下墙面及垛口。所有实际可见墙区须实见连续自然夯土或原土抹面，不得有矩形单块石轮廓、重复水平暗砌缝、短竖灰缝或砖石网格。木柱、横梁、灰色基座、人物遮挡与土墙须能清楚区分；墙面与木构、天空、人物及地面的纹理、透视、光照和遮挡边缘须自然，无贴片、涂抹、重影或错位。细节裁片只是同图观察辅助，不是独立来源；若画面边缘或任何可见墙区材质仍不能确认，必须拒绝。
完整独立重审原 v174 全项：江州街景与人物数、张飞冻结身份及零秒手脚起点、严颜冻结三视图对应的脸型额眼两鬓及窄尖深褐颏须、严颜双腕分开未缚、左后近身军士双髋双腿双膝双靴及与严颜之间连续背景缝、右侧唯一松绳与自由端、衣甲双层下摆及露靴、左下和全景无字形水印，后续动作在零秒均未提前完成。任一项目不确定或不合格即拒绝，并给出位置与实见证据。`

const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}` : JSON.stringify(value ?? null)

export function preservesA8B6LocalManagedReviewNode(run: { node: {
  id: string; prompt?: string; params?: Array<{ name: string;
    englishName?: string; type?: string; value?: string }> };
  sourceBoundNodeOverride?: unknown }, baseNode: typeof run.node): boolean {
  if (run.node.id !== 'sanguo-scene-cut-review') return false
  const override = run.sourceBoundNodeOverride as Record<string, unknown> | undefined
  const marker = override?.marker as Record<string, unknown> | undefined
  const reviewPrompt = override?.version === A8B6_LOCAL_FRAME_VERSION
    ? A8B6_LOCAL_FRAME_REVIEW_PROMPT
    : override?.version === A8B6_LOCAL_V2_FRAME_VERSION
      ? A8B6_LOCAL_V2_FRAME_REVIEW_PROMPT
      : override?.version === A8B6_LOCAL_V3_FRAME_VERSION
        ? A8B6_LOCAL_V3_FRAME_REVIEW_PROMPT
      : override?.version === A8B6_LOCAL_V4_FRAME_VERSION
          ? A8B6_LOCAL_V4_FRAME_REVIEW_PROMPT
          : override?.version === A8B6_LOCAL_V5_FRAME_VERSION
            ? A8B6_LOCAL_V5_FRAME_REVIEW_PROMPT
            : override?.version === A8B6_LOCAL_V6_FRAME_VERSION
              ? A8B6_LOCAL_V6_FRAME_REVIEW_PROMPT
              : override?.version === A8B6_LOCAL_V7_FRAME_VERSION
                ? A8B6_LOCAL_V7_FRAME_REVIEW_PROMPT
                : override?.version === A8B6_LOCAL_V8_FRAME_VERSION
                  ? A8B6_LOCAL_V8_FRAME_REVIEW_PROMPT
                  : override?.version === A8B6_LOCAL_V9_FRAME_VERSION
                    ? A8B6_LOCAL_V9_FRAME_REVIEW_PROMPT : undefined
  if (!reviewPrompt || !override || !marker) return false
  const params = run.node.params?.filter(param =>
    param.name === 'sceneCutLocalComposite') ?? []
  const detailParams = run.node.params?.filter(param =>
    param.name === 'reviewImageDetail') ?? []
  const detailReview = [A8B6_LOCAL_V8_FRAME_VERSION,
    A8B6_LOCAL_V9_FRAME_VERSION].includes(String(override.version))
  const detail = override.version === A8B6_LOCAL_V9_FRAME_VERSION
    ? A8B6_LOCAL_V9_REVIEW_IMAGE_DETAIL
    : A8B6_LOCAL_V8_REVIEW_IMAGE_DETAIL
  const expectedNode = { ...baseNode, prompt: reviewPrompt,
    params: [...(baseNode.params ?? []), { name: 'sceneCutLocalComposite',
      englishName: 'sceneCutLocalComposite', type: 'json',
      value: canonical(marker) }, ...(detailReview ? [{ name: 'reviewImageDetail',
        englishName: 'reviewImageDetail', type: 'json',
        value: canonical(detail) }] : [])] }
  return Boolean(override.nodeId === run.node.id
    && marker?.version === override?.version
    && marker.sourceExecutionId === 'record-4x5m31-a8b6-timing-approval-v3'
    && marker.workflowSchemaVersion === 180
    && marker.workflowNodesMd5 === '3ed9cf16e56b311458f4c6fa7e7f1e2e'
    && marker.workflowEdgesMd5 === '1d0a75acb3d4778a122a4cfd96a23b49'
    && marker.firstPendingIndex === 46
    && typeof marker.sourceReceiptSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(marker.sourceReceiptSha256)
    && typeof marker.reviewPromptSha256 === 'string'
    && marker.reviewPromptSha256 === managedPromptSha256(reviewPrompt)
    && run.node.prompt === reviewPrompt
    && params.length === 1 && params[0].type === 'json'
    && params[0].englishName === 'sceneCutLocalComposite'
    && params[0].value === canonical(marker)
    && (detailReview ? detailParams.length === 1
      && detailParams[0].englishName === 'reviewImageDetail'
      && detailParams[0].type === 'json'
      && detailParams[0].value === canonical(detail)
      : detailParams.length === 0)
    && canonical(run.node) === canonical(expectedNode))
}

function managedPromptSha256(value: string): string {
  // Browser-safe SHA literal is supplied by the signed marker. The prompt
  // itself is matched above; runtime verification recomputes SHA-256.
  return value === A8B6_LOCAL_FRAME_REVIEW_PROMPT
    ? '5fa24ee1bfb73f8729318b611d1c5d8e207d4cc02b81b42ef2120ead39233328'
    : value === A8B6_LOCAL_V2_FRAME_REVIEW_PROMPT
      ? '91ce65e3582fe906549cc8011d3ad3a2948e854694c27683587818571ee2e458'
      : value === A8B6_LOCAL_V3_FRAME_REVIEW_PROMPT
        ? 'a978a59ea149345db0541b285c9d0c938ccfb136c525b7445aa0ee0f747794b2'
        : value === A8B6_LOCAL_V4_FRAME_REVIEW_PROMPT
          ? '0070e5bb385b26e81dc6e38da5942a4f9a6a48e9ed7995de561dffe593798c6e'
          : value === A8B6_LOCAL_V5_FRAME_REVIEW_PROMPT
            ? 'f13538320c9d566bf01725e7e7e57be71fff43ae394f80ca9b442c4969422dff'
            : value === A8B6_LOCAL_V6_FRAME_REVIEW_PROMPT
              ? '95fa03dd3d7c9474203e33306284d2005c8c3cec220172ba5c9810da33a14eda'
              : value === A8B6_LOCAL_V7_FRAME_REVIEW_PROMPT
                ? 'd89c5588deb01c417c2af0574f0015e191ed15f50aef97e386f56d35a47f5b1f'
                : value === A8B6_LOCAL_V8_FRAME_REVIEW_PROMPT
                  ? '142f11602d7b173385df92b08f6b9640ef2e97c9431d49a2190de4337d27a795'
                  : value === A8B6_LOCAL_V9_FRAME_REVIEW_PROMPT
                    ? '2bf1a767ac99e97c78ff50880aaa700f08d1eafdd842e86d4e22276bf40c7439' : ''
}
