# Comfy Mobile Gateway

The Gateway is the only network endpoint the mobile UI should know. It serves
the production frontend, authenticates users, proxies a strict allowlist of
ComfyUI HTTP/WebSocket routes, and optionally bridges the legacy launcher.

## Quick deployment

```bash
cp gateway/.env.example gateway/.env
# Edit COMFYUI_URL, GATEWAY_AUTH_TOKEN and GATEWAY_SESSION_SECRET first.
docker compose -f docker-compose.gateway.yml up --build -d
curl http://127.0.0.1:8080/api/gateway/health
```

The sample configuration uses `COMFYUI_URL=http://192.168.2.150:8188` and the
Compose deployment publishes the Gateway on port `8080`. Generate two
independent secrets with `openssl rand -hex 32`; do not reuse the setup token as
the session secret.

For local development, start the Gateway and Vite in separate terminals:

```bash
node --env-file=gateway/.env gateway/index.js
npm run dev
```

Vite proxies ComfyUI-compatible paths to `VITE_GATEWAY_TARGET`, which defaults
to `http://127.0.0.1:8080`.

## Important configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `COMFYUI_URL` | Private ComfyUI upstream | `http://127.0.0.1:8188` |
| `GATEWAY_AUTH_TOKEN` | Setup/admin token; at least 16 characters | Required |
| `GATEWAY_SESSION_SECRET` | Browser session signing secret | Derived from auth token; set explicitly |
| `GATEWAY_DEVICE_STORE` | Persisted Android device registry | `gateway/.data/devices.json` |
| `GATEWAY_DEVICE_TOKEN_TTL_SECONDS` | Device-token lifetime | `15552000` (180 days) |
| `GATEWAY_ALLOW_DANGEROUS_ACTIONS` | Enable destructive/admin upstream routes | `false` |
| `GATEWAY_SECURE_COOKIES` | Mark browser cookies Secure | `false` |
| `GATEWAY_TRUST_PROXY` | Trust proxy forwarding headers | `false` |

See [`gateway/.env.example`](./.env.example) for limits, CORS origins, the
optional ComfyUI upstream token, and the legacy launcher bridge.

## Security defaults

- Authentication is required unless `GATEWAY_ALLOW_ANONYMOUS=true`.
- Browsers exchange the setup token for an HttpOnly, SameSite session cookie.
- Native clients exchange it for a random, revocable Device Token. Only the
  Device Token SHA-256 digest is stored by the Gateway.
- Gateway cookies and browser Authorization headers are never forwarded.
- Unknown upstream paths are not proxied.
- Destructive/admin routes require `GATEWAY_ALLOW_DANGEROUS_ACTIONS=true`.
- The legacy launcher is unreachable unless `COMFYUI_LAUNCHER_URL` is set.

Terminate TLS in front of this process for any untrusted network. Keep ComfyUI
and the optional launcher bound to loopback or an isolated private network.
Set `GATEWAY_TRUST_PROXY=true` only when requests can reach the Gateway solely
through a trusted reverse proxy that sets `X-Forwarded-*` headers.

## Android device enrollment

The Android app calls `POST /api/gateway/devices/register` once with the setup
token and a device name. The returned `deviceToken` is shown only in that
response and expires after `GATEWAY_DEVICE_TOKEN_TTL_SECONDS` (180 days by
default). Browser login behavior is unchanged.

Example registration request:

```bash
curl -X POST http://127.0.0.1:8080/api/gateway/devices/register \
  -H 'Content-Type: application/json' \
  --data '{"token":"YOUR_SETUP_TOKEN","deviceName":"Pixel 9"}'
```

The response has this shape:

```json
{
  "authenticated": true,
  "device": {
    "id": "DEVICE_ID",
    "name": "Pixel 9",
    "createdAt": 0,
    "expiresAt": 0,
    "revokedAt": null
  },
  "deviceToken": "cmdt_RETURNED_ONLY_ONCE"
}
```

The native app discards the setup token and stores the device token using its
Android Keystore-backed credentials plugin. API and WebSocket requests use
`Authorization: Bearer DEVICE_TOKEN`, strictly for the enrolled Gateway origin.

Administrators can list and revoke devices with the setup token:

```bash
curl -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  http://127.0.0.1:8080/api/gateway/devices

curl -X DELETE -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  http://127.0.0.1:8080/api/gateway/devices/DEVICE_ID
```

A device can revoke itself during logout:

```bash
curl -X DELETE -H "Authorization: Bearer $DEVICE_TOKEN" \
  http://127.0.0.1:8080/api/gateway/device
```

Persist `GATEWAY_DEVICE_STORE` across restarts. The provided Compose file uses
the `gateway-data` volume and stores the registry at `/data/devices.json`.
Removing that file invalidates every enrolled device. Back it up with the same
care as other authentication metadata. Rotating `GATEWAY_AUTH_TOKEN` prevents
future use of the old setup token but does not revoke existing device tokens;
revoke devices individually or intentionally replace the registry.

## TLS reverse proxy

For any untrusted network, expose only an HTTPS reverse proxy and keep ports
`8188` and optional `9188` private. A minimal Caddy configuration is:

```caddyfile
gateway.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

With a trusted reverse proxy as the only path to the Gateway, set:

```dotenv
GATEWAY_SECURE_COOKIES=true
GATEWAY_TRUST_PROXY=true
```

Do not enable trust-proxy when clients can also reach port `8080` directly.
