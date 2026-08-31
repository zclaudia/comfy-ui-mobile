interface NativeGatewaySession {
  origin: string;
  token: string;
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

/**
 * Tauri phase-one credentials deliberately live in memory only. Persisting a
 * shared Gateway token in WebView storage or embedding it in the APK would be
 * unsafe. Device enrollment backed by Android Keystore is a later phase.
 */
export const setNativeGatewaySession = (gatewayUrl: string, token: string): void => {
  const origin = toHttpOrigin(gatewayUrl);
  const normalizedToken = token.trim();
  nativeGatewaySession = origin && normalizedToken
    ? { origin, token: normalizedToken }
    : null;
};

export const clearNativeGatewaySession = (): void => {
  nativeGatewaySession = null;
};

export const getNativeGatewayAuthorization = (requestUrl: string): string | null => {
  const origin = toHttpOrigin(requestUrl);
  if (!origin || nativeGatewaySession?.origin !== origin) return null;
  return `Bearer ${nativeGatewaySession.token}`;
};
