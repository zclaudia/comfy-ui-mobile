import { invoke } from '@tauri-apps/api/core';

const SECURE_SESSION_KEY = 'gateway-session-v1';

export interface NativeGatewaySession {
  origin: string;
  token: string;
  deviceId: string;
  expiresAt: number;
}

interface SecureSecretResponse {
  value?: string;
}

let nativeGatewaySession: NativeGatewaySession | null = null;

const toHttpOrigin = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    return url.origin;
  } catch {
    return null;
  }
};

const isValidSession = (value: unknown): value is NativeGatewaySession => {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<NativeGatewaySession>;
  return typeof session.origin === 'string'
    && toHttpOrigin(session.origin) === session.origin
    && typeof session.token === 'string'
    && session.token.startsWith('cmdt_')
    && typeof session.deviceId === 'string'
    && session.deviceId.startsWith('dev_')
    && typeof session.expiresAt === 'number'
    && session.expiresAt > Math.floor(Date.now() / 1000);
};

export const setNativeGatewaySession = (
  gatewayUrl: string,
  token: string,
  deviceId: string,
  expiresAt: number,
): void => {
  const origin = toHttpOrigin(gatewayUrl);
  const session = {
    origin: origin || '',
    token: token.trim(),
    deviceId,
    expiresAt,
  };
  nativeGatewaySession = isValidSession(session) ? session : null;
};

export const getNativeGatewaySession = (): NativeGatewaySession | null => (
  nativeGatewaySession ? { ...nativeGatewaySession } : null
);

export const persistNativeGatewaySession = async (): Promise<void> => {
  if (!nativeGatewaySession) throw new Error('No valid Gateway device session to persist');
  await invoke('plugin:secure-credentials|set_secret', {
    payload: {
      key: SECURE_SESSION_KEY,
      value: JSON.stringify(nativeGatewaySession),
    },
  });
};

export const restoreNativeGatewaySession = async (
  gatewayUrl?: string,
): Promise<boolean> => {
  try {
    const response = await invoke<SecureSecretResponse>(
      'plugin:secure-credentials|get_secret',
      { payload: { key: SECURE_SESSION_KEY } },
    );
    const session = response.value ? JSON.parse(response.value) : null;
    if (!isValidSession(session)) {
      nativeGatewaySession = null;
      return false;
    }
    if (gatewayUrl && toHttpOrigin(gatewayUrl) !== session.origin) return false;
    nativeGatewaySession = session;
    return true;
  } catch {
    nativeGatewaySession = null;
    return false;
  }
};

export const removePersistedNativeGatewaySession = async (): Promise<void> => {
  await invoke('plugin:secure-credentials|remove_secret', {
    payload: { key: SECURE_SESSION_KEY },
  });
};

export const clearNativeGatewaySession = (): void => {
  nativeGatewaySession = null;
};

export const getNativeGatewayAuthorization = (requestUrl: string): string | null => {
  const origin = toHttpOrigin(requestUrl);
  if (
    !origin
    || nativeGatewaySession?.origin !== origin
    || nativeGatewaySession.expiresAt <= Math.floor(Date.now() / 1000)
  ) return null;
  return `Bearer ${nativeGatewaySession.token}`;
};
