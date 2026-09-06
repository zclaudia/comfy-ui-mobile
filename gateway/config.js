import crypto from 'node:crypto';
import path from 'node:path';

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const parseSameSite = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === '') return 'strict';
  if (['strict', 'lax', 'none'].includes(normalized)) return normalized;
  throw new Error('GATEWAY_COOKIE_SAMESITE must be one of: strict, lax, none');
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
  const agentModel = String(env.AGENT_LLM_MODEL || '').trim();
  if (/(sk-|sess-|Bearer\s)/i.test(agentModel)) {
    throw new Error('AGENT_LLM_MODEL appears to contain a credential; check AGENT_LLM_MODEL and AGENT_LLM_API_KEY');
  }

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
    deviceStorePath: path.resolve(
      cwd,
      env.GATEWAY_DEVICE_STORE || 'gateway/.data/devices.json',
    ),
    deviceTokenTtlSeconds: parseInteger(
      env.GATEWAY_DEVICE_TOKEN_TTL_SECONDS,
      180 * 24 * 60 * 60,
      60 * 60,
    ),
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
    sessionCookieSameSite: parseSameSite(env.GATEWAY_COOKIE_SAMESITE),
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
    agentEnabled: parseBoolean(env.GATEWAY_AGENT_ENABLED, false),
    agentStorePath: path.resolve(cwd, env.GATEWAY_AGENT_STORE || 'gateway/.data/agent.sqlite'),
    agentModel,
    agentBaseUrl: String(env.AGENT_LLM_BASE_URL || '').trim(),
    agentApiKey: String(env.AGENT_LLM_API_KEY || '').trim(),
    agentMaxSteps: Math.min(30, parseInteger(env.AGENT_MAX_STEPS, 12)),
    agentMaxPreviews: Math.min(5, parseInteger(env.AGENT_MAX_PREVIEWS, 3)),
    agentTimeoutMs: Math.min(60 * 60_000, parseInteger(env.AGENT_TIMEOUT_MS, 20 * 60_000)),
    agentPollMs: Math.max(1000, parseInteger(env.AGENT_POLL_MS, 1500)),
  };
};
