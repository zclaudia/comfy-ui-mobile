# Comfy Mobile Gateway

The Gateway is the only network endpoint the mobile UI should know. It serves
the production frontend, authenticates users, proxies a strict allowlist of
ComfyUI HTTP/WebSocket routes, and optionally bridges the legacy launcher.

## Local development

```bash
cp gateway/.env.example gateway/.env
# Edit GATEWAY_AUTH_TOKEN and COMFYUI_URL first.
node --env-file=gateway/.env gateway/index.js
```

In another terminal, run `npm run dev`. Vite proxies ComfyUI-compatible paths
to `VITE_GATEWAY_TARGET`, which defaults to `http://127.0.0.1:8080`.

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

Administrators can list and revoke devices with the setup token:

```bash
curl -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  http://127.0.0.1:8080/api/gateway/devices

curl -X DELETE -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  http://127.0.0.1:8080/api/gateway/devices/DEVICE_ID
```

Persist `GATEWAY_DEVICE_STORE` across restarts. The provided Compose file uses
the `gateway-data` volume and stores the registry at `/data/devices.json`.
Removing that file invalidates every enrolled device. Back it up with the same
care as other authentication metadata.
