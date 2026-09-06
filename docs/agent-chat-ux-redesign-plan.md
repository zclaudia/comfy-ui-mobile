# Agent Chat 入口与工作流绑定 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工作流助手从侧边菜单里的独立页面改成对话优先的首页（底部标签栏），并让每个会话和工作流库里的一个工作流一对一绑定、自动镜像版本。

**Architecture:** Gateway 会话记录增加 `workflow` 绑定字段并新增列表摘要、PATCH、DELETE、画布导入版本四个接口；App 新增底部标签外壳、会话列表页、聊天页，绑定与镜像逻辑放在纯函数模块 `binding.ts` / `mirror.ts` 里以便用 node:test 覆盖；编辑器和工作流库各加一个跳转到绑定会话的入口。

**Tech Stack:** Gateway：Node 22 `node:sqlite`、Zod、Vercel AI SDK（已有）。App：React 18 + react-router 6、zustand、Tailwind、lucide-react、i18next，测试用 `tsx --test`（node:test）。

**设计文档：** `docs/agent-chat-ux-redesign.md`。本计划相对设计文档的一处调整：顶层路由 `/` 改为"入口重定向"，会话列表放在 `/chats`，这样"按可用性决定默认标签"可以用一次 `<Navigate>` 完成。Task 16 会把这条同步回设计文档。

**验证命令速查：**

```bash
npm run test:agent        # Gateway：先 tsc -p gateway/tsconfig.json 再跑 gateway/**/test/*.test.ts
npm run test:transcript   # App 纯函数测试 + i18n 覆盖检查
npm run test:agent-ui     # Task 5 新增：tests/agent/*.test.ts
npm run build             # tsc -b && vite build，前端类型检查以此为准
npm run lint
```

**关于 i18n 测试：** `tests/transcript/i18n.test.ts` 要求 `src/components/agent/**/*.tsx` 里所有 `at('…')` 字面量都在四种语言的 `agentUI` 里有键，且四种语言键集合一致。Task 9 到 Task 14 会新增很多文案，统一在 **Task 15** 补齐翻译。在那之前 `npm run test:transcript` 里的 i18n 用例预期失败，各任务只需保证 `npm run build` 和自己的测试通过。

---

## 文件结构

**Gateway（修改）**

- `gateway/agent/store.ts`：`Session.workflow` 字段；`list()` 返回摘要；新增 `updateSession`、`deleteSession`。
- `gateway/agent/service.ts`：`createSession` 接收绑定；新增 `updateSession`、`deleteSession`、`importVersion`。
- `gateway/agent/routes.ts`：新增 PATCH / DELETE `/sessions/:id`、POST `/sessions/:id/versions`。
- `gateway/agent/README.md`：API 表。
- `gateway/agent/test/sessions.test.ts`（新建）：存储与服务层测试。
- `gateway/agent/test/routes.test.ts`：新接口的 HTTP 断言。

**App（新建）**

- `src/components/agent/binding.ts`：绑定解析、画布变更判断、默认标签选择、会话标题。纯函数。
- `src/components/agent/mirror.ts`：版本镜像到工作流库、画布导入会话。依赖注入，纯逻辑。
- `src/components/agent/useAgentStatus.ts`：助手可用性 hook。
- `src/components/agent/useSessionSnapshot.ts`：从旧 AgentPage 抽出的事件轮询 hook。
- `src/components/agent/AgentGuide.tsx`：未连接 Gateway / 未配模型 的引导页。
- `src/components/agent/SessionListPage.tsx`、`SessionRow.tsx`：会话列表。
- `src/components/agent/ChatPage.tsx`、`ChatHeader.tsx`、`ChatCards.tsx`、`WorkflowPickerSheet.tsx`、`VersionHistorySheet.tsx`：聊天页。
- `src/components/navigation/TabBar.tsx`、`TabLayout.tsx`、`RootRedirect.tsx`：底部标签外壳。
- `src/components/controls/AppSideMenu.tsx`：给会话列表页用的 SideMenu 包装（只做导航）。
- `src/ui/store/agentActivityStore.ts`：是否有会话在生成中（标签角标）。
- `src/platform/mediaDownload.ts`：从 FilePreviewModal 抽出的下载逻辑。
- `tests/agent/binding.test.ts`、`tests/agent/mirror.test.ts`。

**App（修改）**

- `src/infrastructure/api/AgentApi.ts`：类型、新方法；`src/infrastructure/api/AgentRequestError.ts`（新建，零依赖）带状态码的错误类。
- `src/shared/types/app/IComfyWorkflow.ts`：`agent` 绑定字段。
- `src/infrastructure/storage/IndexedDBWorkflowService.ts`：持久化 `agent` 字段。
- `src/App.tsx`：路由。
- `src/components/workflow/WorkflowHeader.tsx`、`WorkflowEditor.tsx`、`WorkflowDetailModal.tsx`、`WorkflowList.tsx`：入口与返回路径。
- `src/components/controls/SideMenu.tsx`：删除助手、画廊两行。
- `src/components/modals/FilePreviewModal.tsx`：改用 `downloadMedia`。
- `src/locale/{zh,en,ja,ko}/common.json`：`agentUI` 与 `tabs` 键。
- `tests/transcript/i18n.test.ts`：去掉 `menu.agent` 断言。
- `tests/e2e/agent-android-scenario.mjs`：新 UI 的选择器。
- `package.json`：`test:agent-ui` 脚本。

**App（删除）**

- `src/components/agent/AgentPage.tsx`、`src/components/agent/AgentHistory.tsx`。

---

### Task 1: Gateway 存储层：会话绑定、列表摘要、更新与删除

**Files:**
- Modify: `gateway/agent/store.ts`
- Create: `gateway/agent/test/sessions.test.ts`

- [ ] **Step 1: 写失败的存储层测试**

创建 `gateway/agent/test/sessions.test.ts`：

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentStore } from '../store.js';
import { textToImage } from '../templates.js';
import { info } from './fixture.js';

const canvas = () => textToImage(info, 'v1-5-pruned-emaonly-fp16.safetensors', 'test');

test('store keeps the workflow binding, summarises sessions and cascades deletion', () => {
  const store = new AgentStore(':memory:');
  const bound = store.create('me', '海报', canvas(), { id: 'wf-1', name: '海报', filename: '海报.json' });
  assert.deepEqual(bound.workflow, { id: 'wf-1', name: '海报', filename: '海报.json' });
  const blank = store.create('me', '新工作流');
  store.create('other', '别人的');
  store.enqueue(blank.id, 'r-1', '现在能用哪些模型？', 60_000);
  store.event(bound.id, null, 'result', { version: 1, outputs: [{ filename: 'a.png', subfolder: 'Agent', type: 'output', kind: 'image' }] });

  const list = store.list('me');
  assert.deepEqual(list.map(s => s.id), [bound.id, blank.id], 'latest activity first');
  const [first, second] = list;
  assert.equal(first.active, false);
  assert.deepEqual(first.thumbnail, { filename: 'a.png', subfolder: 'Agent', type: 'output' });
  assert.equal(first.lastMessage, undefined);
  assert.equal(second.active, true);
  assert.equal(second.lastState, 'queued');
  assert.equal(second.preview, '现在能用哪些模型？');
  assert.equal(second.lastMessage, '现在能用哪些模型？');
  assert.ok(second.lastActivity >= second.created);

  const renamed = store.updateSession(blank.id, { workflow: { id: 'wf-2', name: '模型清单' } });
  assert.equal(renamed.name, '模型清单');
  assert.deepEqual(renamed.workflow, { id: 'wf-2', name: '模型清单' });
  const unbound = store.updateSession(blank.id, { workflow: null });
  assert.equal(unbound.workflow, undefined);
  assert.equal(unbound.name, '模型清单');
  assert.equal(store.updateSession(blank.id, { name: '改名' }).name, '改名');

  store.deleteSession(bound.id);
  assert.throws(() => store.session(bound.id), /会话不存在/);
  assert.equal(store.events(bound.id).length, 0);
  assert.equal(store.versions(bound.id).length, 0);
  assert.deepEqual(store.list('me').map(s => s.id), [blank.id]);
  store.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run build:agent && npx tsx --test gateway/agent/test/sessions.test.ts`
Expected: 编译错误或断言失败，提示 `create` 不接受第 4 个参数 / `updateSession` 不存在。

- [ ] **Step 3: 修改 `gateway/agent/store.ts`**

把 `Session` 接口和 `list` / `create` 替换为：

```ts
export interface SessionWorkflow { id: string; name: string; filename?: string }
export interface Session { id: string; owner: string; name: string; version: number; created: number; workflow?: SessionWorkflow }
export interface MediaRef { filename: string; subfolder: string; type: string }
export interface SessionSummary extends Session { preview?: string; lastMessage?: string; lastActivity: number; active: boolean; lastState?: State; thumbnail?: MediaRef }
```

```ts
  list(owner: string): SessionSummary[] {
    const rows = this.db.prepare(`SELECT s.data,
      (SELECT substr(json_extract(e.data,'$.text'),1,100) FROM events e WHERE e.session_id=s.id AND e.kind='user' ORDER BY e.seq LIMIT 1) AS preview,
      (SELECT substr(json_extract(e.data,'$.text'),1,140) FROM events e WHERE e.session_id=s.id AND e.kind IN ('user','assistant') ORDER BY e.seq DESC LIMIT 1) AS last_message,
      (SELECT e.created FROM events e WHERE e.session_id=s.id ORDER BY e.seq DESC LIMIT 1) AS last_activity,
      (SELECT MAX(e.seq) FROM events e WHERE e.session_id=s.id) AS last_seq,
      (SELECT COUNT(*) FROM tasks t WHERE t.session_id=s.id AND t.state IN ('queued','running','waiting_comfy','reconciling')) AS active,
      (SELECT t.state FROM tasks t WHERE t.session_id=s.id ORDER BY t.rowid DESC LIMIT 1) AS last_state,
      (SELECT json_extract(e.data,'$.outputs[0]') FROM events e WHERE e.session_id=s.id AND e.kind='result' ORDER BY e.seq DESC LIMIT 1) AS thumbnail
      FROM sessions s WHERE s.owner=? ORDER BY s.rowid DESC LIMIT 100`).all(owner);
    return rows.map(r => {
      const session = JSON.parse(r.data as string) as Session;
      const thumbnail = r.thumbnail ? JSON.parse(r.thumbnail as string) as Partial<MediaRef> : undefined;
      return {
        ...session,
        ...(r.preview ? { preview: r.preview as string } : {}),
        ...(r.last_message ? { lastMessage: r.last_message as string } : {}),
        lastActivity: Number(r.last_activity ?? session.created),
        lastSeq: Number(r.last_seq ?? 0),
        active: Number(r.active) > 0,
        ...(r.last_state ? { lastState: r.last_state as State } : {}),
        ...(thumbnail?.filename ? { thumbnail: { filename: String(thumbnail.filename), subfolder: String(thumbnail.subfolder ?? ''), type: String(thumbnail.type ?? 'output') } } : {}),
      };
    }).sort((a, b) => b.lastSeq - a.lastSeq || b.created - a.created).map(({ lastSeq: _, ...summary }) => summary);
  }
  create(owner: string, name: string, canvas?: Canvas, workflow?: SessionWorkflow): Session {
    return this.transaction(() => {
      const session: Session = { id: randomUUID(), owner, name, version: canvas ? 1 : 0, created: Date.now(), ...(workflow ? { workflow } : {}) };
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(session.id, owner, JSON.stringify(session));
      if (canvas) this.db.prepare('INSERT INTO versions VALUES(?,?,?)').run(session.id, 1, JSON.stringify({ version: 1, canvas, summary: '导入工作流副本', saved: false, created: Date.now() }));
      return session;
    });
  }
  updateSession(id: string, patch: { name?: string; workflow?: SessionWorkflow | null }): Session {
    return this.transaction(() => {
      const session = this.session(id);
      if (patch.name !== undefined) session.name = patch.name;
      if (patch.workflow === null) delete session.workflow;
      else if (patch.workflow) { session.workflow = patch.workflow; session.name = patch.workflow.name; }
      this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), id);
      return session;
    });
  }
  deleteSession(id: string) {
    this.transaction(() => {
      this.session(id);
      this.db.prepare('DELETE FROM receipts WHERE task_id IN (SELECT id FROM tasks WHERE session_id=?)').run(id);
      this.db.prepare('DELETE FROM events WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM versions WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM tasks WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    });
  }
```

`list` 之前返回类型 `(Session & { preview?: string })[]`，`routes.ts` 里 `service.store.list(owner)` 不需要改。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:agent`
Expected: 全部 PASS，包含新文件 `sessions.test.ts`。

- [ ] **Step 5: Commit**

```bash
git add gateway/agent/store.ts gateway/agent/test/sessions.test.ts
git commit -m "feat(gateway): session workflow binding, summaries, update and delete in agent store"
```

---

### Task 2: Gateway 服务层：导入画布版本、更新与删除会话

**Files:**
- Modify: `gateway/agent/service.ts`
- Modify: `gateway/agent/test/sessions.test.ts`

- [ ] **Step 1: 追加失败的服务层测试**

在 `gateway/agent/test/sessions.test.ts` 末尾追加：

```ts
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV3 } from 'ai/test';
import { AgentService } from '../service.js';
import { WorkflowError } from '../../workflow/engine.js';

const service = () => new AgentService({ agentStorePath: ':memory:', comfyUrl: 'http://unused.invalid', agentPollMs: 60_000 }, { model: new MockLanguageModelV3({ doGenerate: async () => { throw new Error('model must not be called'); } }) });

test('service imports canvas versions, rejects unsupported canvases and cancels tasks on delete', async () => {
  const agent = service();
  const session = await agent.createSession('me', '忽略', canvas(), { id: 'wf-1', name: '海报' });
  assert.equal(session.name, '海报', 'binding name wins over request name');
  const imported = agent.importVersion(session.id, 'me', canvas(), 1, '画布修改');
  assert.equal(imported.version, 2);
  const events = agent.store.events(session.id);
  assert.deepEqual(events.at(-1)?.data, { version: 2, summary: '画布修改', source: 'canvas' });
  assert.throws(() => agent.importVersion(session.id, 'me', canvas(), 1, '过期'), /版本已改变/);
  const broken = canvas(); broken.nodes[0].mode = 4;
  assert.throws(() => agent.importVersion(session.id, 'me', broken, 2, '坏画布'), WorkflowError);
  assert.throws(() => agent.importVersion(session.id, 'someone-else', canvas(), 2, '越权'), /会话不存在/);

  assert.deepEqual(agent.updateSession(session.id, 'me', { workflow: null }).workflow, undefined);

  const task = agent.enqueue(session.id, 'me', randomUUID(), '开始一个任务');
  assert.throws(() => agent.importVersion(session.id, 'me', canvas(), 2, '任务中'), /先停止当前任务/);
  assert.deepEqual(agent.deleteSession(session.id, 'me'), { deleted: true });
  assert.throws(() => agent.store.task(task.id), /任务不存在/);
  assert.throws(() => agent.store.session(session.id), /会话不存在/);
  await agent.stop();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run build:agent && npx tsx --test gateway/agent/test/sessions.test.ts`
Expected: 编译错误，`importVersion` / `updateSession` / `deleteSession` 不存在。

- [ ] **Step 3: 修改 `gateway/agent/service.ts`**

在 import 里补 `SessionWorkflow`：

```ts
import type { Task, State, SessionWorkflow } from './store.js';
```

把 `createSession` 替换，并在 `restore` 后面加三个方法：

```ts
  async createSession(owner: string, name: string, canvas?: Canvas, workflow?: SessionWorkflow) {
    if (canvas) canvasToPrompt(canvas, {}, false); // Structure only: missing model values must be repairable.
    return this.store.create(owner, workflow?.name ?? name, canvas, workflow);
  }
  updateSession(id: string, owner: string, patch: { name?: string; workflow?: SessionWorkflow | null }) {
    this.store.session(id, owner);
    return this.store.updateSession(id, patch);
  }
  deleteSession(id: string, owner: string) {
    this.store.session(id, owner);
    for (const task of this.store.tasks(id)) {
      if (terminal(task)) continue;
      this.setState(task, 'cancelled');
      if (this.runningId === task.id) this.controller?.abort();
    }
    this.store.deleteSession(id);
    return { deleted: true };
  }
  /** The App pushes canvas edits as a new version before the next message so the agent never works on a stale graph. */
  importVersion(id: string, owner: string, canvas: Canvas, baseVersion: number, summary: string) {
    this.store.session(id, owner);
    if (this.store.tasks(id).some(t => activeStates.includes(t.state))) throw new AgentHttpError(409, '请先停止当前任务');
    canvasToPrompt(canvas, {}, false);
    return this.store.transaction(() => {
      const next = this.store.commitVersion(id, baseVersion, canvas, summary);
      this.store.event(id, null, 'workflow', { version: next.version, summary: next.summary, source: 'canvas' });
      return { version: next.version };
    });
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:agent`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add gateway/agent/service.ts gateway/agent/test/sessions.test.ts
git commit -m "feat(gateway): import canvas versions, update and delete agent sessions"
```

---

### Task 3: Gateway 路由：PATCH / DELETE 会话、POST 画布版本

**Files:**
- Modify: `gateway/agent/routes.ts`
- Modify: `gateway/agent/test/routes.test.ts`
- Modify: `gateway/agent/README.md`

- [ ] **Step 1: 在 `routes.test.ts` 第一个测试里追加 HTTP 断言**

在 `assert.equal(data.tasks.length, 0);` 之后追加：

```ts
  const call = (method: string, path: string, body?: unknown, auth = token) => fetch(`${base}/api/gateway${path}`, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const boundCreate = await request('/agent/sessions', { name: 'ignored', canvas, workflow: { id: 'wf-1', name: '海报', filename: '海报.json' } });
  assert.equal(boundCreate.status, 201);
  const bound = (await boundCreate.json()).session;
  assert.equal(bound.name, '海报');
  const listed = (await (await request('/agent/sessions')).json()).sessions.find((s: any) => s.id === bound.id);
  assert.deepEqual(listed.workflow, { id: 'wf-1', name: '海报', filename: '海报.json' });
  assert.equal(listed.active, false);
  assert.equal(typeof listed.lastActivity, 'number');
  assert.equal((await call('PATCH', `/agent/sessions/${bound.id}`, { workflow: null }, device)).status, 404);
  assert.equal((await call('PATCH', `/agent/sessions/${bound.id}`, { owner: 'x' })).status, 400);
  const patched = await call('PATCH', `/agent/sessions/${bound.id}`, { name: '新名字', workflow: null });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).session.workflow, undefined);
  const imported = await call('POST', `/agent/sessions/${bound.id}/versions`, { canvas, baseVersion: 1, summary: '画布修改' });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).version, 2);
  assert.equal((await call('POST', `/agent/sessions/${bound.id}/versions`, { canvas, baseVersion: 1 })).status, 409);
  assert.equal((await call('POST', `/agent/sessions/${bound.id}/versions`, { canvas: { ...canvas, nodes: [{ ...canvas.nodes[0], mode: 4 }] }, baseVersion: 2 })).status, 422);
  assert.equal((await call('DELETE', `/agent/sessions/${bound.id}`, undefined, device)).status, 404);
  assert.equal((await call('DELETE', `/agent/sessions/${bound.id}`)).status, 200);
  assert.equal((await request(`/agent/sessions/${bound.id}`)).status, 404);
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:agent`
Expected: `routes.test.ts` 失败，PATCH 返回 404（"接口不存在"）。

- [ ] **Step 3: 修改 `gateway/agent/routes.ts`**

把 `createInput` 定义替换为：

```ts
const canvasInput = z.object({ version: z.literal(0.4), nodes: z.array(z.object({ id: z.number().int().nonnegative(), type: z.string(), widgets_values: z.array(z.unknown()).optional(), inputs: z.array(z.object({ name: z.string(), link: z.number().nullable().optional() }).passthrough()).optional(), outputs: z.array(z.object({ links: z.array(z.number()).nullable().optional() }).passthrough()).optional() }).passthrough()).max(100), links: z.array(z.array(z.unknown())).max(500) }).passthrough();
const workflowInput = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(100), filename: z.string().trim().min(1).max(300).optional() }).strict();
const createInput = z.object({ name: z.string().trim().min(1).max(100).default('新工作流'), canvas: canvasInput.optional(), workflow: workflowInput.optional() }).strict();
const patchInput = z.object({ name: z.string().trim().min(1).max(100).optional(), workflow: workflowInput.nullable().optional() }).strict();
const importInput = z.object({ canvas: canvasInput, baseVersion: z.number().int().nonnegative(), summary: z.string().trim().min(1).max(200).default('画布修改') }).strict();
```

`POST /sessions` 分支改为：

```ts
    if (path === '/sessions' && method === 'POST') {
      const body = createInput.parse(await readBody(request));
      return send(201, { session: await service.createSession(owner, body.name, body.canvas as Canvas | undefined, body.workflow) });
    }
```

在 `if (parts.length === 2 && method === 'GET')` 分支后面加：

```ts
    if (parts.length === 2 && method === 'PATCH') {
      const body = patchInput.parse(await readBody(request));
      return send(200, { session: service.updateSession(sessionId, owner, body) });
    }
    if (parts.length === 2 && method === 'DELETE') return send(200, service.deleteSession(sessionId, owner));
    if (parts.length === 3 && parts[2] === 'versions' && method === 'POST') {
      const body = importInput.parse(await readBody(request));
      return send(200, service.importVersion(sessionId, owner, body.canvas as Canvas, body.baseVersion, body.summary));
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:agent`
Expected: 全部 PASS。

- [ ] **Step 5: 更新 `gateway/agent/README.md` 的 API 表**

在表格里 `POST /sessions/:id/restore` 这一行后加三行，并把 `GET/POST /sessions` 的描述改成：

```markdown
| GET/POST `/sessions` | List own sessions with `lastMessage`, `lastActivity`, `active`, `lastState`, `workflow`, `thumbnail` / create with optional canvas copy and `workflow` binding `{id, name, filename?}` |
| PATCH `/sessions/:id` | `{name?, workflow?: {id,name,filename?} | null}`; binding a workflow also renames the session |
| DELETE `/sessions/:id` | Cancel active tasks, then delete the session with its tasks, versions and events |
| POST `/sessions/:id/versions` | `{canvas, baseVersion, summary?}`; commit the App canvas as a new version (422 when unsupported, 409 on stale base or active task) |
```

并把开头 "The App entry is **工作流助手** in the side menu (`/agent`)." 改为 "The App entry is the **对话** tab (`/chats`); each session binds to one workflow in the App library."

- [ ] **Step 6: Commit**

```bash
git add gateway/agent/routes.ts gateway/agent/test/routes.test.ts gateway/agent/README.md
git commit -m "feat(gateway): session PATCH/DELETE and canvas version import routes"
```

---

### Task 4: App 类型、存储字段与 AgentApi

**Files:**
- Modify: `src/shared/types/app/IComfyWorkflow.ts`
- Modify: `src/infrastructure/storage/IndexedDBWorkflowService.ts`
- Modify: `src/infrastructure/api/AgentApi.ts`

- [ ] **Step 1: 给工作流类型加绑定字段**

在 `src/shared/types/app/IComfyWorkflow.ts` 的 `CloudWorkflowMetadata` 后面加：

```ts
/** Which agent session mirrors into this workflow, and which version the library copy currently holds. */
export interface AgentWorkflowBinding {
  sessionId: string;
  mirroredVersion: number;
  /** ISO time written together with modifiedAt when the library copy was last written from a session version. */
  mirroredAt: string;
}
```

在 `IComfyWorkflow` 里 `cloud?: CloudWorkflowMetadata;` 之后加 `agent?: AgentWorkflowBinding;`。

- [ ] **Step 2: 让 IndexedDB 保存该字段**

`src/infrastructure/storage/IndexedDBWorkflowService.ts`：`DBWorkflow` 接口加 `agent?: Workflow['agent']`；`workflowToDBFormat` 返回对象里 `cloud: workflow.cloud` 后加 `agent: workflow.agent`。在文件末尾导出：

```ts
/** Metadata-only write used by the chat page after a canvas import; keeps workflow_json untouched. */
export const updateWorkflowAgentBinding = async (workflowId: string, agent: Workflow['agent']) => {
  const cached = await indexedDBService.findWorkflowById(workflowId)
  if (!cached) return
  await indexedDBService.updateWorkflow({ ...cached, agent })
  emitWorkflowLocalChange({ type: 'upsert', workflowId })
}
```

- [ ] **Step 3: 创建 `src/infrastructure/api/AgentRequestError.ts`**

这个文件不能有任何 import：纯函数模块和 `tsx --test` 测试会直接引用它，而根 `tsconfig.json` 没有 `@/` 路径别名。

```ts
/** HTTP failure from the Gateway agent API. `status` lets callers branch (409 stale version, 422 unsupported canvas). */
export class AgentRequestError extends Error {
  constructor(readonly status: number, message: string, readonly body?: Record<string, unknown>) { super(message); this.name = 'AgentRequestError'; }
}
```

- [ ] **Step 4: 重写 `src/infrastructure/api/AgentApi.ts`**

```ts
import { platformFetch } from '@/platform/http';
import { getNativeGatewayAuthorization } from '@/platform/gatewaySession';
import { isTauriRuntime } from '@/platform/runtime';
import type { IComfyJson } from '@/shared/types/app/IComfyJson';
import { AgentRequestError } from './AgentRequestError';
export { AgentRequestError };

export interface SessionWorkflowRef { id: string; name: string; filename?: string }
export interface AgentMediaRef { filename: string; subfolder: string; type: string }
export interface AgentSession {
  id: string; name: string; version: number; created: number; workflow?: SessionWorkflowRef;
  preview?: string; lastMessage?: string; lastActivity?: number; active?: boolean; lastState?: string; thumbnail?: AgentMediaRef;
}
export interface AgentTask { id: string; state: string; error?: string; message: string }
export interface AgentEvent { seq: number; kind: string; taskId: string | null; data: Record<string, any>; created: number }
export interface AgentVersion { version: number; summary: string; saved: boolean; created: number }
export interface AgentSnapshot { session: AgentSession; tasks: AgentTask[]; versions: AgentVersion[]; events: AgentEvent[]; cursor: number; hasMore: boolean }
export interface AgentStatus { enabled: boolean; providerReady: boolean; model: string | null }
export type SessionPatch = { name?: string; workflow?: SessionWorkflowRef | null };

export class AgentApi {
  readonly baseUrl: string;
  constructor(baseUrl: string) { this.baseUrl = baseUrl.replace(/\/$/, ''); }
  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}/api/gateway/agent${path}`;
    const authorization = getNativeGatewayAuthorization(url);
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    const response = await platformFetch(url, {
      method,
      credentials: isTauriRuntime() ? 'omit' : 'include',
      headers: { ...(authorization ? { Authorization: authorization } : {}), ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body), signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new AgentRequestError(response.status, result.error || `请求失败 (${response.status})`, result);
    return result as T;
  }
  status(signal?: AbortSignal) { return this.request<AgentStatus>('/status', {}, signal); }
  sessions(signal?: AbortSignal) { return this.request<{ sessions: AgentSession[] }>('/sessions', {}, signal); }
  create(name: string, canvas?: IComfyJson, workflow?: SessionWorkflowRef) {
    return this.request<{ session: AgentSession }>('/sessions', { body: { name, ...(canvas ? { canvas } : {}), ...(workflow ? { workflow } : {}) } });
  }
  update(id: string, patch: SessionPatch) { return this.request<{ session: AgentSession }>(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }); }
  remove(id: string) { return this.request<{ deleted: boolean }>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  importVersion(id: string, canvas: IComfyJson, baseVersion: number, summary = '画布修改') {
    return this.request<{ version: number }>(`/sessions/${encodeURIComponent(id)}/versions`, { body: { canvas, baseVersion, summary } });
  }
  snapshot(id: string, after = 0, signal?: AbortSignal) { return this.request<AgentSnapshot>(`/sessions/${encodeURIComponent(id)}?after=${after}`, {}, signal); }
  message(id: string, message: string, requestId: string) { return this.request<{ taskId: string }>(`/sessions/${encodeURIComponent(id)}/messages`, { body: { message, requestId } }); }
  cancel(id: string, taskId: string) { return this.request(`/sessions/${encodeURIComponent(id)}/cancel`, { body: { taskId } }); }
  restore(id: string, version: number, baseVersion: number) { return this.request(`/sessions/${encodeURIComponent(id)}/restore`, { body: { version, baseVersion } }); }
  version(id: string, version: number) { return this.request<AgentVersion & { canvas: IComfyJson }>(`/sessions/${encodeURIComponent(id)}/versions/${version}`); }
}
```

- [ ] **Step 5: 构建确认类型通过**

Run: `npm run build`
Expected: 成功。`AgentPage.tsx` 仍用旧的 `api.save`（已删除）会报错；把 `AgentPage.tsx` 里 `versionActions` 中的"保存"按钮那一行整行删掉即可让构建通过（这个文件在 Task 13 会整体删除）。

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/app/IComfyWorkflow.ts src/infrastructure/storage/IndexedDBWorkflowService.ts src/infrastructure/api/AgentApi.ts src/infrastructure/api/AgentRequestError.ts src/components/agent/AgentPage.tsx
git commit -m "feat(app): agent binding field on workflows and extended AgentApi"
```

---

### Task 5: 绑定纯函数模块与测试

**Files:**
- Create: `src/components/agent/binding.ts`
- Create: `tests/agent/binding.test.ts`
- Modify: `package.json`

- [ ] **Step 1: 写失败的测试**

创建 `tests/agent/binding.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasChangedSinceMirror, chooseDefaultTab, resolveBoundWorkflow, sessionTitle } from '../../src/components/agent/binding';
import type { Workflow } from '../../src/shared/types/app/IComfyWorkflow';

const wf = (id: string, extra: Partial<Workflow> = {}): Workflow => ({ id, name: id, workflow_json: { nodes: [], links: [] } as any, nodeCount: 0, createdAt: new Date(0), isValid: true, ...extra });

test('resolveBoundWorkflow prefers id and falls back to the cloud filename', () => {
  const list = [wf('a'), wf('cloud_1', { cloud: { provider: 'comfyui', filename: '海报.json' } })];
  assert.equal(resolveBoundWorkflow({ id: 'a', name: 'a' }, list)?.id, 'a');
  assert.equal(resolveBoundWorkflow({ id: 'gone', name: 'x', filename: '海报.json' }, list)?.id, 'cloud_1');
  assert.equal(resolveBoundWorkflow({ id: 'gone', name: 'x' }, list), undefined);
  assert.equal(resolveBoundWorkflow(undefined, list), undefined);
});

test('canvasChangedSinceMirror compares modifiedAt with the mirrored stamp', () => {
  const at = '2026-09-06T10:00:00.000Z';
  const same = wf('a', { modifiedAt: new Date(at), agent: { sessionId: 's', mirroredVersion: 2, mirroredAt: at } });
  const later = wf('a', { modifiedAt: new Date('2026-09-06T10:05:00.000Z'), agent: { sessionId: 's', mirroredVersion: 2, mirroredAt: at } });
  assert.equal(canvasChangedSinceMirror(same), false);
  assert.equal(canvasChangedSinceMirror(later), true);
  assert.equal(canvasChangedSinceMirror(wf('a', { modifiedAt: new Date() })), false, 'unbound workflows never import');
});

test('chooseDefaultTab remembers the last tab, otherwise follows agent availability', () => {
  assert.equal(chooseDefaultTab('/outputs', true), '/outputs');
  assert.equal(chooseDefaultTab('/bogus', true), '/chats');
  assert.equal(chooseDefaultTab(null, true), '/chats');
  assert.equal(chooseDefaultTab(null, false), '/workflows');
});

test('sessionTitle uses the bound workflow name, then the first message, then the fallback', () => {
  assert.equal(sessionTitle({ name: '新工作流', workflow: { id: 'a', name: '海报' }, preview: '随便' }, '新对话'), '海报');
  assert.equal(sessionTitle({ name: '新工作流', preview: '现在能用哪些模型？' }, '新对话'), '现在能用哪些模型？');
  assert.equal(sessionTitle({ name: '新工作流' }, '新对话'), '新对话');
});
```

在 `package.json` 的 `scripts` 里加：

```json
"test:agent-ui": "tsx --test tests/agent/*.test.ts",
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:agent-ui`
Expected: 找不到模块 `binding`。

- [ ] **Step 3: 创建 `src/components/agent/binding.ts`**

```ts
import type { Workflow } from '../../shared/types/app/IComfyWorkflow';
import type { SessionWorkflowRef } from '../../infrastructure/api/AgentApi';

export const LAST_TAB_KEY = 'comfy_mobile_last_tab';
export type TabPath = '/chats' | '/workflows' | '/outputs';
export const TAB_PATHS: TabPath[] = ['/chats', '/workflows', '/outputs'];

/** Suggestion chips prefill the composer with these; the assistant picks the template from the description. */
export const NEW_CHAT_PRESETS = {
  image: '生成一张 1024×1024 的图片：',
  video: '用 H3 生成一段 1 秒的短视频：',
} as const;

/** Id first; a workflow re-downloaded from cloud on another device has a different id but the same filename. */
export function resolveBoundWorkflow(ref: SessionWorkflowRef | undefined, workflows: Workflow[]): Workflow | undefined {
  if (!ref) return undefined;
  return workflows.find(w => w.id === ref.id) ?? (ref.filename ? workflows.find(w => w.cloud?.filename === ref.filename) : undefined);
}

/** True when the library copy was edited (canvas, cloud download) after the last mirror from the session. */
export function canvasChangedSinceMirror(workflow: Workflow): boolean {
  if (!workflow.agent || !workflow.modifiedAt) return false;
  return workflow.modifiedAt.toISOString() !== workflow.agent.mirroredAt;
}

export function chooseDefaultTab(lastTab: string | null, agentAvailable: boolean): TabPath {
  if (lastTab && (TAB_PATHS as string[]).includes(lastTab)) return lastTab as TabPath;
  return agentAvailable ? '/chats' : '/workflows';
}

export function sessionTitle(session: { name: string; preview?: string; workflow?: SessionWorkflowRef }, fallback: string): string {
  if (session.workflow) return session.workflow.name;
  return session.preview?.trim() || fallback;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:agent-ui`
Expected: 4 个用例 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/agent/binding.ts tests/agent/binding.test.ts package.json
git commit -m "feat(app): pure binding helpers for agent sessions and tab selection"
```

---

### Task 6: 镜像与画布导入逻辑（依赖注入）与测试

**Files:**
- Create: `src/components/agent/mirror.ts`
- Create: `tests/agent/mirror.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `tests/agent/mirror.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { importCanvasIfChanged, mirrorVersion, type MirrorDeps } from '../../src/components/agent/mirror';
import { AgentRequestError } from '../../src/infrastructure/api/AgentRequestError';
import type { AgentSession } from '../../src/infrastructure/api/AgentApi';
import type { Workflow } from '../../src/shared/types/app/IComfyWorkflow';

const canvas = (n: number) => ({ nodes: Array.from({ length: n }, (_, i) => ({ id: i })), links: [] }) as any;
const wf = (id: string, extra: Partial<Workflow> = {}): Workflow => ({ id, name: id, workflow_json: canvas(1), nodeCount: 1, createdAt: new Date(0), isValid: true, ...extra });
const now = new Date('2026-09-06T12:00:00.000Z');

function deps(list: Workflow[]): MirrorDeps & { added: Workflow[]; updated: Workflow[]; bound: unknown[] } {
  const d = {
    added: [] as Workflow[], updated: [] as Workflow[], bound: [] as unknown[],
    workflows: async () => list,
    add: async (w: Workflow) => { d.added.push(w); },
    update: async (w: Workflow) => { d.updated.push(w); },
    bind: async (sessionId: string, ref: unknown) => { d.bound.push({ sessionId, ref }); },
    now: () => now, id: () => 'new-id',
  };
  return d;
}

test('mirrorVersion updates the bound workflow with the version canvas and stamp', async () => {
  const session: AgentSession = { id: 's1', name: '海报', version: 3, created: 0, workflow: { id: 'a', name: '海报' } };
  const d = deps([wf('a', { agent: { sessionId: 's1', mirroredVersion: 2, mirroredAt: '2026-09-06T11:00:00.000Z' } })]);
  const result = await mirrorVersion(session, 3, canvas(4), d);
  assert.equal(result.kind, 'updated');
  assert.equal(d.updated[0].nodeCount, 4);
  assert.equal(d.updated[0].modifiedAt?.toISOString(), now.toISOString());
  assert.deepEqual(d.updated[0].agent, { sessionId: 's1', mirroredVersion: 3, mirroredAt: now.toISOString() });
  assert.equal((await mirrorVersion(session, 2, canvas(1), d)).kind, 'unchanged', 'older versions never overwrite');
});

test('mirrorVersion creates and binds a workflow for a blank session, and reports a deleted binding', async () => {
  const blank: AgentSession = { id: 's2', name: '新工作流', version: 1, created: 0, preview: '生成一张猫' };
  const d = deps([]);
  const created = await mirrorVersion(blank, 1, canvas(2), d, { fallbackName: '新对话' });
  assert.equal(created.kind, 'created');
  assert.equal(d.added[0].id, 'new-id');
  assert.equal(d.added[0].name, '生成一张猫');
  assert.deepEqual(d.bound[0], { sessionId: 's2', ref: { id: 'new-id', name: '生成一张猫' } });
  const missing: AgentSession = { id: 's3', name: 'x', version: 2, created: 0, workflow: { id: 'gone', name: 'x' } };
  assert.equal((await mirrorVersion(missing, 2, canvas(1), deps([]))).kind, 'missing');
  assert.equal((await mirrorVersion(missing, 2, canvas(1), d, { recreate: true })).kind, 'created');
});

test('importCanvasIfChanged pushes edited canvases, skips clean ones and reports unsupported canvases', async () => {
  const stamp = '2026-09-06T11:00:00.000Z';
  const clean = wf('a', { modifiedAt: new Date(stamp), agent: { sessionId: 's1', mirroredVersion: 2, mirroredAt: stamp } });
  const edited = { ...clean, modifiedAt: new Date('2026-09-06T11:30:00.000Z') };
  const session: AgentSession = { id: 's1', name: '海报', version: 2, created: 0, workflow: { id: 'a', name: '海报' } };
  const calls: unknown[] = [];
  const ok = { importVersion: async (...args: unknown[]) => { calls.push(args); return { version: 3 }; }, setBinding: async (id: string, agent: unknown) => { calls.push({ id, agent }); } };
  assert.deepEqual(await importCanvasIfChanged(session, clean, ok), { kind: 'unchanged' });
  assert.deepEqual(await importCanvasIfChanged(session, undefined, ok), { kind: 'unchanged' });
  assert.deepEqual(await importCanvasIfChanged(session, edited, ok), { kind: 'imported', version: 3 });
  assert.deepEqual(calls[0], ['s1', edited.workflow_json, 2, '画布修改']);
  assert.deepEqual(calls[1], { id: 'a', agent: { sessionId: 's1', mirroredVersion: 3, mirroredAt: edited.modifiedAt!.toISOString() } });
  const unsupported = { ...ok, importVersion: async () => { throw new AgentRequestError(422, '工作流暂不支持或存在错误'); } };
  assert.deepEqual(await importCanvasIfChanged(session, edited, unsupported), { kind: 'unsupported', message: '工作流暂不支持或存在错误' });
  const conflict = { ...ok, importVersion: async () => { throw new AgentRequestError(409, '版本已改变'); } };
  await assert.rejects(importCanvasIfChanged(session, edited, conflict), /版本已改变/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test:agent-ui`
Expected: 找不到模块 `mirror`。

- [ ] **Step 3: 创建 `src/components/agent/mirror.ts`**

```ts
import type { IComfyJson } from '../../shared/types/app/IComfyJson';
import type { Workflow } from '../../shared/types/app/IComfyWorkflow';
import { AgentRequestError } from '../../infrastructure/api/AgentRequestError';
import type { AgentSession, SessionWorkflowRef } from '../../infrastructure/api/AgentApi';
import { canvasChangedSinceMirror, resolveBoundWorkflow, sessionTitle } from './binding';

export interface MirrorDeps {
  workflows: () => Promise<Workflow[]>;
  add: (workflow: Workflow) => Promise<void>;
  update: (workflow: Workflow) => Promise<void>;
  bind: (sessionId: string, ref: SessionWorkflowRef) => Promise<unknown>;
  now?: () => Date;
  id?: () => string;
}
export type MirrorResult =
  | { kind: 'updated' | 'created' | 'unchanged'; workflow: Workflow }
  | { kind: 'missing' };

const nodeCount = (canvas: IComfyJson) => (Array.isArray((canvas as { nodes?: unknown[] }).nodes) ? (canvas as { nodes: unknown[] }).nodes.length : 0);

/** Write a session version into the bound library workflow. Creates the workflow for blank sessions. */
export async function mirrorVersion(session: AgentSession, version: number, canvas: IComfyJson, deps: MirrorDeps, options: { fallbackName?: string; recreate?: boolean } = {}): Promise<MirrorResult> {
  const now = deps.now?.() ?? new Date();
  const agent = { sessionId: session.id, mirroredVersion: version, mirroredAt: now.toISOString() };
  const bound = resolveBoundWorkflow(session.workflow, await deps.workflows());
  if (bound) {
    if ((bound.agent?.mirroredVersion ?? 0) >= version) return { kind: 'unchanged', workflow: bound };
    const workflow: Workflow = { ...bound, workflow_json: canvas, nodeCount: nodeCount(canvas), modifiedAt: now, agent };
    await deps.update(workflow);
    return { kind: 'updated', workflow };
  }
  if (session.workflow && !options.recreate) return { kind: 'missing' };
  const name = sessionTitle(session, options.fallbackName ?? session.name);
  const workflow: Workflow = { id: deps.id?.() ?? crypto.randomUUID(), name, workflow_json: canvas, nodeCount: nodeCount(canvas), createdAt: now, modifiedAt: now, isValid: true, agent };
  await deps.add(workflow);
  await deps.bind(session.id, { id: workflow.id, name });
  return { kind: 'created', workflow };
}

export type ImportResult = { kind: 'unchanged' } | { kind: 'imported'; version: number } | { kind: 'unsupported'; message: string };

/** Before a message, push canvas edits so the agent works on what the user sees. 422 means the canvas uses unsupported nodes. */
export async function importCanvasIfChanged(
  session: AgentSession, bound: Workflow | undefined,
  deps: { importVersion: (id: string, canvas: IComfyJson, baseVersion: number, summary: string) => Promise<{ version: number }>; setBinding: (workflowId: string, agent: Workflow['agent']) => Promise<void> },
): Promise<ImportResult> {
  if (!bound || !canvasChangedSinceMirror(bound)) return { kind: 'unchanged' };
  try {
    const { version } = await deps.importVersion(session.id, bound.workflow_json, session.version, '画布修改');
    await deps.setBinding(bound.id, { sessionId: session.id, mirroredVersion: version, mirroredAt: bound.modifiedAt!.toISOString() });
    return { kind: 'imported', version };
  } catch (error) {
    if (error instanceof AgentRequestError && error.status === 422) return { kind: 'unsupported', message: error.message };
    throw error;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test:agent-ui`
Expected: 7 个用例 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/agent/mirror.ts tests/agent/mirror.test.ts
git commit -m "feat(app): mirror agent versions into bound workflows and import canvas edits"
```

---

### Task 7: 抽出媒体下载工具

**Files:**
- Create: `src/platform/mediaDownload.ts`
- Modify: `src/components/modals/FilePreviewModal.tsx`

- [ ] **Step 1: 创建 `src/platform/mediaDownload.ts`**

```ts
import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './runtime';
import { getNativeGatewayAuthorization } from './gatewaySession';
import { withComfyAuth } from '@/infrastructure/auth/ComfyAuthService';

const mimeTypes: Record<string, string> = {
  avi: 'video/x-msvideo', gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', mkv: 'video/x-matroska',
  mov: 'video/quicktime', mp4: 'video/mp4', png: 'image/png', webm: 'video/webm', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4',
};
export const getMediaMimeType = (filename: string): string | undefined => mimeTypes[filename.split('.').pop()?.toLowerCase() ?? ''];

/**
 * Native builds hand the URL to the Android download manager; browsers use an anchor.
 * `url` is the plain ComfyUI /view URL; `href` is an already-authenticated URL for the anchor fallback.
 */
export async function downloadMedia({ url, href, filename }: { url: string; href?: string; filename: string }): Promise<void> {
  if (isTauriRuntime() && /^https?:\/\//i.test(url)) {
    const nativeUrl = withComfyAuth(url);
    await invoke('plugin:media-download|enqueue_download', {
      payload: { url: nativeUrl, filename, authorization: getNativeGatewayAuthorization(nativeUrl), mimeType: getMediaMimeType(filename) },
    });
    return;
  }
  const link = document.body.appendChild(document.createElement('a'));
  link.download = filename;
  link.href = href ?? url;
  link.click();
  link.remove();
}
```

- [ ] **Step 2: 让 `FilePreviewModal.tsx` 使用它**

删除文件顶部的 `NativeDownloadResponse` 接口、`getMediaMimeType` 函数，以及 `invoke`、`getNativeGatewayAuthorization`、`withComfyAuth`（保留 `comfyAuthenticatedFetch`）的 import；新增 `import { downloadMedia } from '@/platform/mediaDownload';`。把 `handleDownload` 的 `try` 块替换为：

```ts
    try {
      await downloadMedia({ url: url || downloadUrl, href: downloadUrl, filename });
      toast.success(t('media.downloadStarted'), {
        description: t('media.downloadStartedDesc', { filename }),
      });
    } catch (error) {
```

`catch` 和 `finally` 保持不变。如果 `isTauriRuntime` 在文件里再无其他引用，也删掉它的 import。

- [ ] **Step 3: 构建与 lint**

Run: `npm run build && npm run lint`
Expected: 成功，无未使用 import 警告。

- [ ] **Step 4: Commit**

```bash
git add src/platform/mediaDownload.ts src/components/modals/FilePreviewModal.tsx
git commit -m "refactor(app): extract downloadMedia helper from FilePreviewModal"
```

---

### Task 8: 助手可用性 hook、活跃状态 store、SideMenu 包装

**Files:**
- Create: `src/components/agent/useAgentStatus.ts`
- Create: `src/ui/store/agentActivityStore.ts`
- Create: `src/components/controls/AppSideMenu.tsx`
- Modify: `src/components/controls/SideMenu.tsx`
- Modify: `src/components/workflow/WorkflowList.tsx`

- [ ] **Step 1: 创建 `src/components/agent/useAgentStatus.ts`**

```ts
import { useEffect, useMemo, useState } from 'react';
import { AgentApi, type AgentStatus } from '@/infrastructure/api/AgentApi';
import { useConnectionStore } from '@/ui/store/connectionStore';

export type AgentAvailability = 'loading' | 'no-gateway' | 'no-provider' | 'error' | 'ready';

/** Resolves whether the chat feature can be used with the current connection. Re-runs when the connection changes. */
export function useAgentStatus() {
  const { url, authMode } = useConnectionStore();
  const api = useMemo(() => new AgentApi(url), [url]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [state, setState] = useState<AgentAvailability>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setStatus(null);
    if (!url || authMode !== 'gateway') { setState('no-gateway'); return; }
    const controller = new AbortController();
    setState('loading');
    api.status(controller.signal)
      .then(value => { if (controller.signal.aborted) return; setStatus(value); setState(value.providerReady ? 'ready' : 'no-provider'); })
      .catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [api, url, authMode, attempt]);
  return { api, status, state, ready: state === 'ready', retry: () => setAttempt(n => n + 1) };
}
```

- [ ] **Step 2: 创建 `src/ui/store/agentActivityStore.ts`**

```ts
import { create } from 'zustand';

/** Whether any agent session has an active task. Fed by the session list and chat pages; read by the tab bar badge. */
interface AgentActivityState { active: boolean; setActive: (active: boolean) => void }
export const useAgentActivityStore = create<AgentActivityState>(set => ({ active: false, setActive: active => set({ active }) }));
```

- [ ] **Step 3: 创建 `src/components/controls/AppSideMenu.tsx`**

```tsx
import React from 'react';
import { useNavigate } from 'react-router-dom';
import SideMenu from '@/components/controls/SideMenu';

/** SideMenu with navigation-only handlers, for pages that have no workflow-specific menu actions. */
const AppSideMenu: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const navigate = useNavigate();
  const go = (path: string) => { onClose(); sessionStorage.setItem('app-navigation', 'true'); navigate(path); };
  return (
    <SideMenu
      isOpen={isOpen}
      onClose={onClose}
      onServerSettingsClick={() => go('/settings/server')}
      onApiKeysClick={() => go('/settings/api-keys')}
      onImportWorkflowsClick={() => go('/import/server')}
      onUploadWorkflowsClick={() => go('/upload/server')}
      onServerRebootClick={() => go('/reboot')}
      onModelDownloadClick={() => go('/models/download')}
      onModelBrowserClick={() => go('/models/browser')}
      onBrowserDataBackupClick={() => go('/browser-data-backup')}
      onWidgetTypeSettingsClick={() => go('/settings/widget-types')}
      onVideoDownloadClick={() => go('/videos/download')}
      onChainsClick={() => go('/chains')}
    />
  );
};
export default AppSideMenu;
```

- [ ] **Step 4: 从 SideMenu 删除助手和画廊两行**

`src/components/controls/SideMenu.tsx`：
- 删除 `MenuRow icon={<Bot size={18} />} …` 那一行，以及紧随其后画廊那个 `MenuRow`（`icon={<Image …/>}`，`onClick` 调 `onGalleryClick` 的那个）。
- 从 `SideMenuProps` 删除 `onGalleryClick: () => void;`，从组件解构里删掉 `onGalleryClick`。
- 从 lucide import 里删掉 `Bot`；如果 `Image` 再无引用也删掉。

`src/components/workflow/WorkflowList.tsx`：删掉 `<SideMenu … onGalleryClick={() => handleNavigation('/outputs')} />` 这一个 prop。

- [ ] **Step 5: 构建与 lint**

Run: `npm run build && npm run lint`
Expected: 成功。

- [ ] **Step 6: Commit**

```bash
git add src/components/agent/useAgentStatus.ts src/ui/store/agentActivityStore.ts src/components/controls/AppSideMenu.tsx src/components/controls/SideMenu.tsx src/components/workflow/WorkflowList.tsx
git commit -m "feat(app): agent availability hook, activity store, side menu cleanup"
```

---

### Task 9: 引导页、会话列表页

**Files:**
- Create: `src/components/agent/AgentGuide.tsx`
- Create: `src/components/agent/SessionRow.tsx`
- Create: `src/components/agent/SessionListPage.tsx`

所有用户可见文案通过 `useAgentText()` 的 `at('…')` 传中文字面量，Task 15 统一补翻译。

- [ ] **Step 1: 创建 `src/components/agent/AgentGuide.tsx`**

```tsx
import { Link } from 'react-router-dom';
import { Loader2, RefreshCw, Server } from 'lucide-react';
import { useAgentText } from './useAgentText';
import type { AgentAvailability } from './useAgentStatus';

const primary = 'h-11 w-full rounded-[10px] bg-[#3069f0] text-[13px] font-semibold text-white flex items-center justify-center gap-2 hover:bg-[#3f78f5] transition-colors';
const secondary = 'h-11 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.045] text-[13px] font-semibold text-[#c8ccd4] flex items-center justify-center gap-2';

/** Shown inside the 对话 tab while the assistant cannot be used. `ready` never renders this. */
export function AgentGuide({ state, onRetry }: { state: Exclude<AgentAvailability, 'ready'>; onRetry: () => void }) {
  const at = useAgentText();
  if (state === 'loading') return <div className="flex-1 flex items-center justify-center text-[#71798a]"><Loader2 className="animate-spin" size={20} /></div>;
  const gateway = state === 'no-gateway';
  return <div className="flex-1 min-h-0 px-6 flex flex-col items-center justify-center gap-4 text-center" data-agent-guide={state}>
    <div className="w-[52px] h-[52px] rounded-[14px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center"><Server size={26} strokeWidth={1.6} className="text-[#71798a]" /></div>
    <h2 className="text-[16px] font-semibold text-[#e9ebef]">{at(gateway ? '助手需要通过 Gateway 连接' : state === 'no-provider' ? '等待管理员配置语言模型' : '暂时无法连接助手')}</h2>
    <p className="text-[12.5px] leading-relaxed text-[#66758a] max-w-[300px]">{at(gateway
      ? '你现在直连的是 ComfyUI。对话助手运行在 Comfy Mobile Gateway 上，负责理解需求、修改工作流和在后台等待生成。工作流库和画廊不受影响，可以照常使用。'
      : state === 'no-provider' ? 'Gateway 已连接，但还没有配置语言模型。管理员在 Gateway 的 .env 里填好 AGENT_LLM_* 后，这里就可以开始对话。'
      : '已连接 Gateway，但助手接口没有响应。可能是 Gateway 未启用助手或正在重启。')}</p>
    {gateway && <div className="w-full flex flex-col gap-2 text-left">
      {[at('在服务器上部署 Gateway，并在其配置里启用助手和语言模型'), at('在连接设置里把服务器地址改为 Gateway 地址并登录')].map((text, index) => <div key={index} className="flex items-start gap-2.5 p-3 rounded-[10px] border border-white/[0.07] bg-[#101217]">
        <span className="w-5 h-5 shrink-0 rounded-md bg-[#3069f0]/15 text-[#5b8af5] font-mono text-[10px] font-semibold flex items-center justify-center">{index + 1}</span>
        <span className="text-[12px] leading-relaxed text-[#c8ccd4]">{text}</span>
      </div>)}
    </div>}
    <div className="w-full flex flex-col gap-2 mt-1">
      {gateway ? <Link to="/settings/server" className={primary}>{at('打开连接设置')}</Link> : <button className={primary} onClick={onRetry}><RefreshCw size={14} />{at('重新检查')}</button>}
      {gateway && <a className={secondary} href="https://github.com/zhvala/comfy-ui-mobile/blob/main/docs/connection_guide_zh.md" target="_blank" rel="noreferrer">{at('查看 Gateway 部署指南')}</a>}
    </div>
  </div>;
}
```

- [ ] **Step 2: 创建 `src/components/agent/SessionRow.tsx`**

```tsx
import { Bot, ChevronRight, Loader2, Network } from 'lucide-react';
import { useLongPress } from '@/hooks/useLongPress';
import { AuthenticatedImage } from '@/components/media/AuthenticatedImage';
import type { AgentSession } from '@/infrastructure/api/AgentApi';
import { useAgentText } from './useAgentText';
import { sessionTitle } from './binding';

export function relativeTime(timestamp: number, now: number, at: (text: string, values?: Record<string, string | number>) => string): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return at('刚刚');
  if (minutes < 60) return at('{{count}} 分钟前', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return at('{{count}} 小时前', { count: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return at('{{count}} 天前', { count: days });
  return new Date(timestamp).toLocaleDateString();
}

export function SessionRow({ session, baseUrl, thumbnail, onOpen, onLongPress }: { session: AgentSession; baseUrl: string; thumbnail?: string; onOpen: () => void; onLongPress: () => void }) {
  const at = useAgentText();
  const press = useLongPress(onLongPress, onOpen, { threshold: 500 });
  const media = session.thumbnail ? `${baseUrl}/view?${new URLSearchParams({ filename: session.thumbnail.filename, subfolder: session.thumbnail.subfolder, type: session.thumbnail.type })}` : undefined;
  const image = thumbnail ?? media;
  const failed = !session.active && session.lastState === 'failed';
  return <div role="button" tabIndex={0} data-agent-session={session.id} {...press} style={{ ...press.style, background: '#101217' }} className="w-full flex items-center gap-3 p-[10px_11px] rounded-[10px] border border-white/[0.07] active:border-white/[0.14] transition-colors text-left cursor-pointer" onKeyDown={e => { if (e.key === 'Enter') onOpen(); }}>
    <div className="w-14 h-14 shrink-0 rounded-lg border border-white/[0.06] overflow-hidden flex items-center justify-center" style={{ background: '#0c0e12' }}>
      {image ? <AuthenticatedImage source={image} alt="" className="w-full h-full object-cover" /> : session.workflow ? <Network size={22} strokeWidth={1.6} className="text-white/15" /> : <Bot size={22} strokeWidth={1.6} className="text-white/15" />}
    </div>
    <div className="flex-1 min-w-0 flex flex-col gap-1">
      <div className="text-[13px] font-semibold text-[#e9ebef] truncate">{sessionTitle(session, at('新对话'))}</div>
      <div className="text-[11.5px] text-[#8a919e] truncate">{session.lastMessage || session.preview || at('还没有消息')}</div>
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-[#565d6b]">
        <span>{relativeTime(session.lastActivity ?? session.created, Date.now(), at)}</span>
        {session.version > 0 && <><span className="text-[#31363f]">·</span><span className="text-[#5b8af5]">V{session.version}</span></>}
      </div>
    </div>
    {session.active
      ? <span className="shrink-0 h-6 px-2 rounded-md border border-[#3069f0]/30 bg-[#3069f0]/12 text-[10.5px] font-semibold text-[#5b8af5] flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" />{at('生成中')}</span>
      : failed ? <span aria-label={at('上轮出错')} className="shrink-0 w-2 h-2 rounded-full bg-[#f0a35b] mr-1.5" />
      : <ChevronRight size={14} strokeWidth={2} className="shrink-0 text-[#4a5261] mr-1" />}
  </div>;
}
```

`AuthenticatedImage` 的 props 以 `src/components/media/AuthenticatedImage.tsx` 为准；WorkflowGridItem 已经这样用（`source`、`alt`、`className`）。

- [ ] **Step 3: 创建 `src/components/agent/SessionListPage.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Film, Image as ImageIcon, Menu, Network, Plus, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import AppSideMenu from '@/components/controls/AppSideMenu';
import { SimpleConfirmDialog } from '@/components/ui/SimpleConfirmDialog';
import { loadAllWorkflows, updateWorkflowAgentBinding } from '@/infrastructure/storage/IndexedDBWorkflowService';
import type { AgentSession } from '@/infrastructure/api/AgentApi';
import { useConnectionStore } from '@/ui/store/connectionStore';
import { useAgentActivityStore } from '@/ui/store/agentActivityStore';
import type { Workflow } from '@/shared/types/app/IComfyWorkflow';
import { AgentGuide } from './AgentGuide';
import { SessionRow } from './SessionRow';
import { NEW_CHAT_PRESETS, resolveBoundWorkflow, sessionTitle } from './binding';
import { useAgentStatus } from './useAgentStatus';
import { useAgentText } from './useAgentText';

const POLL_MS = 5000;

export default function SessionListPage() {
  const at = useAgentText();
  const navigate = useNavigate();
  const { api, state, ready, retry } = useAgentStatus();
  const serverUrl = useConnectionStore(s => s.url);
  const setActive = useAgentActivityStore(s => s.setActive);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AgentSession | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [list, local] = await Promise.all([api.sessions(signal), loadAllWorkflows().catch(() => [] as Workflow[])]);
      if (signal?.aborted) return;
      setSessions(list.sessions); setWorkflows(local); setError('');
      setActive(list.sessions.some(s => s.active));
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : '加载会话失败'); }
    finally { if (!signal?.aborted) setLoaded(true); }
  }, [api, setActive]);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === 'visible') await load(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    const onVisible = () => { if (document.visibilityState === 'visible') void load(controller.signal); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [ready, load]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return sessions;
    return sessions.filter(s => `${sessionTitle(s, '')} ${s.lastMessage ?? ''} ${s.preview ?? ''}`.toLocaleLowerCase().includes(query));
  }, [sessions, search]);
  const serverHost = (serverUrl || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');

  async function remove(session: AgentSession) {
    try {
      await api.remove(session.id);
      const bound = resolveBoundWorkflow(session.workflow, workflows);
      if (bound?.agent?.sessionId === session.id) await updateWorkflowAgentBinding(bound.id, undefined);
      setSessions(previous => previous.filter(s => s.id !== session.id));
      toast.success(at('会话已删除'));
    } catch (e) { toast.error(at(e instanceof Error ? e.message : '删除失败')); }
  }

  const chips = [
    { icon: <ImageIcon size={14} strokeWidth={1.8} />, label: at('生成一张图片'), to: `/chat/new?draft=${encodeURIComponent(NEW_CHAT_PRESETS.image)}` },
    { icon: <Film size={14} strokeWidth={1.8} />, label: at('生成一段短视频'), to: `/chat/new?draft=${encodeURIComponent(NEW_CHAT_PRESETS.video)}` },
    { icon: <Network size={14} strokeWidth={1.8} />, label: at('从我的工作流开始'), to: '/chat/new?pick=1' },
  ];

  return <div className="h-full flex flex-col text-[#e9ebef] overflow-hidden" style={{ background: '#0b0c0f' }}>
    <header className="flex-none z-40 border-b border-white/[0.08] pwa-header" style={{ background: '#0b0c0f' }}>
      <div className="max-w-[1600px] mx-auto h-[52px] px-4 flex items-center gap-2.5">
        <button onClick={() => setMenuOpen(true)} className="shrink-0 -ml-1 p-1.5 text-[#c8ccd4] hover:text-white transition-colors" aria-label={at('菜单')}><Menu className="w-5 h-5" strokeWidth={1.7} /></button>
        <div className="w-[26px] h-[26px] shrink-0 rounded-[7px] bg-[#3069f0] flex items-center justify-center"><Bot size={16} strokeWidth={2} className="text-white" /></div>
        <span className="text-[13.5px] font-semibold">{at('对话')}</span>
        {serverHost && <span className="shrink-0 font-mono text-[11px] text-[#565d6b] px-1.5 py-[3px] border border-white/10 rounded-[5px] max-w-[164px] truncate">{serverHost}</span>}
        <div className="flex-1" />
        {ready && <button data-agent-new onClick={() => navigate('/chat/new')} className="shrink-0 h-9 px-3.5 flex items-center gap-1.5 rounded-[9px] bg-[#3069f0] hover:bg-[#3f78f5] text-white text-[12.5px] font-semibold transition-colors"><Plus className="w-[13px] h-[13px]" strokeWidth={2.4} />{at('新对话')}</button>}
      </div>
    </header>
    {!ready ? <AgentGuide state={state} onRetry={retry} /> : <>
      <div className="flex-none border-b border-white/[0.08] px-4 py-2.5">
        <div className="flex items-center h-9 pl-3 pr-2 rounded-[9px] border border-white/[0.08] focus-within:border-[#3069f0]/50 transition-colors" style={{ background: 'rgba(255,255,255,0.045)' }}>
          <Search className="w-3.5 h-3.5 text-[#71798a] shrink-0" strokeWidth={1.8} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={at('搜索会话')} aria-label={at('搜索会话')} className="flex-1 h-9 min-w-0 bg-transparent border-none outline-none px-2 text-[12.5px] text-[#e9ebef] placeholder:text-[#71798a]" />
          {search ? <button onClick={() => setSearch('')} className="shrink-0 text-[#565d6b]" aria-label={at('清除')}><X className="w-3.5 h-3.5" /></button>
            : <span className="shrink-0 font-mono text-[10px] text-[#565d6b] border border-white/10 rounded-[4px] px-1.5 py-0.5">{sessions.length}</span>}
        </div>
      </div>
      <div className="flex-none px-4 pt-3 pb-2 flex items-center gap-2.5">
        <span className="font-mono text-[10px] font-semibold text-[#565d6b] tracking-[0.14em]">SESSIONS · {filtered.length}</span>
        <div className="flex-1 h-px bg-white/[0.06]" />
      </div>
      <main className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-2">
        {error && <div role="alert" className="rounded-[10px] border border-[#f0a35b]/30 bg-[#f0a35b]/10 px-3 py-2.5 text-[12px] text-[#f0a35b] flex items-center gap-3"><span className="flex-1">{at(error)}</span><button className="font-semibold" onClick={() => void load()}>{at('重试')}</button></div>}
        {loaded && !sessions.length && !error && <div className="py-16 flex flex-col items-center text-center gap-3">
          <Bot size={34} strokeWidth={1.4} className="text-[#5b8af5]" />
          <p className="text-[14px] font-semibold text-[#c8ccd4]">{at('你想创作什么？')}</p>
          <p className="text-[12px] text-[#66758a] max-w-xs">{at('直接描述目标。助手会根据已安装的模型选择合适的工作流，生成预览并写入你的工作流库。')}</p>
          <div className="flex flex-wrap justify-center gap-2 mt-2">{chips.map(chip => <button key={chip.to} onClick={() => navigate(chip.to)} className="h-[34px] px-3 rounded-[9px] border border-white/[0.08] bg-white/[0.035] text-[12px] font-medium text-[#c8ccd4] flex items-center gap-1.5">{chip.icon}{chip.label}</button>)}</div>
        </div>}
        {loaded && sessions.length > 0 && !filtered.length && <p className="py-10 text-center text-[12px] text-[#66758a]">{at('没有匹配的会话')}</p>}
        {filtered.map(session => {
          const bound = resolveBoundWorkflow(session.workflow, workflows);
          return <SessionRow key={session.id} session={session} baseUrl={api.baseUrl} thumbnail={bound?.thumbnail} onOpen={() => navigate(`/chat/${session.id}`)} onLongPress={() => setPendingDelete(session)} />;
        })}
      </main>
    </>}
    <AppSideMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />
    <SimpleConfirmDialog isOpen={!!pendingDelete} onClose={() => setPendingDelete(null)} onConfirm={() => { const target = pendingDelete; setPendingDelete(null); if (target) void remove(target); }} title={at('删除会话')} message={at('只删除对话记录和版本历史，工作流库里的工作流会保留。')} confirmText={at('删除')} cancelText={at('取消')} />
  </div>;
}
```

- [ ] **Step 4: 构建**

Run: `npm run build`
Expected: 成功（页面尚未接入路由，只做类型检查）。如果 `SimpleConfirmDialog` 的 props 名字与上面不符，按 `src/components/ui/SimpleConfirmDialog.tsx` 里的接口调整调用处，不改该组件。

- [ ] **Step 5: Commit**

```bash
git add src/components/agent/AgentGuide.tsx src/components/agent/SessionRow.tsx src/components/agent/SessionListPage.tsx
git commit -m "feat(app): session list page and assistant guide"
```

---

### Task 10: 底部标签外壳与路由

**Files:**
- Create: `src/components/navigation/TabBar.tsx`
- Create: `src/components/navigation/TabLayout.tsx`
- Create: `src/components/navigation/RootRedirect.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/workflow/WorkflowEditor.tsx`

- [ ] **Step 1: 创建 `src/components/navigation/TabBar.tsx`**

```tsx
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { Image as ImageIcon, MessageSquare, Network } from 'lucide-react';
import { useAgentActivityStore } from '@/ui/store/agentActivityStore';
import { TAB_PATHS, type TabPath } from '@/components/agent/binding';

const icons: Record<TabPath, typeof MessageSquare> = { '/chats': MessageSquare, '/workflows': Network, '/outputs': ImageIcon };

export function TabBar() {
  const { t } = useTranslation();
  const active = useAgentActivityStore(s => s.active);
  const labels: Record<TabPath, string> = { '/chats': t('tabs.chats', '对话'), '/workflows': t('tabs.workflows', '工作流'), '/outputs': t('tabs.gallery', '画廊') };
  return <nav data-tab-bar className="fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08]" style={{ background: 'rgba(15,17,22,0.96)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
    <div className="h-14 px-3 flex items-stretch">
      {TAB_PATHS.map(path => { const Icon = icons[path]; return <NavLink key={path} to={path} className={({ isActive }) => `flex-1 flex flex-col items-center justify-center gap-[3px] relative text-[10.5px] ${isActive ? 'text-[#5b8af5] font-semibold' : 'text-[#71798a] font-medium'}`}>
        <Icon size={22} strokeWidth={1.8} />
        <span>{labels[path]}</span>
        {path === '/chats' && active && <span data-tab-badge className="absolute top-1.5 left-[calc(50%+8px)] w-[7px] h-[7px] rounded-full bg-[#3069f0] border-[1.5px] border-[#0f1116]" />}
      </NavLink>; })}
    </div>
  </nav>;
}
```

- [ ] **Step 2: 创建 `src/components/navigation/TabLayout.tsx`**

```tsx
import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { LAST_TAB_KEY, TAB_PATHS } from '@/components/agent/binding';
import { TabBar } from './TabBar';

/** Wraps the three top-level pages; each page keeps its own header and scroll container. */
export function TabLayout() {
  const { pathname } = useLocation();
  useEffect(() => {
    if ((TAB_PATHS as string[]).includes(pathname)) { try { localStorage.setItem(LAST_TAB_KEY, pathname); } catch { /* storage unavailable */ } }
  }, [pathname]);
  return <>
    <div className="h-dvh overflow-y-auto" style={{ paddingBottom: 'calc(56px + env(safe-area-inset-bottom))' }}><Outlet /></div>
    <TabBar />
  </>;
}
```

- [ ] **Step 3: 创建 `src/components/navigation/RootRedirect.tsx`**

```tsx
import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { chooseDefaultTab, LAST_TAB_KEY } from '@/components/agent/binding';
import { useAgentStatus } from '@/components/agent/useAgentStatus';

/** `/` decides the landing tab: the remembered one, otherwise by assistant availability. */
export function RootRedirect() {
  let lastTab: string | null = null;
  try { lastTab = localStorage.getItem(LAST_TAB_KEY); } catch { /* storage unavailable */ }
  const { state } = useAgentStatus();
  if (!lastTab && state === 'loading') return <div className="h-dvh flex items-center justify-center" style={{ background: '#0b0c0f' }}><Loader2 className="animate-spin text-[#71798a]" size={20} /></div>;
  return <Navigate to={chooseDefaultTab(lastTab, state === 'ready')} replace />;
}
```

- [ ] **Step 4: 修改 `src/App.tsx` 路由**

把 `import AgentPage from '@/components/agent/AgentPage';` 换成：

```ts
import SessionListPage from '@/components/agent/SessionListPage';
import { TabLayout } from '@/components/navigation/TabLayout';
import { RootRedirect } from '@/components/navigation/RootRedirect';
```

并在 `react-router-dom` import 里加 `Navigate`。把 `<Routes>` 里前三行：

```tsx
        <Route path="/" element={<WorkflowList />} />
        <Route path="/agent" element={<AgentPage />} />
```
和 `<Route path="/outputs" element={<OutputsGallery />} />` 替换为：

```tsx
        <Route path="/" element={<RootRedirect />} />
        <Route element={<TabLayout />}>
          <Route path="/chats" element={<SessionListPage />} />
          <Route path="/workflows" element={<WorkflowList />} />
          <Route path="/outputs" element={<OutputsGallery />} />
        </Route>
        <Route path="/agent" element={<Navigate to="/chats" replace />} />
```

（`/chat/new` 和 `/chat/:id` 在 Task 13 加。）

- [ ] **Step 5: 编辑器返回到 `/workflows`**

`src/components/workflow/WorkflowEditor.tsx`：`onNavigateBack` 回调最后的 `navigate('/');`（在 `setIsNodePanelVisible(false); setSelectedNode(null);` 的 `else` 分支）改为 `navigate('/workflows');`。加载失败页的 `onClick={() => navigate('/')}` 也改为 `'/workflows'`。

- [ ] **Step 6: 构建并在浏览器里核对标签栏**

Run: `npm run build`
Expected: 成功。

然后用 UI 联调脚本看一眼（它起一个带模拟模型和模拟 ComfyUI 的本地 Gateway，托管 `dist/`）：

```bash
npm run build:agent && node_modules/.bin/tsx gateway/agent/test/uiHarness.ts
```

输出 `UI_HARNESS_URL=http://127.0.0.1:<port>`。用浏览器预览工具打开该 URL，登录 token `local-agent-ui-test-token`，确认：`/` 跳到 `/chats`；底部三个标签可切换；`/workflows` 与原首页一致；`/agent` 跳到 `/chats`。Ctrl-C 结束脚本。

- [ ] **Step 7: Commit**

```bash
git add src/components/navigation src/App.tsx src/components/workflow/WorkflowEditor.tsx
git commit -m "feat(app): bottom tab shell with chats, workflows and gallery"
```

---

### Task 11: 事件轮询 hook

**Files:**
- Create: `src/components/agent/useSessionSnapshot.ts`

- [ ] **Step 1: 创建 hook（逻辑从 AgentPage.tsx 的第二个 effect 抽出）**

```ts
import { useEffect, useRef, useState } from 'react';
import type { AgentApi, AgentEvent, AgentSnapshot } from '@/infrastructure/api/AgentApi';

/** Cursor-based polling: dedupes by seq, drains pagination immediately, backs off on errors. Never cancels the task. */
export function useSessionSnapshot(api: AgentApi, sessionId: string | undefined) {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState('');
  const cursor = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setSnapshot(null); setEvents([]); setError(''); cursor.current = 0;
    if (!sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let delay = 1500;
      try {
        const value = await api.snapshot(sessionId!, cursor.current, controller.signal);
        if (controller.signal.aborted) return;
        cursor.current = value.cursor;
        setSnapshot(value); setError('');
        setEvents(previous => {
          const seen = new Set(previous.map(e => e.seq));
          const incoming = value.events.filter(e => !seen.has(e.seq));
          return incoming.length ? [...previous, ...incoming] : previous;
        });
        if (value.hasMore) delay = 0;
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : '连接中断，正在重试');
        delay = 4000;
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, delay);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, sessionId, refreshKey]);

  const caughtUp = !!snapshot && !snapshot.hasMore && (events.at(-1)?.seq ?? 0) >= snapshot.cursor;
  return { snapshot, events, error, caughtUp, setSnapshot, refresh: () => setRefreshKey(n => n + 1) };
}
```

- [ ] **Step 2: 构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 3: Commit**

```bash
git add src/components/agent/useSessionSnapshot.ts
git commit -m "feat(app): extract session snapshot polling hook"
```

---

### Task 12: 聊天页的卡片、头部与底部面板

**Files:**
- Create: `src/components/agent/ChatCards.tsx`
- Create: `src/components/agent/ChatHeader.tsx`
- Create: `src/components/agent/WorkflowPickerSheet.tsx`
- Create: `src/components/agent/VersionHistorySheet.tsx`

- [ ] **Step 1: 创建 `src/components/agent/ChatCards.tsx`**

```tsx
import { Check, Download, Network } from 'lucide-react';
import { toast } from 'sonner';
import { downloadMedia } from '@/platform/mediaDownload';
import { useAgentText } from './useAgentText';
import { AgentMedia, type AgentMediaOutput } from './AgentMedia';

export const chipButton = 'h-8 px-3 inline-flex items-center gap-1.5 rounded-[9px] border border-white/[0.08] bg-white/[0.045] text-[12px] font-semibold text-[#c8ccd4] disabled:opacity-40 disabled:cursor-not-allowed';
export const accentChip = 'h-8 px-3 inline-flex items-center gap-1.5 rounded-[9px] border border-[#3069f0]/35 bg-[#3069f0]/12 text-[12px] font-semibold text-[#5b8af5] disabled:opacity-40 disabled:cursor-not-allowed';

export function WorkflowChangeCard({ version, summary, operations, mirrored, onOpenCanvas }: { version: number; summary: string; operations?: unknown; mirrored: boolean; onOpenCanvas?: () => void }) {
  const at = useAgentText();
  return <article data-agent-card="workflow" className="rounded-[10px] border border-white/[0.07] p-3 space-y-2" style={{ background: '#101217' }}>
    <div className="flex items-center gap-2">
      <Network size={15} strokeWidth={1.8} className="text-[#5b8af5]" />
      <span className="text-[12.5px] font-semibold">{at('工作流已更新')}</span>
      <span className="font-mono text-[10px] text-[#5b8af5]">V{version}</span>
      <span className="flex-1" />
      {mirrored && <span className="font-mono text-[10px] text-[#565d6b]">{at('已写入工作流库')}</span>}
    </div>
    <p className="text-[12px] leading-relaxed text-[#9aa3b2]">{at(summary)}</p>
    {!!operations && <details className="text-xs"><summary className="cursor-pointer text-[#8a919e]">{at('查看改动')}</summary><pre className="mt-2 whitespace-pre-wrap break-all text-[#9aa3b2]">{JSON.stringify(operations, null, 2)}</pre></details>}
    {onOpenCanvas && <div><button className={accentChip} onClick={onOpenCanvas}><Network size={13} />{at('在画布查看')}</button></div>}
  </article>;
}

export function ResultCard({ version, outputs, baseUrl }: { version: number; outputs: AgentMediaOutput[]; baseUrl: string }) {
  const at = useAgentText();
  async function save(output: AgentMediaOutput) {
    const url = `${baseUrl}/view?${new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: output.type })}`;
    try { await downloadMedia({ url, filename: output.filename }); toast.success(at('已开始保存 {{name}}', { name: output.filename })); }
    catch { toast.error(at('保存失败')); }
  }
  return <article data-agent-card="result" className="rounded-[10px] border border-[#34c77b]/25 p-3 space-y-2.5" style={{ background: '#101217' }}>
    <div className="flex items-center gap-2"><Check size={15} strokeWidth={1.8} className="text-[#4ade80]" /><span className="text-[12.5px] font-semibold">{at('生成结果')}</span><span className="font-mono text-[10px] text-[#5b8af5]">V{version}</span></div>
    {outputs.length ? <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{outputs.map((output, index) => <div key={index} className="space-y-1.5"><AgentMedia baseUrl={baseUrl} output={output} index={index} /><button className={chipButton} onClick={() => void save(output)}><Download size={13} />{at('保存到相册')}</button></div>)}</div>
      : <p className="text-[12px] text-[#9aa3b2]">{at('执行完成，但没有返回可预览媒体。')}</p>}
  </article>;
}

export function ErrorCard({ title, detail }: { title: string; detail: string }) {
  const at = useAgentText();
  return <article data-agent-card="error" className="rounded-[10px] border border-[#f25555]/30 bg-[#f25555]/[0.06] p-3 space-y-2">
    <p className="text-[12.5px] font-semibold text-[#f87c7c]">{at(title)}</p>
    <details className="text-xs"><summary className="cursor-pointer text-[#8a919e]">{at('查看诊断')}</summary><pre className="mt-2 whitespace-pre-wrap break-all text-[#9aa3b2]">{detail}</pre></details>
  </article>;
}

export function NoticeCard({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  const at = useAgentText();
  return <div role="status" data-agent-card="notice" className="rounded-[10px] border border-[#f0a35b]/30 bg-[#f0a35b]/[0.08] px-3 py-2.5 text-[12px] text-[#f0a35b] flex items-center gap-3">
    <span className="flex-1">{at(text)}</span>
    {action && onAction && <button className="font-semibold shrink-0" onClick={onAction}>{at(action)}</button>}
  </div>;
}
```

- [ ] **Step 2: 创建 `src/components/agent/ChatHeader.tsx`**

```tsx
import { ArrowLeft, History, MoreVertical, Network, Pencil, Trash2 } from 'lucide-react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { useAgentText } from './useAgentText';

const tile = 'w-9 h-9 shrink-0 flex items-center justify-center rounded-[10px] border border-white/[0.08] text-[#c8ccd4] disabled:opacity-40';
const tileStyle = { background: 'rgba(255,255,255,0.045)' };

export function ChatHeader({ title, subtitle, onBack, onOpenCanvas, onRename, onHistory, onDelete }: {
  title: string; subtitle?: string; onBack: () => void; onOpenCanvas?: () => void; onRename?: () => void; onHistory?: () => void; onDelete?: () => void;
}) {
  const at = useAgentText();
  const item = 'flex items-center gap-2.5 px-3 h-10 text-[13px] text-[#e9ebef] rounded-[8px] outline-none data-[highlighted]:bg-white/[0.06] cursor-pointer';
  return <header className="shrink-0 z-10 border-b border-white/[0.08] pwa-header" style={{ background: 'rgba(11,12,15,0.86)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' }}>
    <div className="h-14 flex items-center gap-[11px] px-3">
      <button className={tile} style={tileStyle} onClick={onBack} aria-label={at('返回')}><ArrowLeft className="w-[17px] h-[17px]" strokeWidth={1.8} /></button>
      <div className="min-w-0 flex-1">
        <h1 className="text-[14px] font-semibold text-[#e9ebef] leading-[1.25] truncate">{title}</h1>
        {subtitle && <div className="font-mono text-[9px] font-medium text-[#565d6b] tracking-[0.12em] uppercase mt-[3px] truncate">{subtitle}</div>}
      </div>
      {onOpenCanvas && <button data-agent-open-canvas className="h-9 px-3 shrink-0 flex items-center gap-1.5 rounded-[10px] border border-white/[0.08] text-[12px] font-semibold text-[#c8ccd4]" style={tileStyle} onClick={onOpenCanvas}><Network size={15} strokeWidth={1.8} />{at('画布')}</button>}
      {(onRename || onHistory || onDelete) && <Dropdown.Root>
        <Dropdown.Trigger asChild><button className={tile} style={tileStyle} aria-label={at('更多')}><MoreVertical className="w-[17px] h-[17px]" strokeWidth={1.8} /></button></Dropdown.Trigger>
        <Dropdown.Portal><Dropdown.Content align="end" sideOffset={6} className="z-[60] min-w-[180px] p-1 rounded-[12px] border border-white/[0.08] shadow-2xl" style={{ background: '#101217' }}>
          {onRename && <Dropdown.Item className={item} onSelect={onRename}><Pencil size={15} />{at('重命名')}</Dropdown.Item>}
          {onHistory && <Dropdown.Item className={item} onSelect={onHistory}><History size={15} />{at('版本历史')}</Dropdown.Item>}
          {onDelete && <Dropdown.Item className={`${item} text-[#f87c7c]`} onSelect={onDelete}><Trash2 size={15} />{at('删除会话')}</Dropdown.Item>}
        </Dropdown.Content></Dropdown.Portal>
      </Dropdown.Root>}
    </div>
  </header>;
}
```

`@radix-ui/react-dropdown-menu` 已是依赖（`src/components/ui/dropdown-menu.tsx` 在用）。

- [ ] **Step 3: 创建 `src/components/agent/WorkflowPickerSheet.tsx`**

```tsx
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FileText, X } from 'lucide-react';
import { loadAllWorkflows } from '@/infrastructure/storage/IndexedDBWorkflowService';
import type { Workflow } from '@/shared/types/app/IComfyWorkflow';
import { useAgentText } from './useAgentText';

export function SheetFrame({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: React.ReactNode }) {
  const at = useAgentText();
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
    <Dialog.Content className="fixed z-[101] inset-x-0 bottom-0 max-h-[80dvh] rounded-t-2xl border-t border-white/10 text-[#e9ebef] flex flex-col" style={{ background: '#0f1116', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="flex items-center gap-2 px-4 pt-3 pb-2"><Dialog.Title className="font-semibold text-[14px] flex-1">{title}</Dialog.Title><Dialog.Close className="p-2" aria-label={at('关闭')}><X size={18} /></Dialog.Close></div>
      <div className="min-h-0 overflow-y-auto px-4 pb-4">{children}</div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

export function WorkflowPickerSheet({ open, onOpenChange, onPick }: { open: boolean; onOpenChange: (open: boolean) => void; onPick: (workflow: Workflow) => void }) {
  const at = useAgentText();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  useEffect(() => { if (open) void loadAllWorkflows().then(list => setWorkflows(list.filter(w => w.isValid))).catch(() => setWorkflows([])); }, [open]);
  return <SheetFrame open={open} onOpenChange={onOpenChange} title={at('选择工作流')}>
    {!workflows.length && <p className="py-8 text-center text-[12px] text-[#66758a]">{at('工作流库是空的')}</p>}
    <div className="space-y-2">{workflows.map(w => <button key={w.id} data-agent-pick={w.name} onClick={() => { onPick(w); onOpenChange(false); }} className="w-full flex items-center gap-3 p-3 rounded-[10px] border border-white/[0.07] text-left" style={{ background: '#101217' }}>
      <FileText size={18} strokeWidth={1.6} className="shrink-0 text-white/30" />
      <span className="flex-1 min-w-0"><span className="block text-[13px] font-semibold truncate">{w.name}</span><span className="block font-mono text-[10px] text-[#565d6b] mt-0.5">{w.nodeCount}N{w.agent ? ` · ${at('已有会话')}` : ''}</span></span>
    </button>)}</div>
  </SheetFrame>;
}
```

- [ ] **Step 4: 创建 `src/components/agent/VersionHistorySheet.tsx`**

```tsx
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import type { AgentVersion } from '@/infrastructure/api/AgentApi';
import { useAgentText } from './useAgentText';
import { SheetFrame } from './WorkflowPickerSheet';
import { chipButton } from './ChatCards';

export function VersionHistorySheet({ open, onOpenChange, versions, current, busy, onRestore }: { open: boolean; onOpenChange: (open: boolean) => void; versions: AgentVersion[]; current: number; busy: boolean; onRestore: (version: number) => void }) {
  const at = useAgentText();
  const { i18n } = useTranslation();
  return <SheetFrame open={open} onOpenChange={onOpenChange} title={at('版本历史（{{count}}）', { count: versions.length })}>
    <div className="divide-y divide-white/[0.05]">{versions.map(v => <div key={v.version} className="py-3 flex items-center gap-3">
      <span className="font-mono text-[10px] text-[#5b8af5] w-8 shrink-0">V{v.version}</span>
      <span className="flex-1 min-w-0"><span className="block text-[12.5px] truncate">{at(v.summary)}</span><span className="block font-mono text-[10px] text-[#565d6b] mt-0.5">{new Date(v.created).toLocaleString(i18n.resolvedLanguage || 'en')}</span></span>
      <button className={chipButton} disabled={busy || v.version === current} onClick={() => { onRestore(v.version); onOpenChange(false); }}><RotateCcw size={13} />{at('回到这个版本')}</button>
    </div>)}</div>
  </SheetFrame>;
}
```

- [ ] **Step 5: 构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 6: Commit**

```bash
git add src/components/agent/ChatCards.tsx src/components/agent/ChatHeader.tsx src/components/agent/WorkflowPickerSheet.tsx src/components/agent/VersionHistorySheet.tsx
git commit -m "feat(app): chat cards, header and bottom sheets"
```

---

### Task 13: 聊天页与路由接入，删除旧页面

**Files:**
- Create: `src/components/agent/ChatPage.tsx`
- Modify: `src/App.tsx`
- Delete: `src/components/agent/AgentPage.tsx`, `src/components/agent/AgentHistory.tsx`

- [ ] **Step 1: 创建 `src/components/agent/ChatPage.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Bot, Film, Image as ImageIcon, Loader2, Network, Send, Square } from 'lucide-react';
import { toast } from 'sonner';
import { SimpleConfirmDialog } from '@/components/ui/SimpleConfirmDialog';
import { addWorkflow, loadAllWorkflows, updateWorkflow, updateWorkflowAgentBinding } from '@/infrastructure/storage/IndexedDBWorkflowService';
import type { AgentEvent, AgentSession } from '@/infrastructure/api/AgentApi';
import { useAgentActivityStore } from '@/ui/store/agentActivityStore';
import type { Workflow } from '@/shared/types/app/IComfyWorkflow';
import { AgentTranscript } from './transcript/AgentTranscript';
import { ChatHeader } from './ChatHeader';
import { ErrorCard, NoticeCard, ResultCard, WorkflowChangeCard } from './ChatCards';
import { WorkflowPickerSheet } from './WorkflowPickerSheet';
import { VersionHistorySheet } from './VersionHistorySheet';
import { NEW_CHAT_PRESETS, resolveBoundWorkflow, sessionTitle } from './binding';
import { importCanvasIfChanged, mirrorVersion, type MirrorDeps } from './mirror';
import { useAgentStatus } from './useAgentStatus';
import { useAgentText } from './useAgentText';
import { useSessionSnapshot } from './useSessionSnapshot';

const active = new Set(['queued', 'running', 'waiting_comfy', 'reconciling']);
const states: Record<string, string> = { queued: '等待助手处理', running: '正在分析和操作工作流', waiting_comfy: 'ComfyUI 正在生成', reconciling: '正在核对提交状态' };
const BACKGROUND_HINT_KEY = 'comfy_mobile_agent_background_hint';

export default function ChatPage() {
  const at = useAgentText();
  const navigate = useNavigate();
  const { id } = useParams();
  const [params] = useSearchParams();
  const { api, ready, state } = useAgentStatus();
  const setActive = useAgentActivityStore(s => s.setActive);
  const { snapshot, events, error, caughtUp, setSnapshot, refresh } = useSessionSnapshot(api, id);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [pending, setPending] = useState<Workflow | null>(null); // workflow chosen for a not-yet-created session
  const [draft, setDraft] = useState(() => params.get('draft') ?? '');
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(params.get('pick') === '1');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [missing, setMissing] = useState(false);
  const [unsupported, setUnsupported] = useState<string | null>(null);
  const [mirroredVersion, setMirroredVersion] = useState(0);
  const request = useRef<{ text: string; id: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [showLatest, setShowLatest] = useState(false);

  const reloadWorkflows = useCallback(() => loadAllWorkflows().then(setWorkflows).catch(() => setWorkflows([])), []);
  useEffect(() => { void reloadWorkflows(); }, [reloadWorkflows, id]);
  useEffect(() => {
    const preset = params.get('workflow');
    if (!id && preset) void loadAllWorkflows().then(list => { const found = list.find(w => w.id === preset); if (found) setPending(found); });
  }, [id, params]);

  const session = snapshot?.session;
  const bound = useMemo(() => resolveBoundWorkflow(session?.workflow, workflows), [session, workflows]);
  const task = snapshot?.tasks.find(t => active.has(t.state));
  useEffect(() => { if (snapshot) setActive(!!task); }, [snapshot, task, setActive]);
  useEffect(() => { if (followLatest.current) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); else setShowLatest(true); }, [events.length]);

  const mirrorDeps: MirrorDeps = useMemo(() => ({
    workflows: loadAllWorkflows,
    add: addWorkflow,
    update: updateWorkflow,
    bind: (sessionId, ref) => api.update(sessionId, { workflow: ref }).then(({ session: next }) => setSnapshot(previous => previous ? { ...previous, session: next } : previous)),
  }), [api, setSnapshot]);

  // Mirror the session's current version into the library whenever it moves forward.
  useEffect(() => {
    if (!session || session.version === 0 || session.version <= mirroredVersion) return;
    let cancelled = false;
    (async () => {
      try {
        const version = await api.version(session.id, session.version);
        const result = await mirrorVersion(session, session.version, version.canvas, mirrorDeps, { fallbackName: at('新对话') });
        if (cancelled) return;
        setMissing(result.kind === 'missing');
        setMirroredVersion(session.version);
        await reloadWorkflows();
      } catch (e) { if (!cancelled) toast.error(at('写入工作流库失败：{{message}}', { message: e instanceof Error ? e.message : String(e) })); }
    })();
    return () => { cancelled = true; };
  }, [api, session, mirroredVersion, mirrorDeps, reloadWorkflows, at]);

  async function action(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { toast.error(at(e instanceof Error ? e.message : '操作失败')); }
    finally { setBusy(false); }
  }

  async function send() {
    const text = draft.trim(); if (!text) return;
    let target: AgentSession | undefined = session;
    if (!target) {
      const created = await api.create(pending ? pending.name : at('新工作流'), pending?.workflow_json, pending ? { id: pending.id, name: pending.name, filename: pending.cloud?.filename } : undefined);
      target = created.session;
      if (pending) await updateWorkflowAgentBinding(pending.id, { sessionId: target.id, mirroredVersion: 1, mirroredAt: (pending.modifiedAt ?? pending.createdAt).toISOString() });
    } else if (!unsupported) {
      const result = await importCanvasIfChanged(target, bound, { importVersion: (sid, canvas, base, summary) => api.importVersion(sid, canvas, base, summary), setBinding: updateWorkflowAgentBinding });
      if (result.kind === 'unsupported') { setUnsupported(result.message); return; }
      if (result.kind === 'imported') { target = { ...target, version: result.version }; setMirroredVersion(result.version); await reloadWorkflows(); }
    }
    setUnsupported(null);
    if (!request.current || request.current.text !== text) request.current = { text, id: crypto.randomUUID() };
    await api.message(target.id, text, request.current.id);
    request.current = null; setDraft('');
    try { if (!localStorage.getItem(BACKGROUND_HINT_KEY)) { toast.info(at('离开页面后，后台任务继续运行。')); localStorage.setItem(BACKGROUND_HINT_KEY, '1'); } } catch { /* storage unavailable */ }
    if (!session) { setPending(null); navigate(`/chat/${target.id}`, { replace: true }); }
    else setSnapshot(await api.snapshot(target.id));
  }

  const title = session ? sessionTitle(session, at('新对话')) : pending ? pending.name : at('新对话');
  const subtitle = session ? [session.version ? `V${session.version}` : '', bound ? `${bound.nodeCount}N` : ''].filter(Boolean).join(' · ') : pending ? `${pending.nodeCount}N` : undefined;
  const chips = [
    { icon: <ImageIcon size={14} strokeWidth={1.8} />, label: at('生成一张图片'), onClick: () => setDraft(NEW_CHAT_PRESETS.image) },
    { icon: <Film size={14} strokeWidth={1.8} />, label: at('生成一段短视频'), onClick: () => setDraft(NEW_CHAT_PRESETS.video) },
    { icon: <Network size={14} strokeWidth={1.8} />, label: at('从我的工作流开始'), onClick: () => setPickerOpen(true) },
  ];
  const canSend = ready && !busy && !task && !!draft.trim();

  const renderContent = (event: AgentEvent) => {
    const data = event.data;
    if (event.kind === 'workflow') return <WorkflowChangeCard key={event.seq} version={data.version} summary={data.summary} operations={data.operations} mirrored={data.version <= mirroredVersion && !!bound} onOpenCanvas={bound ? () => navigate(`/workflow/${bound.id}`) : undefined} />;
    if (event.kind === 'result') return <ResultCard key={event.seq} version={data.version} outputs={data.outputs ?? []} baseUrl={api.baseUrl} />;
    if (event.kind === 'execution_error') return <ErrorCard key={event.seq} title="这次生成未成功" detail={data.diagnostic || JSON.stringify(data, null, 2)} />;
    if (event.kind === 'state' && data.state === 'failed') return <NoticeCard key={event.seq} text={data.error || '任务未完成'} />;
    return null;
  };

  return <main className="h-dvh overflow-hidden flex flex-col text-[#e9ebef]" style={{ background: '#0b0c0f', paddingTop: 'env(safe-area-inset-top)' }}>
    <ChatHeader title={title} subtitle={subtitle} onBack={() => navigate('/chats')}
      onOpenCanvas={bound ? () => navigate(`/workflow/${bound.id}`) : undefined}
      onRename={session ? () => { const name = window.prompt(at('新的会话名'), title); if (name?.trim()) void action(async () => { const { session: next } = await api.update(session.id, { name: name.trim(), ...(session.workflow ? { workflow: { ...session.workflow, name: name.trim() } } : {}) }); setSnapshot(p => p ? { ...p, session: next } : p); if (bound) await updateWorkflow({ ...bound, name: name.trim() }); await reloadWorkflows(); }); } : undefined}
      onHistory={session && snapshot?.versions.length ? () => setHistoryOpen(true) : undefined}
      onDelete={session ? () => setDeleteOpen(true) : undefined} />
    <div onScroll={e => { const el = e.currentTarget; followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; if (followLatest.current) setShowLatest(false); }} className="w-full max-w-4xl mx-auto flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 space-y-3">
      {!ready && state !== 'loading' && <NoticeCard text="请先连接 Gateway，再使用工作流助手。" action="打开连接设置" onAction={() => navigate('/settings/server')} />}
      {error && <NoticeCard text={error} action="重新连接" onAction={refresh} />}
      {missing && <NoticeCard text="绑定的工作流已从库里删除。" action="从当前版本重新创建" onAction={() => void action(async () => { if (!session) return; const version = await api.version(session.id, session.version); await mirrorVersion(session, session.version, version.canvas, mirrorDeps, { recreate: true, fallbackName: at('新对话') }); setMissing(false); await reloadWorkflows(); })} />}
      {unsupported && <NoticeCard text="画布里有助手暂不支持的改动，助手将基于上一版本继续。" action="继续发送" onAction={() => { void action(send); }} />}
      {pending && !session && <div className="rounded-[10px] border border-white/[0.07] p-3 flex items-center gap-2 text-[12.5px]" style={{ background: '#101217' }}><Network size={15} className="text-[#5b8af5]" />{at('已载入工作流 · {{count}} 个节点', { count: pending.nodeCount })}</div>}
      {!id && !pending && <div className="py-14 flex flex-col items-center text-center gap-3">
        <div className="w-[52px] h-[52px] rounded-[14px] bg-[#3069f0]/12 border border-[#3069f0]/25 flex items-center justify-center"><Bot size={26} strokeWidth={1.8} className="text-[#5b8af5]" /></div>
        <p className="text-[16px] font-semibold">{at('你想创作什么？')}</p>
        <p className="text-[12.5px] text-[#66758a] max-w-[280px] leading-relaxed">{at('直接描述目标。助手会根据已安装的模型选择合适的工作流，生成预览并写入你的工作流库。')}</p>
      </div>}
      {id && <AgentTranscript events={events} tasks={snapshot?.tasks ?? []} caughtUp={caughtUp} renderContent={renderContent} />}
      <div ref={bottom} />
    </div>
    <footer className="shrink-0 border-t border-white/[0.08]" style={{ background: 'rgba(11,12,15,0.95)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
      <div className="max-w-4xl mx-auto p-4 space-y-2.5">
        {showLatest && <button className="text-[12px] text-[#5b8af5] font-semibold" onClick={() => { followLatest.current = true; setShowLatest(false); bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }}>{at('回到最新消息')}</button>}
        {!id && <div className="flex gap-2 overflow-x-auto scrollbar-hide">{chips.map(chip => <button key={chip.label} onClick={chip.onClick} className="h-[34px] px-3 shrink-0 rounded-[9px] border border-white/[0.08] bg-white/[0.035] text-[12px] font-medium text-[#c8ccd4] flex items-center gap-1.5">{chip.icon}{chip.label}</button>)}</div>}
        {task && <div role="status" className="h-10 pl-3 pr-1.5 rounded-[10px] border border-[#3069f0]/30 bg-[#3069f0]/10 flex items-center gap-2 text-[12.5px] font-medium text-[#5b8af5]">
          <Loader2 size={14} className="animate-spin" /><span className="flex-1">{at(states[task.state] ?? '正在处理')}</span>
          <button className="h-7 px-2.5 rounded-[7px] border border-white/10 bg-white/5 text-[11.5px] font-semibold text-[#c8ccd4] flex items-center gap-1.5" disabled={busy} onClick={() => void action(async () => { if (session) await api.cancel(session.id, task.id); })}><Square size={10} fill="currentColor" />{at('停止')}</button>
        </div>}
        <form className="flex items-end gap-2" onSubmit={e => { e.preventDefault(); if (canSend) void action(send); }}>
          <textarea aria-label={at('给助手的消息')} value={draft} onChange={e => setDraft(e.target.value)} rows={2} maxLength={8000} disabled={!ready} placeholder={ready ? at('描述你想要的效果，或告诉助手如何调整…') : at('等待模型连接')} className="flex-1 min-w-0 resize-none rounded-[12px] border border-white/[0.08] bg-white/[0.045] p-3 text-[13px] disabled:opacity-50 focus:outline-none focus:border-[#3069f0]/50" />
          <button type="submit" aria-label={at('发送消息')} disabled={!canSend} className={`w-11 h-11 shrink-0 rounded-[12px] flex items-center justify-center ${canSend ? 'bg-[#3069f0] text-white' : 'bg-[#23262d] text-[#565d6b]'}`}><Send size={18} /></button>
        </form>
      </div>
    </footer>
    <WorkflowPickerSheet open={pickerOpen} onOpenChange={setPickerOpen} onPick={workflow => { if (workflow.agent?.sessionId) navigate(`/chat/${workflow.agent.sessionId}`, { replace: true }); else setPending(workflow); }} />
    {snapshot && <VersionHistorySheet open={historyOpen} onOpenChange={setHistoryOpen} versions={snapshot.versions} current={snapshot.session.version} busy={busy || !!task} onRestore={version => void action(async () => { await api.restore(snapshot.session.id, version, snapshot.session.version); setSnapshot(await api.snapshot(snapshot.session.id)); })} />}
    <SimpleConfirmDialog isOpen={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={() => { setDeleteOpen(false); void action(async () => { if (!session) return; await api.remove(session.id); if (bound?.agent?.sessionId === session.id) await updateWorkflowAgentBinding(bound.id, undefined); navigate('/chats', { replace: true }); }); }} title={at('删除会话')} message={at('只删除对话记录和版本历史，工作流库里的工作流会保留。')} confirmText={at('删除')} cancelText={at('取消')} />
  </main>;
}
```

关键行为说明（实现时不要偏离）：
- **懒创建**：没有 `id` 时页面不创建会话；第一条消息发送时才 `api.create`，带上选中工作流的画布和绑定，然后 `navigate(/chat/:id, replace)`。
- **镜像**：effect 监视 `session.version`；大于本页已镜像版本时拉取画布并调用 `mirrorVersion`。首次进入会把当前版本镜像一次（覆盖离线期间的版本）。
- **画布导入**：`send()` 在有会话时先 `importCanvasIfChanged`；422 时显示提示卡，用户点"继续发送"会跳过导入。
- 选择器里选到 `workflow.agent.sessionId` 已存在的工作流时直接跳到那个会话。

- [ ] **Step 2: 路由接入并删除旧页面**

`src/App.tsx`：加 `import ChatPage from '@/components/agent/ChatPage';`，在 `<Route path="/agent" …/>` 后加：

```tsx
        <Route path="/chat/new" element={<ChatPage />} />
        <Route path="/chat/:id" element={<ChatPage />} />
```

删除文件：

```bash
git rm src/components/agent/AgentPage.tsx src/components/agent/AgentHistory.tsx
```

- [ ] **Step 3: 构建与 lint**

Run: `npm run build && npm run lint`
Expected: 成功。

- [ ] **Step 4: 用 UI 联调脚本走一遍主流程**

```bash
npm run build:agent && node_modules/.bin/tsx gateway/agent/test/uiHarness.ts
```

打开输出的 URL，登录 `local-agent-ui-test-token`，检查：
1. `/chats` 空状态显示三个芯片；点"新对话"进入 `/chat/new`。
2. 输入任意文字发送：URL 变为 `/chat/<id>`；脚本化模型会依次创建模板、修改、预览、保存；出现"工作流已更新"卡（带"已写入工作流库"）和"生成结果"卡。
3. 切到 `/workflows`：库里出现一个以第一条消息命名的工作流；打开画布后头部标题一致。
4. 回到 `/chats`：列表第一行是该会话，缩略图为生成结果。
5. 更多菜单 → 版本历史 → "回到这个版本"生成新版本；删除会话后回到列表，工作流仍在库里。

如有偏差，先改代码再继续。Ctrl-C 结束脚本。

- [ ] **Step 5: Commit**

```bash
git add src/components/agent/ChatPage.tsx src/App.tsx
git commit -m "feat(app): chat page with lazy session creation, version mirroring and canvas import"
```

---

### Task 14: 编辑器与工作流库入口

**Files:**
- Modify: `src/components/workflow/WorkflowHeader.tsx`
- Modify: `src/components/workflow/WorkflowEditor.tsx`
- Modify: `src/components/workflow/WorkflowDetailModal.tsx`

- [ ] **Step 1: WorkflowHeader 增加"对话"按钮**

`WorkflowHeaderProps` 加 `onOpenChat?: () => void; chatActive?: boolean;`，解构处加这两个。lucide import 加 `MessageSquare`。在 "Save Button Slot" 那个 `<div className="w-9 h-9 …">` 之前插入：

```tsx
          {onOpenChat && (
            <button
              data-e2e-action="open-chat"
              onClick={onOpenChat}
              className="h-9 px-3 shrink-0 flex items-center gap-1.5 rounded-[10px] border border-[#3069f0]/35 text-[12px] font-semibold text-[#5b8af5] relative"
              style={{ background: 'rgba(48,105,240,0.12)' }}
              title={t('workflow.openChat', '对话')}
            >
              <MessageSquare className="w-[15px] h-[15px]" strokeWidth={1.8} />
              <span>{t('workflow.openChat', '对话')}</span>
              {chatActive && <span className="absolute -top-[3px] -right-[3px] w-2 h-2 rounded-full bg-[#3069f0] border-[1.5px] border-[#0b0c0f]" />}
            </button>
          )}
```

- [ ] **Step 2: WorkflowEditor 传入回调**

在 `<WorkflowHeader … onSaveChanges={handleSaveChanges} />` 里加：

```tsx
        onOpenChat={authMode === 'gateway' ? () => {
          if (workflow?.agent?.sessionId) navigate(`/chat/${workflow.agent.sessionId}`);
          else if (workflow) navigate(`/chat/new?workflow=${encodeURIComponent(workflow.id)}`);
        } : undefined}
        chatActive={chatActive}
```

需要在文件顶部加 `import { useAgentActivityStore } from '@/ui/store/agentActivityStore';`，在组件顶部其他 hook 旁加 `const chatActive = useAgentActivityStore(s => s.active);`，并确认组件里已有 `authMode`（`useConnectionStore` 解构）；没有的话在现有 `useConnectionStore` 调用处加上 `authMode`。

- [ ] **Step 3: WorkflowDetailModal 增加"和助手对话"**

在 footer 的 `Copy` 按钮前加一个按钮（图标 `MessageSquare`，从 lucide import）：

```tsx
                {authMode === 'gateway' && workflow && (
                  <Button
                    onClick={() => { onClose(); navigate(workflow.agent?.sessionId ? `/chat/${workflow.agent.sessionId}` : `/chat/new?workflow=${encodeURIComponent(workflow.id)}`); }}
                    variant="outline"
                    className="flex-1 h-10 py-0 rounded-[10px] bg-[#3069f0]/12 border border-[#3069f0]/35 text-[#5b8af5] hover:bg-[#3069f0]/20 transition-all duration-200 flex items-center justify-center gap-2"
                    title={t('workflow.openChat', '和助手对话')}
                  >
                    <MessageSquare className="w-5 h-5" />
                  </Button>
                )}
```

文件顶部加 `import { useNavigate } from 'react-router-dom';`、`import { useConnectionStore } from '@/ui/store/connectionStore';`，组件内加 `const navigate = useNavigate(); const authMode = useConnectionStore(s => s.authMode);`（若已有 `navigate` 则复用）。

- [ ] **Step 4: 构建，并在联调脚本里核对**

Run: `npm run build && npm run lint`
Expected: 成功。

联调：打开一个工作流画布，头部出现"对话"按钮；点击进入该工作流的会话（已有绑定时直接进入，否则进入预载入的新对话）。

- [ ] **Step 5: Commit**

```bash
git add src/components/workflow/WorkflowHeader.tsx src/components/workflow/WorkflowEditor.tsx src/components/workflow/WorkflowDetailModal.tsx
git commit -m "feat(app): open the bound chat from the canvas editor and workflow details"
```

---

### Task 15: 翻译键与 i18n 测试

**Files:**
- Modify: `src/locale/zh/common.json`, `src/locale/en/common.json`, `src/locale/ja/common.json`, `src/locale/ko/common.json`
- Modify: `tests/transcript/i18n.test.ts`

- [ ] **Step 1: 列出需要的键**

Run:

```bash
grep -ho "at('[^']*'" src/components/agent/*.tsx src/components/agent/transcript/*.tsx | sed "s/at('//; s/'$//" | sort -u > /tmp/agent-keys.txt
node -e "const zh=require('./src/locale/zh/common.json').agentUI; require('fs').readFileSync('/tmp/agent-keys.txt','utf8').trim().split('\n').filter(k=>!(k in zh)).forEach(k=>console.log(k))"
```

Expected: 打印缺失的中文键列表（约 60 条，包括本计划里所有 `at('…')` 字面量，如 `对话`、`新对话`、`搜索会话`、`生成中`、`上轮出错`、`工作流已更新`、`已写入工作流库`、`在画布查看`、`保存到相册`、`回到这个版本`、`删除会话`、`只删除对话记录和版本历史，工作流库里的工作流会保留。` 等）。

这个 grep 抓不到通过 prop 传给 `NoticeCard` / `ErrorCard` 再由组件内部 `at()` 翻译的字面量，以下键要手动补上：`这次生成未成功`、`任务未完成`、`请先连接 Gateway，再使用工作流助手。`、`打开连接设置`、`重新连接`、`绑定的工作流已从库里删除。`、`从当前版本重新创建`、`画布里有助手暂不支持的改动，助手将基于上一版本继续。`、`继续发送`、`重试`、`加载会话失败`、`删除失败`、`操作失败`、`连接中断，正在重试`、`画布修改`、`导入工作流副本`（后两条是 Gateway 写进版本摘要的文本，版本历史面板会 `at()` 它们）。

- [ ] **Step 2: 写入四种语言**

对列表中的每个键：zh 的值等于键本身；en / ja / ko 给出对应翻译。带 `{{count}}`、`{{name}}`、`{{message}}` 的键保留占位符。示例（其余同法）：

| zh 键 | en | ja | ko |
| --- | --- | --- | --- |
| 对话 | Chats | チャット | 대화 |
| 新对话 | New chat | 新しいチャット | 새 대화 |
| 搜索会话 | Search chats | チャットを検索 | 대화 검색 |
| 生成中 | Generating | 生成中 | 생성 중 |
| 上轮出错 | Last turn failed | 前回エラー | 마지막 턴 실패 |
| 工作流已更新 | Workflow updated | ワークフローを更新しました | 워크플로 업데이트됨 |
| 已写入工作流库 | Saved to library | ライブラリに保存済み | 라이브러리에 저장됨 |
| 在画布查看 | Open on canvas | キャンバスで開く | 캔버스에서 열기 |
| 保存到相册 | Save to gallery | ギャラリーに保存 | 갤러리에 저장 |
| 回到这个版本 | Restore this version | このバージョンに戻す | 이 버전으로 복원 |
| 删除会话 | Delete chat | チャットを削除 | 대화 삭제 |
| {{count}} 分钟前 | {{count}} min ago | {{count}}分前 | {{count}}분 전 |

同时在四个文件顶层加 `tabs` 节：

```json
"tabs": { "chats": "对话", "workflows": "工作流", "gallery": "画廊" }
```
（en: Chats / Workflows / Gallery；ja: チャット / ワークフロー / ギャラリー；ko: 대화 / 워크플로 / 갤러리。）并在四个文件的 `workflow` 节加 `"openChat"`（zh 对话 / en Chat / ja チャット / ko 대화）。删除四个文件 `menu` 节里的 `agent` 与 `agentDescription`、`gallery` 与 `gallerySub`。

- [ ] **Step 3: 更新 i18n 测试**

`tests/transcript/i18n.test.ts` 第一个用例里删掉 `assert(dictionaries[lang].menu.agent);`，替换为：

```ts
   assert.deepEqual(Object.keys(dictionaries[lang].tabs).sort(), ['chats', 'gallery', 'workflows']);
```

- [ ] **Step 4: 运行**

Run: `npm run test:transcript && npm run test:agent-ui && npm run build`
Expected: 全部 PASS。若 "all literal assistant UI translation keys exist" 仍失败，按提示补键。

- [ ] **Step 5: Commit**

```bash
git add src/locale tests/transcript/i18n.test.ts
git commit -m "feat(i18n): chat-first assistant strings in zh, en, ja, ko"
```

---

### Task 16: E2E 脚本、文档同步

**Files:**
- Modify: `tests/e2e/agent-android-scenario.mjs`
- Modify: `docs/agent-chat-ux-redesign.md`

- [ ] **Step 1: 更新 Android 场景脚本的入口与选择器**

`tests/e2e/agent-android-scenario.mjs` 里从 `location.href = "/agent"` 到 `const sessionId = …` 这一段替换为：

```js
  await app.evaluate('localStorage.setItem("i18nextLng","zh");location.href = "/chat/new?pick=1"; "nav"').catch(() => {});
  await waitFor(`!!document.querySelector('[data-agent-pick]')`, 20000);
  const picked = await app.evaluate(`(() => { const b = [...document.querySelectorAll('[data-agent-pick]')].find(b => b.dataset.agentPick.includes('ComfyMobileAndroidE2E')); if (!b) return false; b.click(); return true; })()`);
  assert(picked, 'test workflow missing in agent workflow picker');
  await waitFor(`!!document.querySelector('textarea:not(:disabled)') && document.body.innerText.includes('已载入工作流')`, 15000);
```

发送后把 `const sessionId = …` 改为在 URL 变化后读取：

```js
  await waitFor(`location.pathname.startsWith('/chat/') && location.pathname !== '/chat/new'`, 15000);
  const sessionId = await app.evaluate(`location.pathname.split('/').pop()`);
  assert(sessionId, 'agent session missing');
```

结果等待条件 `document.body.innerText.includes('生成结果 · v') && document.body.innerText.includes('已保存')` 改为 `!!document.querySelector('[data-agent-card="result"]') && !!document.querySelector('[data-agent-card="workflow"]')`。冷启动恢复处 `location.href = "/agent"` 改为 `` location.href = "/chat/" + ${JSON.stringify(sessionId)} ``，等待条件改为 `` location.pathname === "/chat/" + ${JSON.stringify(sessionId)} && !!document.querySelector('[data-agent-card="result"]') ``。文件后半段其他引用 `select[aria-label=…]` 的地方一律改为按 `data-agent-session` / URL 判断。

在第一轮结果断言之后追加"画布 → 对话"的往返检查：

```js
  // The bound workflow now exists in the library; the chat header opens it and the editor links back.
  await app.evaluate(`document.querySelector('[data-agent-open-canvas]').click(); true`);
  await waitFor(`location.pathname.startsWith('/workflow/') && !!document.querySelector('[data-e2e-action="open-chat"]')`, 15000);
  await app.evaluate(`document.querySelector('[data-e2e-action="open-chat"]').click(); true`);
  await waitFor(`location.pathname === "/chat/" + ${JSON.stringify(sessionId)}`, 15000);
  console.log('    Agent: canvas <-> chat round trip verified');
```

画布改参数后自动导入版本的逻辑由 `tests/agent/mirror.test.ts` 覆盖，联调脚本里人工核对（Task 17）。这个脚本只能在带真实 provider 的模拟器环境跑（`npm run test:e2e:android`），本任务只要求语法正确：

Run: `node --check tests/e2e/agent-android-scenario.mjs`
Expected: 无输出。

- [ ] **Step 2: 同步设计文档**

`docs/agent-chat-ux-redesign.md` 第 1 节表格里 `| 对话 | \`/\` | 会话列表 |` 改为 `| 对话 | \`/chats\` | 会话列表 |`，并在表格后加一行：

```markdown
- `/` 是入口重定向：读取上次停留的标签；没有记录时按助手可用性选择。
```

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/agent-android-scenario.mjs docs/agent-chat-ux-redesign.md
git commit -m "test: point the Android agent scenario at the chat-first UI"
```

---

### Task 17: 完整验证

- [ ] **Step 1: 全部测试与构建**

```bash
npm run test:agent && npm run test:transcript && npm run test:agent-ui && npm run test:gateway && npm run build && npm run lint
```

Expected: 全部通过。

- [ ] **Step 2: 联调脚本完整走查并截图**

```bash
npm run build:agent && node_modules/.bin/tsx gateway/agent/test/uiHarness.ts
```

按 Task 13 Step 4 的五条流程和 Task 14 Step 4 的入口检查再走一遍，另外核对：
- 直连状态（在连接设置里把 `authMode` 切成非 gateway，或直接打开一个没登录的会话）下 `/chats` 显示引导页，`/` 落到 `/workflows`。
- 手机宽度（375px）下 `/chats`、`/chat/:id` 无横向滚动：`document.documentElement.scrollWidth <= innerWidth`。
- 底部标签栏在 `/chat/:id` 和画布页不出现。

每个页面截一张图放到 `tests/output/agent-chat-redesign/`（目录已在 `.gitignore` 的 `tests/output` 下）。

- [ ] **Step 3: 最终提交检查**

```bash
git status
git log --oneline main..HEAD
```

Expected: 工作树干净，提交序列与本计划任务对应。
