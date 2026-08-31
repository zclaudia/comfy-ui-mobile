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
- The setup token is exchanged for an HttpOnly, SameSite session cookie.
- Gateway cookies and browser Authorization headers are never forwarded.
- Unknown upstream paths are not proxied.
- Destructive/admin routes require `GATEWAY_ALLOW_DANGEROUS_ACTIONS=true`.
- The legacy launcher is unreachable unless `COMFYUI_LAUNCHER_URL` is set.

Terminate TLS in front of this process for any untrusted network. Keep ComfyUI
and the optional launcher bound to loopback or an isolated private network.
Set `GATEWAY_TRUST_PROXY=true` only when requests can reach the Gateway solely
through a trusted reverse proxy that sets `X-Forwarded-*` headers.
