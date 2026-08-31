[English](./connection_guide.md) | [한국어](./connection_guide_kor.md) | [日本語](./connection_guide_jp.md) | [简体中文](./connection_guide_zh.md)

# Comfy Mobile 연결 가이드

## 연결 원칙

Android App과 Web UI는 ComfyUI에 직접 연결하지 않고 Comfy Mobile Gateway에만 연결합니다.

```text
Android / 브라우저 → Gateway :8080 → ComfyUI :8188
```

- `8188`은 Gateway가 사용하는 내부 Upstream입니다.
- `8080`은 클라이언트가 사용하는 Gateway 포트입니다.
- 선택적인 레거시 Launcher `9188`도 사설 네트워크에 둡니다.

`8188` 또는 `9188`을 인터넷에 직접 포트 포워딩하지 마세요. 외부 포트 번호만 변경하는 것은 인증이나 유효한 접근 제어가 아닙니다.

## 1. Gateway 설정

```bash
cp gateway/.env.example gateway/.env
openssl rand -hex 32
openssl rand -hex 32
```

`gateway/.env`를 수정합니다.

```dotenv
COMFYUI_URL=http://192.168.2.150:8188
GATEWAY_AUTH_TOKEN=첫번째-무작위-값
GATEWAY_SESSION_SECRET=두번째-무작위-값
```

`GATEWAY_AUTH_TOKEN`은 설정/관리 토큰이며 16자 이상이어야 합니다. APK, 프런트엔드 `.env`, URL 또는 채팅에 저장하지 마세요.

## 2. 실행 및 확인

```bash
docker compose -f docker-compose.gateway.yml up --build -d
curl http://127.0.0.1:8080/api/gateway/health
```

직접 실행할 수도 있습니다.

```bash
npm install
npm run build
node --env-file=gateway/.env gateway/index.js
```

Gateway는 기본적으로 `dist/`를 제공하고 `8080`에서 수신합니다.

## 3. Android 최초 등록

1. Gateway가 ComfyUI와 같은 호스트라면 휴대폰에서 `http://192.168.2.150:8080`에 접근할 수 있게 합니다.
2. Server Settings에는 Gateway URL만 입력하고 `http://192.168.2.150:8188`은 입력하지 않습니다.
3. `GATEWAY_AUTH_TOKEN`을 한 번 입력해 기기를 등록합니다.
4. 등록 후 설정 토큰은 삭제됩니다. 기기 토큰은 Android Keystore가 보호하는 암호화 로컬 저장소에 저장됩니다.

이후 앱 실행 시 기기 세션을 복원합니다. 기기 토큰의 기본 유효 기간은 180일입니다. 만료, 관리자 폐기 또는 서버 측 레지스트리 손실 후에는 다시 등록해야 합니다.

## 4. 브라우저 로그인

Gateway URL을 열고 설정 토큰을 입력합니다. Gateway는 이를 HttpOnly 세션 Cookie로 교환합니다. 브라우저는 Android 기기 토큰을 사용하지 않습니다.

개발 중에는 Gateway와 Vite를 별도로 실행하고 `http://localhost:5173`을 엽니다.

```bash
node --env-file=gateway/.env gateway/index.js
npm run dev
```

## 5. 기기 관리 및 폐기

```bash
# 등록 기기 목록
curl -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  http://127.0.0.1:8080/api/gateway/devices

# 지정 기기 폐기
curl -X DELETE \
  -H "Authorization: Bearer $GATEWAY_AUTH_TOKEN" \
  http://127.0.0.1:8080/api/gateway/devices/DEVICE_ID
```

앱에서 정상 로그아웃하면 기기 자체 토큰으로 `DELETE /api/gateway/device`를 호출해 즉시 폐기합니다.

Compose는 `gateway-data` volume에 기기 레지스트리를 저장합니다. 이 데이터가 손실되면 모든 기기 토큰이 무효화됩니다. `GATEWAY_AUTH_TOKEN` 교체만으로 기존 기기가 자동 폐기되지는 않습니다.

## 6. 외부 네트워크

신뢰할 수 없는 네트워크에서는 VPN/Tailscale/WireGuard를 사용하거나 Caddy/Nginx/로드 밸런서를 Gateway 앞에 두고 `https://` / `wss://`로 서비스합니다. ComfyUI `8188`은 계속 클라이언트에서 차단합니다.

신뢰할 수 있는 Reverse Proxy가 유일한 진입점이고 올바른 `X-Forwarded-*` 헤더를 설정할 때만 `GATEWAY_TRUST_PROXY=true`를 사용하세요. 운영 환경에서는 `GATEWAY_SECURE_COOKIES=true`도 설정합니다.

## 7. 선택적 Python 확장

생성, 큐, 기록, 업로드, 결과 미디어는 ComfyUI 기본 API를 사용하므로 확장이 필요하지 않습니다. 모델/파일 관리, 다운로드, 스냅샷, 워크플로 체인 등의 고급 기능에는 `comfy-mobile-ui-api-extension`이 필요합니다. 이 확장은 내부 API 보강 계층이며 Gateway를 대체하지 않습니다.

## 문제 해결

- Gateway가 시작되지 않음: `gateway/.env`와 16자 이상의 토큰을 확인합니다.
- Gateway는 정상이지만 생성 실패: Gateway 호스트에서 `curl http://192.168.2.150:8188/system_stats`를 실행합니다.
- 휴대폰 연결 실패: Gateway 호스트의 `8080` 및 LAN/Firewall 접근을 확인합니다.
- 등록 후 `401`: 기기가 만료되었거나 폐기되었습니다. 로컬 세션을 삭제하고 다시 등록합니다.
