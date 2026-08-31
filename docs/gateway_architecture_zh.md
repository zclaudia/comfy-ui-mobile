# Comfy Mobile Gateway 架构与实施计划

## 目标架构

```text
Mobile Web/PWA
      │ HTTPS + WebSocket
      ▼
Gateway（唯一公开入口）
      ├── 静态前端
      ├── 身份验证、会话、CORS、限流
      ├── HTTP/WebSocket 白名单反代
      └── 权限与危险操作控制
              │ 私有网络
              ▼
ComfyUI :8188
      ├── 原生 API /ws /prompt /history /view ...
      └── 可选的最小化 Python 扩展 API
```

手机不再保存或选择真实的 ComfyUI 地址。前端只连接 Gateway；`COMFYUI_URL`
由服务端部署人员配置。ComfyUI 不再需要为浏览器开启全局 CORS。

## 分阶段计划

### 阶段 1：建立 Gateway 边界（本次改造）

- 新增独立 Node.js Gateway。
- 使用长随机 Token 换取 HttpOnly 会话 Cookie。
- 对 ComfyUI 原生 API、扩展 API 和 WebSocket 进行白名单反代。
- 默认拒绝重启、文件删除、模型下载等危险操作。
- 前端默认使用同源 Gateway，并迁移旧的直连配置。
- 全局执行 WebSocket 改用 ComfyUI 原生 `/ws`。
- 每台设备生成独立 `clientId`，消除多设备冲突。
- 保留可选的 `9188` Launcher 内网迁移桥接，但浏览器不再直接访问它。

验收标准：未登录不能调用 ComfyUI；登录后 `/system_stats`、`/prompt`、
`/view` 和 `/ws` 可用；未知路径和默认关闭的危险操作不能被转发。

### 阶段 2：最小化 Python Companion Extension

- 统计前端实际使用的 `/comfymobile/api/*` 能力。
- 优先改用官方 API，删除重复实现。
- 将文件系统、模型目录、快照和内部事件保留在扩展中。
- 移除扩展的静态前端托管、公开 CORS 和身份验证职责。
- 为扩展增加 capability/version 接口以及 Gateway 到扩展的内部凭证。

验收标准：不安装扩展时核心生成、队列、历史、上传和画廊仍可用；安装扩展
后按 capability 渐进启用高级功能。

### 阶段 3：产品化安全与运维

- 在 Gateway 前加入 HTTPS（Caddy、Nginx 或云负载均衡）。
- 将共享 Token 替换为 OIDC/OAuth2 Authorization Code + PKCE。
- 增加角色权限、审计日志、指标和结构化日志。
- 增加请求幂等键、断线恢复和执行事件游标。
- 如有需要，再增加多 ComfyUI 实例路由与任务调度。

## 当前本地开发

1. 创建 Gateway 配置：

   ```bash
   cp gateway/.env.example gateway/.env
   ```

2. 至少设置：

   ```dotenv
   COMFYUI_URL=http://192.168.2.150:8188
   GATEWAY_AUTH_TOKEN=<长随机字符串>
   GATEWAY_SESSION_SECRET=<另一条长随机字符串>
   ```

3. 启动 Gateway 和前端：

   ```bash
   node --env-file=gateway/.env gateway/index.js
   npm run dev
   ```

4. 浏览器打开 `http://开发机IP:5173`，在服务器设置中选择 `Gateway` 并输入
   `GATEWAY_AUTH_TOKEN`。前端会把 Token 换成会话 Cookie。

## 生产部署

```bash
npm run build
node --env-file=gateway/.env gateway/index.js
```

Gateway 会从 `dist/` 托管前端，默认监听 `8080`。也可以运行：

```bash
docker compose -f docker-compose.gateway.yml up -d --build
```

正式环境应让 Gateway 使用 HTTPS，并限制 `8188` 和可选的 `9188` 仅能由
Gateway 所在主机或私有网络访问。只有当 Gateway 无法被客户端绕过、且前置反代
会覆盖 `X-Forwarded-*` 请求头时，才设置 `GATEWAY_TRUST_PROXY=true`。
