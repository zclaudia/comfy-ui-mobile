[English](./connection_guide.md) | [한국어](./connection_guide_kor.md) | [日本語](./connection_guide_jp.md) | [简体中文](./connection_guide_zh.md)

# Comfy Mobile 连接指南

## 连接原则

Android App 和 Web UI 只连接 Comfy Mobile Gateway，不直接连接 ComfyUI：

```text
Android / 浏览器 → Gateway :8080 → ComfyUI :8188
```

- `8188` 是 Gateway 使用的内部上游地址。
- `8080` 是客户端使用的 Gateway 地址。
- 可选的旧 Launcher `9188` 也只能留在内部网络。

不要将 `8188` 或 `9188` 直接做公网端口映射。仅改变外部端口号不能提供有效的认证或访问控制。

## 1. 配置 Gateway

在仓库根目录执行：

```bash
cp gateway/.env.example gateway/.env
openssl rand -hex 32
openssl rand -hex 32
```

编辑 `gateway/.env`：

```dotenv
COMFYUI_URL=http://192.168.2.150:8188
GATEWAY_AUTH_TOKEN=第一个随机值
GATEWAY_SESSION_SECRET=第二个随机值
```

`GATEWAY_AUTH_TOKEN` 是部署/管理令牌，至少 16 个字符。不要将它写进 APK、前端 `.env`、URL 或聊天记录。

## 2. 启动并检查

推荐使用 Compose：

```bash
docker compose -f docker-compose.gateway.yml up --build -d
curl http://127.0.0.1:8080/api/gateway/health
```

也可以直接启动：

```bash
npm install
npm run build
node --env-file=gateway/.env gateway/index.js
```

Gateway 默认从 `dist/` 托管前端，并监听 `8080`。

## 3. Android 首次注册

1. 确保手机能够访问 Gateway；若它和 ComfyUI 在同一主机，地址可使用 `http://192.168.2.150:8080`。
2. 在 App 的服务器设置中只填写 Gateway 地址，不要填写 `http://192.168.2.150:8188`。
3. 输入一次 `GATEWAY_AUTH_TOKEN` 完成注册。
4. 注册成功后，部署令牌会从输入框和运行内存中清除；App 将设备令牌加密保存在 Android Keystore 管理的本地存储中。

以后启动 App 会自动恢复设备会话。设备令牌有有效期，默认 180 天；过期、被管理员撤销或服务端注册表丢失后，需要重新注册。

## 4. 浏览器登录

浏览器打开 Gateway 地址，例如 `http://192.168.2.150:8080`，在登录页输入部署令牌。Gateway 会换取 HttpOnly 会话 Cookie；浏览器不会直接持有 Android 设备令牌。

开发时可分别启动 Gateway 和 Vite：

```bash
node --env-file=gateway/.env gateway/index.js
npm run dev
```

然后打开 `http://localhost:5173`。Vite 默认把 ComfyUI 兼容请求代理到 `http://127.0.0.1:8080`。

## 5. 管理与撤销设备

列出已注册设备：

```bash
curl -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  http://127.0.0.1:8080/api/gateway/devices
```

撤销指定设备：

```bash
curl -X DELETE \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  http://127.0.0.1:8080/api/gateway/devices/DEVICE_ID
```

App 正常退出登录时会使用自己的设备令牌调用 `DELETE /api/gateway/device`，立即撤销当前设备。

Compose 使用 `gateway-data` volume 保存设备注册表。删除或丢失该数据会使全部设备令牌失效；轮换 `GATEWAY_AUTH_TOKEN` 不会自动撤销已经签发的设备令牌，需要按设备撤销或重建设备注册表。

## 6. 外网访问

公网或不可信网络必须使用以下任一方案：

- VPN/Tailscale/WireGuard，只在私有网络暴露 Gateway；或
- 在 Gateway 前部署 Caddy/Nginx/负载均衡器，以 `https://` / `wss://` 提供服务。

只有反向代理是唯一入口并正确设置 `X-Forwarded-*` 请求头时，才启用 `GATEWAY_TRUST_PROXY=true`。正式环境设置 `GATEWAY_SECURE_COOKIES=true`，防火墙继续阻止客户端访问 ComfyUI `8188`。

## 7. 可选 Python 扩展

生成、队列、历史、上传和输出媒体使用 ComfyUI 原生 API，不要求安装扩展。模型/文件管理、远程下载、快照、工作流链等高级能力需要 `comfy-mobile-ui-api-extension`。它是内部 API 增强层，不负责客户端认证，也不能替代 Gateway。

## 故障排查

- Gateway 无法启动：检查令牌是否至少 16 个字符、`gateway/.env` 是否存在。
- Gateway 健康但无法生成：从 Gateway 主机测试 `curl http://192.168.2.150:8188/system_stats`。
- 手机无法连接：确认手机访问的是 Gateway 主机地址和 `8080`，且局域网/防火墙允许该端口。
- 注册后出现 `401`：设备令牌可能已过期或被撤销，删除本地会话后重新注册。
- HTTPS 下浏览器无法保持登录：确认 `GATEWAY_SECURE_COOKIES=true`，并仅在可信反代后启用 `GATEWAY_TRUST_PROXY=true`。
