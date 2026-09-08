# Chat 与工作流库解耦 · A1 实施计划

**Goal:** 完成设计文档 `docs/agent-workflow-drafts-design.md` 第 9 节的 A1 阶段：取消 Chat 到工作流库的自动镜像，把会话版本正式当作草稿，入库改为用户明确操作，并修正跨设备工作流身份。

**Architecture:** Gateway 会话记录增加 `workspaceMode / sourceRef / lastLibrarySave / librarySaveOp` 字段并校验保存操作的状态迁移；App 删除 `mirror.ts`，新增 `LibrarySaveService`（意图记在 Gateway、文件由客户端条件写入）和 `migration.ts`（旧绑定转来源关系）；云同步下载时采纳文件内 `workflow_id`。所有状态机和判定逻辑放在纯函数模块，用 `node:test` 覆盖。

**范围外（A2/B）：** 草稿画布 `/chat/:id/canvas`、事件派生的执行记录、相关对话筛选、归档、会话列表分页。A1 期间聊天页“画布”按钮只在已保存到库时出现，打开库中的正式工作流。

**进度（2026-09-08）：** Task 1 到 11 的代码与自动化测试已完成并通过；未做的是 Task 11 的 Android E2E 实跑和手工验收，以及各任务里标注“手工”的真机检查。

**验证命令速查：**

```bash
npm run test:agent        # Gateway：tsc -p gateway/tsconfig.json 再跑 gateway/**/test/*.test.ts
npm run test:agent-ui     # App 纯函数：tests/agent/*.test.ts
npm run test:transcript   # App 纯函数 + i18n 覆盖检查
npm run build             # tsc -b && vite build
npm run lint
```

**关于 i18n 测试：** `tests/transcript/i18n.test.ts` 要求 `src/components/agent/**/*.tsx` 里所有 `at('…')` 字面量在四种语言的 `agentUI` 里都有键。Task 5 到 Task 9 新增的文案统一在 **Task 10** 补齐，在那之前 `npm run test:transcript` 的 i18n 用例预期失败，各任务只需保证 `npm run build` 和自己的测试通过。

**任务依赖：** 1 → 2 → 3 → {4, 5, 6, 7} → 8 → 9 → 10 → 11。Task 4 与 5/6/7 可并行。

---

## 文件结构

**Gateway（修改）**

- `gateway/agent/store.ts`：`Session` 新字段；启动迁移 `markLegacySessions`；`updateSession` 校验 `librarySaveOp` 迁移；`version_requests` 表；`versionsPage`。
- `gateway/agent/service.ts`：`createSession` 接收 `sourceRef`，名称不再取工作流名；`importVersion` 接收 `requestId`。
- `gateway/agent/routes.ts`：`createInput / patchInput / importInput` 扩展；`GET /sessions/:id/versions?before=&limit=`。
- `gateway/index.js`：启动时调用 `markLegacySessions`。
- `gateway/agent/README.md`：API 表。
- `gateway/agent/test/sessions.test.ts`、`routes.test.ts`：新字段与状态机断言。

**App（新建）**

- `src/components/agent/graphHash.ts`：`graphHash(canvas)`，nodes/links 规范化 JSON 的 SHA-256。
- `src/components/agent/migration.ts`：`planLegacyMigration`。纯函数。
- `src/infrastructure/library/librarySaveMachine.ts`：保存操作状态机与核对判定。纯函数。
- `src/infrastructure/library/LibrarySaveService.ts`：把状态机接到 `AgentApi`、`ComfyFileService`、IndexedDB 与墓碑。
- `src/components/agent/LibrarySaveSheet.tsx`：保存面板。
- `src/components/agent/DraftStatusLine.tsx`：composer 上方的草稿/入库状态行。
- `src/infrastructure/sync/cloudIdentity.ts`：`resolveCloudWorkflowId`。纯函数。
- `tests/agent/graphHash.test.ts`、`migration.test.ts`、`librarySave.test.ts`、`cloudIdentity.test.ts`。

**App（修改）**

- `src/infrastructure/api/AgentApi.ts`：类型与 `versions()`、`importVersion(requestId)`。
- `src/shared/types/app/IComfyWorkflow.ts`：`CloudWorkflowMetadata.identityConflict`、`saveOpId`。
- `src/infrastructure/sync/CloudWorkflowSyncService.ts`：下载采纳 id；`workflowContentForCloud` schema 2。
- `src/infrastructure/storage/IndexedDBWorkflowService.ts`：`upsertSyncedWorkflow`（不触发本地变更事件）。
- `src/components/agent/binding.ts`：`sessionTitle` 不再返回工作流名；删除 `canvasChangedSinceMirror`、`hashCanvas`。
- `src/components/agent/ChatPage.tsx`、`ChatHeader.tsx`、`ChatCards.tsx`、`WorkflowPickerSheet.tsx`、`VersionHistorySheet.tsx`。
- `src/components/workflow/WorkflowDetailModal.tsx`、`WorkflowEditor.tsx`、`WorkflowList.tsx`：“使用”入口；“需要重新关联”标记。
- `src/locale/{zh,en,ja,ko}/common.json`：`agentUI` 键。
- `tests/e2e/agent-android-scenario.mjs`：选择器。

**App（删除）**

- `src/components/agent/mirror.ts`、`tests/agent/mirror.test.ts`。

---

### Task 1: 图内容哈希 `graphHash`

**Files:**
- Create: `src/components/agent/graphHash.ts`
- Create: `tests/agent/graphHash.test.ts`
- Modify: `src/components/agent/binding.ts`（删除 `hashCanvas`、`canvasChangedSinceMirror`，在 Task 5 前先保留导出以免编译失败）

- [x] **Step 1: 写测试。** 同一图不同键序哈希相同；只改 `extra` 哈希不变；改一个 widget 值哈希变化；输出为 64 位十六进制。
- [x] **Step 2: 实现。** 取 `nodes` 与 `links`，对象键排序后 `JSON.stringify`，用 `crypto.subtle.digest('SHA-256')`；返回 `Promise<string>`。浏览器与 Node 22 都有 `globalThis.crypto.subtle`。
- [x] **Step 3: 验证。** `npm run test:agent-ui`。

---

### Task 2: Gateway 会话字段、名称独立、保存操作状态机、版本幂等与分页

**Files:**
- Modify: `gateway/agent/store.ts`、`service.ts`、`routes.ts`、`index.js`、`README.md`
- Modify: `gateway/agent/test/sessions.test.ts`、`routes.test.ts`

- [x] **Step 1: 类型。** 在 `store.ts` 增加：

```ts
export interface SourceRef { serverId: string; workflowId: string; filename: string; name: string; etag?: string }
export interface LibrarySave { serverId: string; workflowId: string; filename: string; name: string; draftVersion: number; graphHash: string; etag: string; opId: string; at: number }
export type LibrarySaveState = 'pending' | 'applying' | 'reconciling' | 'succeeded' | 'conflict' | 'failed';
export interface LibrarySaveOp {
  opId: string; mode: 'create' | 'update'; draftVersion: number; graphHash: string;
  target: { serverId: string; filename: string; workflowId: string; name: string; expectedEtag?: string };
  state: LibrarySaveState; startedBy: string; startedAt: number; updatedAt: number; result?: { etag?: string; error?: string };
}
export interface Session {
  id: string; owner: string; name: string; version: number; created: number;
  workspaceMode?: 'draft' | 'legacy'; sourceRef?: SourceRef; lastLibrarySave?: LibrarySave; librarySaveOp?: LibrarySaveOp;
  legacyWorkflow?: SessionWorkflow; // 旧绑定证据，迁移后只读
}
```

- [x] **Step 2: 启动迁移。** `markLegacySessions()`：没有 `workspaceMode` 的会话置 `legacy`，`workflow` 改名 `legacyWorkflow`；可重复执行。在 `index.js` 里紧跟 `adoptLegacyDeviceSessions` 调用。
- [x] **Step 3: 创建与命名。** `store.create(owner, name, canvas?, sourceRef?)` 写 `workspaceMode: 'draft'`；`service.createSession` 不再用 `workflow?.name` 覆盖 `name`。`updateSession` 删除“绑定改名同步会话名”的分支。
- [x] **Step 4: 保存操作迁移校验。** `updateSession` 接受 `librarySaveOp` 与 `lastLibrarySave`，规则：
  - 已有操作处于 `pending/applying/reconciling` 时，提交不同 `opId` 的新操作返回 409 `另一设备正在保存`。
  - 同一 `opId`：`pending→applying→(succeeded|conflict|failed)`、`applying→reconciling→(succeeded|conflict)` 合法；其他返回 409。
  - 同一 `opId` 且请求体与已存内容相同返回原会话（幂等）。
  - `lastLibrarySave` 只能与 `succeeded` 一起写，且 `opId` 一致。
- [x] **Step 5: 版本幂等。** 新表 `version_requests(session_id, request_id, version, PRIMARY KEY(session_id, request_id))`。`importVersion` 带 `requestId` 时先查表，命中直接返回原版本；未命中在同一事务写入。
- [x] **Step 6: 版本分页。** `store.versionsPage(id, before?: number, limit = 50)`；路由 `GET /sessions/:id/versions?before=&limit=` 返回 `{ versions, hasMore }`。`snapshot()` 改用 `versionsPage(id, undefined, 50)` 并附 `versionsHasMore`。
- [x] **Step 7: 路由输入。** `createInput` 的 `workflow` 改为 `sourceRef`；`patchInput` 增加 `sourceRef | null`、`librarySaveOp`、`lastLibrarySave`、`workspaceMode: 'draft'`；`importInput` 增加 `requestId: uuid().optional()`。
- [x] **Step 8: 测试。** `sessions.test.ts`：迁移可重复；创建不改名；状态机每条非法迁移返回 409；并发第二个 op 被拒；`requestId` 重试返回同一版本；分页边界。`routes.test.ts`：新字段的 HTTP 断言。
- [x] **Step 9: 验证。** `npm run test:agent`，更新 README API 表。

---

### Task 3: App API 客户端类型

**Files:**
- Modify: `src/infrastructure/api/AgentApi.ts`

- [x] **Step 1:** 镜像 Task 2 的类型到 `AgentSession`、`SessionPatch`；`create(name, canvas?, sourceRef?)`；`importVersion(id, canvas, baseVersion, summary, requestId)`；新增 `versions(id, before?, limit?)`；`AgentSnapshot` 增加 `versionsHasMore`。
- [x] **Step 2: 验证。** `npm run build`（此时 ChatPage 仍引用旧 `workflow` 字段，允许临时用 `legacyWorkflow` 过渡以通过编译）。

---

### Task 4: 云下载采纳 `workflow_id`（设计 5.2）

**Files:**
- Create: `src/infrastructure/sync/cloudIdentity.ts`、`tests/agent/cloudIdentity.test.ts`
- Modify: `src/shared/types/app/IComfyWorkflow.ts`、`src/infrastructure/sync/CloudWorkflowSyncService.ts`、`src/components/workflow/WorkflowList.tsx`

- [x] **Step 1: 纯函数。** `resolveCloudWorkflowId({ cachedId, fileWorkflowId, filename, existing: Array<{ id, filename }> })` 返回 `{ id, identityConflict }`：顺序 `cachedId → fileWorkflowId → stableCloudId(filename)`；`fileWorkflowId` 已被另一条不同文件名的记录占用时退回文件名派生 id 并置 `identityConflict: true`。
- [x] **Step 2: 测试。** 三个来源的优先级；复制文件冲突；改名后 id 不变（因为文件内 id 存在）。
- [x] **Step 3: 接入。** 下载函数改用它；`CloudWorkflowMetadata` 增加 `identityConflict?: boolean`、`saveOpId?: string`。`workflowContentForCloud` 写 `comfy_mobile_cloud: { schema: 2, workflow_id, save_op_id? }`，读取时兼容 schema 1。
- [x] **Step 4: 列表标记。** `WorkflowList` 对 `identityConflict` 的条目显示“需要重新关联”标签（文案走 `agentUI`）。首期不做重新关联操作，只提示。
- [x] **Step 5: 验证。** `npm run test:agent-ui`、`npm run build`。真实服务器上把一个文件复制一份后同步，副本带标记，原件 id 不变。

---

### Task 5: 删除自动镜像与单会话绑定

**Files:**
- Delete: `src/components/agent/mirror.ts`、`tests/agent/mirror.test.ts`
- Modify: `src/components/agent/binding.ts`、`ChatPage.tsx`、`ChatHeader.tsx`、`ChatCards.tsx`、`WorkflowPickerSheet.tsx`
- Modify: `src/components/workflow/WorkflowDetailModal.tsx`、`WorkflowEditor.tsx`
- Modify: `tests/agent/binding.test.ts`

- [x] **Step 1: binding.ts。** `sessionTitle` 删除 `if (session.workflow) return session.workflow.name` 分支；删除 `resolveBoundWorkflow`、`canvasChangedSinceMirror`、`hashCanvas`。更新 `binding.test.ts`。
- [x] **Step 2: ChatPage。** 删除镜像 effect、`mirrorDeps`、`importCanvasIfChanged` 调用、`missing / conflict / unsupported / mirroredVersion / writtenVersion / mirrorError` 状态和对应卡片；`send()` 创建会话时不再写 `updateWorkflowAgentBinding`；重命名只 `api.update({ name })`；删除会话不再清绑定。空态文案里的“并写入你的工作流库”删掉。
- [x] **Step 3: 入口。** `WorkflowPickerSheet.onPick` 一律 `setPending(workflow)`。`WorkflowDetailModal` 与 `WorkflowEditor` 的“打开会话”改为“使用”，固定跳 `/chat/new?workflow=<id>`；保留 `AgentWorkflowBinding` 类型供 Task 7 读取，不再写入。
- [x] **Step 4: 卡片。** `WorkflowChangeCard` 去掉 `mirrored` 属性；`ChatHeader.onOpenCanvas` 只在 `session.lastLibrarySave` 存在且库中能找到目标时提供，跳 `/workflow/<目标 id>`。
- [x] **Step 5: 验证。** `npm run test:agent-ui`、`npm run build`。手工：新建 3 个会话各生成一次，IndexedDB 与服务器工作流数量不变。

---

### Task 6: “使用”入口与来源快照

**Files:**
- Modify: `src/components/agent/ChatPage.tsx`、`ChatHeader.tsx`

- [x] **Step 1: 创建会话。** `pending` 存在时 `api.create(fallbackName, pending.workflow_json, sourceRef)`，其中 `sourceRef` 只在 `pending.cloud?.filename` 存在时构造：`{ serverId: 规范化 ComfyUI 地址, workflowId: pending.id, filename, name, etag: pending.cloud.etag }`；本地未同步流程只传 canvas。会话名用首条消息，不用工作流名。
- [x] **Step 2: 头部。** 有 `sourceRef` 时副标题显示“使用：<name>”；`?workflow=` 预载时同样显示。
- [x] **Step 3: 验证。** `npm run build`。手工：同一流程开两个会话分别改提示词，来源文件 ETag 不变。

---

### Task 7: 旧会话迁移（设计 8.2）

**Files:**
- Create: `src/components/agent/migration.ts`、`tests/agent/migration.test.ts`
- Modify: `src/components/agent/ChatPage.tsx`

- [x] **Step 1: 纯函数。** `planLegacyMigration({ session, workflows, latestGraphHash, serverId })` 返回 `{ patch: SessionPatch; clearBinding?: workflowId }`：
  - 找 `legacyWorkflow` 对应的本地条目（按 id，再按 `cloud.filename`）。
  - 条目存在且 `agent.sessionId === session.id`：`sourceRef` 指向它；`agent.mirroredHash === latestGraphHash` 时再写 `lastLibrarySave`（`draftVersion = agent.mirroredVersion`，`opId = 'legacy'`，`etag = cloud.etag ?? ''`）。
  - 条目不存在或绑定的是别的会话：只写 `workspaceMode: 'draft'`，不建 `sourceRef`。
  - 始终写 `workspaceMode: 'draft'`。
- [x] **Step 2: 测试。** 上述三种分支；旧 `mirroredHash` 是 FNV 格式时视为不一致（不写 `lastLibrarySave`）。
- [x] **Step 3: 接入。** `ChatPage` 打开 `workspaceMode === 'legacy'` 的会话时执行一次：取最新版本算 `graphHash`，`api.update(patch)`，成功后 `updateWorkflowAgentBinding(id, undefined)`。失败只 toast，不阻塞聊天。
- [x] **Step 4: 验证。** `npm run test:agent-ui`。手工：打开一个旧会话，刷新后 `workspaceMode` 为 draft，库条目未增加。

---

### Task 8: 入库状态机与 `LibrarySaveService`（设计 6.1）

**Files:**
- Create: `src/infrastructure/library/librarySaveMachine.ts`、`LibrarySaveService.ts`、`tests/agent/librarySave.test.ts`
- Modify: `src/infrastructure/storage/IndexedDBWorkflowService.ts`

- [x] **Step 1: 纯函数。** `librarySaveMachine.ts`：
  - `planSave({ session, mode, draftVersion, graphHash, name?, target?, serverId, startedBy })` → `LibrarySaveOp`（`create` 模式在此固定 `filename = sanitizeCloudWorkflowFilename(name)` 与新 `workflowId`；`update` 模式带 `expectedEtag`）。
  - `decideAfterWrite(op, result)` → `succeeded | conflict | failed` 与 `lastLibrarySave`。
  - `decideAfterReconcile(op, downloaded)`：文件的 `save_op_id === op.opId` 且 `graphHash` 相同 → `succeeded`；否则 `conflict`。
  - `saveAvailability(session, currentGraphHash)` → 3.3 表格的六种情况之一。
- [x] **Step 2: 测试。** 每种状态迁移；双击只产生一个 op；重试沿用原文件名；核对成功/失败；六种可用性判定。
- [x] **Step 3: IndexedDB。** 新增 `upsertSyncedWorkflow(workflow)`：写入 `cloud.dirty=false`，不调用 `emitWorkflowLocalChange`。
- [x] **Step 4: 服务。** `LibrarySaveService.start(...)`：
  1. `api.update(session.id, { librarySaveOp: pending })`（Gateway 409 → 显示“另一设备正在保存”）。
  2. `removeCloudWorkflowDelete(filename)` 清墓碑；`api.update(... state: 'applying')`。
  3. `service.saveWorkflow(filename, content, create ? { overwrite: false } : { expectedEtag })`，content 由 `workflowContentForCloud` 生成并带 `save_op_id`。
  4. `api.update` 写结果；成功时同时写 `lastLibrarySave` 并 `upsertSyncedWorkflow`。
  - `reconcile(session)`：会话 `librarySaveOp.state` 为 `applying/reconciling` 时下载目标文件走 `decideAfterReconcile`。
- [x] **Step 5: 验证。** `npm run test:agent-ui`、`npm run build`。

---

### Task 9: 保存面板、状态行与“保留版本”卡片

**Files:**
- Create: `src/components/agent/LibrarySaveSheet.tsx`、`DraftStatusLine.tsx`
- Modify: `src/components/agent/ChatPage.tsx`、`ChatCards.tsx`、`VersionHistorySheet.tsx`

- [x] **Step 1: 面板。** 按 `saveAvailability` 渲染：新建（输入名称）、更新「目标名」/另存、已与工作流一致、冲突（查看当前版本 / 另存）、目标已删除（另存）、另一设备正在保存。固定 `draftVersion` 为打开面板时的 `session.version`，面板上显示“将保存版本 N”。
- [x] **Step 2: 状态行。** composer 上方一行：草稿已保存 / 正在保存到工作流库… / 已保存到「名称」 / 草稿有新修改 / 未能保存到工作流库，草稿已保留 / 上次保存未确认，正在核对。“草稿有新修改”由 `lastLibrarySave.draftVersion < session.version` 判定，不再算哈希。
- [x] **Step 3: 卡片。** `saved` 事件改渲染为“版本 N 已保留”，附“保存到工作流库”按钮，点击打开面板并固定该版本。`VersionHistorySheet` 每个版本增加同样的入口。
- [x] **Step 4: 打开会话时核对。** `ChatPage` 拿到快照后若 `librarySaveOp.state ∈ {applying, reconciling}` 调用 `reconcile`。
- [x] **Step 5: 验证。** `npm run build`。手工走 3.3 表格六种情况。

---

### Task 10: 文案与 i18n

**Files:**
- Modify: `src/locale/{zh,en,ja,ko}/common.json`

- [x] **Step 1:** 收集 Task 4 到 9 新增的 `at('…')` 字面量，四种语言补齐 `agentUI` 键；删除镜像相关的废弃键（“写入工作流库失败”“绑定的工作流已从库里删除”“画布上有未同步的修改”等）。
- [x] **Step 2: 验证。** `npm run test:transcript` 全绿。

---

### Task 11: 回归、E2E 与验收

**Files:**
- Modify: `tests/e2e/agent-android-scenario.mjs`
- Modify: `comfy-mobile-ui-api-extension/handlers/workflow_handler.py`、`tests/test_workflow_paths.py`

- [x] **Step 1: 扩展端。** `save_workflow` 的 ETag 检查到 `os.replace` 之间加注释说明依赖“无 await”串行；`test_workflow_paths.py` 增加一个并发保存用例（两个协程同 `expected_etag`，恰好一个 409）。
- [x] **Step 2: E2E。**（2026-09-08 在 emulator-5554 上以隔离 Gateway + 新 APK 跑通：库数量断言、明确保存、画布往返、19 个应用用例全部通过；唯一失败是既有的顶部菜单中心触摸断言，见 `docs/agent-chat-e2e-2026-09-07.md`） Android 场景改为：新建会话生成 → 断言库数量不变 → 保存到工作流库 → 断言只多一条 → 再聊天修改 → 断言库未变且状态行显示“草稿有新修改”。
- [x] **Step 3: 全量。** `npm run test:agent && npm run test:agent-ui && npm run test:transcript && npm run build && npm run lint`。
- [ ] **Step 4: 手工验收。** 对照设计文档第 10 节，勾选与 A1 相关的条目：
  - 20 个咨询会话、20 个生成会话，库与服务器文件数不变。
  - 同一流程两个 Chat，来源 ETag 不变。
  - 双击保存、超时重试、App 被杀后重开，只产生一个库条目。
  - 入库后再聊天修改，库不被覆盖，显示“草稿有新修改”。
  - 两台设备同时更新同一正式工作流，一方成功一方冲突，无 conflict 副本。
  - A 设备保存中，B 设备显示“另一设备正在保存”。
  - 两台设备下载同一文件 id 相同；服务器复制文件后副本被标记。
  - 有同名墓碑时保存成功，下次同步不删除。
  - 迁移旧会话，所有版本与旧库条目保留。
  - 超过 100 个版本可分页访问。
