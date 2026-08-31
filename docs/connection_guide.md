[English](./connection_guide.md) | [한국어](./connection_guide_kor.md) | [日本語](./connection_guide_jp.md) | [简体中文](./connection_guide_zh.md)

# Comfy Mobile Connection Guide

## Connection rule

The Android app and Web UI connect only to Comfy Mobile Gateway, never directly to ComfyUI:

```text
Android / browser → Gateway :8080 → ComfyUI :8188
```

- `8188` is the internal upstream used by the Gateway.
- `8080` is the Gateway endpoint used by clients.
- The optional legacy launcher on `9188` also stays private.

Do not port-forward `8188` or `9188` to the public Internet. Changing only the external port does not add authentication or meaningful access control.

## 1. Configure the Gateway

From the repository root:

```bash
cp gateway/.env.example gateway/.env
openssl rand -hex 32
openssl rand -hex 32
```

Edit `gateway/.env`:

```dotenv
COMFYUI_URL=http://192.168.2.150:8188
GATEWAY_AUTH_TOKEN=first-random-value
GATEWAY_SESSION_SECRET=second-random-value
```

`GATEWAY_AUTH_TOKEN` is the setup/admin token and must contain at least 16 characters. Never place it in an APK, frontend `.env`, URL, or chat message.

## 2. Start and verify

Compose is the recommended deployment:

```bash
docker compose -f docker-compose.gateway.yml up --build -d
curl http://127.0.0.1:8080/api/gateway/health
```

Or run it directly:

```bash
npm install
npm run build
node --env-file=gateway/.env gateway/index.js
```

The Gateway serves `dist/` and listens on port `8080` by default.

## 3. Enroll Android

1. Make the Gateway reachable from the phone, for example at `http://192.168.2.150:8080` when it runs on the ComfyUI host.
2. Enter only the Gateway URL in Server Settings; do not enter `http://192.168.2.150:8188`.
3. Enter `GATEWAY_AUTH_TOKEN` once to enroll the device.
4. After enrollment, the setup token is cleared. The app stores the new device token in encrypted local storage backed by Android Keystore.

The app restores the device session on later launches. Device tokens expire after 180 days by default. Re-enrollment is required after expiry, admin revocation, or loss of the server-side device registry.

## 4. Browser login

Open the Gateway URL, such as `http://192.168.2.150:8080`, and enter the setup token. The Gateway exchanges it for an HttpOnly session cookie; browsers do not use Android device tokens.

For split development, run the Gateway and Vite separately:

```bash
node --env-file=gateway/.env gateway/index.js
npm run dev
```

Open `http://localhost:5173`. Vite proxies ComfyUI-compatible traffic to `http://127.0.0.1:8080` by default.

## 5. Manage and revoke devices

List enrolled devices:

```bash
curl -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  http://127.0.0.1:8080/api/gateway/devices
```

Revoke one device:

```bash
curl -X DELETE \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  http://127.0.0.1:8080/api/gateway/devices/DEVICE_ID
```

Normal app logout calls `DELETE /api/gateway/device` with that device's own token and revokes it immediately.

Compose stores the registry in the `gateway-data` volume. Losing it invalidates every device token. Rotating `GATEWAY_AUTH_TOKEN` does not automatically revoke existing device tokens; revoke them individually or rebuild the registry.

## 6. Remote access

For public or otherwise untrusted networks, use one of these approaches:

- VPN/Tailscale/WireGuard with the Gateway exposed only inside the private network; or
- Caddy/Nginx/a load balancer in front of the Gateway, serving `https://` and `wss://`.

Enable `GATEWAY_TRUST_PROXY=true` only when the reverse proxy is the sole entry point and sets the correct `X-Forwarded-*` headers. Set `GATEWAY_SECURE_COOKIES=true` in production and keep firewall access to ComfyUI `8188` blocked from clients.

## 7. Optional Python extension

Generation, queue, history, uploads, and output media use native ComfyUI APIs and do not require the extension. Advanced model/file management, remote downloads, snapshots, and workflow chains require `comfy-mobile-ui-api-extension`. It is an internal API enhancement, not the client authentication boundary and not a replacement for the Gateway.

## Troubleshooting

- Gateway does not start: verify `gateway/.env` exists and tokens contain at least 16 characters.
- Gateway is healthy but generation fails: from the Gateway host, try `curl http://192.168.2.150:8188/system_stats`.
- The phone cannot connect: use the Gateway host address and port `8080`, and check LAN/firewall access.
- `401` after enrollment: the device may be expired or revoked; clear its local session and enroll it again.
- Browser login is lost under HTTPS: set `GATEWAY_SECURE_COOKIES=true`, and enable trust-proxy only behind a trusted proxy.
