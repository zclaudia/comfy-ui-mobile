# Agent 消息展示迁移计划

状态：迁移已实现；App 已切换至 npm 正式版 0.8.0。2026-09-06。

## 目标与范围

将 Comfy Mobile 助手的消息展示迁移至 `@zclaudia/agent-transcript-kit` 的视图模型、reducer 和 React 组件。同一轮请求按顺序显示说明、工具调用、工作流版本、生成结果和最终回复；保留既有对话、保存/恢复版本、打开画布、原生媒体鉴权和后台任务恢复。

已通过 npm registry 核对：latest 为 0.7.0，本地 `/Users/zhvala/SourceCode/zclaudia-agent-transcript-kit` 也是 0.7.0。实现从该基线开始。当前 App 使用 React 19，满足包的 React >=18 peer 约束。

本轮不引入新的 LLM SDK，不改模型、生成模板或执行预算，不增加审批流程、终端执行、附件上传或 token 级流式传输。当前 Gateway 的逐步骤文本与轮询足够支撑本次迁移。

## 架构与职责

数据链路：Gateway 持久事件 → App 会话排序/去重 → ComfyTranscriptAdapter → kit TranscriptState → App AgentTranscript → kit 通用组件与 Comfy 专属卡片。

- Gateway：记录可信的工具生命周期、任务状态与输出引用；继续负责 SQLite、任务执行、会话所有权和幂等提交。
- App：负责传输、seq/cursor、分页和重连、业务名称、媒体鉴权、版本操作、滚动及中文文案。
- kit：负责通用消息块、reducer、工具卡片、代码块与主题协议；不引入 Comfy、Tauri 或 Vercel AI SDK 依赖。
- `AgentMarkdown` 保留 react-markdown + remark-gfm，代码围栏接入 kit `CodeBlock`；生成媒体继续使用 `AgentMedia`。

## P1：补齐 kit 的通用扩展

### 有序自定义内容块

当前 `TurnBlock` 只有 text/thinking/tool_call。顶层 marker 无法表达“同轮文本 → 媒体 → 后续文本”：同轮后来追加的文本仍在原 assistant_turn 中，会排列在独立 marker 之前。

新增通用 custom block（拟定字段 `id`、`type`、`payload`）及对应插入事件，带 `turnId`。按块 ID 幂等插入，保持该轮 block 顺序；业务 payload 的校验、内容与渲染由宿主负责。独立于任务的保存/恢复通知仍使用顶层 marker。类型名称在实现时与包现有设计统一。

配套更新 guards、selectors、批处理事件分类、公共导出、README、reducer 测试；未知 custom 类型允许宿主忽略或显示通用说明。新增联合类型成员可能影响其他消费者的穷尽检查，发布前核对并明确版本兼容性，不直接承诺无影响的 minor 升级。

用户消息已有 `appendUserMessage`，直接使用，不重复增加一套用户消息事件。

### 移动端组件能力

- 能力注入增加可选 `copyText(text)`，默认仍使用浏览器剪贴板；捕获复制失败并提供可见反馈。
- 通用按钮文案允许配置，默认保持现有英文，App 提供中文。
- `ToolCallCard` 增加宿主可提供的展示名称与摘要，保留现有 classifier 作为默认值。模型返回的原始参数不直接成为标题。
- App 通过主题变量、宿主样式确保至少 44px 的交互目标、长名称可换行/省略、代码与宽表格局部滚动。
- 核对 CSS 入口的打包保留：现有 `sideEffects: false` 改为显式保留 CSS 的声明，并验证生产构建。

不为此次迁移新增 ThinkingBlock 内容来源；仅展示后端明确提供、允许展示的内容。本次不接入 InteractionCard 或 DiffView；工作流改动继续使用业务描述。

验收：kit 核心与 React 测试、类型检查、打包通过；新增块交错、重放、复制成功/失败、中文文案和默认兼容行为有针对性测试。

## P2：完善 Gateway 展示事件

在统一工具执行包装器中记录 `tool_started` 和 `tool_finished`，包含稳定 `toolCallId`、name、必要的输入摘要、成功/错误状态与时间。所有工具路径都覆盖，包括只读检查、验证和提交；内部 `finish_response` 完成审核不作为业务工具卡片展示。

- 已存在的 receipt 重放不得重复执行，也不得留下无法结束的工具卡片；进程重启按 receipt 与任务状态恢复。
- 捕获后以 `{error: ...}` 返回的工具失败，仍必须发出失败状态。
- 记录有界且经过字段筛选的展示数据；不增加 provider 原始响应、密钥、整个模型目录或完整工作流副本到卡片事件。
- 保留旧 `tool` 事件兼容现有客户端，新增事件给新版使用；两者的关联以稳定调用 ID 为准，新版只展示一次。
- 保存成功、工作流创建、媒体成功等业务事件继续独立记录，并通过 taskId 归入同轮；独立手动操作保持 taskId=null。
- `submit_preview` 的工具完成仅表示提交完成，不能显示为生成完成；任务继续显示等待 ComfyUI，收到 result 才显示产物成功。
- 未知提交状态继续使用现有 reconciling 流程；前端展示不得触发重新提交。

当前 generateText 在整个步骤结束后才写 assistant 文本，历史事件不足以恢复模型在工具前说话的精确时间。本次保证持久事件的真实顺序，不通过前端猜测重排。新协议可附 step/call 关联，但 token 级实时顺序另行建设。

数据库原则：优先使用现有事件 JSON 的增量字段，无需重写历史事件表。记录协议/能力版本，以便 App 判断旧、新事件路径。

验收：生命周期、错误、receipt 重放、取消、进程恢复和生成等待的定向后端测试通过；旧客户端读取 snapshot 不受影响。

## P3：App 适配器与消息组件迁移

建议新增：

- `src/components/agent/transcript/adapter.ts`：wire → kit 转换与旧事件兼容。
- `src/components/agent/transcript/useAgentTranscript.ts`：会话局部状态、分页应用与生命周期清理。
- `src/components/agent/transcript/AgentTranscript.tsx`：用户消息和助手轮次布局。
- `src/components/agent/transcript/ComfyToolCard.tsx`：中文名称、执行状态及按需展开详情。
- `src/components/agent/transcript/ComfyContentBlock.tsx`：工作流、媒体、保存和错误卡片。
- `src/components/agent/transcript/theme.css`：主题变量及移动端样式。

| 现有事件 | 目标展示 |
| --- | --- |
| user | appendUserMessage，ID 使用会话 ID + seq |
| queued/running | taskId 对应同一 turn_started，重复状态不重复开轮 |
| assistant | 当前为独立完整段落，去重后作为带段落边界的 delta 追加；不能当作整轮 snapshot |
| tool_started/tool_finished | 同一 toolCallId 的 ToolCallCard 生命周期 |
| 旧 tool | 使用 seq 生成稳定 ID，显示已完成记录；不虚构历史执行时间 |
| workflow/result/execution_error/saved | 归属 taskId 的 custom block；无 taskId 时为顶层 marker |
| waiting_comfy/reconciling | 保持轮次未结束，显示“正在生成/正在核对提交” |
| completed/failed/cancelled | turn_finished/turn_failed/turn_cancelled |
| usage | 汇总各 step 的 usage，防止重复页计数；可先不展示费用 |

适配规则：

1. seq 是全库递增值，会话内不要求连续。按会话排序去重，按服务端 cursor/hasMore 拉完分页，不用 seq+1 判断丢包。
2. 历史回放完成前，不用 snapshot 的最新终态提前关闭旧工具；完成分页后再与任务状态核对。会话切换取消请求并隔离 reducer。
3. 不能依赖 reducer 为 text delta 去重；App 必须在应用事件前过滤已处理 seq。
4. 展开状态以稳定 ID 保持；只在用户接近底部时自动跟随，向上阅读时提供“回到最新”入口。
5. 运行状态、停止按钮、错误重试和 provider 未配置提示继续工作。取消展示不得暗示 GPU 已停止。
6. 保留鉴权媒体组件，不把 bearer token 或临时 Blob URL 写入可持久化 transcript。
7. 代码复制走宿主能力；不用 runInTerminal。Markdown 不启用原始 HTML，链接处理沿用既有安全边界。
8. 提供临时开发回退开关，便于相同会话对照新旧展示；验证结束后统一为新版入口。

## P4：验证、发布与回滚

### 验证矩阵

- 原 H3 会话：表格、内联代码、中文排版、历史视频播放正常。
- Z-Image：自然语言请求 → 检查/创建/验证/提交 → 图片 → 最终回复，顺序正确。
- H3：工具提交结束后仍显示生成中，成功后视频可播放。
- 调整并再运行：同轮内容无错序，多轮边界清晰；版本保存、恢复、打开独立画布副本有效。
- 缺模型/校验失败/生成失败：准确显示失败位置，可展开诊断，无永久旋转状态。
- 请求进行中切换会话、断网重连、Gateway 重启、超过 200 条事件分页、重复响应：消息和工具不丢失、不重复。
- 取消：轮次结束、迟到事件妥善处理，不额外中断其他人的生成。
- Android：代码复制与失败反馈、44px 点击区域、宽内容滚动、键盘打开、向上阅读不被拉回底部。
- 从旧事件恢复、新旧 Gateway 与 App 组合兼容；保留现有模型适配单测与 Android 关键回归。

### 依赖与部署

1. kit 改动先在其仓库验证，用 `npm pack` 产物在 App 测试真实 exports/CSS/peer 依赖；不把开发机器的绝对 file 路径写进最终依赖。
2. 对照其他使用方确认新增公共类型的兼容性，记录变更日志，再确定发布版本。发布 npm 是单独的外部发布动作，执行前呈现确切版本与变更；本计划不执行发布。
3. 正式 App 精确锁定已发布版本；没有正式包时仅形成可复现的候选测试构建。
4. 先部署兼容旧客户端的 Gateway，再升级 Android/Web；保留已有 `.env` 和设备注册。
5. 仅对明确为 emulator-* 且 ro.kernel.qemu=1 的 Android 虚拟机安装和验证，保留用户演示会话。
6. 回滚 App 到旧展示即可继续使用新增事件的 Gateway；Gateway 回滚时新版 App 走旧事件兼容路径。保留部署前镜像与 APK。

## 执行顺序与完成标准

顺序：P1 通用扩展 → P2 Gateway 事件 → P3 适配与 UI → P4 真机环境链路验收和发布。这里的 Android 验收目标为虚拟机，后端为真实 ai-server。

完成标准：现有功能全部可用；每轮请求的正文、工具、版本和产物顺序正确；旧会话可读；断线重连与恢复不导致重复消息或重复执行；Android 上 Markdown、复制、媒体和画布操作验证通过；依赖版本与回滚路径明确。

最终交付：kit 可发布变更、Gateway 兼容事件、App 迁移实现、针对性测试、Android 演示截图/录像及部署说明。

## 实施记录（2026-09-06）

已实现 kit custom_block、复制注入/失败反馈/中文标签、工具名称摘要覆盖和 CSS sideEffects；Gateway 新增工具生命周期及协议标识；App 使用 kit reducer、同轮 block 展示、工具卡片与代码块，保留原生媒体和版本操作，并支持回到最新消息。

依赖采用仓库内 `vendor/zclaudia-agent-transcript-kit-0.8.0-comfy.0.tgz` 候选包及 lockfile 校验，Docker 在 npm ci 前复制 vendor。此版本未发布 npm；registry 正式版本替换属于后续发布步骤。旧用户消息使用现有 appendUserMessage，没有重复扩展用户事件。

实现使用纯适配函数在 events 更新时重建 transcript（useMemo），不额外增加一份持久化消息状态；从 seq 去重后的持久事件重放。该策略简化旧会话兼容与恢复，未来大型会话可在保持相同回放测试的前提下增量化。现阶段没有引入虚拟列表。

代码高亮保留宿主注入接口，本次仅增加语言标签、复制和滚动；没有新增语法高亮依赖。未展示思考内容、审批卡片或终端执行操作。


### 验证结果与已知边界

- kit 核心检查、43 项 React 测试和构建通过。
- App transcript 6 项测试通过，覆盖交错顺序、重复事件、720 条事件分页、终态核对和未结束工具恢复。
- Agent 40 项、Gateway 4 项测试通过；Web/Android 构建通过。
- 实际 Android Z-Image 生成、保存与画布打开通过。H3 视频生成、保存与播放通过；该轮因模型多次修正参数触发 12 次调用上限，界面保留产物并显示失败终态。后续整理参数的一轮成功完成，没有重复生成。
- Android 浏览器剪贴板被 WebView 拒绝，已改为通过能力注入使用 Tauri 官方 clipboard-manager，原生端只授权 write-text。复制后粘贴到输入框，内容与代码块一致。测试随后清空输入框。
- 同一会话两轮、8 张工具卡片、表格和代码块显示正常，无页面横向溢出；Gateway 重启与 APK 覆盖安装后原会话/视频仍可访问。
- 实测证据位于 `tests/output/transcript-demo/`；APK 构建和后端测试日志位于 `tests/output/android-demo/transcript-*.log`。
- 可在完整 Android E2E 中设置 `E2E_AGENT_MODELS=1 E2E_AGENT_TRANSCRIPT=1` 复测模型与消息展示；完整测试仍按原规则清理其测试设备注册，演示期间使用保留会话的独立验证。
- 未发布 npm，也未对其他 kit 宿主仓库做联合升级；新增 custom 联合类型的穷尽检查兼容性需在正式发布前核对。


### 正式版依赖切换（2026-09-06）

用户已发布 npm 0.8.0。App 现精确依赖 `@zclaudia/agent-transcript-kit: 0.8.0`，lockfile 使用 registry 产物和 integrity 校验。移除本地候选 tarball、vendor 说明及 Docker 的 vendor COPY。上方关于候选包与未发布状态的描述为迁移阶段历史记录，已由此正式版切换取代。
