import { isTauriRuntime } from '@/platform/runtime';

const trimTrailingSlash = (value: string): string => value.trim().replace(/\/$/, '');

export const getDefaultGatewayUrl = (): string => {
  const configuredUrl = import.meta.env.VITE_GATEWAY_URL;
  if (configuredUrl?.trim()) return trimTrailingSlash(configuredUrl);
  // A packaged Tauri UI is served from tauri.localhost, not from the Gateway.
  // Force explicit configuration instead of accidentally targeting the app's
  // internal asset origin.
  if (isTauriRuntime()) return '';
  return trimTrailingSlash(window.location.origin);
};

export const resolveGatewayUrl = (value?: string | null): string => (
  value?.trim() ? trimTrailingSlash(value) : getDefaultGatewayUrl()
);
