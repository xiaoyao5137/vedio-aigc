# GPT-5.6 Sol 视觉审核接入

2026-09-08，已在本机模型管理新增 `GPT-5.6 Sol（Doro）`，模型 ID 为 `gpt-5.6-sol`。

## 当前配置

- Provider：`OpenAI`；能力：`text`（含图片理解）。
- 接口协议：`anthropic-messages`。
- Endpoint：`https://doro.lat/v1/messages`。
- 使用独立 API Key，保存在现有 PostgreSQL 模型配置库；本文和源码不包含凭据。
- `maxTokens=8192`；节点或体验参数可覆盖。
- 2026-09-08 实际完整采样观察出现上游过载及流式结束标记缺失；当前 `stream=false`，独立观察映射并发为 1。两者都是可编辑的通用配置。

Doro 模型目录包含该 ID。实际 Messages 文本请求返回 `CONNECTION_OK`，响应中的模型名为 `gpt-5.6-sol`。这是此网关的实际兼容性验证，不表示 OpenAI 官方端点采用 Messages 协议。

VLM 指视觉语言模型：读取视频抽帧并输出画面、动作等审核意见。可灵仍负责生成视频，抽帧和 ASR 仍由原工具完成。

## 工作流选择

按用户后续偏好，生产工作流 `wf-sanguo-history-drama` 仅独立画面观察选择新模型，其余视觉审核使用本机 Codex：

| 节点 | 之前 | 现在 |
| --- | --- | --- |
| 人物三视图质量推理 | Claude Opus 4.8 / Doro | 本机 Codex / gpt-6-astra |
| 独立画面观察 | Claude Opus 4.8 / Doro | GPT-5.6 Sol / Doro |
| 原要求逐项画面审核 | 本机 Codex / gpt-6-astra | 本机 Codex / gpt-6-astra |
| 成片质量推理 | 本机 Codex / gpt-6-astra | 本机 Codex / gpt-6-astra |
| 整集叙事声画审看 | Claude Opus 4.8 / Doro | 本机 Codex / gpt-6-astra |

生产配置修改模型选择及独立观察的通用映射并发，保留提示词、质检阈值、图像证据及图结构。schema 112，已有执行记录保留原始快照；历史流水中的旧模型名称代表当时实际执行情况。后续从新配置启动或恢复执行时，应核对该执行快照的模型选择。

## 通用实现

`server/remote-text.ts` 以显式协议选择适配器，不按模型名写分支。Anthropic 默认使用 Messages；OpenAI / Custom 文本模型须配置网关支持的 Messages 协议。暂未增加 OpenAI 原生 Responses 或 Chat Completions 文本协议。

模型体验和工作流共用图像加载、原图及局部证据、已有快照和流式解析。修复了远端模型体验仅发送文字、遗漏审核图片的问题。`apiProtocol` 纳入请求指纹，修改协议不能误复用旧结果，凭据不进入指纹和流水。

Messages 文本响应还须包含非空有效文本：HTTP 200 的 HTML 错误页、空内容、纯空白和仅 thinking 内容会返回 `MODEL_RESPONSE_INVALID`，不再误记成功。完整流式消息同样检查，原有截断和上游错误判定保留。诊断不回显错误页正文。

支持模型 `settings.stream` 和单次 `params.stream` 明确配置 `true/false`，缺省仍为流式。关闭流式不会关闭完整性检查；模型设置中的返回方式参与缓存指纹。遇到过载继续遵循有限重试，不把半截响应当成功。

## 初始接入验证

- 真实文本请求：通过。
- 真实视频 `verified-9d58f38815c56c6a518c.mp4` 的首尾两帧，经 `/api/model-test` 和 `/api/node-run` 分别调用：均 HTTP 200、单次传输成功。
- 两条路径均正确识别单人、深蓝色服装、木门背景，以及首帧张嘴、尾帧闭嘴，与人工查看的原图相符；约 22.7 秒和 21.4 秒。
- 全量测试：756 项，755 通过，1 项可选 PostgreSQL 测试跳过；构建、Lint、diff 检查通过。两份真实读图响应通过新增有效文本检查的重放验证。
- 工作流升级函数保持新模型选择，修改前后原执行 `record-2yqxmc` 和基线 `record-dkozzh` 内容哈希一致。

以上是初始接入验证。后续已完成第一轮既有 14.04 秒视频的独立观察、逐项要求审核、综合审核和验收节点重跑：Sol 13/13 次观察完成，本机 Astra 8/8 项要求及综合报告完成，最终结论仍为证据不足、未获验收。详见 [完整检测报告](./sanguo-sol-quality-2026-09-08.md)。这不是多轮合成整集验收。

本地证据：`logs/gpt-sol-integration/live-vlm-proof.json`、`workflow-switch-proof.json`、`tests-final.log`。这些文件不含 API Key。

本次完整质检及通用配置改动的回归结果：767 项测试，766 通过、1 项可选 PostgreSQL 测试跳过、0 失败；构建、Lint、diff 检查通过。记录在 `logs/sol-full-quality-2026-09-08/`。
