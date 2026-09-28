# 百炼 TTS 接入与验收（2026-09-12）

已在正式服务 http://127.0.0.1:5173/ 加载并配置。入口：模型管理 → 语音合成 / TTS → 测试 / 体验。

## 已交付

- 百炼 Qwen Audio TTS：`qwen-audio-3.0-tts-flash`，默认女声 `longanfengyue`。
- 百炼 Qwen Audio TTS Plus（男声）：`qwen-audio-3.0-tts-plus`，默认男声 `longanlufeng`。
- 用户指定的业务空间 Base URL 与 API Key 已保存到现有 PostgreSQL 模型配置；密钥未写入源码、本文或验收日志。
- 体验页支持合成台词、人物标记、系统音色建议与自定义音色 ID、人物/情绪指令、语速、音调、音量、采样率、随机种子。
- 模型体验和工作流音频节点使用同一适配器。生成完整 PCM 后封装 WAV，返回实际样本时长、任务 ID、音色、输入台词、SHA-256 和供应商事件；输入台词明确标记为 `transcriptSource=input-text`，不冒充识别结果。
- 音频持久化到 `public/generated/tts-<task-id>.wav`，可试听、下载，并在执行流水回查。新文件直接通过媒体路由提供，不依赖 Vite 文件监听缓存；支持 HEAD、Range 和 416。
- 空音频、奇数字节 PCM、供应商拒绝、错任务 ID、提前断线及超时不会被标成成功，不交付部分音频。

## 使用

选择对应模型，填写人物真正要说的台词，在声音指令中填写年龄、性格、情绪与表达方式，然后发起测试调用。系统音色与定制音色必须匹配 Model ID。人物名称是本次语音的标记；稳定声音由音色 ID 与相关参数决定。

工作流音频节点选择以上模型，prompt 填写台词；params 可填写 `voice`、`instruction`、`rate`、`pitch`、`volume`、`sampleRate`、`seed`、`characterName`。输出 `url` 是音频文件，`duration` 是根据 PCM 样本计算的实际秒数。

## 真实媒体证据

| 样本 | 模型/音色 | 实测时长 | 解码及台词检查 |
| --- | --- | --- | --- |
| 甘陵乡人甲 | Plus / longanlufeng | 4.69 秒 | 通过，拼音序列差异 0 |
| 村中妇人 | Flash / longanfengyue | 4.45 秒 | 通过，拼音序列差异 0 |
| 同一男声低语 | Plus / longanlufeng | 3.97 秒 | 通过，拼音序列差异 0 |

媒体及 API 证据：`.runtime/tts-20260912/{male,female,whisper}.json`。实际识别结果及 RMS、峰值和时长检查：`audio-validation.json`。低语样本识别为“满满”而输入为“慢慢”，同音检查一致；识别不能认证音色审美、角色一致性或情绪表达质量。

- 正式 `/api/node-run`：任务 `26aa0b03-9a51-4e7d-a18f-a2e31b4d8915`，4.13 秒；生成后立即 Range 获取文件头返回 206、audio/wav、44 字节。证据 `workflow-node.json`。
- 正式 Chrome 页面最终生成任务 `241d6fe0-903f-4368-a454-541f1fd5c2ba`，页面显示“生成完成”；首次播放器可用，实际点击播放后控件显示“暂停”。
- 全量测试 1111 项：1108 通过、0 失败、3 环境条件跳过。日志 `full-tests.log`。
- 新增协议/媒体读取测试 9 项全部通过；覆盖连接顺序、身份核对、完整落盘、异常响应和 Range。日志 `audio-tests.log`。
- TypeScript/Vite 构建和本次新增模块 lint 通过：`build.log`、`lint.log`。构建仍有既有 bundle 大小提示。

## 用户之前的样片听审

用户本次明确反馈之前样片听审通过。已将三段单人和一段双人视频的声音听审保存为 passed，并绑定原视频 URL 和原声音版本；正式库及原隔离验收库均已保存。证据：`prior-user-listening-reviews.json`。未覆盖原媒体文件或原执行记录。

此前完成度核对文档是历史结论，本次更新了两项事实：四段人物样片已有用户听审通过；真实 TTS 生成与实际音频时长返回已接入，正式服务已加载。

本次新 TTS 样本通过的是生成、播放、解码和台词完整性验证，没有把旧样片的听审意见移用到新音频。现有视频自动替换配音、混音、口型和完整长工作流换声验收不在本次模型接入交付范围；人物名称标记也不等于向可灵创建了新音色资产。

## 协议来源

[官方实时语音合成示例](https://docs.bailian.console.aliyun.com/zh/model-studio/realtime-tts-user-guide)、[客户端事件](https://docs.bailian.console.aliyun.com/zh/model-studio/cosyvoice-client-events)、[Qwen Audio 音色列表](https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list)。2026-09-12 在用户 Chrome 中读取。

使用指定 Base URL 的同一业务空间域名，转换为 `wss://<workspace>.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`，按 run-task → task-started → continue-task → finish-task → task-finished 收集二进制音频。没有将新款 TTS 错接到 OpenAI audio/speech。
