import {
  clearNativeGatewaySession,
  getNativeGatewayAuthorization,
  getNativeGatewaySession as getNativeDeviceSession,
  persistNativeGatewaySession,
  removePersistedNativeGatewaySession,
  restoreNativeGatewaySession,
  setNativeGatewaySession,
} from '@/platform/gatewaySession';
import { platformFetch } from '@/platform/http';
import { isTauriRuntime } from '@/platform/runtime';

export interface GatewayLoginResult {
  authenticated: boolean;
  expiresAt?: number;
  storage?: 'cookie' | 'keystore' | 'memory';
}

interface GatewayDeviceRegistration {
  authenticated: boolean;
  deviceToken: string;
  device: {
    id: string;
    name: string;
    createdAt: number;
    expiresAt: number;
    revokedAt: number | null;
  };
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
    const registrationResponse = await platformFetch(
      gatewayEndpoint(gatewayUrl, '/api/gateway/devices/register'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token.trim(),
          deviceName: 'Comfy Mobile Android',
        }),
      },
    );
    if (!registrationResponse.ok) throw new Error(await readGatewayError(registrationResponse));

    const registration = await registrationResponse.json() as GatewayDeviceRegistration;
    setNativeGatewaySession(
      gatewayUrl,
      registration.deviceToken,
      registration.device.id,
      registration.device.expiresAt,
    );
    const sessionUrl = gatewayEndpoint(gatewayUrl, '/api/gateway/session');
    const authorization = getNativeGatewayAuthorization(sessionUrl);
    const response = await platformFetch(sessionUrl, {
      headers: authorization ? { Authorization: authorization } : undefined,
    });
    if (!response.ok) {
      const gatewayError = await readGatewayError(response);
      await platformFetch(gatewayEndpoint(gatewayUrl, '/api/gateway/device'), {
        method: 'DELETE',
        headers: authorization ? { Authorization: authorization } : undefined,
      }).catch(() => undefined);
      clearNativeGatewaySession();
      throw new Error(gatewayError);
    }

    const isAndroid = /Android/i.test(globalThis.navigator?.userAgent || '');
    try {
      await persistNativeGatewaySession();
      return {
        authenticated: true,
        expiresAt: registration.device.expiresAt,
        storage: 'keystore',
      };
    } catch (error) {
      if (!isAndroid) {
        return {
          authenticated: true,
          expiresAt: registration.device.expiresAt,
          storage: 'memory',
        };
      }
      await platformFetch(gatewayEndpoint(gatewayUrl, '/api/gateway/device'), {
        method: 'DELETE',
        headers: authorization ? { Authorization: authorization } : undefined,
      }).catch(() => undefined);
      clearNativeGatewaySession();
      throw new Error(`Unable to secure the Android device credential: ${String(error)}`);
    }
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
  let authorization = getNativeGatewayAuthorization(sessionUrl);
  if (isTauriRuntime() && !authorization) {
    await restoreNativeGatewaySession(gatewayUrl);
    authorization = getNativeGatewayAuthorization(sessionUrl);
  }
  const response = await platformFetch(sessionUrl, {
    credentials: isTauriRuntime() ? 'omit' : 'include',
    headers: authorization ? { Authorization: authorization } : undefined,
  });
  return response.ok;
};

export const logoutFromGateway = async (gatewayUrl: string): Promise<void> => {
  if (isTauriRuntime()) {
    const session = getNativeDeviceSession();
    const authorization = getNativeGatewayAuthorization(gatewayUrl);
    try {
      if (session && authorization) {
        await platformFetch(gatewayEndpoint(gatewayUrl, '/api/gateway/device'), {
          method: 'DELETE',
          headers: { Authorization: authorization },
        });
      }
    } finally {
      clearNativeGatewaySession();
      await removePersistedNativeGatewaySession().catch(() => undefined);
    }
    return;
  }

  await platformFetch(gatewayEndpoint(gatewayUrl, '/api/gateway/logout'), {
    method: 'POST',
    credentials: 'include',
  });
};
