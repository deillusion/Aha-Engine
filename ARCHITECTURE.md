# Varina-Grounded architecture

主产品是 Agent，不是 workflow。依赖方向如下：

```text
Web / CLI / MCP
       |
       v
AgentService ── SessionStore
       |
       v
AgentSession (conversation + bounded tool loop)
       |                    \
       v                     v
CodebaseHost          Post-ReAct Varina stage
       |                     |
       v                     v
NodeFsHost       Gate → Baseline extraction → ExploreDesignEngine
                             |
                             v
          Seats → Grounder → EvidenceVerifier → Dedup → Assembly
                             |
                             v
                    MeetingBoard + FactLedger
```

## Agent layer

`AgentService` 管理会话创建、单会话互斥、取消、事件与进程中断恢复。持久化状态不含 API Key。

`AgentSession` 保持以下不变式：

1. 当前 user 消息不被动态状态改写；观点板、事实与文件清单作为独立受信 system state 注入。
2. 工具调用与结果按唯一 ID 1:1 配对；重复 ID 不重复执行。
3. 只有当前用户消息包含明确写入意图时，`Edit / Write` 才能通过本地门控。
4. 工具续轮受 `maxToolIterations` 与 `AbortSignal` 限制。
5. 文件正文是待分析的不可信内容，不能改变工具权限。
6. 工具结果进对话前必须过体积闸门：单条超限或单轮合计超预算的结果落盘，对话内只保留 `persisted_path` 与预览，且配对用的 `id / name / ok` 必须原样保留。
7. Varina 开关不得改变普通 ReAct 的 prompt、工具、context 或第一份回答；深度探索只在常规回答落盘后启动。
8. `/init` 通过一次性 prompt overlay 和专用工具集运行；普通轮次不携带初始化协议或 `InitProject` 工具。

## Context budget

`src/agent/tool_result_budget.mjs` 是唯一的体积闸门实现，阈值对标 Claude Code 的 `toolLimits.ts` / `toolResultStorage.ts`：

- 单条命中行 500 字符（Grep 侧裁剪，返回 `line_chars` / `truncated`）。
- 单条结果 `Grep` 20,000 字符、其余 50,000 字符；单轮合计 200,000 字符。
- 超限不是截断而是落盘 + 2,000 字符预览，落盘走 `Host.persistToolResult`，因此 `NodeFsHost` 与 `MemoryHost` 行为一致。
- 落盘目录位于工作区的 `.varina` 下，运行时数据位于 `.varina/data`，`listFiles` / `grep` 默认跳过 `.varina`，既避免自己再被检索命中，又让模型能用 `Read` 取回原文。

## Retry policy

`src/retry_policy.mjs` 是唯一的重试判据：带 HTTP status 的错误走白名单（408/409/429/5xx），其余（含 400）立即失败；不带 status 的本地解析/校验失败才重试，并且只有它才允许追加“只修复 JSON”的提示。`ModelGateway` 与旧的 `model_executor.mjs` 共用同一判据，避免两套重试语义分叉。

## Host layer

`NodeFsHost` 是所有工作区访问的唯一端口实现：

- 路径先做词法边界检查，再用 `realpath` 防止 symlink/junction 越界。
- 原始字节用于 SHA-256、BOM 与换行检测；模型看到的是去 BOM、统一 `\n` 的文本视图。
- `expectedHash` 防止读取后被外部修改的文件遭覆盖。
- 覆盖前先备份原始字节；备份索引和目标写入都使用临时文件 + rename。
- `grep` 默认把命中行裁到 500 字符并标注 `line_chars`；单文件大小上限之外，还限制单行宽度，避免“整个文件就是一行”的数据文件一次命中就搬走兆字节。
- `persistToolResult` 是超限结果的落盘出口，写入 `.varina/tool-results/`（模型可用 `Read` 取回，`listFiles` 不会再检索到）。
- 核心逻辑不调用 shell、Git 或 native grep。

`MemoryHost` 实现相同端口，用于离线测试与可重复模拟。

## Varina engine

`ExploreDesignEngine` 是普通 ReAct 完成后的可选增量阶段，不暴露给主 Agent 的工具循环。开关开启时，后置 gate 只在任务显然与深度探索无关时请求用户确认；不确定默认启动，确认状态持久化且没有计时超时。真实模式配置 `TYPESAFE_API_KEY` 后，这个 gate 由独立的 Jev System One 决策网关执行：只提交状态与 `START / ASK` 选项并读取概率，不进入聊天模型路由，也不生成用户可见文本；模拟模式、未配置凭据或调用失败时沿用保守的本地/既有回退。

常规回答先由结构化提取器完整解析为初始 MeetingBoard，基线观点标记为 round 0，不受 creative 席位每轮 0–3 条贡献上限影响。第一轮席位从该基线继续新增、反驳或修正；终局仅向用户追加相对基线的实质增量，不覆盖常规回答。

每轮先由实际纳入 Working Memory 的 `(path, content_hash)` 有序清单计算 `repository_snapshot_id`，再冻结问题、硬约束、有效事实、观点板和 snapshot，生成 `packet_token`。同轮所有席位的公共消息完全一致，席位特有算子位于公共前缀之后。

席位只产生抽象机制和待核验假设，不接触文件内容。Grounder 读取常驻资料并可发出结构化 `load_requests`；确定性的 EvidenceVerifier 随后重读引用位置。Dedup 对每个候选恰好执行一次 ADD/MERGE/DROP，失败时显式降级为“全部 ADD”，不静默丢弃已付费结果。

Runner 最多执行五轮。只有连续两轮 ADD=0、MERGE=0 且不存在阻断未知项时才早停。终局 Assembly 只引用活跃 Point ID，不做评分、排名或唯一裁决。

## Persistence and recovery

会话 JSON 是完整审计记录。常规回答与 Varina 综合终稿分别以 `baseline`、`varina_addendum` 消息保存；后者吸收发散结果重新回答原问题，而不是只汇报增量。Varina 每轮 checkpoint 写入 `active_varina_runtime`；正常 handoff 后沉淀为 `VarinaRunRecord` 并移除运行时容器。进程重启遇到普通 ReAct 或后置 Varina 的运行态会话时将其标记为 `interrupted`，避免自动重复调用；`awaiting_varina_confirmation` 保持可恢复。

模型凭证只存在于运行期配置对象。`AgentSessionStore`、会话导出和模型调用审计均不保存 provider payload 或 API Key。

## Compatibility boundary

`src/engine.mjs` 与 `src/application/RunService` 是旧多方案实验工作流的兼容路径，保留既有测试和历史记录读取能力。Web 主界面、CLI 和 MCP `varina_chat` (及兼容别名 `aha_chat`) 不依赖它。MCP 工具名 `varina_design_architecture` (及兼容别名 `aha_design_architecture`) 也已转接新 Agent，而非旧 RunService。
