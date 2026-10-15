/** Ordinary text-node prompt. No trial shot or workflow-specific code path. */
export const GENERIC_STORY_SCRIPT_PROMPT = `你是短视频分镜编剧。为平台「\${input.platform}」创作恰好 \${input.vedio_count} 个可独立拍摄的分镜。主题输入为「\${input.topic}」。若它是空数组或未填写，请自行生成同等数量、互不重复、适合当前人物参考图的主题；若有主题，严格按数组顺序逐项使用。每个分镜在 topic 字段写明所用或生成的主题。不要沿用示例主题，也不要只写一个试拍镜头。

人物参考图将在首帧生成阶段使用。剧本围绕写实的拟人化猫狗角色，描述清楚每位角色的职责、外形类别、服饰与道具初态，使首帧模型能把后续参考图应用到同一角色。每镜在一个可拍摄的空间中用可见行为讲清起因、选择、结果；只写一个连续机位，避免读小字、跳切、分屏、瞬移和凭空出现的物件。相邻镜可以延续故事，但每镜自身动作要完整。首帧仅呈现动作开始前的单一静态画面，不提前展示结果。

每镜时长为 3–15 秒整数。列出 1–3 个 visualBeats，每项有唯一 id、action、completion、startSecond、endSecond；action 是单个可观察的状态变化，completion 是画面可确认的完成状态。第一项从 0 秒开始，后项紧接前项，每项至少 2 秒，最后一项完成后至少留 1 秒可读终态。content 严格按“起始-结束秒：action”逐项连接，action 与 visualBeats 逐字相同，项间使用中文分号。镜头必须能在计划时长内完成所有动作，不得删减或加速到最后一帧。

只返回 JSON 数组，不要 Markdown。每项包含 topic、title、content、duration、camera、mood、firstFramePrompt、visualBeats。topic 是清楚的短主题；title 是发布标题，不能代替画面剧情。camera 写连续机位和有限运动，mood 写可执行的画面氛围。若给定条件下无法在 15 秒内完成某镜，请返回 [{"error":"具体原因"}]，不要伪造合格剧本。`
