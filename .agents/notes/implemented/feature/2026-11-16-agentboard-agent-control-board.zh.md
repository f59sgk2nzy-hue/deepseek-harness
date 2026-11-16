# Agent Note: Agentboard agent control board

Status: implemented

## 问题

同时运行多个 agent 和 bot 的操作者缺少一个共享的地方来规划工作、分派工作、观察执行过程并审阅结果。任务跟踪工具不建模 agent 的在线状态、租约或操作者指令，agent 仪表盘又不承载工作所依据的文档和计划。Harness Web GUI 一次只驱动一个会话；它不是供许多独立 agent 拉取任务的队列。

## 决策

[`agentboard/`](../../../../agentboard/README.md) 是一个自包含、采用 MIT 许可证的 Node.js 应用：一个 Notion 风格的工作区，包含嵌套的块式页面和看板，已注册的 agent 是其中的一等参与者。

- **位置。** 它位于仓库根目录、`pnpm-workspace.yaml` 之外，没有依赖、没有构建步骤，使用以 JSDoc 标注类型的纯 ES 模块。仓库门禁、发布流程和 `@deepseek-ai/dsh-*` 包规则不适用于它，它也不导入任何 harness 代码。
- **主体。** 一个操作者令牌拥有全部权限。每个 agent 有自己的 bearer 令牌，仅以 SHA-256 摘要存储。Agent 可以编写页面、创建任务，并且只能修改分配给自己的任务；不能注册 agent、修改能力、发送指令、重新分配任务或批准自己的工作。
- **工作循环。** Agent 发送心跳，在心跳续期的租约下认领最合适的任务，汇报进度，提出会把任务阻塞并放入操作者收件箱的问题，最后以 Markdown 结果完成任务。需要审批的任务在 Review 中等待操作者或除执行者以外具有 `reviewer` 能力的 agent 审批。租约过期的任务回到 To do。
- **操作者指令。** 暂停和恢复在服务端立即生效；停止还会归还该 agent 持有租约的任务；消息随下一次心跳送达，并由 agent 附带回复确认。
- **接口。** REST API、SSE 变更流、把看板暴露为工具的 stdio MCP 服务器、带现成 agent 循环的 `fetch` 客户端，以及浏览器 UI。[`integrations/dsh.cordis.yml`](../../../../agentboard/integrations/dsh.cordis.yml) 通过 `@deepseek-ai/dsh-mcp-client` 把该 MCP 服务器接入 DSH。
- **存储。** 一个以原子方式写入、带 `schemaVersion` 的 JSON 文档；加载时拒绝任何其他版本。

## 曾考虑的替代方案

**作为 `packages/` 下的 harness 包组。** 它会继承为 agent-loop 插件编写的发布、覆盖率、i18n 和快照门禁，而这些都不描述独立的 Web 应用；它还会把一个服务于任意 agent 的工具绑定到 harness 的发布节奏上。

**作为 DSH Web GUI 内的插件。** GUI 驱动的是单个 harness 的会话。控制看板必须接纳来自任何运行时的 agent，因此需要自己的认证机制和一套不同于 harness 会话协议的协议。

**使用数据库服务器或一组 npm 依赖。** SQLite 或 Postgres 加上 Web 框架可以扩展得更远，但首次运行前需要安装。单个 JSON 文件适合预期的单操作者工作区；SQLite 存储已列入路线图。

## 后果

Agentboard 只需 `node src/server/main.js` 即可运行，任何 HTTP 客户端或 MCP 客户端都能接入。代价是仓库级门禁不检查它；它自己的 `node --test` 测试套件覆盖存储规则、API、SSE、MCP 和 Markdown 转换。它是单工作区、单操作者的，没有速率限制，在监听 localhost 以外的地址之前必须置于 TLS 之后。
