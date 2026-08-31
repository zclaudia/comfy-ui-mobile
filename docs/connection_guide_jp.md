[English](./connection_guide.md) | [한국어](./connection_guide_kor.md) | [日本語](./connection_guide_jp.md) | [简体中文](./connection_guide_zh.md)

# Comfy Mobile 接続ガイド

## 接続ルール

Android App と Web UI は ComfyUI に直接接続せず、Comfy Mobile Gateway のみに接続します。

```text
Android / ブラウザ → Gateway :8080 → ComfyUI :8188
```

- `8188` は Gateway が使用する内部 Upstream です。
- `8080` はクライアントが使用する Gateway のポートです。
- 任意の旧 Launcher `9188` もプライベートネットワーク内に置きます。

`8188` や `9188` をインターネットへ直接ポートフォワードしないでください。外部ポート番号を変えるだけでは認証や有効なアクセス制御にはなりません。

## 1. Gateway の設定

```bash
cp gateway/.env.example gateway/.env
openssl rand -hex 32
openssl rand -hex 32
```

`gateway/.env` を編集します。

```dotenv
COMFYUI_URL=http://192.168.2.150:8188
GATEWAY_AUTH_TOKEN=1つ目のランダム値
GATEWAY_SESSION_SECRET=2つ目のランダム値
```

`GATEWAY_AUTH_TOKEN` はセットアップ/管理用で、16文字以上が必要です。APK、フロントエンド `.env`、URL、チャットには保存しないでください。

## 2. 起動と確認

```bash
docker compose -f docker-compose.gateway.yml up --build -d
curl http://127.0.0.1:8080/api/gateway/health
```

直接起動する場合：

```bash
npm install
npm run build
node --env-file=gateway/.env gateway/index.js
```

Gateway はデフォルトで `dist/` を配信し、`8080` で待ち受けます。

## 3. Android の初回登録

1. Gateway が ComfyUI と同じホストなら、スマートフォンから `http://192.168.2.150:8080` へ接続できるようにします。
2. Server Settings には Gateway URL のみを入力し、`http://192.168.2.150:8188` は入力しません。
3. `GATEWAY_AUTH_TOKEN` を一度入力して端末を登録します。
4. 登録後、セットアップトークンは消去されます。端末トークンは Android Keystore が保護する暗号化ローカルストレージに保存されます。

端末セッションは次回起動時に復元されます。端末トークンの有効期限はデフォルトで180日です。期限切れ、管理者による失効、サーバー側レジストリの消失後は再登録が必要です。

## 4. ブラウザログイン

Gateway URL を開き、セットアップトークンを入力します。Gateway は HttpOnly セッション Cookie に交換します。ブラウザは Android の端末トークンを使用しません。

開発時は Gateway と Vite を別々に起動し、`http://localhost:5173` を開きます。

```bash
node --env-file=gateway/.env gateway/index.js
npm run dev
```

## 5. 端末の管理と失効

```bash
# 登録端末の一覧
curl -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  http://127.0.0.1:8080/api/gateway/devices

# 指定端末を失効
curl -X DELETE \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  http://127.0.0.1:8080/api/gateway/devices/DEVICE_ID
```

App から通常ログアウトすると、端末自身のトークンで `DELETE /api/gateway/device` が呼ばれ、すぐに失効します。

Compose は `gateway-data` volume に端末レジストリを保存します。このデータを失うと全端末トークンが無効になります。`GATEWAY_AUTH_TOKEN` のローテーションだけでは既存端末は自動失効しません。

## 6. 外部ネットワーク

信頼できないネットワークでは VPN/Tailscale/WireGuard、または Caddy/Nginx/ロードバランサーを使用し、Gateway を `https://` / `wss://` で公開します。ComfyUI `8188` は引き続きクライアントから遮断します。

信頼できる Reverse Proxy が唯一の入口で、正しい `X-Forwarded-*` ヘッダーを設定する場合だけ `GATEWAY_TRUST_PROXY=true` にします。本番では `GATEWAY_SECURE_COOKIES=true` も設定してください。

## 7. 任意の Python 拡張

生成、キュー、履歴、アップロード、出力メディアは ComfyUI ネイティブ API を使用するため拡張は不要です。モデル/ファイル管理、ダウンロード、スナップショット、ワークフローチェーンなどには `comfy-mobile-ui-api-extension` が必要です。この拡張は内部 API の追加層であり、Gateway の代わりにはなりません。

## トラブルシューティング

- Gateway が起動しない：`gateway/.env` と16文字以上のトークンを確認します。
- Gateway は正常だが生成できない：Gateway ホストで `curl http://192.168.2.150:8188/system_stats` を試します。
- 端末から接続できない：Gateway ホストの `8080` と LAN/Firewall を確認します。
- 登録後に `401`：端末が期限切れまたは失効しています。ローカルセッションを削除して再登録します。
