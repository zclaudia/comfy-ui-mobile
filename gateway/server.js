import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { createSessionManager } from './auth.js';
import { createDeviceStore } from './deviceStore.js';
import { comfyFrontendRoute, comfyFrameAncestors, comfyAssetPreviewId } from './comfyFrontend.js';
import { createCanvasAccess } from './canvasAccess.js';
import {
  authorizeProxyRoute,
  isAllowedWebSocketPath,
  isReservedApiPath,
} from './routes.js';

const GATEWAY_VERSION = '0.3.0';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);

const sendJson = (response, status, body, extraHeaders = {}) => {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...extraHeaders,
  });
  response.end(payload);
};

const requestIsSecure = (request, config) => (
  request.socket.encrypted === true
  || (config.trustProxy && request.headers['x-forwarded-proto'] === 'https')
);

const requestOrigin = (request, config) => {
  const protocol = requestIsSecure(request, config) ? 'https' : 'http';
  return `${protocol}://${request.headers.host}`;
};

const isOriginAllowed = (request, config) => {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === requestOrigin(request, config) || config.allowedOrigins.has(origin);
};

const applyGatewayHeaders = (response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
};

const applyCorsHeaders = (request, response, config) => {
  const origin = request.headers.origin;
  if (!origin || !isOriginAllowed(request, config)) return;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Vary', 'Origin');
};

const readJsonBody = (request, maximumBytes = 64 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let total = 0;
  request.on('data', (chunk) => {
    total += chunk.length;
    if (total > maximumBytes) {
      reject(new Error('request_body_too_large'));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(raw ? JSON.parse(raw) : {});
    } catch {
      reject(new Error('invalid_json'));
    }
  });
  request.on('error', reject);
});

const createRateLimiter = () => {
  const buckets = new Map();
  return (key, maximum) => {
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    current.count += 1;
    return current.count <= maximum;
  };
};

const clientAddress = (request, config) => (
  String(
    (config.trustProxy && request.headers['x-forwarded-for'])
    || request.socket.remoteAddress
    || 'unknown',
  )
    .split(',')[0]
    .trim()
);

const sanitizeRequestHeaders = (headers, target, request, config) => {
  const sanitized = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (
      value === undefined
      || HOP_BY_HOP_HEADERS.has(lowerName)
      || lowerName === 'host'
      || lowerName === 'cookie'
      || lowerName === 'authorization'
      || lowerName === 'origin'
      || lowerName.startsWith('sec-fetch-')
    ) continue;
    sanitized[name] = value;
  }
  sanitized.host = target.host;
  // The Gateway is the sole client ComfyUI sees; forwarding the browser's
  // cross-site marker trips ComfyUI's CSRF protection with a bare 403.
  sanitized['sec-fetch-site'] = 'same-origin';
  sanitized['x-forwarded-for'] = clientAddress(request, config);
  sanitized['x-forwarded-host'] = request.headers.host || '';
  sanitized['x-forwarded-proto'] = requestIsSecure(request, config) ? 'https' : 'http';
  return sanitized;
};

const sanitizeResponseHeaders = (headers) => {
  const sanitized = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (
      value === undefined
      || HOP_BY_HOP_HEADERS.has(lowerName)
      || lowerName === 'set-cookie'
      || lowerName.startsWith('access-control-')
    ) continue;
    sanitized[name] = value;
  }
  return sanitized;
};

const buildUpstreamUrl = (
  requestUrl,
  upstreamUrl,
  upstreamAuthToken = '',
  websocket = false,
) => {
  const upstreamBase = new URL(upstreamUrl);
  if (websocket) upstreamBase.protocol = upstreamBase.protocol === 'https:' ? 'wss:' : 'ws:';
  const target = new URL(requestUrl, upstreamBase);
  target.searchParams.delete('token');
  if (upstreamAuthToken) target.searchParams.set('token', upstreamAuthToken);
  return target;
};

const proxyHttpRequest = (
  request,
  response,
  config,
  upstreamUrl = config.comfyUrl,
  upstreamRequestUrl = request.url,
  upstreamAuthToken = config.comfyAuthToken,
  frameAncestors,
) => {
  const target = buildUpstreamUrl(upstreamRequestUrl, upstreamUrl, upstreamAuthToken);
  const contentLength = Number.parseInt(String(request.headers['content-length'] || '0'), 10);
  if (Number.isFinite(contentLength) && contentLength > config.maxBodyBytes) {
    sendJson(response, 413, { error: 'request_body_too_large' });
    return;
  }

  const transport = target.protocol === 'https:' ? https : http;
  const upstreamRequest = transport.request(target, {
    method: request.method,
    headers: sanitizeRequestHeaders(request.headers, target, request, config),
    timeout: config.requestTimeoutMs,
  }, (upstreamResponse) => {
    const headers = sanitizeResponseHeaders(upstreamResponse.headers);
    if (request.canvasAccess) {
      headers['referrer-policy'] = 'no-referrer';
      headers['cache-control'] = 'no-store';
    }
    if (frameAncestors) {
      response.removeHeader('X-Frame-Options');
      delete headers['x-frame-options'];
      const policy = String(headers['content-security-policy'] || '').split(';').filter(part => !/^\s*frame-ancestors(?:\s|$)/i.test(part)).filter(part => part.trim()).join('; ');
      headers['content-security-policy'] = `${policy ? `${policy}; ` : ''}${frameAncestors}`;
    }
    response.writeHead(upstreamResponse.statusCode || 502, headers);
    pipeline(upstreamResponse, response, (error) => {
      if (error && !response.destroyed) response.destroy(error);
    });
  });

  let receivedBytes = 0;
  request.on('data', (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes > config.maxBodyBytes) {
      upstreamRequest.destroy(new Error('request_body_too_large'));
      if (!response.headersSent) sendJson(response, 413, { error: 'request_body_too_large' });
      request.destroy();
    }
  });

  upstreamRequest.on('timeout', () => {
    upstreamRequest.destroy(new Error('upstream_timeout'));
  });
  upstreamRequest.on('error', (error) => {
    if (!response.headersSent) {
      sendJson(response, 502, { error: 'upstream_unavailable', message: error.message });
    } else if (!response.destroyed) {
      response.destroy(error);
    }
  });
  request.pipe(upstreamRequest);
};

const serveStaticFile = (request, response, config, pathname) => {
  if (!['GET', 'HEAD'].includes(request.method)) return false;

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: 'invalid_path' });
    return true;
  }

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const staticRoot = path.resolve(config.staticDir);
  let filePath = path.resolve(staticRoot, relativePath);
  const isWithinRoot = filePath === staticRoot || filePath.startsWith(`${staticRoot}${path.sep}`);
  if (!isWithinRoot) {
    sendJson(response, 400, { error: 'invalid_path' });
    return true;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    filePath = path.join(staticRoot, 'index.html');
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;

  const stat = fs.statSync(filePath);
  const isHashedAsset = relativePath.startsWith('assets/');
  response.writeHead(200, {
    'Content-Type': MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': isHashedAsset
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(filePath).pipe(response);
  return true;
};

const rejectUpgrade = (socket, status, message) => {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n`
      + JSON.stringify({ error: message.toLowerCase().replaceAll(' ', '_') }),
  );
  socket.destroy();
};

const safeWebSocketCloseCode = (code) => {
  const reserved = new Set([1004, 1005, 1006, 1015]);
  if ((code >= 1000 && code <= 1014 && !reserved.has(code)) || (code >= 3000 && code <= 4999)) {
    return code;
  }
  return 1000;
};

const proxyWebSocket = (client, request, config, upstreamRequestUrl = request.url) => {
  const target = buildUpstreamUrl(
    upstreamRequestUrl,
    config.comfyUrl,
    config.comfyAuthToken,
    true,
  );
  const upstream = new WebSocket(target, {
    headers: {
      'x-forwarded-for': clientAddress(request, config),
      'x-forwarded-host': request.headers.host || '',
      'x-forwarded-proto': requestIsSecure(request, config) ? 'https' : 'http',
    },
    maxPayload: config.maxWsPayloadBytes,
  });
  const pendingMessages = [];

  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (pendingMessages.length < 32) pendingMessages.push({ data, isBinary });
  });

  upstream.on('open', () => {
    for (const message of pendingMessages) {
      upstream.send(message.data, { binary: message.isBinary });
    }
    pendingMessages.length = 0;
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on('close', (code, reason) => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(safeWebSocketCloseCode(code), reason.toString());
    }
  });
  client.on('close', (code, reason) => {
    if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(upstream.readyState)) {
      if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      else upstream.close(safeWebSocketCloseCode(code), reason.toString());
    }
  });
  upstream.on('error', () => {
    if (client.readyState === WebSocket.OPEN) client.close(1011, 'Upstream WebSocket unavailable');
  });
  client.on('error', () => {
    if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(upstream.readyState)) upstream.terminate();
  });
};

export const createGatewayServer = (config, { agentService, agentRequestHandler, frontendAssetProvider } = {}) => {
  let agent = agentService;
  let agentHandler = agentRequestHandler;
  const deviceStore = createDeviceStore(config);
  const sessions = createSessionManager(config, deviceStore);
  const canvasAccess = createCanvasAccess(sessions, { cookieName: config.sessionCookieName });
  const rateLimit = createRateLimiter();
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxWsPayloadBytes,
  });

  const server = http.createServer(async (request, response) => {
    applyGatewayHeaders(response);
    applyCorsHeaders(request, response, config);

    if (!isOriginAllowed(request, config)) {
      sendJson(response, 403, { error: 'origin_not_allowed' });
      return;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Agent-Schema-Version, X-Agent-Server-Id',
        'Access-Control-Max-Age': '600',
      });
      response.end();
      return;
    }

    let url;
    try {
      url = new URL(request.url, requestOrigin(request, config));
    } catch {
      sendJson(response, 400, { error: 'invalid_url' });
      return;
    }

    if (url.pathname === '/api/gateway/health' && request.method === 'GET') {
      sendJson(response, 200, {
        status: 'ok',
        version: GATEWAY_VERSION,
        authenticationRequired: !config.allowAnonymous,
      });
      return;
    }

    if (url.pathname === '/api/gateway/login' && request.method === 'POST') {
      if (!rateLimit(`login:${clientAddress(request, config)}`, config.loginRateLimitPerMinute)) {
        sendJson(response, 429, { error: 'too_many_login_attempts' });
        return;
      }
      try {
        const body = await readJsonBody(request);
        if (!sessions.authenticateSetupToken(String(body.token ?? ''))) {
          sendJson(response, 401, { error: 'invalid_gateway_token' });
          return;
        }
        const session = sessions.createSession(body.remember === true);
        response.setHeader(
          'Set-Cookie',
          sessions.sessionCookie(session, requestIsSecure(request, config)),
        );
        sendJson(response, 200, { authenticated: true, expiresAt: session.expiresAt });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    if (url.pathname === '/api/gateway/devices/register' && request.method === 'POST') {
      if (!rateLimit(`register:${clientAddress(request, config)}`, config.loginRateLimitPerMinute)) {
        sendJson(response, 429, { error: 'too_many_registration_attempts' });
        return;
      }
      try {
        const body = await readJsonBody(request);
        if (!sessions.authenticateSetupToken(String(body.token ?? ''))) {
          sendJson(response, 401, { error: 'invalid_gateway_token' });
          return;
        }
        const registration = await deviceStore.register(body.deviceName);
        sendJson(response, 201, {
          authenticated: true,
          device: registration.device,
          deviceToken: registration.token,
        });
      } catch (error) {
        const clientError = ['device_name_required', 'device_name_too_long'].includes(error.message);
        sendJson(response, clientError ? 400 : 500, {
          error: clientError ? error.message : 'device_registration_failed',
        });
      }
      return;
    }

    if (url.pathname === '/api/gateway/devices' && request.method === 'GET') {
      if (!sessions.authenticateAdmin(request)) {
        sendJson(response, 401, { error: 'gateway_admin_authentication_required' });
        return;
      }
      sendJson(response, 200, { devices: deviceStore.list() });
      return;
    }

    if (url.pathname === '/api/gateway/device' && request.method === 'DELETE') {
      const token = sessions.authenticatedDeviceToken(request);
      if (!token) {
        sendJson(response, 401, { error: 'device_authentication_required' });
        return;
      }
      try {
        const device = await deviceStore.revokeToken(token);
        sendJson(response, 200, { device, authenticated: false });
      } catch {
        sendJson(response, 500, { error: 'device_revocation_failed' });
      }
      return;
    }

    const devicePathMatch = url.pathname.match(/^\/api\/gateway\/devices\/([^/]+)$/);
    if (devicePathMatch && request.method === 'DELETE') {
      if (!sessions.authenticateAdmin(request)) {
        sendJson(response, 401, { error: 'gateway_admin_authentication_required' });
        return;
      }
      let deviceId;
      try {
        deviceId = decodeURIComponent(devicePathMatch[1]);
      } catch {
        sendJson(response, 400, { error: 'invalid_device_id' });
        return;
      }
      try {
        const device = await deviceStore.revoke(deviceId);
        if (!device) {
          sendJson(response, 404, { error: 'device_not_found' });
          return;
        }
        sendJson(response, 200, { device });
      } catch {
        sendJson(response, 500, { error: 'device_revocation_failed' });
      }
      return;
    }

    if (url.pathname === '/api/gateway/logout' && request.method === 'POST') {
      canvasAccess.revokeCredentials(request);
      response.setHeader('Set-Cookie', sessions.clearCookie(requestIsSecure(request, config)));
      sendJson(response, 200, { authenticated: false });
      return;
    }

    if (url.pathname === '/api/gateway/session' && request.method === 'GET') {
      const authenticated = sessions.authenticate(request);
      sendJson(response, authenticated ? 200 : 401, { authenticated });
      return;
    }

    const accessPath = /^\/api\/gateway\/canvas-access(?:\/([A-Za-z0-9_-]{43})(\/renew)?)?$/.exec(url.pathname);
    if (accessPath) {
      response.setHeader('Cache-Control', 'no-store');
      if (!rateLimit(`canvas-access:${clientAddress(request, config)}`, config.rateLimitPerMinute)) { sendJson(response, 429, { error: 'rate_limit_exceeded' }); return; }
      try {
        await readJsonBody(request, 1024);
        if (request.method === 'POST' && !accessPath[1]) { sendJson(response, 201, canvasAccess.issue(request)); return; }
        if (request.method === 'POST' && accessPath[2]) { sendJson(response, 200, canvasAccess.renew(request, accessPath[1])); return; }
        // Possession permits revoking this one read capability; it grants no data mutation.
        if (request.method === 'DELETE' && accessPath[1] && !accessPath[2]) { canvasAccess.revoke(accessPath[1]); sendJson(response, 200, { revoked: true }); return; }
        sendJson(response, 405, { error: 'method_not_allowed' });
      } catch (error) {
        const status = error.status || (error.message === 'invalid_json' ? 400 : error.message === 'request_body_too_large' ? 413 : 500);
        sendJson(response, status, { error: status < 500 ? error.message : 'canvas_connection_failed' });
      }
      return;
    }
    try {
      const access = canvasAccess.resolve(request, url.pathname);
      if (access) {
        url.pathname = access.pathname;
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Cache-Control', 'no-store');
      }
    } catch (error) { sendJson(response, error.status || 401, { error: error.message }); return; }

    const previewAssetId = comfyAssetPreviewId(url, request.method);
    if (previewAssetId) {
      url.pathname = `/api/gateway/agent/assets/${previewAssetId}/content`;
      url.search = '';
    }
    if (url.pathname.startsWith('/api/gateway/agent/')) {
      // The principal is per-client so devices keep separate rate-limit buckets; the owner is shared so they see the
      // same sessions.
      const principal = sessions.agentPrincipal(request);
      const owner = sessions.agentOwner(request);
      if (!principal || !owner) { sendJson(response, 401, { error: 'gateway_authentication_required' }); return; }
      if (!rateLimit(`agent:${principal}`, config.rateLimitPerMinute)) { sendJson(response, 429, { error: 'rate_limit_exceeded' }); return; }
      if (!agent || !agentHandler) { sendJson(response, 503, { enabled: false, providerReady: false, error: '当前 Gateway 尚未启用工作流助手' }); return; }
      await agentHandler(agent, owner, request, response, url);
      return;
    }

    if (url.pathname.startsWith('/api/gateway/launcher/')) {
      if (!sessions.authenticate(request)) {
        sendJson(response, 401, { error: 'gateway_authentication_required' });
        return;
      }
      if (!rateLimit(`api:${clientAddress(request, config)}`, config.rateLimitPerMinute)) {
        sendJson(response, 429, { error: 'rate_limit_exceeded' });
        return;
      }

      const launcherPath = url.pathname.slice('/api/gateway/launcher'.length);
      const launcherRouteAllowed = (
        request.method === 'GET'
        && ['/status', '/logs', '/api/update/check', '/api/update/status'].includes(launcherPath)
      ) || (
        request.method === 'POST'
        && ['/restart', '/api/update/download'].includes(launcherPath)
      );
      if (!launcherRouteAllowed) {
        sendJson(response, 404, { error: 'launcher_route_not_allowed' });
        return;
      }
      if (
        request.method === 'POST'
        && !config.allowDangerousActions
      ) {
        sendJson(response, 403, { error: 'dangerous_action_disabled' });
        return;
      }
      if (!config.launcherUrl) {
        sendJson(response, 503, { error: 'launcher_not_configured' });
        return;
      }
      proxyHttpRequest(
        request,
        response,
        config,
        config.launcherUrl,
        `${launcherPath}${url.search}`,
        '',
      );
      return;
    }

    const frontend = comfyFrontendRoute(url.pathname, request.method, config);
    if (frontend) {
      if (!sessions.authenticate(request)) { sendJson(response, 401, { error: 'gateway_authentication_required' }); return; }
      if (!frontend.allowed) { sendJson(response, frontend.status || 404, { error: frontend.code || 'frontend_route_not_allowed' }); return; }
      if (!rateLimit(`api:${clientAddress(request, config)}`, config.rateLimitPerMinute)) { sendJson(response, 429, { error: 'rate_limit_exceeded' }); return; }
      // Internal fixture seam for testing a matching extension without deploying to ComfyUI.
      const localAsset = ['GET', 'HEAD'].includes(request.method) && frontendAssetProvider?.(frontend.upstreamPath);
      if (localAsset) {
        response.writeHead(200, { 'Content-Type': localAsset.contentType, 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : localAsset.body); return;
      }
      proxyHttpRequest(request, response, config, config.comfyUrl, `${frontend.upstreamPath}${url.search}`, config.comfyAuthToken, frontend.document ? comfyFrameAncestors(config) : undefined);
      return;
    }

    const route = authorizeProxyRoute(url.pathname, request.method, config);
    if (route.allowed || route.status === 403) {
      if (!sessions.authenticate(request)) {
        sendJson(response, 401, { error: 'gateway_authentication_required' }, {
          'WWW-Authenticate': 'Bearer realm="comfy-mobile-gateway"',
        });
        return;
      }
      if (!rateLimit(`api:${clientAddress(request, config)}`, config.rateLimitPerMinute)) {
        sendJson(response, 429, { error: 'rate_limit_exceeded' });
        return;
      }
      if (route.allowed) proxyHttpRequest(request, response, config);
      else sendJson(response, 403, { error: route.code });
      return;
    }

    if (isReservedApiPath(url.pathname)) {
      sendJson(response, route.status || 404, { error: route.code || 'route_not_allowed' });
      return;
    }

    if (!serveStaticFile(request, response, config, url.pathname)) {
      sendJson(response, 404, { error: 'not_found' });
    }
  });

  server.on('upgrade', (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, requestOrigin(request, config));
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (!isOriginAllowed(request, config)) {
      rejectUpgrade(socket, 403, 'Origin Not Allowed');
      return;
    }
    let access;
    try { access = canvasAccess.resolve(request, url.pathname); if (access) url.pathname = access.pathname; }
    catch { rejectUpgrade(socket, 401, 'Unauthorized'); return; }
    const socketPath = url.pathname.startsWith('/comfy/') ? url.pathname.slice('/comfy'.length) : url.pathname;
    if (!isAllowedWebSocketPath(socketPath)) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!sessions.authenticate(request)) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      if (access) canvasAccess.watch(access.id, client);
      proxyWebSocket(client, request, config, `${socketPath}${url.search}`);
    });
  });

  return {
    server,
    start: async () => {
      if (config.agentEnabled || agent) {
        const [{ AgentService }, { handleAgentRequest }] = await Promise.all([
          import('./dist/agent/service.js'), import('./dist/agent/routes.js'),
        ]);
        agent ??= new AgentService(config);
        agentHandler ??= handleAgentRequest;
        agent.start();
      }
      return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve(server.address());
      });
      });
    },
    stop: async () => {
      canvasAccess.clear();
      await agent?.stop();
      return new Promise((resolve, reject) => {
      webSocketServer.clients.forEach((client) => client.terminate());
      server.closeIdleConnections?.();
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections?.();
      });
    },
  };
};
