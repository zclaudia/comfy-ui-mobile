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

## 阶段 1：可运行基础框架（已完成）

- 增加 `src-tauri/`、Tauri 2 配置、Android/桌面 capability 和构建脚本。
- 保留现有 React 19、TypeScript、Vite、Tailwind 和 Zustand。
- Android HTTP 请求切换到 Tauri Rust HTTP Client；Web 继续使用浏览器网络栈。
- 三个 WebSocket 服务统一经过平台适配器。Android 可以在 Upgrade 请求中携带
  Gateway Bearer Token。
- 部署 Token 仅用于首次设备注册，不进入 `localStorage`、构建产物或普通配置文件；
  注册完成后立即从输入框和运行内存清除。
- 注册得到的 Device Token 由 Android Keystore 支持的安全凭据插件持久化，并严格
  绑定注册时的 Gateway Origin。
- HTTP capability 默认允许 HTTPS，以及 localhost 和常见私有 IPv4 网段；不允许任意
  公网 HTTP。

## 阶段 2：Mobile 认证与媒体通道（已完成基础实现）

- Gateway 已增加设备注册、列表、自助注销和管理员撤销接口；注册后换取随机、可过期的
  Device Token，磁盘只保留 SHA-256 摘要。
- Device Token 使用仓库内的 Tauri Kotlin 插件保存。插件用 Android Keystore 管理
  AES-GCM 密钥，用应用私有 SharedPreferences 保存密文；共享部署 Token 不进入 APK。
- `/view`、视频、画廊缩略图和 Canvas 预览已改为授权请求 + 临时 Blob URL，避免依赖
  WebView Cookie 或把 Device Token 放进查询字符串。
- Device Token 在运行时严格绑定注册时的 Gateway Origin。Tauri HTTP capability 仍只允许
  HTTPS、localhost 和私有 IPv4 网段；若部署地址固定，可在发布配置中进一步收窄。

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
├─ capabilities/       # 桌面与移动权限边界
├─ plugins/
│  └─ secure-credentials/
│     ├─ android/      # Android Keystore + AES-GCM 实现
│     ├─ permissions/  # Tauri 插件权限
│     └─ src/          # Rust 插件桥接
└─ src/                # Tauri 应用入口

src/platform/
├─ runtime.ts          # Web/Tauri 运行时识别与 Axios 初始化
├─ http.ts             # 平台 Fetch
├─ websocket.ts        # 浏览器/Tauri WebSocket 统一接口
└─ gatewaySession.ts   # Device Token 安全存取与 Origin 绑定

src/components/media/
└─ AuthenticatedImage.tsx  # Android 授权媒体加载

src/hooks/
└─ useAuthenticatedMediaUrl.ts  # 授权请求与临时 Blob URL 生命周期
```

## 本地准备

安装 Android Studio，并通过 SDK Manager 安装：

- Android SDK Platform 36（当前插件 `compileSdk=36`）
- Android SDK Platform-Tools
- Android SDK Build-Tools
- Android SDK Command-line Tools
- NDK (Side by side)

当前最低运行版本是 Android 7.0/API 24。配置 Java 17、`JAVA_HOME`、
`ANDROID_HOME` 和 `NDK_HOME`，并添加 Rust Android targets：

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

然后输入 Gateway 部署 Token。注册成功后输入框会被清空，App 重启时从 Android
Keystore 恢复 Device Token，不需要重复输入。部署 Token 不能写入前端 `.env` 或 APK。

## 当前验证状态

- TypeScript/Vite 生产构建已通过。
- Gateway 的注册、Bearer HTTP/WebSocket、管理员撤销、自助注销和持久化测试已通过。
- 安全凭据插件的 Android Rust target 检查已通过。
- 完整主应用 Android 构建、Kotlin 编译以及 Keystore 重启恢复仍需在配置 SDK/NDK 的
  环境中通过实体设备验证。
