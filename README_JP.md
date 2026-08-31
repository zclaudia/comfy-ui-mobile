[English](README.md) | [한국어](README_KOR.md) | [日本語](README_JP.md) | [简体中文](README_ZH.md)
<div align="center">

# Comfy Mobile UI

https://github.com/user-attachments/assets/20480b56-5c01-4c27-9401-0d4ba455dd81

**Tauri 2 ベースの ComfyUI Android クライアントとモバイル優先 Web UI**

[主な機能](#features) | [インストールガイド](#installation) | [貢献する](#contributing) | [応援する](#support)

---

<p align="left">
  <img src="https://img.shields.io/badge/Platform-Android_%7C_Web-success?style=flat-square&logo=android" alt="Platform">
  <img src="https://img.shields.io/badge/App-Tauri_2-24C8DB?style=flat-square&logo=tauri" alt="Tauri 2">
  <img src="https://img.shields.io/badge/Backend-ComfyUI-blueviolet?style=flat-square" alt="ComfyUI">
  <img src="https://img.shields.io/github/license/zclaudia/comfy-ui-mobile?style=flat-square" alt="License">
</p>
</div>

---

## 📖 はじめに

**Comfy Mobile UI**は、PC環境に最適化されていたノードベースのAIワークフローをモバイルでも扱えるように設計された、Tauri 2 Android クライアント兼モバイル優先 Web UI です。

単なるビューアではありません。外出先でも複雑なワークフローを修正し、新しいノードを追加し、モデルを管理し、実行状態をリアルタイムで監視できます。タッチ環境に最適化されたUXで、デスクトップの体験を手のひらで再現します。

このリポジトリは [jaeone94/comfy-mobile-ui](https://github.com/jaeone94/comfy-mobile-ui) を基に開発を継続しています。現在の Clone、Issue、Release は [zclaudia/comfy-ui-mobile](https://github.com/zclaudia/comfy-ui-mobile) を参照してください。

---

## <a name="features"></a>✨ 主な機能

### 1. マルチモード対応 (Multi-Mode Support)
ワークフローを自由に編集できる強力な **Graph View** と、ノードをタイプ別にグループ化してウィジェット値を直感的に修正できる **Stack View** を同時に提供します。

<div align="center">
  <img src="./public/showcases/graph_view.png" width="45%" alt="Graph View" />
  <img src="./public/showcases/stack_view.png" width="45%" alt="Stack View" />
</div>

### 2. タッチに最適化された操作 (Touch-First UX)
モバイル環境でも複雑なノードグラフを直感的に制御できるように最適化されたユーザー体験を提供します。
- **Radial Menu:** ロングプレス（長押し）一つでノードの追加、削除、色の変更、実行モード（Always, Mute, Bypass）の切り替え機能を素早く呼び出せます。
- **Advanced Widget Editor:** 専用のモーダル画面でノードウィジェットを快適に編集できます。特にデバイスのアルバムや出力結果のギャラリーから画像やビデオを簡単に取り込めます。
- **Precision Linking:** 小さな画面でも便利なドラッグ＆ドロップインターフェースにより、ノード間の接続線を精密に構成できます。

<div align="center">
  <img src="./public/showcases/long_press_circular_control.png" width="30%" alt="Longpress Circular Control" />
  <img src="./public/showcases/edit_widget.png" width="30%" alt="Node Widget Editor" />
  <img src="./public/showcases/connect_link.png" width="30%" alt="Node Connection" />
</div>

### 3. 実行と監視 (Execution & Monitoring)
実行状況をリアルタイムで追跡し、キューを管理する強力なツールを提供します。
- **Live Progress:** 実行中のノードを視覚的に確認し、全体の進捗率をリアルタイムで把握できます。
- **Server Console:** サーバーの実行ログをリアルタイムで監視し、稼働状態を確認できます。

<div align="center">
  <img src="./public/showcases/console.png" width="45%" alt="Workflow Execution Console" />
  <img src="./public/showcases/progress.png" width="45%" alt="Workflow Execution Progress" />
</div>

### 4. 便利なリソースダウンローダー (Resource Downloader)
サーバーに直接アクセスすることなく、URLだけで必要なモデルを即座にインストールできます。
- **Remote Download:** Hugging FaceやCivitaiなどのモデルリンクを通じて、チェックポイントやLoRAなどをサーバーへ直接ダウンロードします。
- **Target Folder Selection:** ダウンロード時の保存先フォルダを直接指定でき、モデルの種類に合わせて体系的に管理できます。

<div align="center">
  <img src="./public/showcases/download_model.png" width="45%" alt="Model Download Manager" />
  <img src="./public/showcases/model_management.png" width="45%" alt="Model Management" />
</div>

### 5. 統合メディアライブラリ (Unified Media Library)
生成された画像やビデオ(MP4)を、アプリ内で別のギャラリーアプリを使わずに即座に確認・管理できます。
- **In-App Gallery:** 高画質の結果からビデオプレビューまで、スムーズな再生・確認環境を提供します。
- **Seamless Export:** 結果を即座に確認し、ローカルストレージに保存したり外部へ共有したりできます。

<div align="center">
  <img src="./public/showcases/album.png" width="45%" alt="Output Gallery" />
  <img src="./public/showcases/album2.png" width="45%" alt="Video Player" />
</div>

### 6. 高度なユーティリティ (Advanced Utilities)
ワークフローの編集と管理をさらに効率化するスマートなツールを提供します。
- **Workflow Snapshots:** ワークフローの現在の状態をスナップショットとして保存し、いつでも復元できます。
- **Embedded Group Control:** rgthreeのFast Group Muter/Bypasser機能を内蔵し、グループ内の全ノードの実行モードを一括制御できます。
- **Trigger Word Manager:** モデルブラウザでLoRA別のトリガーワードを保存・管理できます。
- **Advanced Video Downloader:** [yt-dlp](https://github.com/yt-dlp/yt-dlp)を活用して様々なプラットフォームの映像をサーバーへ直接ダウンロードできます。
- **Workflow Chain (Experimental):** 独立した複数のワークフローを一つに連結し、自動化されたプロセスを構築できます。

---

## アーキテクチャと機能範囲

```text
Tauri 2 Android App / Web UI
              │
              ▼
Comfy Mobile Gateway :8080（認証、HTTP/WS プロキシ、UI 配信）
              │
              ▼
        ComfyUI :8188
```

クライアントは Gateway のみに接続します。ComfyUI の `8188` と任意の旧 Launcher `9188` はプライベートネットワーク内に置き、モバイル端末へ直接公開しません。

| 機能 | 提供元 | 必須 |
| --- | --- | --- |
| 生成、キュー、履歴、アップロード、出力メディア | Gateway 経由の ComfyUI ネイティブ API | はい |
| 認証、端末の失効、HTTP/WebSocket プロキシ | Comfy Mobile Gateway | はい |
| モデル/ファイル管理、ダウンロード、スナップショット、ワークフローチェーン、Launcher | `comfy-mobile-ui-api-extension` | 任意 |

詳細は [Gateway アーキテクチャ](./docs/gateway_architecture_zh.md)、[Tauri 2 Android 計画](./docs/tauri_android_plan_zh.md)、[接続ガイド](./docs/connection_guide_jp.md)を参照してください。

---

## <a name="installation"></a>🛠️ インストールと設定

### **1. Gateway の導入（推奨）**

Node.js 20.19+（または 22.12+）と、Gateway ホストから接続できる ComfyUI が必要です。サンプル設定は `http://192.168.2.150:8188` を使用しています。

```bash
git clone https://github.com/zclaudia/comfy-ui-mobile.git
cd comfy-ui-mobile
npm install
cp gateway/.env.example gateway/.env
```

`openssl rand -hex 32` を2回実行し、それぞれを `gateway/.env` の `GATEWAY_AUTH_TOKEN` と `GATEWAY_SESSION_SECRET` に設定します。`COMFYUI_URL` を確認してから起動します。

```bash
# 本番に近い構成：UI をビルドし、端末レジストリを永続化
docker compose -f docker-compose.gateway.yml up --build -d

# またはローカル開発（別々のターミナルで実行）
node --env-file=gateway/.env gateway/index.js
npm run dev
```

Android の設定には `http://Gatewayホスト:8080` を入力し、ComfyUI の `:8188` は入力しません。信頼できないネットワークでは Gateway の前段に HTTPS を構成してください。

### **2. 任意の ComfyUI Python 拡張**

Python 拡張はこのリポジトリに含まれますが、Gateway ではなく、ComfyUI の基本機能には不要です。高度な機能が必要な場合のみインストールします。

```bash
cp -r comfy-mobile-ui-api-extension /path/to/ComfyUI/custom_nodes/
```

コピー後に ComfyUI を再起動してください。旧 Launcher の `9188` は公開せず、移行時に必要な場合は `COMFYUI_LAUNCHER_URL` を設定して Gateway からのみ接続します。

### **3. Android 開発**

Android Studio、SDK Platform 36、Build-Tools、Command-line Tools、NDK (Side by side)、Java、Rust Android targets を準備して実行します。

```bash
npm run tauri:android:init
npm run tauri:android:dev
```

リリースビルドは `npm run tauri:android:build` を使用します。最低対応バージョンは Android 7.0/API 24 です。詳細は [Tauri 2 Android 実施計画](./docs/tauri_android_plan_zh.md)を参照してください。

---

## <a name="contributing"></a>🤝 貢献する

**貢献は大歓迎です！**

### **コード品質について**
このアプリの多くは「バイブコーディング（情緒的コーディング）」で開発されているため、コードの品質にばらつきがある場合があります。ご理解いただけますと幸いです。改善の提案をお待ちしております！

---

## <a name="support"></a>⭐ 応援する

⭐ **このアプリが役に立つと思ったら、ぜひスターをお願いします！** ⭐

皆様の応援はプロジェクトの成長と継続的な開発の大きな励みになります。

---
