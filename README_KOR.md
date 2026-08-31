[English](README.md) | [한국어](README_KOR.md) | [日本語](README_JP.md) | [简体中文](README_ZH.md)
<div align="center">

# Comfy Mobile UI

https://github.com/user-attachments/assets/53ace07b-d060-4147-9ea4-cbc72a3bd059

**Tauri 2 기반 ComfyUI Android 클라이언트 및 모바일 우선 Web UI**

[Key Features](#features) | [설치 가이드](#installation) | [기여하기](#contributing) | [응원하기](#support)

---

<p align="left">
  <img src="https://img.shields.io/badge/Platform-Android_%7C_Web-success?style=flat-square&logo=android" alt="Platform">
  <img src="https://img.shields.io/badge/App-Tauri_2-24C8DB?style=flat-square&logo=tauri" alt="Tauri 2">
  <img src="https://img.shields.io/badge/Backend-ComfyUI-blueviolet?style=flat-square" alt="ComfyUI">
  <img src="https://img.shields.io/github/license/zclaudia/comfy-ui-mobile?style=flat-square" alt="License">
</p>
</div>

## 📖 Introduction

**Comfy Mobile UI**는 PC 환경에 최적화되었던 노드 기반 AI 워크플로우를 모바일에서도 다룰 수 있도록 설계된 Tauri 2 Android 클라이언트 겸 모바일 우선 Web UI입니다.

단순한 뷰어가 아닙니다. 이동 중에도 복잡한 워크플로우를 수정하고, 새로운 노드를 추가하고, 모델을 관리하고, 실행 상태를 실시간으로 모니터링하세요. 터치 환경에 최적화된 UX로 데스크톱의 경험을 손안에서 그대로 재현합니다.

이 저장소는 [jaeone94/comfy-mobile-ui](https://github.com/jaeone94/comfy-mobile-ui)를 기반으로 개발을 이어갑니다. 현재 Clone, Issue 및 Release는 [zclaudia/comfy-ui-mobile](https://github.com/zclaudia/comfy-ui-mobile)을 기준으로 합니다.

---

## <a name="features"></a>✨ Key Features

### 1. 멀티 모드 지원 (Multi-Mode Support)
ComfyUI 워크플로우를 자유롭게 편집할 수 있는 강력한 **Graph View**와, 노드들을 유형별로 그룹화하여 위젯 값을 직관적으로 수정할 수 있는 **Stack View**를 동시에 제공합니다.

<div align="center">
  <img src="./public/showcases/graph_view.png" width="45%" alt="Graph View" />
  <img src="./public/showcases/stack_view.png" width="45%" alt="Stack View" />
</div>

### 2. 터치에 최적화된 노드 조작 (Touch-First UX)
모바일 환경에서도 복잡한 노드 그래프를 직관적으로 제어할 수 있도록 최적화된 사용자 경험을 제공합니다.
- **Radial Menu:** 롱 프레스 한 번으로 노드 추가, 제거, 색상 변경 및 실행 모드(Always, Mute, Bypass) 전환 기능을 빠르게 호출합니다.
- **Advanced Widget Editor:** 전용 모달 화면에서 노드 위젯을 편하게 편집할 수 있습니다. 특히 기기의 앨범이나 출력 결과물 갤러리에서 이미지와 비디오를 간편하게 가져올 수 있습니다.
- **Precision Linking:** 작은 화면에서도 편리한 드래그 앤 드롭 인터페이스를 통해 노드 사이의 연결선을 정밀하게 구성합니다.

<div align="center">
  <img src="./public/showcases/long_press_circular_control.png" width="30%" alt="Longpress Circular Control" />
  <img src="./public/showcases/edit_widget.png" width="30%" alt="Node Widget Editor" />
  <img src="./public/showcases/connect_link.png" width="30%" alt="Node Connection" />
</div>

### 3. 워크플로우 실행 및 모니터링 (Execution & Monitoring)
실행 현황을 실시간으로 추적하고 대기열을 관리하는 강력한 도구를 제공합니다.
- **Live Progress:** 실행 중인 노드를 시각적으로 확인하고 전체 진행률을 실시간으로 파악합니다.
- **Server Console:** 서버의 실행 로그를 실시간으로 모니터링하여 가동 상태를 확인합니다.

<div align="center">
  <img src="./public/showcases/console.png" width="45%" alt="Workflow Execution Console" />
  <img src="./public/showcases/progress.png" width="45%" alt="Workflow Execution Progress" />
</div>

### 4. 편리한 리소스 다운로드 (Resource Downloader)
서버에 직접 접속할 필요 없이 URL만으로 필요한 모델을 즉시 설치할 수 있습니다.
- **Remote Download:** Hugging Face나 Civitai 등의 모델 링크를 통해 체크포인트, LoRA 등을 서버로 직접 다운로드합니다.
- **Target Folder Selection:** 다운로드 시 저장될 대상 폴더를 직접 지정하여 모델 종류에 맞게 체계적으로 관리합니다.

<div align="center">
  <img src="./public/showcases/download_model.png" width="45%" alt="Model Download Manager" />
  <img src="./public/showcases/model_management.png" width="45%" alt="Model Management" />
</div>

### 5. 통합 미디어 라이브러리 (Unified Media Library)
생성된 이미지와 비디오(MP4)를 앱 내에서 별도의 갤러리 앱 없이 즉시 확인하고 관리합니다.
- **In-App Gallery:** 고화질 결과물부터 비디오 프리뷰까지 매끄러운 재생 및 확인 환경을 제공합니다.
- **Seamless Export:** 결과물을 즉시 확인하고 로컬 저장소로 저장하거나 외부로 공유할 수 있습니다.
<div align="center">
  <img src="./public/showcases/album.png" width="45%" alt="Output Gallery" />
  <img src="./public/showcases/album2.png" width="45%" alt="Video Player" />
</div>

### 6. 다양한 작업 편의 도구 (Advanced Utilities)
워크플로우 편집과 관리를 더욱 효율적으로 만들어주는 스마트한 도구들을 제공합니다.
- **Workflow Snapshots:** 워크플로우의 현재 상태를 스냅샷으로 저장하고 언제든지 복구할 수 있습니다. 파라미터를 실험하며 최적의 값을 찾을 때 데이터 손실 걱정 없이 자유로운 테스트가 가능합니다.
- **Embedded Group Control:** rgthree의 Fast Group Muter/Bypasser 기능을 내장하여, 어떤 워크플로우에서든 그룹 내 모든 노드의 실행 모드(`Always`, `Mute`, `Bypass`)를 일괄적으로 제어할 수 있습니다.
- **Trigger Word Manager:** 모델 브라우저에서 LoRA별 트리거 워드를 미리 저장해 관리할 수 있습니다. 기억하기 어려운 키워드를 워크플로우 편집 시 즉시 조회하고 복사하여 작업 효율을 높입니다.
- **Advanced Video Downloader:** [yt-dlp](https://github.com/yt-dlp/yt-dlp)를 활용해 다양한 플랫폼의 영상을 서버의 `input` 폴더로 직접 다운로드하여 워크플로우의 소스로 즉시 활용할 수 있습니다.
- **Workflow Chain (Experimental):** 독립적인 여러 워크플로우를 하나로 연결합니다. 한 워크플로우의 결과물을 다음 단계의 입력값으로 자동 전송하여 복잡한 순차 실행 프로세스를 자동화합니다.

---

## 아키텍처 및 기능 범위

```text
Tauri 2 Android App / Web UI
              │
              ▼
Comfy Mobile Gateway :8080 (인증, HTTP/WS 프록시, UI 제공)
              │
              ▼
        ComfyUI :8188
```

클라이언트는 Gateway에만 연결합니다. ComfyUI의 `8188`과 선택적인 레거시 Launcher의 `9188`은 사설 네트워크에 두고 모바일 기기에 직접 노출하지 않습니다.

| 기능 | 제공 구성요소 | 필수 여부 |
| --- | --- | --- |
| 생성, 큐, 기록, 업로드, 결과 미디어 | Gateway를 통한 ComfyUI 기본 API | 필수 |
| 인증, 기기 폐기, HTTP/WebSocket 프록시 | Comfy Mobile Gateway | 필수 |
| 모델/파일 관리, 다운로드, 스냅샷, 워크플로 체인, Launcher | `comfy-mobile-ui-api-extension` | 선택 |

자세한 내용은 [Gateway 아키텍처](./docs/gateway_architecture_zh.md), [Tauri 2 Android 계획](./docs/tauri_android_plan_zh.md), [연결 가이드](./docs/connection_guide_kor.md)를 참고하세요.

---

## <a name="installation"></a>🛠️ 설치 및 설정

### **1. Gateway 배포 (권장)**

Node.js 20.19+ 또는 22.12+와 Gateway 호스트에서 접근 가능한 ComfyUI가 필요합니다. 예제 설정은 `http://192.168.2.150:8188`을 사용합니다.

```bash
git clone https://github.com/zclaudia/comfy-ui-mobile.git
cd comfy-ui-mobile
npm install
cp gateway/.env.example gateway/.env
```

`openssl rand -hex 32`를 두 번 실행하고 각각 `gateway/.env`의 `GATEWAY_AUTH_TOKEN`과 `GATEWAY_SESSION_SECRET`으로 설정합니다. `COMFYUI_URL`을 확인한 다음 실행합니다.

```bash
# 운영 환경과 유사한 배포: UI 빌드 및 기기 레지스트리 영속화
docker compose -f docker-compose.gateway.yml up --build -d

# 또는 로컬 개발(각각 별도 터미널에서 실행)
node --env-file=gateway/.env gateway/index.js
npm run dev
```

Android 설정에는 `http://Gateway호스트:8080`을 입력하고 ComfyUI의 `:8188`은 입력하지 않습니다. 신뢰할 수 없는 네트워크에서는 Gateway 앞에 HTTPS를 구성하세요.

### **2. 선택적 ComfyUI Python 확장**

Python 확장은 이 저장소의 일부지만 Gateway가 아니며 ComfyUI 기본 기능에 필수도 아닙니다. 고급 기능이 필요할 때만 설치하세요.

```bash
cp -r comfy-mobile-ui-api-extension /path/to/ComfyUI/custom_nodes/
```

복사 후 ComfyUI를 재시작하세요. 레거시 Launcher의 `9188`은 공개하지 말고, 마이그레이션 중 필요하면 `COMFYUI_LAUNCHER_URL`을 설정해 Gateway에서만 접근하도록 합니다.

### **3. Android 개발**

Android Studio, SDK Platform 36, Build-Tools, Command-line Tools, NDK (Side by side), Java, Rust Android targets를 설치한 후 실행합니다.

```bash
npm run tauri:android:init
npm run tauri:android:dev
```

릴리스 빌드는 `npm run tauri:android:build`를 사용합니다. 최소 지원 버전은 Android 7.0/API 24입니다. 자세한 내용은 [Tauri 2 Android 구현 계획](./docs/tauri_android_plan_zh.md)을 참고하세요.

---

## <a name="contributing"></a>🤝 Contributing

**기여는 언제나 환영합니다!**

### **코드 품질 안내**
이 앱의 대부분은 "바이브 코딩"으로 개발되었으므로 코드 품질이 떨어질 수 있습니다. 양해를 부탁드리며 개선을 환영합니다!

### **기여 방법**
1. 저장소 포크
2. 기능 브랜치 생성 (`git checkout -b feature/amazing-feature`)
3. 변경사항 커밋 (`git commit -m 'Add amazing feature'`)
4. 브랜치에 푸시 (`git push origin feature/amazing-feature`)
5. Pull Request 열기

---

## <a name="support"></a>⭐ 응원하기

⭐ **이 앱이 유용하다고 생각되시면 스타를 눌러주세요!** ⭐

여러분의 응원은 프로젝트 성장에 큰 힘이 됩니다.

---
