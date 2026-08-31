# Tauri 2 Android 客户端实施计划

## 目标架构

```text
React / TypeScript UI
        │
        ├─ Web：浏览器 fetch / WebSocket
        │
        └─ Android：Tauri HTTP / WebSocket（Rust）
                         │
                         ▼
                 Comfy Mobile Gateway
                         │
                         ▼
                      ComfyUI
```

Android 客户端只允许访问 Gateway。Rust/Tauri 层不保存 ComfyUI 凭据，也不绕过
Gateway 直接连接 `8188`。

## 阶段 1：可运行基础框架（本次完成）

- 增加 `src-tauri/`、Tauri 2 配置、Android/桌面 capability 和构建脚本。
- 保留现有 React 19、TypeScript、Vite、Tailwind 和 Zustand。
- Android HTTP 请求切换到 Tauri Rust HTTP Client；Web 继续使用浏览器网络栈。
- 三个 WebSocket 服务统一经过平台适配器。Android 可以在 Upgrade 请求中携带
  Gateway Bearer Token。
- Gateway Token 仅保存在当前 Android 进程内存中，不进入 `localStorage`、构建产物
  或普通配置文件。
- HTTP capability 默认允许 HTTPS，以及 localhost 和常见私有 IPv4 网段；不允许任意
  公网 HTTP。

## 阶段 2：完成 Mobile 认证与媒体通道

- Gateway 增加设备注册/撤销接口，用一次性注册码换取可撤销的 Device Token。
- Device Token 使用 Android Keystore 封装的 Tauri Kotlin 插件保存；共享部署 Token
  不进入 APK。
- 为 `/view`、视频和下载资源实现授权媒体加载器，避免依赖 WebView Cookie 或裸直链。
- 将 Gateway capability 从通用 HTTPS 进一步收敛到用户确认的 Gateway Origin。

## 阶段 3：Android 原生能力

- 接入系统 Photo Picker、文件保存、分享、返回键、网络状态和生命周期事件。
- App 回到前台时重连 WebSocket，并通过 `/queue`、`/history` 恢复任务状态。
- 长时间生成任务留在 ComfyUI/Gateway；不依赖 WebView 在后台持续运行。
- 可选接入 FCM，由 Gateway 推送任务完成通知。

## 阶段 4：发布与质量

- Debug/Release 使用不同 application ID 和 Gateway 配置。
- 配置应用签名、AAB、版本号、CI 构建和依赖审计。
- 增加真实 Android 设备上的连接、上传、生成、断网恢复和大图内存测试。
- 正式包只允许 `https://` / `wss://`；局域网明文连接仅用于 Debug。

## 当前目录结构

```text
src-tauri/
├─ Cargo.toml
├─ tauri.conf.json
├─ tauri.android.conf.json
├─ capabilities/
└─ src/

src/platform/
├─ runtime.ts          # Web/Tauri 运行时识别与 Axios 初始化
├─ http.ts             # 平台 Fetch
├─ websocket.ts        # 浏览器/Tauri WebSocket 统一接口
└─ gatewaySession.ts   # Android 会话内 Gateway Bearer Token
```

## 本地准备

安装 Android Studio，并通过 SDK Manager 安装：

- Android SDK Platform
- Android SDK Platform-Tools
- Android SDK Build-Tools
- Android SDK Command-line Tools
- NDK (Side by side)

然后配置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`，并添加 Rust Android targets：

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm run tauri:android:init
```

连接实体设备或启动 Emulator 后：

```bash
npm run tauri:android:dev
```

生成发布构建：

```bash
npm run tauri:android:build
```

## 开发连接

Gateway 仍按 `docs/gateway_architecture_zh.md` 部署。Android 设置页填写 Gateway 地址，
例如：

```text
http://192.168.2.150:8080
```

然后输入 Gateway Token。阶段 1 的 Token 只在当前 App 会话有效，完全退出 App 后需要
重新输入。正式发布前必须完成阶段 2，不能把共享 Token 写入 `.env` 或 APK。
