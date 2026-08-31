import {
  clearNativeGatewaySession,
  getNativeGatewayAuthorization,
  setNativeGatewaySession,
} from '@/platform/gatewaySession';
import { platformFetch } from '@/platform/http';
import { isTauriRuntime } from '@/platform/runtime';

export interface GatewayLoginResult {
  authenticated: boolean;
  expiresAt?: number;
  storage?: 'cookie' | 'memory';
}

const gatewayEndpoint = (gatewayUrl: string, path: string): string => (
  `${gatewayUrl.trim().replace(/\/$/, '')}${path}`
);

const readGatewayError = async (response: Response): Promise<string> => {
  try {
    const body = await response.json();
    return body.error || `Gateway returned HTTP ${response.status}`;
  } catch {
    return `Gateway returned HTTP ${response.status}`;
  }
};

export const loginToGateway = async (
  gatewayUrl: string,
  token: string,
  remember: boolean,
): Promise<GatewayLoginResult> => {
  if (isTauriRuntime()) {
    setNativeGatewaySession(gatewayUrl, token);
    const sessionUrl = gatewayEndpoint(gatewayUrl, '/api/gateway/session');
    const authorization = getNativeGatewayAuthorization(sessionUrl);
    const response = await platformFetch(sessionUrl, {
      headers: authorization ? { Authorization: authorization } : undefined,
    });
    if (!response.ok) {
      clearNativeGatewaySession();
      throw new Error(await readGatewayError(response));
    }
    return { authenticated: true, storage: 'memory' };
  }

  const response = await platformFetch(gatewayEndpoint(gatewayUrl, '/api/gateway/login'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token.trim(), remember }),
  });

  if (!response.ok) throw new Error(await readGatewayError(response));
  return response.json();
};

export const getGatewaySession = async (gatewayUrl: string): Promise<boolean> => {
  const sessionUrl = gatewayEndpoint(gatewayUrl, '/api/gateway/session');
  const authorization = getNativeGatewayAuthorization(sessionUrl);
  const response = await platformFetch(sessionUrl, {
    credentials: isTauriRuntime() ? 'omit' : 'include',
    headers: authorization ? { Authorization: authorization } : undefined,
  });
  return response.ok;
};

export const logoutFromGateway = async (gatewayUrl: string): Promise<void> => {
  clearNativeGatewaySession();
  await platformFetch(gatewayEndpoint(gatewayUrl, '/api/gateway/logout'), {
    method: 'POST',
    credentials: isTauriRuntime() ? 'omit' : 'include',
  });
};
