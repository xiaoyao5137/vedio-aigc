import { SCENE_CUT_FRAME_REVIEW_PROMPT_V174 } from './scene-cut-action-start-workflow.ts'

const textStart = '最外层增加 readableTextCheck：'
const hemStart = '最外层还要有 wardrobeHemCheck：'
const textIndex = SCENE_CUT_FRAME_REVIEW_PROMPT_V174.indexOf(textStart)
const hemIndex = SCENE_CUT_FRAME_REVIEW_PROMPT_V174.indexOf(hemStart, textIndex)
if (textIndex < 0 || hemIndex < textIndex) throw Error('SCENE_CUT_ADVISORY_PROMPT_INVALID: review sections missing')

/** Schema 186 keeps action and identity checks, but lets the user judge visual
 * polish in the generated video. Advisory findings remain in the raw review. */
export const SCENE_CUT_FRAME_REVIEW_PROMPT_V186 = (SCENE_CUT_FRAME_REVIEW_PROMPT_V174
  .slice(0, textIndex)
  + `最外层增加 readableTextCheck：{"applicable":false,"backgroundInspected":false,"readableGlyphsPresent":false,"actualReadableTextPresent":false,"pixelEvidence":""}。逐一查看背景与道具；确实可读的汉字、字母、数字或标语使 actualReadableTextPresent=true，列入 issues 并判失败。无法转录、没有语义的装饰性拟字笔画只令 readableGlyphsPresent=true，列入 advisoryIssues，不因此判失败。被遮挡而无法检查的区域不推断存在文字；说明可见范围。
` + SCENE_CUT_FRAME_REVIEW_PROMPT_V174.slice(hemIndex))
  .replace('若画面已将人物放到目标台阶/门槛附近', '若画面已抵达目标、完全没有可继续行走的距离')
  .replace('若禁止文字，远景旗面、匾额及服饰上的拟字也算 readableGlyphsPresent=true。',
    '若禁止文字，确实可读的文字属于阻断项；不可转录的拟字笔画记入 advisoryIssues。')
  .replace('原三视图的外袍摆、连续深色内层下摆和鞋靴比例必须逐项核对。',
    '原三视图的外袍、内摆和鞋靴仍须逐项记录；层次和身份正确时，轻微比例偏差只记 advisoryIssues。')
  .replace('只有衣层缺失、可见内摆面积或下摆/露靴比例有清楚且显著改变，才判 matches=false，并在 issues 写明两图的归一化地标和具体差异；关键部位被遮挡到无法核对时不确定仍不得通过。',
    '衣层缺失、人物认不出或关键装备错误才列入 issues 并阻断；下摆、露靴比例差异即使明显，也如实填 matches=false 并写入 advisoryIssues，供用户看成片后决定。关键人物身份被遮挡到无法核对时仍不得通过。')
  .replace('一旦能辨出文字或拟字形仍按禁字规则拒绝。',
    '确实可读的文字按禁字规则拒绝；不可转录的装饰笔画记入 advisoryIssues。')
  .replace('服装仍以原三视图为准；若同一人的外摆、内摆都向鞋底明显偏移、露靴高度显著改变，即使颜色和两层结构相似，wardrobeHemCheck.matches=false 并列出腰带到鞋底的相对地标。',
    '服装仍以原三视图为准；若外摆、内摆比例改变，如实填 wardrobeHemCheck.matches=false 并列出相对地标，记入 advisoryIssues；人物身份、衣层或关键装备错误仍列入 issues。')
  + `
【用户验收的首帧质检口径·v186】必须先查批准人数、人物身份、必需道具、动作起点与后续必需动作是否尚能发生。位移动作的参与者仍在批准起点、到目标方向有可见开放路径时，即使目标的局部细节在画外或不够清晰，routeStillPossible=true、actionStillPossible=true；不要为了门槛、台阶或交接点的每一条边都可辨而拒绝。人物已站在终点、没有可行走空间、动作已经完成、关键人物或道具错误，仍是 issues 和 passed=false。画面审美、衣摆细节、不可转录拟字形写入 advisoryIssues，不放入 issues，不把相应 hardChecks 置 false。hardChecks.wardrobeAndEquipment 评估人物身份、衣层类型与关键装备，不要求精确衣摆长度。保留原始观察和所有 advisoryIssues；passed 仅由真正阻断本镜动作或身份的 issues 决定。`

/** The user judges an uncertain manipulation in the later media checkpoint.
 * The reviewer must still distinguish uncertainty from a visibly completed action. */
export const SCENE_CUT_FRAME_REVIEW_PROMPT_V187 = SCENE_CUT_FRAME_REVIEW_PROMPT_V186 + `
【不明确的收绳起点留待用户断点判断·v187】若实际像素清楚显示绳圈已贴紧腕部、结扣闭合，或所需动作已完成，仍列入 issues、passed=false。若腕前或拳下确有可见松绳大圈、操作手与绳端可见、收紧终态未实见，但手部遮挡使结口/张力不能完全辨明，不要将“无法确认”写成已完成或硬失败。该节拍 actionStillPossible=true、terminalStateAlreadyPresent=false；manipulationStartCheck 保留各项真实布尔观察，并加 uncertainStartAdvisory=true 及具体 pixelEvidence、visibilityEvidence；把不确定原因写入 advisoryIssues，issues 保持空。其余硬检查如实判定，只有没有别的明确失败时 passed=true。此通过表示继续到后续用户断点判断，并不声称结口已由像素证实。`
