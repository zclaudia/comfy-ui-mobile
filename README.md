[English](README.md) | [한국어](README_KOR.md) | [日本語](README_JP.md) | [简体中文](README_ZH.md)
<div align="center">

# Comfy Mobile UI

https://github.com/user-attachments/assets/20480b56-5c01-4c27-9401-0d4ba455dd81

**Tauri 2 Android client and mobile-first web UI for ComfyUI**

[Key Features](#features) | [Installation Guide](#installation) | [Contributing](#contributing) | [Show Your Support](#support)

---

<p align="left">
  <img src="https://img.shields.io/badge/Platform-Android_%7C_Web-success?style=flat-square&logo=android" alt="Platform">
  <img src="https://img.shields.io/badge/App-Tauri_2-24C8DB?style=flat-square&logo=tauri" alt="Tauri 2">
  <img src="https://img.shields.io/badge/Backend-ComfyUI-blueviolet?style=flat-square" alt="ComfyUI">
  <img src="https://img.shields.io/github/license/zclaudia/comfy-ui-mobile?style=flat-square" alt="License">
</p>
</div>

## 📖 Introduction

**Comfy Mobile UI** is a Tauri 2 Android client and mobile-first web interface for working with node-based ComfyUI workflows on smaller screens.

This is not just a simple viewer. Modify complex workflows on the go, add new nodes, manage models, and monitor execution status in real-time. Experience a desktop-like environment on your mobile device with a touch-optimized UX.

This repository continues the work of [jaeone94/comfy-mobile-ui](https://github.com/jaeone94/comfy-mobile-ui); current clone, issue, and release links belong to [zclaudia/comfy-ui-mobile](https://github.com/zclaudia/comfy-ui-mobile).

---

## <a name="features"></a>✨ Key Features

### 1. Multi-Mode Support
Provides both a powerful **Graph View** for freeform workflow editing and a **Stack View** for intuitivel modifying widget values by grouping nodes by type.

<div align="center">
  <img src="./public/showcases/graph_view.png" width="45%" alt="Graph View" />
  <img src="./public/showcases/stack_view.png" width="45%" alt="Stack View" />
</div>

### 2. Touch-First UX
Perfectly reimagines complex desktop editing experiences for mobile gestures. Control intricate node graphs with ease using just your fingers.
- **Radial Menu:** Quickly access node addition, removal, color change, and execution mode (Always, Mute, Bypass) with a single long-press.
- **Advanced Widget Editor:** Comfortably edit node widgets in a dedicated large modal. Easily import images and videos from your device's album or the generated gallery.
- **Precision Linking:** Precisely configure connection lines between nodes using an intuitive drag-and-drop interface specifically designed for smaller screens.

<div align="center">
  <img src="./public/showcases/long_press_circular_control.png" width="30%" alt="Longpress Circular Control" />
  <img src="./public/showcases/edit_widget.png" width="30%" alt="Node Widget Editor" />
  <img src="./public/showcases/connect_link.png" width="30%" alt="Node Connection" />
</div>

### 3. Execution & Monitoring
Provides powerful tools to track execution status in real-time and manage the queue.
- **Live Progress:** Visually monitor the current executing node and overall progress in real-time.
- **Server Console:** Monitor server execution logs in real-time to check the overall system status.

<div align="center">
  <img src="./public/showcases/console.png" width="45%" alt="Workflow Execution Console" />
  <img src="./public/showcases/progress.png" width="45%" alt="Workflow Execution Progress" />
</div>

### 4. Easy Resource Downloader
Install required models directly via URL without needing to access the server manually.
- **Remote Download:** Directly download Checkpoints, LoRAs, etc., to the server using model links from Hugging Face, Civitai, and more.
- **Target Folder Selection:** Directly specify the target folder for downloads to systematically manage resources by model type.

<div align="center">
  <img src="./public/showcases/download_model.png" width="45%" alt="Model Download Manager" />
  <img src="./public/showcases/model_management.png" width="45%" alt="Model Management" />
</div>

### 5. Unified Media Library
Instantly view and manage generated images and videos (MP4) within the app without needing a separate gallery.
- **In-App Gallery:** Offers smooth playback and viewing for everything from high-fidelity outputs to video previews.
- **Seamless Export:** Check outputs instantly and save them to local storage or share them externally.
<div align="center">
  <img src="./public/showcases/album.png" width="45%" alt="Output Gallery" />
  <img src="./public/showcases/album2.png" width="45%" alt="Video Player" />
</div>

### 6. Advanced Utilities
Provides smart tools to make workflow editing and management even more efficient.
- **Workflow Snapshots:** Save the current state of your workflow as a snapshot and restore it at any time. Ideal for fearless experimentation with parameters.
- **Embedded Group Control:** Built-in Fast Group Muter/Bypasser (from rgthree) to bulk control execution modes (`Always`, `Mute`, `Bypass`) of all nodes within a group.
- **Trigger Word Manager:** Save and manage trigger words for each LoRA in the Model Browser. Quickly lookup and copy keywords while editing workflows.
- **Advanced Video Downloader:** Use [yt-dlp](https://github.com/yt-dlp/yt-dlp) to download videos from various platforms directly to the server's `input` folder.
- **Workflow Chain (Experimental):** Link multiple independent workflows together. Automatically transfer output from one workflow to the input of the next for complex, sequential automation.

---

## Architecture and capabilities

```text
Tauri 2 Android app / Web UI
             │
             ▼
Comfy Mobile Gateway :8080  (authentication, HTTP/WS proxy, static UI)
             │
             ▼
       ComfyUI :8188
```

The client only connects to the Gateway. ComfyUI `:8188` and the optional legacy launcher `:9188` stay on the private network and should not be exposed to mobile clients.

| Capability | Provider | Required? |
| --- | --- | --- |
| Prompt execution, queue, history, upload, output media | Native ComfyUI API through the Gateway | Yes |
| Authentication, device revocation, HTTP/WebSocket proxy | Comfy Mobile Gateway | Yes |
| Model/file management, downloads, snapshots, workflow chains and launcher features | `comfy-mobile-ui-api-extension` | Optional |

See the [Gateway architecture](./docs/gateway_architecture_zh.md), [Android plan](./docs/tauri_android_plan_zh.md), and [connection guide](./docs/connection_guide.md) for details.

---

## <a name="installation"></a>🛠️ Installation & Setup

### **1. Gateway deployment (recommended)**

Requirements: Node.js 20.19+ (or 22.12+) and a reachable ComfyUI instance. The example configuration already points to `http://192.168.2.150:8188`.

```bash
git clone https://github.com/zclaudia/comfy-ui-mobile.git
cd comfy-ui-mobile
npm install
cp gateway/.env.example gateway/.env
```

Generate independent secrets and put them in `gateway/.env`:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Set the first value as `GATEWAY_AUTH_TOKEN`, the second as `GATEWAY_SESSION_SECRET`, verify `COMFYUI_URL`, then start either:

```bash
# Production-style deployment; builds the UI and persists the device registry.
docker compose -f docker-compose.gateway.yml up --build -d

# Or local development (run these in separate terminals).
node --env-file=gateway/.env gateway/index.js
npm run dev
```

The production Gateway listens on `http://gateway-host:8080`. Android should be configured with this Gateway address, never the ComfyUI `:8188` address. Use HTTPS in any untrusted network.

### **2. Optional ComfyUI extension**

The Python extension is part of this repository, but it is not the Gateway and is not required for native ComfyUI operations. Install it only when the advanced features in the capability table are needed:

```bash
cp -r comfy-mobile-ui-api-extension /path/to/ComfyUI/custom_nodes/
```

Restart ComfyUI after copying it. Do not expose the extension's legacy `:9188` launcher; if it is needed during migration, set `COMFYUI_LAUNCHER_URL` so only the Gateway can reach it.

### **3. Android development**

Install Android Studio, SDK Platform 36, Build-Tools, Command-line Tools, NDK (Side by side), Java, and the Rust Android targets. Then run:

```bash
npm run tauri:android:init
npm run tauri:android:dev
```

Use `npm run tauri:android:build` for a release build. The current app requires Android 7.0/API 24 or newer. See the [Tauri 2 Android plan](./docs/tauri_android_plan_zh.md) for environment variables and current validation status.

### **4. Web development**

```bash
npm install
# Terminal 1
node --env-file=gateway/.env gateway/index.js
# Terminal 2
npm run dev
```

Vite serves the UI at `http://localhost:5173` and proxies API traffic to the Gateway. Useful checks:

```bash
npm run build
npm run test:gateway
npm run lint
```

---

## <a name="contributing"></a>🤝 Contributing

**Contributions are always welcome!**

### **Code Quality Notice**
Much of this app was developed using "vibe coding," so code quality may vary. We appreciate your understanding and welcome improvements!

### **How to Contribute**
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## <a name="support"></a>⭐ Show Your Support

⭐ **If you find this app useful, please consider giving it a star!** ⭐

Your support helps the project grow and motivates continued development.

---
