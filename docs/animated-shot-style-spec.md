# 历史短剧通用动画镜头规格

状态：已实施｜目标工作流：`wf-sanguo-history-drama`｜配置版本：131

## 1. 问题与目标

现有 `animated_map` 把“动画”误收窄为地图，并限制在片头、承接与结尾。目标是让动画镜头成为与真人实景并列的叙事手段，可用于片头、片中、人物剧情、结尾回应及任意场间衔接，同时保持史实、人物身份、时长、连续性和媒体请求可校验。

## 2. 用户与场景

主要用户是历史短剧的编剧、分镜导演和工作流维护者。典型场景包括片头建立时代背景、人物插画推进正戏、片中压缩时间、地点或势力切换、用视觉母题衔接两镜，以及片尾回应开场问题。

## 3. 非目标

不在本次范围：自动评价哪一种画风最美；可灵失败后切换 Qwen；把所有真人镜头自动动画化；依赖生成图中的中文传递关键剧情。

## 4. 字段契约

`visualTreatment`：

- `live_action`：真人实景。
- `animated`：通用动画镜头；必须同时声明下列两个字段。
- 兼容读取：`animated_map` 映射为 `animated + historical_map`；`historical_montage` 映射为 `animated + historical_tableau`。新大纲不再产出这两个旧值。

`animationStyle` 只回答“本镜用什么动画叙事方法”：

| 枚举 | 用途 | 人物规则 | 典型运动 |
|---|---|---|---|
| `historical_map` | 地理、疆域、路线、势力关系 | 可空 cast | 高亮、路径、区域推移 |
| `character_illustration` | 人物行动、对白、心理处境的历史插画表演 | 必须有 cast 和人物资产 | 视线、姿态、动作层次、景深推移 |
| `historical_tableau` | 历史事件定格/绘卷式重建 | 无命名人物时可空 cast | 分层显现、局部运动、因果递进 |
| `symbolic_transition` | 用共同物件或视觉母题衔接剧情 | 可空 cast | 形状匹配、动作匹配、溶接 |
| `time_montage` | 压缩时间、积累局势、呈现因果序列 | 可空 cast | 连续意象、光影/物件状态推进 |
| `environment_transition` | 昼夜、季节、天气、地点氛围转换 | 可空 cast | 天光、雨雪、烟火、环境景别变化 |

`animationAesthetic` 只回答“画面采用何种统一美术语言”：

- `cinematic_gongbi`：电影工笔，考据清晰、层次细密。
- `ink_wash`：水墨写意，以墨色、留白和克制晕染组织空间。
- `woodblock_print`：木刻版画，强轮廓、有限色、历史印刷质感。
- `shadow_puppet`：皮影剪影，侧面造型、关节动作、幕布光影。
- `painterly_2d`：二维厚涂插画，成熟绘本/概念艺术质感。

所有组合禁止低幼卡通、Q版、现代动漫符号、游戏 CG、玄幻光效。人物插画必须保留角色脸部、年龄、体型、发式和服装连续性。

## 5. 使用规则

- 动画不是固定“插片位置”。`editorialRole` 继续表达片头、故事、承接、结尾；`visualTreatment` 表达真人或动画；两个维度独立组合。
- 选择动画必须完成一个明确职责：建立时空、推进人物行动、解释因果、压缩时间、转换视角/地点或回应前文。纯装饰动画不进入大纲。
- `context_bridge` 可出现在任何需要显著重置地点、时间、势力视角或因果阶段的位置；连续行动内部不得机械插入说明镜头。
- `character_illustration` 可以是 `editorialRole=story`，可承载对白或旁白，不再被“不得把人物剧情动画化”拦截。
- 关键人名、年代、地点和因果通过旁白/对白传达；画内中文非必要不生成，必要文字必须逐字来自分镜并在首尾帧间保持不变。

## 6. 生成与连续性

所有 `animated` 及两个旧兼容类型统一使用可灵：

1. `firstFrameMode=reference`：根据 `visualPrompt + animationStyle + animationAesthetic` 生成动画首帧；人物插画同时带人物参考。
2. `firstFrameMode=reuse_previous_tail`：首帧使用上一镜真实尾帧，不重复生图。
3. 两种模式都根据 `lastFramePrompt + videoPrompt` 生成目标尾帧。
4. 视频请求必须同时携带首帧与目标尾帧；缺一即在付费请求前失败，禁止退回无边界文生视频。
5. 旧节点 id 与 operation 名称保持不变，避免破坏历史执行记录；展示名称和路由语义升级为通用动画。

## 7. 功能需求

- FR-001: 大纲和分镜接受 `animated`，并要求两个合法枚举。
- FR-002: 人物插画可用于普通 `story` 镜头。
- FR-003: 无人物动画允许空 cast，且不得为满足字段虚构人物。
- FR-004: 所有动画统一进入可灵首尾帧链路。
- FR-005: 旧数据和旧节点标识无损兼容。

## 8. 验收标准

- AC-001: 验证 FR-001；当 `visualTreatment=animated` 缺少或使用非法 `animationStyle` / `animationAesthetic` 时，系统必须拒绝大纲或视频请求。
- AC-002: 验证 FR-001；当分镜未逐字继承大纲中的两个动画枚举时，系统必须拒绝分镜。
- AC-003: 验证 FR-002；给定 `story + animated + character_illustration` 且 cast 非空，合法大纲必须通过校验。
- AC-004: 验证 FR-002；当人物插画 cast 为空时，系统必须拒绝。
- AC-005: 验证 FR-003；给定五种无人物类型和空 cast，系统应当通过，且分镜视角必须为“观众”。
- AC-006: 验证 FR-004；参考开场必须生成首帧和尾帧，复用前镜尾帧时必须只生成本镜目标尾帧。
- AC-007: 验证 FR-004；付费视频请求缺首帧、尾帧或人物插画身份参考时，系统必须拒绝。
- AC-008: 验证 FR-005；旧地图与蒙太奇无需补字段即可运行；配置迁移不得增删执行历史或更换已选模型，重复执行结果必须幂等。

## 9. 可观测性、发布与回滚

- 记录 `visualTreatment`、解析后的 `animationStyle`、`animationAesthetic`、首帧来源、是否生成尾帧和最终路由。
- 配置由 schema 130 升至 131；先预演并保存配置哈希，再事务更新，更新前写只读回滚快照。
- 回滚只恢复 workflow 配置快照，不删除新执行或媒体资产。旧执行继续按其冻结输入读取。
- 发布门槛：定向契约测试、全量测试、lint、build 全部通过；真实人物插画视频在生成前仍属于“代码/契约已验收”，不得宣称媒体效果已验收。

## 10. 风险

- 可灵图片接口当前只消费首个身份参考，双人物插画的首帧身份稳定性仍需真实媒体测试；视频阶段仍携带完整人物参考数组。
- 画风枚举不能替代具体动作设计；提示词若只写美术名词，可能生成静态展示而不是剧情镜头。
- 旧节点 id 保留“animated-map”字样，降低迁移风险，但会产生短期命名债务。

## 11. 开放问题与决策

- 当前决策：可灵继续作为动画首尾帧首选，不实现 Qwen 降级。
- 待真实媒体验收：优先测试单人物 `character_illustration + ink_wash`，再决定是否需要可灵多人物图片编辑能力或单独合成策略。
- 当前不自动选择动画风格；由大纲依据叙事职责显式声明，避免模型机械插动画。

## 12. 追踪矩阵

| 需求 | 验收 | 代码/测试 |
|---|---|---|
| 需求 FR-001 | 验收 AC-001/002 | `src/animation-shot.ts`、`src/history-drama.ts`、`tests/editorial-film-grammar.test.ts` |
| 需求 FR-002 | 验收 AC-003/004 | `src/history-drama.ts`、`tests/editorial-film-grammar.test.ts` |
| 需求 FR-003 | 验收 AC-005 | `src/history-drama.ts`、`server/workflow-contracts.ts` |
| 需求 FR-004 | 验收 AC-006/007 | `src/code-node-presets.ts`、`src/animated-map-frames.ts`、`tests/code-node.test.ts`、`tests/workflow-contracts.test.ts` |
| 需求 FR-005 | 验收 AC-008 | `src/animated-map-frames.ts`、`tests/animated-map-frames.test.ts`、迁移脚本 |
