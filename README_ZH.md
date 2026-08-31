[English](README.md) | [한국어](README_KOR.md) | [日本語](README_JP.md) | [简体中文](README_ZH.md)
<div align="center">

# Comfy Mobile UI

https://github.com/user-attachments/assets/20480b56-5c01-4c27-9401-0d4ba455dd81

**基于 Tauri 2 的 ComfyUI Android 客户端与移动优先 Web 界面**

[核心功能](#features) | [安装指南](#installation) | [参与贡献](#contributing) | [给予支持](#support)

---

<p align="left">
  <img src="https://img.shields.io/badge/Platform-Android_%7C_Web-success?style=flat-square&logo=android" alt="Platform">
  <img src="https://img.shields.io/badge/App-Tauri_2-24C8DB?style=flat-square&logo=tauri" alt="Tauri 2">
  <img src="https://img.shields.io/badge/Backend-ComfyUI-blueviolet?style=flat-square" alt="ComfyUI">
  <img src="https://img.shields.io/github/license/zclaudia/comfy-ui-mobile?style=flat-square" alt="License">
</p>
</div>

---

## 📖 简介

**Comfy Mobile UI** 是一款基于 Tauri 2 的 Android 客户端与移动优先 Web 界面，让原本为 PC 环境优化的节点式 AI 工作流也能在移动设备上流畅运行。

它不仅仅是一个简单的查看器。你可以在旅途中修改复杂的工作流、添加新节点、管理模型，并实时监控执行状态。通过专为触屏优化的 UX，在掌中重现桌面级的体验。

本仓库基于 [jaeone94/comfy-mobile-ui](https://github.com/jaeone94/comfy-mobile-ui) 继续演进；当前克隆、Issue 和 Release 地址以 [zclaudia/comfy-ui-mobile](https://github.com/zclaudia/comfy-ui-mobile) 为准。

---

## <a name="features"></a>✨ 核心功能

### 1. 多模式支持 (Multi-Mode Support)
同时提供可自由编辑工作流的强大 **Graph View**，以及按类型对节点进行分组、直观修改参数（Widget）的 **Stack View**。

<div align="center">
  <img src="./public/showcases/graph_view.png" width="45%" alt="Graph View" />
  <img src="./public/showcases/stack_view.png" width="45%" alt="Stack View" />
</div>

### 2. 触屏优先 UX (Touch-First UX)
为移动端手势完美重构了复杂的桌面编辑体验。
- **径向菜单 (Radial Menu):** 通过长按即可快速调用添加/删除节点、更改颜色及切换执行模式（Always, Mute, Bypass）等功能。
- **高级参数编辑器 (Advanced Widget Editor):** 在专用的大型模态框中舒适地编辑节点参数。支持从设备相册或生成画廊中轻松导入图像和视频。
- **精准链接:** 专为小屏幕设计的拖拽界面，让你能够精确地配置节点间的连线。

<div align="center">
  <img src="./public/showcases/long_press_circular_control.png" width="30%" alt="Longpress Circular Control" />
  <img src="./public/showcases/edit_widget.png" width="30%" alt="Node Widget Editor" />
  <img src="./public/showcases/connect_link.png" width="30%" alt="Node Connection" />
</div>

### 3. 执行与监控 (Execution & Monitoring)
提供实时追踪执行状态和管理队列的强大工具。
- **实时进度:** 视觉化监控当前运行的节点和整体执行进度。
- **服务器控制台:** 实时查看服务器执行日志，掌握系统运行状态。

<div align="center">
  <img src="./public/showcases/console.png" width="45%" alt="Workflow Execution Console" />
  <img src="./public/showcases/progress.png" width="45%" alt="Workflow Execution Progress" />
</div>

### 4. 便捷资源下载器 (Resource Downloader)
无需手动访问服务器，仅凭 URL 即可直接安装所需模型。
- **远程下载:** 支持通过 Hugging Face、Civitai 等链接将模型直接下载至服务器。
- **目录选择:** 可自定义下载存放的文件夹，按模型类型进行系统化管理。

<div align="center">
  <img src="./public/showcases/download_model.png" width="45%" alt="Model Download Manager" />
  <img src="./public/showcases/model_management.png" width="45%" alt="Model Management" />
</div>

### 5. 统一媒体库 (Unified Media Library)
在应用内即时查看和管理生成的图像及视频 (MP4)，无需切换至相册。
- **内置画廊:** 提供从高清大图到视频预览的流畅播放和查看体验。
- **无缝导出:** 即时检查输出结果，并保存至本地存储或分享至外部。

<div align="center">
  <img src="./public/showcases/album.png" width="45%" alt="Output Gallery" />
  <img src="./public/showcases/album2.png" width="45%" alt="Video Player" />
</div>

### 6. 高级实用工具 (Advanced Utilities)
提供一系列智能工具，让工作流的编辑与管理更高效。
- **工作流快照 (Snapshots):** 保存当前工作流状态并随时恢复，无惧参数实验。
- **集成组控制 (Group Control):** 内置 Fast Group Muter/Bypasser 映射功能，可批量控制组内节点的执行模式。
- **触发词管理:** 为每个 LoRA 预设触发词，编辑工作流时可快速查阅并复制。
- **视频下载增强:** 利用 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 将各平台视频直接下载至服务器 `input` 文件夹。
- **工作流链 (Experimental):** 将多个独立工作流串联，实现复杂的自动化顺序执行。

---

## 架构与能力边界

```text
Tauri 2 Android App / Web UI
              │
              ▼
Comfy Mobile Gateway :8080（认证、HTTP/WS 反代、前端托管）
              │
              ▼
        ComfyUI :8188
```

客户端只连接 Gateway。ComfyUI 的 `8188` 和可选的旧 Launcher `9188` 保持在私有网络内，不直接暴露给手机。

| 能力 | 提供方 | 是否必需 |
| --- | --- | --- |
| 生成、队列、历史、上传、查看输出 | Gateway 转发的 ComfyUI 原生 API | 是 |
| 认证、设备撤销、HTTP/WebSocket 反代 | Comfy Mobile Gateway | 是 |
| 模型/文件管理、远程下载、快照、工作流链和 Launcher 能力 | `comfy-mobile-ui-api-extension` | 可选 |

更详细的设计见 [Gateway 架构](./docs/gateway_architecture_zh.md)、[Tauri 2 Android 计划](./docs/tauri_android_plan_zh.md)和[连接指南](./docs/connection_guide_zh.md)。

---

## <a name="installation"></a>🛠️ 安装与设置

### **1. 部署 Gateway（推荐）**

需要 Node.js 20.19+（或 22.12+），并确保 Gateway 所在主机可以访问 ComfyUI。示例配置已使用你的 ComfyUI 地址 `http://192.168.2.150:8188`。

```bash
git clone https://github.com/zclaudia/comfy-ui-mobile.git
cd comfy-ui-mobile
npm install
cp gateway/.env.example gateway/.env
```

生成两个相互独立的随机值：

```bash
openssl rand -hex 32
openssl rand -hex 32
```

在 `gateway/.env` 中分别设置 `GATEWAY_AUTH_TOKEN` 和 `GATEWAY_SESSION_SECRET`，确认 `COMFYUI_URL` 后选择一种启动方式：

```bash
# 类生产部署：构建前端并持久化设备注册表
docker compose -f docker-compose.gateway.yml up --build -d

# 或本地开发：在两个终端中分别执行
node --env-file=gateway/.env gateway/index.js
npm run dev
```

生产 Gateway 默认地址为 `http://Gateway主机:8080`。Android 设置页应填写这个地址，不能填写 ComfyUI 的 `:8188`。离开可信局域网时必须在 Gateway 前配置 HTTPS。

### **2. 可选的 ComfyUI Python 扩展**

Python 扩展属于本仓库的一部分，但它不是 Gateway，也不是使用 ComfyUI 原生能力的前置条件。只有需要上表中的高级能力时才安装：

```bash
cp -r comfy-mobile-ui-api-extension /path/to/ComfyUI/custom_nodes/
```

复制后重启 ComfyUI。不要公开旧 Launcher 的 `9188`；迁移期确实需要它时，通过 `COMFYUI_LAUNCHER_URL` 仅供 Gateway 内部访问。

### **3. Android 开发**

安装 Android Studio、SDK Platform 36、Build-Tools、Command-line Tools、NDK (Side by side)、Java 和 Rust Android targets，然后执行：

```bash
npm run tauri:android:init
npm run tauri:android:dev
```

发布构建使用 `npm run tauri:android:build`。当前最低系统版本为 Android 7.0/API 24。环境变量与当前验证状态见 [Tauri 2 Android 实施计划](./docs/tauri_android_plan_zh.md)。

### **4. Web 开发**

```bash
npm install
# 终端 1
node --env-file=gateway/.env gateway/index.js
# 终端 2
npm run dev
```

Vite 在 `http://localhost:5173` 提供界面，并将 API 请求转发到 Gateway。常用检查命令：

```bash
npm run build
npm run test:gateway
npm run lint
```

---

## <a name="contributing"></a>🤝 参与贡献

**非常欢迎您的贡献！**

### **关于代码质量**
本应用的大部分代码是通过“氛围感编程 (Vibe Coding)”开发的，因此代码质量可能参差不齐。感谢您的理解，并欢迎任何改进意见！

---

## <a name="support"></a>⭐ 给予支持

⭐ **如果你觉得这个应用好用，请考虑给它点个 Star！** ⭐

你的支持是项目成长和持续开发的巨大动力。

---
