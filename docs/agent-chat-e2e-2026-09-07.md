# Agent Chat 端到端复测（2026-09-07）

测试提交：`d736b119393c93f58eeebb3c4dd754788d89eb0e`。本轮只修改测试和报告，未部署或修改生产服务。

## 环境与结果

- Web 构建、最新 arm64 Android 调试 APK 构建通过。
- Agent/工作流/HTTP 回归 47/47、Agent UI 逻辑 16/16、transcript/i18n 8/8、Gateway 4/4，共 75/75。
- 生产公网 Gateway 基础 E2E 7/7（Node 统计包含父测试），覆盖登录、HTTP/WS、上传、图片执行和 MP4。
- 最新 Gateway 的真实 Agent API 连续两轮均为 13/14 场景通过；Node 统计 13 通过、2 失败，其中一个失败是父测试汇总。失败项为新增的图片主色识别断言。
- Android 最终 21/22 通过；唯一失败是聊天顶部菜单中心触摸断言。通过键盘打开菜单继续验证后，19 项 Agent 子检查完成，包括多轮对话、恢复 v1 为 v4、取消后继续、会话切换、8 个附件上限、图片粘贴/纯附件消息/认证回显/刷新恢复，以及 MP4+WAV 混合附件。最终会话实际生成 1 次，所有附件任务预览次数为 0。
- Android 使用 `emulator-5554`，已验证 QEMU；未操作实体设备。

生产服务的 `gateway/agent/service.ts` 和 `routes.ts` 与当前提交的 SHA-256 不同，因此新 Agent 代码使用独立本地 Gateway、独立 SQLite/设备凭据存储，通过 SSH 隧道连接 ai-server 的真实 ComfyUI，并调用本地配置的真实 MiniMax-M3。Android 通过 ADB reverse 访问该 Gateway。公网基础回归使用服务器现有凭据，不能用它证明新 Agent 已部署。

## 未通过的问题

### 图片视觉描述不可靠

上传纯色 PNG `#945dbf`，让模型只描述主色和 LoadImage 文件路径。两轮 Agent 调用均完成且文件路径正确，但主色识别错误，首轮答为“浅粉（近乎纯白）”。纯附件消息、附件持久化、请求幂等、附件变化冲突、非法路径/output 类型/超过 8 个附件的拒绝断言已在第二轮执行通过。

直接绕过 Agent 编排，使用相同 SDK、模型与图片继续诊断：64×64 图片先后被识别为深蓝、绿色；512×512 图片一次识别正确，另一次被识别为浅绿色。上传后原始像素仍是 RGB `[148,93,191]`，SDK 最终 HTTP 请求中图片字节的 SHA-256 与输入完全一致。没有证据表明上传链路改变了图片；问题位于实际模型/提供方视觉处理链路，具体根因未定。不能把放大图片视为已验证的修复。

证据：`tests/output/chat-retest/comfy-vision-{diagnostic,repeat}.log`、`vision-64.png`、`vision-512.png`，以及 API 报告：

- `tests/output/agent-cases/60b1d475-8758-4fa0-9fc7-467d0e5ddabe/report.json`
- `tests/output/agent-cases/13f55eea-8575-4dde-a142-0c40111de775/report.json`

### Android 聊天页顶部菜单触摸失败

聊天页顶部与系统状态栏重叠。“更多”菜单通过 DOM `.click()` 和真实 ADB 点击均未打开，导致版本历史场景中断。系统报告状态栏覆盖屏幕纵向 0–136 px；菜单中心为 `(1003,74)`，下缘测试点为 `(1003,113)`，两处真实触摸都失败。截图中标题、菜单与系统状态图标重叠。原生 Activity 开启 edge-to-edge，页面依赖 CSS `env(safe-area-inset-top)`，实际 header padding 为 `0px`；测试保留中心触摸失败断言。

为继续验证其他功能，测试会尝试按钮下缘，必要时使用键盘 Enter 激活菜单；这些后续检查不代表中心触摸问题已解决。

证据：`tests/output/chat-retest/second-run/failure.png`、`android-insets.txt`。

最终 Android 报告和附件截图：`tests/output/chat-retest/android-report.json`、`attachments.png`。原始最终日志：`comfy-agent-android-fourth.log`。

## 测试调整与边界

- 扩展真实 API 测试：图片消息、纯附件消息、附件持久化、图片路径传给模型、内容幂等、非法附件校验、真实视觉描述。
- 扩展 Android 测试：最多 8 个附件、移除、粘贴图片、纯附件发送、已发送图片认证读取与刷新恢复、真实 MP4 与 WAV 附件。
- Android 附件通过 WebView `File`/`DataTransfer` 触发真实输入框处理器与网络上传；没有验证 Android 系统相册/文件选择器本身。
- 已发送图片在 Android 使用 IntersectionObserver 懒加载；测试已补上滚动到图片再检查解码，避免把屏幕外尚未加载的图片误判为上传失败。
- 首轮隔离 Gateway 使用 HTTP/Lax cookie，造成两项 WebView cookie 测试失败；改为 Secure/SameSite=None 后，loopback 环境两项均通过。这是测试环境修正，不是应用代码修复。
- 公网首次运行误用了本地开发凭据而返回 401；改用服务器凭据后 7/7，通过结果和原始失败均保留。
- 未做完整 Z-Image/H3 文生图、视频模型质量验收、生产负载或长期断网测试。
- 收尾确认独立 Gateway 的活动任务和活动测试设备数均为 0；调试 App 数据已清理。最终调试 APK 恢复为生产 Gateway 默认地址，避免留下依赖临时服务的安装包。

本地证据目录：`tests/output/chat-retest/`（被 Git 忽略，含日志、截图与独立测试数据库；不应公开上传数据库或设备存储）。
