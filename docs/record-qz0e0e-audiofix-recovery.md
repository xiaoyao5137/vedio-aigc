# record-qz0e0e-audiofix 故障修复与恢复

2026-09-26，第17轮 `sanguo-shot-script`（索引537）失败。首稿需17秒，超过单片15秒上限；拆镜稿把已批准的 `observable.visual` 动作“四下张望”写入 `beatCoverage`，校验器因它不在 `mustShow` 中而拒绝。供应商两次请求均成功，失败发生在本地契约处理。

修复保留 `beatCoverage` 的 `mustShow` 分配语义。仅在同一源节拍已批准、且 `beatDramaturgy.visual` 已声明该动作时，纠正重复的分配元数据；动作正文、排程和台词保持。未知动作、错误节拍、遗漏或重复的实际义务仍由原校验检查。拆段提示同步明确两类声明的区别。

即时校验、运行时分段和展开大纲复核共用同一描述投影，部分节拍保留其 `observable.visual/audio`，以及原文明确指定的吟唱、旁白与发声主体；完整节拍保留原表演描述。声部描述只引用本段已分配的音频片段，不能回写完整歌词或未分配动作。具有来源身份和有效声画义务的 cinematic 运行时子段允许 `mustShow: []`；原始场景和无义务空段继续拒绝。

## 验证

- 原始失败响应零模型调用回放通过可执行结构校验，保留原候选重复音频的真实质量警告。
- 全量测试1440项：1432通过、8环境跳过、0失败；构建、lint、diff检查通过。
- 重启常驻服务并重新加载页面后，从原失败节点真实重试，恢复到 `record-crr7s5`。
- 第537步 revision 14 成功：单段 `scene-17`，12秒，保留全部三项视觉锚点与完整讹言，结构校验无警告。共享语速政策从完整节拍推导时长，没有压缩到15秒或删除动作。
- 本次只新增1次文本模型请求，无图片或视频生成。下一节点 `sanguo-shot-script-review` 保持 idle。
- 原记录MD5前后均为 `920ca3c42b7f67c5d66148576274dd22`；前537个节点完整语义哈希逐项相同，已有16轮媒体和历史保留。
- 重试沿用 `requestScopeId=record-9ildu8` 与原声音策略；新的生成作用域为 `record-crr7s5`，未覆盖原请求。

本次验证范围是失败分镜节点及恢复完整性。当前用户验收策略仍为 `manual-review-v1`，通过结构校验不代表分镜内容审核、后续实际视频或整集观看已经完成。

证据位于 `logs/record-qz0e0e-audiofix-repair/`：`verified-recovery.json`、`live-retry.log`、原始请求与响应、`all-tests.log`、`build.log`、`lint.log`。可重新执行 `node logs/record-qz0e0e-audiofix-repair/verify-recovery.mjs record-crr7s5` 核对记录和历史哈希。
