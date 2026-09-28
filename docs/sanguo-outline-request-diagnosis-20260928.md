# 三国 518 新大纲请求断线诊断（2026-09-28）

- 请求 `dramatic-expression-outline-1790566326414-b2c64bfc` 于北京时间 11:32:06 发往本地 `/api/node-run`。验收脚本在 11:37:07 记录 `fetch failed`；5 分钟的间隔符合 Node 内置 fetch 对迟迟没有响应头的连接的默认超时。脚本只保存了异常消息，未保存 `cause`，所以具体 Undici 错误码未被直接记录。
- 客户端断线后服务端仍在执行：Vite 进程 75506 保持存活，Codex 子进程 38754 持续运行，PostgreSQL 后端 38752 持有该请求身份的 advisory lock。此时没有模型执行流水，不能根据客户端错误判断模型已经失败，也不能换 key 重新提交。
- 北京时间 11:47:06，服务端写入唯一流水 `model-run-mukoyjt9-cchyicj`，状态 `failed`，运行 900466 毫秒，错误 `CODEX_TIMEOUT`。该次调用没有完整模型文本，没有产生新大纲或媒体。客户端断线和模型超时是两个先后发生的独立问题。
- `scripts/verify-dramatic-expression.mjs` 现使用本地 HTTP 长连接，等待时间按模型超时另加 120 秒，并在已有 `request.json` 的输出目录阻止再提交。`scripts/recover-dramatic-expression.mjs` 只读查询原 key 的流水与指纹，若原请求成功则从流水恢复并跑生产结构/史实校验；若仍在执行或失败，则不调用模型。
- 验证：两个脚本通过 `node --check` 和 ESLint；恢复脚本对本次请求报告 `failed`、同指纹流水 1 条、额外模型请求 0；重复使用原输出目录的 `--run` 在任何读写前被拒绝，`summary.json` 修改时间未变，流水仍为 1 条。

后续文本回归需要作为一次明确的新请求执行，并记录新 key。此前同节点 Codex ultra 成功记录耗时 414261 和 776215 毫秒，本次 900466 毫秒超时；对输出质量、耗时和费用应单独验收，不能把接通本地 HTTP 当成内容通过。
