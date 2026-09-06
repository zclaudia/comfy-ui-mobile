import crypto from 'node:crypto';

const safeEqual = (left, right) => {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
};

const parseCookies = (header = '') => {
  const cookies = new Map();
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
};

const sign = (secret, value) => crypto
  .createHmac('sha256', secret)
  .update(value)
  .digest('base64url');

const bearerToken = (request) => {
  const authorization = request.headers.authorization || '';
  return authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : '';
};

export const createSessionManager = (config, deviceStore) => {
  const createSession = (remember = false) => {
    const ttl = remember
      ? config.rememberedSessionTtlSeconds
      : config.sessionTtlSeconds;
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    const payload = `${expiresAt}.${crypto.randomBytes(18).toString('base64url')}`;
    return {
      value: `${payload}.${sign(config.sessionSecret, payload)}`,
      expiresAt,
      ttl,
      persistent: remember,
    };
  };

  const validateSession = (value) => {
    if (!value) return false;
    const parts = String(value).split('.');
    if (parts.length !== 3) return false;
    const [expiresAtRaw, nonce, signature] = parts;
    const expiresAt = Number.parseInt(expiresAtRaw, 10);
    if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
      return false;
    }
    const payload = `${expiresAtRaw}.${nonce}`;
    return safeEqual(signature, sign(config.sessionSecret, payload));
  };

  const authenticate = (request) => {
    if (config.allowAnonymous) return true;

    const token = bearerToken(request);
    if (token) {
      return safeEqual(token, config.authToken) || deviceStore.authenticate(token);
    }

    const cookies = parseCookies(request.headers.cookie);
    return validateSession(cookies.get(config.sessionCookieName));
  };

  const authenticateSetupToken = (token) => (
    config.allowAnonymous || safeEqual(token, config.authToken)
  );

  const authenticateAdmin = (request) => authenticateSetupToken(bearerToken(request));

  const authenticatedDeviceToken = (request) => {
    const token = bearerToken(request);
    return deviceStore.authenticate(token) ? token : null;
  };

  // Existing setup-token/browser login is one administrator identity, not a user account system.
  // Device tokens get separate durable namespaces; anonymous access cannot run agents.
  const agentPrincipal = (request) => {
    const token = bearerToken(request);
    if (token && config.authToken && safeEqual(token, config.authToken)) return 'administrator';
    if (token && deviceStore.authenticate(token)) return `device:${crypto.createHash('sha256').update(token).digest('hex')}`;
    if (!token && validateSession(parseCookies(request.headers.cookie).get(config.sessionCookieName))) return 'administrator';
    return null;
  };

  // SameSite=None requires Secure in modern browsers, so pair them automatically.
  const cookieSameSite = config.sessionCookieSameSite === 'none' ? 'None' : config.sessionCookieSameSite === 'lax' ? 'Lax' : 'Strict';
  const cookieSecure = (secure) => secure
    || config.secureCookies
    || config.sessionCookieSameSite === 'none';

  const sessionCookie = ({ value, ttl, persistent }, secure) => {
    const attributes = [
      `${config.sessionCookieName}=${value}`,
      'Path=/',
      'HttpOnly',
      `SameSite=${cookieSameSite}`,
    ];
    if (persistent) attributes.push(`Max-Age=${ttl}`);
    if (cookieSecure(secure)) attributes.push('Secure');
    return attributes.join('; ');
  };

  const clearCookie = (secure) => {
    const attributes = [
      `${config.sessionCookieName}=`,
      'Path=/',
      'HttpOnly',
      `SameSite=${cookieSameSite}`,
      'Max-Age=0',
    ];
    if (cookieSecure(secure)) attributes.push('Secure');
    return attributes.join('; ');
  };

  return {
    authenticate,
    authenticateAdmin,
    authenticateSetupToken,
    authenticatedDeviceToken,
    agentPrincipal,
    createSession,
    validateSession,
    sessionCookie,
    clearCookie,
  };
};
