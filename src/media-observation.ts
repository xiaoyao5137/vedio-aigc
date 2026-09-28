import { isCanonicalMediaReviewPrompt } from './canonical-media-review.ts'

/** Reusable observation instructions. No script, earlier rejection or expected
 * prop enters the independent observation; ownership must come from the pixels. */
export const GROUNDED_FRAME_OBSERVATION_PROMPT = `附件只有一张原始采样帧，编号 \${frame.index}，时刻 \${frame.second} 秒。独立观察实际可见内容，不评剧本，不猜人物姓名，不使用其他帧或旧报告。先观察完整空间，再逐人描述服装、站位、姿态与手部。
【物体空间归属】看到线条或形状不等于看到持物。分别检查人物双手可见范围、手指与物件接触点、物件轮廓、遮挡层次以及与背景的位置关系。门窗边缘、接缝、光线、阴影、衣褶、腰带与建筑构件都可能投影到人物附近；没有接触或明确归属证据不能把背景物件认作手持物。也不能因靠近身体就断定属于背景。不要主动寻找某种历史道具，不从模糊轮廓猜剑、笛、扇、笏等名称。
分别写左手和右手的实际可见状态：看见完整手部且没有持物可写空手；被遮挡写 unknown 并说明原因。不能把“没有足够证据证明持物”改写成“双手确定空置”，也不能把“手部有重叠线条”改写成“确定持物”。heldObjects 与 handEvidence 必须一致。tailObservation 只总结当前图片，不补造动作过程。
仅返回 JSON {"index":\${frame.index},"second":\${frame.second},"setting":"实际场景","people":[{"clothing":"服装线索","position":"画面位置","pose":"身体及双手实际姿态","heldObjects":"明确持物/可见空手/unknown，描述形状与实际归属依据","handEvidence":{"left":"可见范围、接触证据或不确定原因","right":"可见范围、接触证据或不确定原因","nearbyShapes":"与人物重叠或靠近的形状及其可证实的空间归属；没有则写未见"}}],"tailObservation":"当前帧实际状态"}。`;

export const MEDIA_ATTRIBUTION_REVIEW_CLAUSE = `
【物件归属复核 v1】独立观察是待核对的草稿，同一句在 raw/text/结构化字段里重复不构成多份证据。先看全部原图的空间结构，再与观察核对。判断持物必须描述可见接触点、物体轮廓或可确认的归属关系；靠近手部、腰带或与人物重叠的线条本身不能证明持物。对疑似物件比较其在各帧相对于手、身体及固定背景的位置；人物移动而线条保持与背景连接时，应复核是否为背景边缘、接缝、光线或阴影。不要只沿用首帧猜测，也不要用后帧否定首帧真正明确的持物。
对每个 visualChecks.actualObjectsByFrame 描述实际可见双手与物件归属；check.evidence 解释跨帧一致性。若纠正独立观察的误认，将原说法、帧号和原图反证记入 warnings，issues 仅保留复核后成立的实质缺陷。看不清仍为 unknown，不得把疑似道具升级为确定错误并要求重拍。确认存在错误道具、缺失核心动作或错误人物时仍须拒绝。`;

export function refreshMediaAttributionReviewPrompt(prompt: string): string {
  return isCanonicalMediaReviewPrompt(prompt) || prompt.includes('【物件归属复核 v1】') ? prompt : prompt + MEDIA_ATTRIBUTION_REVIEW_CLAUSE;
}

export const MEDIA_DETAIL_REVIEW_CLAUSE = `
【原图局部采证 v1】附件先提供全部完整原帧，再提供配置所选原帧的局部图；每张带 frameIndex 和源像素矩形标签。局部图只是同一张原图的裁剪，不是新的时间帧，不提供新的动作过程或额外证据来源。帧号、时刻仍以 video_evidence.frames/frameTimes 为准。先结合完整原图判断空间，再看局部图核对手指、物体接触和遮挡；将局部发现关联回对应原帧。不得因为重复裁剪同一帧就声称具有多帧动作证据。`;

export function refreshMediaDetailReviewPrompt(prompt: string): string {
  return isCanonicalMediaReviewPrompt(prompt) || prompt.includes('【原图局部采证 v1】') ? prompt : prompt + MEDIA_DETAIL_REVIEW_CLAUSE;
}

/** An observation draft can anchor a second reviewer to the first model's
 * hallucination. Retain it in the execution record; the judge reads raw media. */
export function refreshIndependentMediaReviewPrompt(prompt: string): string {
  const next = prompt.replace('无剧本逐帧观察：${media_observations}',
    '【原图独立判断】本节点只接收实际图片、ASR、数值预算和拍摄目标。逐帧观察在另一个节点单独存档，不作为本节点的判断输入；本节点需直接阅读完整原帧和局部附件，独立列出实际证据。')
    .replace(/\$\{([^{}]+)\}/g, (slot, path: string) => /^media_observations(?:\s*$|[.[])/.test(path.trim())
      ? '（独立观察另行存档，本节点直接读取原始图片）' : slot)
    .replace('结尾状态只根据最后一帧的独立观察。', '结尾状态只根据最后一帧原图。')
    .replace('实际 ASR、数值预算和无剧本抽帧观察', '实际 ASR、数值预算和原始采样图片')
    .replace('第一帧可以是0–1秒展开卷轴动作的起始阶段，不能要求动作在0秒已经完成。', '第一帧可以是所写动作的起始状态，不能要求整个动作在0秒已经完成。')
    .replace('每项只能是带value/evidence的observed或只带status的unknown；', '每项只能是带value/evidence的observed，或不携带事实value的unknown（可用evidence说明不确定原因）；')
    .replace('media_observations是模型观察草稿，可能误读人物、手势或持物，不能直接当作原图事实；逐项对照附件纠正，尤其首帧与尾帧。实际图像优先于观察文本，冲突写入warnings并给出准确帧号；', '本节点直接从原图判断，尤其首帧与尾帧。每项实际发现附准确帧号；')
    .replace('独立观察是待核对的草稿，同一句在 raw/text/结构化字段里重复不构成多份证据。先看全部原图的空间结构，再与观察核对。', '先看全部原图的空间结构，再核对局部细节。同一帧及其裁剪只是一份时间点证据。')
    .replace('若纠正独立观察的误认，将原说法、帧号和原图反证记入 warnings，issues 仅保留复核后成立的实质缺陷。', 'issues 仅保留原图可证实的实质缺陷。');
  return next;
}
