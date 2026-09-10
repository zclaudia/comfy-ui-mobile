# 移动端工作流表单视图（方案三）设计与实施计划

状态：第二稿，已自查，待开工。2026-09-11。第一稿的三个待确认项已定：默认视图为表单；图钉入口放现有全屏 `NodeDetailModal`；关联字段首期就做。自查改动汇总见第 11 节。

背景见上一轮讨论：手机上真正高频的操作是"改几个参数 → 运行 → 看结果"，而现有图视图把桌面版全图编辑搬到了 6 英寸屏幕上。方案三的核心是：**每个工作流可以定义一张"表单"，只暴露作者或用户认为需要调的输入；手机端打开工作流默认渲染这张表单，画布降级为查结构时才进的"结构视图"。**

## 1. 目标与范围

### 1.1 目标

- 打开工作流即看到表单，不需要缩放、平移或找节点。
- 表单字段与图中节点的 widget 一一绑定，改表单就是改图；运行走现有执行链路，进度和输出直接回到表单页。
- 表单定义随工作流文件保存并云同步，换设备后一致；在桌面版 ComfyUI 里打开再保存也不丢。
- 没有手动配置时，自动推荐一版表单，用户在此基础上增删。
- 一个字段可以关联多个节点的同名 widget，一处改多处（Wan 2.2 的 High / Low 双采样器）。

### 1.2 首期不做

- 拖拽排序（用上移 / 下移代替）。
- 跨工作流复用表单模板。
- Agent 自动生成表单（第 7 节预留）。
- 子图内部节点的字段（首期只支持根图；子图通过官方 `proxyWidgets` 暴露的输入除外）。
- 结构视图的语义缩放和分组导航条（方案二，排在阶段 3）。
- 半屏节点面板（mockup 画板 3 的形态，方案二）。

## 2. 核心概念

| 概念 | 说明 |
|---|---|
| 表单定义 `MobileFormSpec` | 字段列表 + 分区，描述"暴露哪些输入、怎么显示" |
| 字段 `MobileFormField` | 绑定到一个主目标 `nodeId + widget`，可选若干关联目标；可带自定义标签、控件类型、范围、提示 |
| 关联字段 | 字段有多个目标时，表单显示主目标的值，改值写入全部目标；目标值不一致时显示提示并可一键统一 |
| 来源优先级 | 用户手动配置 > 子图 `properties.proxyWidgets`（官方暴露输入） > 自动推荐 |
| 自动模式 / 自定义模式 | `auto`：每次打开重新推荐，新加的节点会自动出现；用户一旦手动改动即转 `custom` |
| 失效字段 | 目标节点被删、类型变化或 widget 改名；表单页隐藏，编辑模式标红并提供"删除 / 重新绑定" |

## 3. 数据模型

### 3.1 存放位置：`workflow_json.extra.comfy_mobile_form`

第一稿写的是 `mobile_ui_metadata.form`，自查后改为 `extra`，原因：

- `mobile_ui_metadata` 是工作流 JSON 的根级自定义键。桌面版 ComfyUI 前端保存时只序列化 LiteGraph 认识的根级字段，根级未知键会丢；而 `extra` 会原样保留（官方前端自己的 `ds`、`frontendVersion` 就放在那里）。工作流通过云同步在桌面和手机之间来回编辑是这个项目的常态，表单定义不能在这一趟里丢掉。
- 云同步已经把自己的元数据放在 `extra.comfy_mobile_cloud`（[cloudIdentity.ts:86](../src/infrastructure/sync/cloudIdentity.ts)），这是现成先例。
- `ComfyGraph.configure` 把 `data.extra` 整体复制到实例，`serialize` 原样写回（[ComfyGraph.ts](../src/core/domain/ComfyGraph.ts) 第 86 行和第 285 行附近），不需要新增序列化路径。
- 现有 `control_after_generate` 留在 `mobile_ui_metadata` 里有同样的丢失风险，但不在本期处理。

### 3.2 类型

```ts
// src/shared/types/app/IMobileForm.ts（新建）
export interface MobileFormSpec {
  version: 1;
  mode: 'auto' | 'custom';
  sections: MobileFormSection[];
  updatedAt: string;            // ISO
}

export interface MobileFormSection {
  id: string;
  title: string;                // 默认取 Group 标题或自动分类名
  collapsed?: boolean;
  fields: MobileFormField[];
}

export interface MobileFormTarget {
  nodeId: number;               // 根图节点 id，ComfyGraphNode.id 是 number
  widget: string;               // widget name（不是 widgets_values 下标）
  nodeType: string;             // 校验用：类型变了视为失效
}

export interface MobileFormField {
  id: string;                   // 稳定随机 id，不用 nodeId 拼接（关联字段有多个目标）
  target: MobileFormTarget;     // 主目标：取值、控件类型都以它为准
  linked?: MobileFormTarget[];  // 关联目标：写值时同步写入
  label?: string;               // 默认 `${node.title} · ${widget}`
  control?: 'auto' | 'text' | 'textarea' | 'number' | 'slider' | 'stepper'
          | 'select' | 'toggle' | 'seed' | 'image' | 'video';
  hint?: string;
  range?: { min?: number; max?: number; step?: number };
}
```

绑定用 widget 名而不是 `widgets_values` 下标：下标依赖 `objectInfo` 的输入顺序，自定义节点更新后会漂移；名字通过 `ComfyGraphNode.getWidget(name)` 解析，和 `useWidgetValueEditor` 现有接口一致。

### 3.3 关联字段的规则

- 读：表单显示主目标的当前值（含未保存修改）。
- 写：对主目标和每个关联目标各调一次 `widgetEditor.setWidgetValue`，走现有修改高亮和保存流程。
- 不一致：任一关联目标的值与主目标不同（例如用户在结构视图单独改了 Low noise 的 steps），字段右侧显示"不一致"标记，点开列出各目标当前值，可"统一为主值"或"解除关联"。
- 执行前：`useWorkflowRunner` 在 seed 处理之后调用 `applyLinkedFields(spec)`，把主值再写一遍到所有目标。这一步是为 seed 准备的：`autoChangeSeed` 会给每个 seed widget 各生成一个随机数，关联的 seed 字段必须在它之后统一。
- 关联的合法条件：目标 widget 的类型（INT / FLOAT / STRING / COMBO）与主目标一致；COMBO 还要求选项集合有交集。不满足时编辑模式拒绝关联并说明原因。
- 自动推荐时的合并：同一节点类型的同名 widget 自动合并成一个关联字段（两个 `KSamplerAdvanced` 的 `steps`、`cfg`、`noise_seed`）。不同类型节点即使同名也不合并（`EmptyLatentImage.width` 与 `ImageResize.width`）。

## 4. 界面

### 4.1 表单视图（默认页）

对应 mockup 画板 1 的骨架，去掉"按工作流分组"的折叠节点列表，整页只有表单：

- 头部：返回、工作流名、`表单 / 结构` 分段切换。
- 分区卡片：每个 `MobileFormSection` 一张卡，字段就地编辑。控件按 widget 类型和 `control` 提示选择：多行文本、步进器、滑条、下拉、开关、seed（带"每次随机"，读写现有 `control_after_generate`）、图片 / 视频（缩略图 + 更换）。
- 关联字段的标签旁显示目标数量（"steps · 2 处"）。
- 结果区：最近一次输出的缩略图和耗时，执行中显示 latent 预览。
- 底栏：运行 / 中断 / 清队列，复用现有 `QuickActionPanel` 的逻辑。
- 头部右侧"编辑表单"进入 4.2。

### 4.2 编辑表单模式

- 字段行显示上移 / 下移 / 删除 / 改标签 / 改控件类型 / 管理关联。
- "添加字段"：先选节点（复用 `FloatingControlsPanel` 的节点搜索列表），再勾选该节点的 widget；一次可多选。
- "关联到…"：从已有字段出发，列出同类型节点上的同名 widget 供勾选。
- 分区：新建 / 重命名 / 删除，删除分区时字段并入上一分区。
- "重新推荐"：丢弃当前定义，重新跑自动推荐，需二次确认。
- 完成后写回 `extra.comfy_mobile_form`，`mode` 置为 `custom`，触发工作流保存（进而云同步）。

### 4.3 从节点弹窗钉住

在现有全屏 `NodeDetailModal` 的每个参数行加一个图钉按钮：未钉住时点一下即向表单追加字段（默认落到"未分区"），已钉住时点一下移除。图钉状态通过 props（`pinnedTargets`、`onTogglePin`）传入，不改 `WidgetValueEditor` 本身。如果被钉的 widget 与已有字段的某个关联目标重合，提示"已关联到 XX 字段"而不是重复添加。

### 4.4 默认视图与空状态

- 打开工作流总是先进表单视图，只有两种例外落到结构视图：解析后没有任何有效字段；处于离线或 `objectInfo` 缺失状态（见 8）。不记忆上次视图。
- 首次打开且没有 `comfy_mobile_form`：按自动推荐生成一版并以 `auto` 模式展示，顶部提示"这是自动推荐的参数，可编辑表单"。
- 用户在结构视图进入了子图会话后切回表单：表单始终操作根图，切换时先 `jumpToSession(0)`。

## 5. 自动推荐的规则

第一稿写"沿用堆栈视图的分类启发式"，自查发现堆栈视图的启发式是**节点级**分类（把节点归到"提示词 / 采样器 / 加载器"），表单需要的是**字段级**筛选：一个 `KSamplerAdvanced` 有十来个 widget，表单默认只该露出两三个。因此 `FormSuggestionService` 分两步：

1. 节点分类：复用堆栈视图 `typeGroups` 的规则，得到每个节点所属分区和顺序。
2. 字段筛选：按下面的默认露出清单挑 widget，其余留给编辑模式手动添加。

| 分区 | 默认露出的 widget | 控件 |
|---|---|---|
| 输入 | `image`、`video`、`width`、`height`、`length`、`batch_size` | image / video / stepper |
| 提示词 | 类型为 STRING 且多行的 `text` / `prompt` / `value` | textarea |
| 模型 | `ckpt_name`、`unet_name`、`lora_name`、`strength_model`、`shift` | select / slider |
| 采样 | `seed`、`noise_seed`、`steps`、`cfg`、`denoise` | seed / stepper / slider |
| 输出 | `filename_prefix`、`fps`、`format` | text / select |

规则：已被连线接管的 widget 不露出；`control: 'auto'` 时控件由现有 registry 决定；同类型节点的同名 widget 合并为关联字段（3.3）。分区标题优先用节点所在 Group 的标题，没有 Group 才用分类名。

## 6. 与现有代码的对应关系

| 需求 | 复用 / 新建 | 位置 |
|---|---|---|
| 参数读写、修改高亮 | 复用根会话的 `useWidgetValueEditor` | [WorkflowEditor.tsx:311](../src/components/workflow/WorkflowEditor.tsx) |
| 控件渲染 | 复用 widget registry 和 `WidgetValueEditor`（支持 `themeOverride`） | [controls/widgets](../src/components/controls/widgets/index.ts) |
| 运行、seed 自增、API 转换、草稿执行、canvas v2 桥接 | 从 **`WorkflowEditor.handleExecute`** 抽成 `useWorkflowRunner`；堆栈视图的简化版迁移过来 | [WorkflowEditor.tsx:1694](../src/components/workflow/WorkflowEditor.tsx) |
| 自动推荐 | 新建 `FormSuggestionService`，节点分类部分从堆栈视图 `typeGroups` 抽出 | [WorkflowStackEditor.tsx:740](../src/components/workflow/WorkflowStackEditor.tsx) |
| 子图暴露输入 | 复用 `SubgraphMetadataService` 对 `proxyWidgets` 的解析 | [SubgraphMetadataService.ts](../src/core/services/SubgraphMetadataService.ts) |
| 表单持久化 | 新建 `src/shared/utils/mobileForm.ts`：`readForm(json) / writeForm(json, spec)`，操作 `extra.comfy_mobile_form` | 参考 [cloudIdentity.ts](../src/infrastructure/sync/cloudIdentity.ts) |
| 视图切换 | 嵌入 `WorkflowEditor`，与画布共用 `comfyGraphRef`、`sessionStack[0]` 和 widget editor | [WorkflowEditor.tsx](../src/components/workflow/WorkflowEditor.tsx) |
| 图钉 | `NodeDetailModal` 参数行加按钮，状态由 props 传入 | [NodeDetailModal.tsx](../src/components/canvas/NodeDetailModal.tsx) |
| 草稿画布（Agent） | `WorkflowEditorIntegration.storage` 同样适用；`renderParameter` 钩子可让 Agent 侧覆盖字段渲染 | [WorkflowEditorStorage.ts](../src/components/workflow/WorkflowEditorStorage.ts) |
| 进度、队列、latent 预览 | 复用 `QuickActionPanel`、`latentPreviewStore` | [QuickActionPanel.tsx](../src/components/controls/QuickActionPanel.tsx) |
| 文案 | `en / zh / ja / ko` 四份 `common.json` 新增 `form.*` 键 | [src/locale](../src/locale) |

## 7. 关键设计决策

1. **表单视图嵌入 `WorkflowEditor`，不做独立路由。** 堆栈视图走独立路由、自己从 IndexedDB 再加载一份图，导致两边改动互不可见、必须先保存。表单视图和画布共用同一个 `ComfyGraph` 实例后，钉住、改值、运行、缺失节点检测、快照都天然一致。代价是 `WorkflowEditor` 已有 4400 行，需要先把执行逻辑抽出来（阶段 0）。
2. **执行 hook 以 `WorkflowEditor` 的版本为准。** 它已经处理了草稿的 `integration.execute`、canvas v2 桥接下跳过本地 seed 处理、用真实 `workflow` 和 `nodeMetadata` 调 `autoChangeSeed`；堆栈视图那份是简化副本，抽 hook 时把它换掉而不是反过来。
3. **表单只操作根图会话。** `WorkflowEditor` 的 widget 修改是按子图会话分层存在 `sessionStack` 里的；表单绑定 `sessionStack[0]` 的 widget editor，进入表单时跳回根会话。
4. **`/workflow-stack/:id` 保留但降级。** 入口从浮动栏移到设置菜单；表单视图稳定后再决定是否合并。
5. **自动模式的边界。** `auto` 只在没有手动配置时生效；用户任何一次编辑都转 `custom`，之后不再自动加字段。"重新推荐"作为编辑模式里的显式按钮提供。
6. **字段值改动不单独持久化。** 改值走现有 widget 修改 → 保存流程；表单定义改动才写 `extra.comfy_mobile_form`。两者都是工作流改动，走同一个 etag 冲突机制。
7. **seed 的"每次随机"沿用 `control_after_generate`。** 不新增状态；关联的 seed 字段在执行前统一（3.3）。

## 8. 实施阶段

### 阶段 0：准备（约 1 天）

- 新建 `IMobileForm.ts` 类型和 `mobileForm.ts` 读写函数，含版本字段和损坏数据的容错。
- 从 `WorkflowEditor` 抽 `useWorkflowRunner`（执行、中断、seed 处理、关联字段统一、promptId 跟踪、草稿分支、v2 桥接分支）；`WorkflowEditor` 和 `WorkflowStackEditor` 改为调用它，行为不变。
- 新建 `FormSuggestionService`，节点分类从堆栈视图抽出，加字段级筛选和关联合并；用 `tests/samples/workflows` 里的工作流写快照式单测（`tsx --test`，与 `tests/agent` 同风格）。
- 验收：`npm run test:agent-ui` 通过；堆栈视图和图视图运行一次 Wan 2.2 无回归。

### 阶段 1：表单视图只读 + 运行（3 到 4 天）

- 新建 `src/components/form/WorkflowFormView.tsx` 及字段控件适配层，含关联字段的显示、写入和不一致提示。
- `WorkflowEditor` 头部加分段切换；默认视图规则按 4.4。
- 自动推荐落地；运行、中断、进度、最近输出。
- 四语文案。
- 验收：Wan 2.2 I2V 工作流打开即表单；改主提示词和 seed 后运行成功，输出出现在表单页；`steps` 关联字段改一次，两个采样器都变；切到结构视图能看到同样的改动；草稿画布打开同一工作流表单可用。

### 阶段 2：表单编辑与持久化（约 3 天）

- 编辑模式：增删改、上下移、分区、关联管理、重新推荐。
- `NodeDetailModal` 图钉。
- 写回 `extra.comfy_mobile_form`；验证三条路径都不丢：A 设备编辑 → B 设备打开；桌面版 ComfyUI 打开并保存 → 手机再打开；Agent 草稿保存到库 → 再打开。
- 失效字段检测与修复入口。
- 验收：删掉一个已钉住的节点后，表单页不报错、编辑模式能看到失效提示；三条持久化路径通过。

### 阶段 3：增强

- 子图 `proxyWidgets` 作为推荐来源。
- 结构视图语义缩放 + 分组导航条 + 半屏节点面板（方案二）。
- 把 `control_after_generate` 也迁到 `extra`，解决桌面往返丢失。

### 阶段 4：可选

- Gateway Agent 工具 `set_form_spec`，让对话直接生成或调整表单。
- 工作流列表卡片上的"快速运行"（不进编辑器，弹表单底部抽屉）。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| `WorkflowEditor` 过大，改动容易牵连画布逻辑 | 阶段 0 先抽 hook，表单视图作为独立组件只通过 props 接图、widget editor 和 runner |
| 离线或 `objectInfo` 缺失时 widget 名解析失败（`handleNoServerMetadata` 路径下 widget 名可能是回退名） | 这种状态下默认落到结构视图并提示连接服务器，不显示半残的表单 |
| 自定义节点的动态 widget（`CustomDynamicWidget`） | `control: 'auto'` 时交给现有 registry，不自行猜控件 |
| 关联字段掩盖了用户在画布上有意做的差异 | 不一致时明确提示，从不静默覆盖；执行前的统一只对关联字段生效 |
| 子图内 `nodeId` 不唯一 | 首期只支持根图；`MobileFormTarget` 预留可选 `subgraphId` |
| 云同步冲突把表单定义覆盖 | 表单定义与工作流同属一个文件，沿用现有冲突副本机制，不另加合并逻辑 |
| Agent 草稿路径是否透传 `extra` 尚未在代码里确认 | 阶段 0 补一条单测：草稿编解码后 `extra.comfy_mobile_form` 仍在 |

## 10. 验证方式

- 单测：spec 读写 / 版本容错 / 失效检测 / 关联合法性；推荐服务对样例工作流的输出快照；草稿编解码保留 `extra`。
- 浏览器：`npm run dev` + `.claude/launch.json` 连本地 ComfyUI，用 Wan 2.2 工作流走完 4.1 到 4.3。
- 桌面往返：手机保存 → 桌面 ComfyUI 打开、挪一个节点、保存 → 手机刷新，表单定义仍在。
- Android：沿用 `tests/e2e/*-android-scenario.mjs` 的写法补一条"打开工作流 → 表单可见 → 运行"脚本。

## 11. 自查改动记录（第一稿 → 第二稿）

| 项 | 第一稿 | 第二稿 | 原因 |
|---|---|---|---|
| 存放位置 | `mobile_ui_metadata.form` | `extra.comfy_mobile_form` | 根级自定义键在桌面版 ComfyUI 保存时会丢，`extra` 不会；云同步已有先例 |
| 执行 hook 来源 | 从堆栈视图抽 | 从 `WorkflowEditor` 抽 | 堆栈视图缺草稿分支、v2 桥接分支，是简化副本 |
| widget editor | 泛指 | 明确绑定 `sessionStack[0]` | 修改值按子图会话分层，表单必须操作根图 |
| 默认视图 | 记住上次视图 | 总是表单，两种例外 | 按你的决定；离线状态另加例外 |
| 自动推荐 | 复用节点级启发式 | 节点级分类 + 字段级白名单 | 表单需要的是字段筛选，堆栈视图没有这一层 |
| 关联字段 | 阶段 3 | 首期，补了读写、不一致、执行前统一、合法性、自动合并的规则 | 按你的决定 |
| 字段 id | `${nodeId}:${widget}` | 独立随机 id + `target` / `linked` | 关联字段有多个目标 |
| 图钉入口 | 二选一 | 现有全屏 `NodeDetailModal` | 按你的决定 |
| 工时 | 阶段 1 两三天 | 阶段 1 三四天 | 加了关联字段和字段级推荐 |
| 持久化验收 | 只验云同步 | 云同步、桌面往返、草稿入库三条 | 存放位置改动的直接后果 |
