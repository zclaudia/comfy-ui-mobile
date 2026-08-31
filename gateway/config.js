import crypto from 'node:crypto';
import path from 'node:path';

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const parseInteger = (value, fallback, minimum = 1) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
};

const normalizeHttpUrl = (value, name) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use http:// or https://`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not contain embedded credentials`);
  }

  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
};

export const loadGatewayConfig = (env = process.env, cwd = process.cwd()) => {
  const allowAnonymous = parseBoolean(env.GATEWAY_ALLOW_ANONYMOUS, false);
  const authToken = String(env.GATEWAY_AUTH_TOKEN ?? '').trim();

  if (!allowAnonymous && authToken.length < 16) {
    throw new Error(
      'GATEWAY_AUTH_TOKEN must contain at least 16 characters unless GATEWAY_ALLOW_ANONYMOUS=true',
    );
  }

  const configuredSecret = String(env.GATEWAY_SESSION_SECRET ?? '').trim();
  const derivedSecret = crypto
    .createHash('sha256')
    .update(`comfy-mobile-gateway:${authToken}`)
    .digest('hex');

  const launcherUrl = String(env.COMFYUI_LAUNCHER_URL ?? '').trim();

  return {
    host: env.GATEWAY_HOST || '0.0.0.0',
    port: parseInteger(env.GATEWAY_PORT, 8080),
    comfyUrl: normalizeHttpUrl(
      env.COMFYUI_URL || 'http://127.0.0.1:8188',
      'COMFYUI_URL',
    ),
    comfyAuthToken: String(env.COMFYUI_AUTH_TOKEN ?? '').trim(),
    launcherUrl: launcherUrl
      ? normalizeHttpUrl(launcherUrl, 'COMFYUI_LAUNCHER_URL')
      : null,
    staticDir: path.resolve(cwd, env.GATEWAY_STATIC_DIR || 'dist'),
    allowAnonymous,
    authToken,
    sessionSecret: configuredSecret || derivedSecret,
    sessionCookieName: env.GATEWAY_SESSION_COOKIE || 'comfy_mobile_session',
    sessionTtlSeconds: parseInteger(env.GATEWAY_SESSION_TTL_SECONDS, 12 * 60 * 60),
    rememberedSessionTtlSeconds: parseInteger(
      env.GATEWAY_REMEMBERED_SESSION_TTL_SECONDS,
      30 * 24 * 60 * 60,
    ),
    secureCookies: parseBoolean(env.GATEWAY_SECURE_COOKIES, false),
    trustProxy: parseBoolean(env.GATEWAY_TRUST_PROXY, false),
    allowedOrigins: new Set(
      String(env.GATEWAY_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
    allowDangerousActions: parseBoolean(env.GATEWAY_ALLOW_DANGEROUS_ACTIONS, false),
    maxBodyBytes: parseInteger(env.GATEWAY_MAX_BODY_BYTES, 1024 * 1024 * 1024),
    maxWsPayloadBytes: parseInteger(env.GATEWAY_MAX_WS_PAYLOAD_BYTES, 32 * 1024 * 1024),
    requestTimeoutMs: parseInteger(env.GATEWAY_UPSTREAM_TIMEOUT_MS, 10 * 60 * 1000),
    rateLimitPerMinute: parseInteger(env.GATEWAY_RATE_LIMIT_PER_MINUTE, 600),
    loginRateLimitPerMinute: parseInteger(env.GATEWAY_LOGIN_RATE_LIMIT_PER_MINUTE, 10),
  };
};
