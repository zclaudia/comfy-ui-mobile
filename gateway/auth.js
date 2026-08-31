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

export const createSessionManager = (config) => {
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

    const authorization = request.headers.authorization || '';
    if (authorization.startsWith('Bearer ')) {
      return safeEqual(authorization.slice('Bearer '.length).trim(), config.authToken);
    }

    const cookies = parseCookies(request.headers.cookie);
    return validateSession(cookies.get(config.sessionCookieName));
  };

  const authenticateToken = (token) => (
    config.allowAnonymous || safeEqual(token, config.authToken)
  );

  const sessionCookie = ({ value, ttl, persistent }, secure) => {
    const attributes = [
      `${config.sessionCookieName}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
    ];
    if (persistent) attributes.push(`Max-Age=${ttl}`);
    if (secure || config.secureCookies) attributes.push('Secure');
    return attributes.join('; ');
  };

  const clearCookie = (secure) => {
    const attributes = [
      `${config.sessionCookieName}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0',
    ];
    if (secure || config.secureCookies) attributes.push('Secure');
    return attributes.join('; ');
  };

  return {
    authenticate,
    authenticateToken,
    createSession,
    validateSession,
    sessionCookie,
    clearCookie,
  };
};
