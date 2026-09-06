# 端到端测试计划

本计划验证真实生产链路，而不是 mock：Android 虚拟机 → `https://comfy.zhvala.space:28443` → router 上的 Caddy → `ai-server:18080` Gateway → `ai-server:8188` ComfyUI。测试只允许使用 Android 虚拟机，不依赖或操作实体手机。

## 放行范围与原则

- Android 目标必须同时满足 ADB serial 以 `emulator-` 开头、`ro.kernel.qemu=1`；当前固定为 `emulator-5554`。
- 所有 ADB 命令必须显式带 `-s emulator-5554`。
- Gateway setup token 只通过环境变量注入，不写进 APK、日志、localStorage 或 sessionStorage。
- 测试开始时记录已有 Gateway device ID；测试仅吊销本轮新建的 ID，禁止批量吊销已有手机。
- App 数据清理只针对调试包 `app.comfymobile.client.debug`。
- 图片、视频和工作流使用 `ComfyMobileE2E` 命名空间，避免与用户资源混淆。
- 生产 Gateway 禁用了危险删除接口，所以服务器输出保留作审计；虚拟机下载文件在校验后精确删除。

## 自动化用例矩阵

### Gateway / 公网边界

| ID | 用例 | 关键断言 | 自动化 |
|---|---|---|---|
| EDGE-01 | 公网健康检查 | `/api/gateway/health` 返回 200 | `live-gateway.test.mjs` |
| EDGE-02 | 版本资源 | `version.json` 类型与 semver 正确 | 同上 |
| AUTH-01 | 未认证访问 | ComfyUI API 返回 401 | 同上、Android |
| AUTH-02 | 浏览器登录/登出 | HttpOnly、`SameSite=None`、Secure cookie；登出清除 | 同上 |
| API-01 | 核心 API | system stats、object info、扩展 status 可用 | 同上 |
| SEC-01 | 路由白名单 | 未知内部路由 404 | 同上 |
| SEC-02 | 高危操作 | reboot 等接口保持 403 | 同上 |
| MEDIA-01 | 图片上传/读取 | 上传成功，读取为非空图片 | 同上 |
| EXEC-01 | 图片工作流 | prompt → WS 完成 → history → 图片读取 | 同上 |
| EXEC-02 | 视频工作流 | 生成 MP4；MIME、Range、`ftyp` 均正确 | 同上 |

### Android 虚拟机

| ID | 用例 | 关键断言 |
|---|---|---|
| AND-01 | 设备隔离 | serial 与 QEMU 双重校验，调试包已安装 |
| AND-02 | 冷启动 | Tauri WebView 启动于 `http://tauri.localhost` |
| AND-03 | 错误令牌 | UI 显示失败且不能变成 Connected |
| AND-04 | 正确注册 | 新建设备凭据并显示 Connected |
| AND-05 | 秘钥防泄漏 | setup/device token 不出现在 WebView storage，输入框被清空 |
| AND-06 | 设备隔离清理 | 只识别本轮新增 device ID，不修改基线设备 |
| AND-07 | 凭据吊销 | 只吊销测试设备，空令牌重连失败且有可见提示 |
| AND-08 | 重新注册 | 吊销后使用 setup token 可恢复连接 |
| AND-09 | Keystore 恢复 | force-stop 后无需重输 setup token 即可连接 |
| AND-10 | 原生 WebSocket | 冷启动恢复后设置页 WebSocket 状态为 success |
| AND-11 | 服务器工作流导入 | App 从真实扩展列表导入二节点工作流到 IndexedDB |
| AND-12 | App 发起执行 | 点击 Android UI 的 Execute，history 出现新的输出 |
| AND-13 | App 输出读取 | Android 发起的输出通过 Gateway 返回图片 MIME |
| AND-14 | 图片画廊 | 原生 Bearer 请求生成 Blob URL，图片 natural size 非零 |
| AND-15 | 视频画廊 | 真实 MP4 在 Android `<video>` 中读到 metadata/duration，无 media error |
| AND-16 | 原生下载 | DownloadManager 携带 Authorization，下载大小与服务器字节数一致 |
| AND-17 | WebView Cookie API | login、system stats、queue 均为 200，覆盖 CORS/CSRF 路径 |
| AND-18 | WebView Cookie WS | 公网 WSS 握手成功 |
| AND-19 | 测试资源收尾 | 只吊销本轮设备、清理调试包数据与本轮下载文件 |

## 执行方法

构建带生产 Gateway 默认地址的 arm64 调试 APK：

```sh
VITE_GATEWAY_URL='https://comfy.zhvala.space:28443' \
  npm run tauri:android:build -- --debug --target aarch64 --apk --ci
```

确认目标是虚拟机后安装：

```sh
test "$(adb -s emulator-5554 shell getprop ro.kernel.qemu | tr -d '\r')" = 1
adb -s emulator-5554 install -r \
  src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

执行 Android E2E（`E2E_GATEWAY_TOKEN` 由安全环境注入）：

```sh
EMULATOR_SERIAL=emulator-5554 \
E2E_GATEWAY_URL='https://comfy.zhvala.space:28443' \
E2E_GATEWAY_TOKEN='<gateway setup token>' \
  npm run test:e2e:android
```

Gateway 单元与公网 live E2E：

```sh
npm run build
npm run test:gateway

LIVE_GATEWAY_URL='https://comfy.zhvala.space:28443' \
LIVE_EXPECT_COOKIE_SAMESITE='None' \
GATEWAY_AUTH_TOKEN='<gateway setup token>' \
  node --test tests/e2e/live-gateway.test.mjs
```

## 通过标准

- Web 构建、Gateway 单元测试、公网 live E2E、Android E2E 全部退出码为 0。
- App 必须通过公网域名完成注册、HTTP、WSS、工作流导入与执行、图片/视频预览及下载。
- 视频必须在 Android WebView 中成功解析时长，下载后的字节数必须与服务器一致。
- 任何测试都不得访问物理 ADB 设备，不得吊销已有手机凭据，不得把 setup/device token 落盘到 WebView storage。

## 2026-09-04 实测结果

- `npm run build`：通过。
- `npm run test:gateway`：3/3 通过。
- 公网 live Gateway：7/7 通过，包含真实图片与 MP4 生成。
- Android `emulator-5554`：20/20 通过，包含从服务器导入工作流并由 App UI 发起执行。
- 最新调试 APK 已安装到 `emulator-5554`；测试结束后已清除其测试注册与 App 数据。

涉及停止生产 Gateway、断开 router 或修改 Caddy 的灾备测试不纳入自动放行集，因为它们会影响正在使用的真实设备；应在维护窗口单独演练。

## Agent 真实模型 Android 用例

在现有 Android 测试命令上增加 `E2E_AGENT_LIVE=1`，可运行
`tests/e2e/agent-android-scenario.mjs`。此开关会使用 Gateway 已配置的真实
LLM，产生模型调用费用，并运行一次 ComfyUI 图片复制工作流。

用例从 Android UI 导入测试工作流为助手副本，发送自然语言指令修改输入图片和
输出路径，验证结果图片加载、版本保存、单次实际执行、设备会话隔离、App 冷启动
恢复以及在编辑器打开副本。上传图片为程序生成的 64×64 色块，服务器资源保留于
测试命名空间；设备凭据由原有测试收尾逻辑精确吊销。

截图、对话和结构化报告位于忽略提交的 `tests/output/agent-android/`。
该用例覆盖助手编排链路，不代表已验证 checkpoint 文生图的生成质量。

## 2026-09-05 Agent 部署实测

- Gateway 已在 ai-server 的 `/home/zhvala/services/comfy-mobile-gateway` 重建并启动，容器健康；服务器 `gateway/.env` 校验保持原样。
- 配置状态确认 Agent 已启用，providerReady=true，模型 MiniMax-M3；SQLite 使用命名卷 `/data/agent.sqlite`。
- Agent/工作流测试 19/19、Gateway 单元测试 4/4、公网 live 测试 7/7 通过。
- 新 arm64 调试 APK 安装到 `emulator-5554`；开启真实 Agent 用例后 Android 21/21 通过。
- MiniMax 修改二节点图片复制工作流并保存 v2，ComfyUI 实际执行一次；图片加载、设备会话隔离、App 冷启动恢复及编辑器打开副本全部通过。
- 测试仅操作虚拟机，收尾吊销本轮新增设备注册并清空调试包数据。真实 checkpoint 文生图未在本轮验证。
- 本地证据：`tests/output/deploy-agent/{live,android}.log` 和 `tests/output/agent-android/{report.json,result.png,conversation.txt}`。
- 部署前镜像保留为 `comfy-mobile-gateway-rollback:pre-agent`。

完整的 Agent 应用场景、故障层次及最新实测结果见 [Agent E2E 用例](agent-e2e-cases.md)。
