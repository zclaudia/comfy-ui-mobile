import { useEffect, useState } from 'react';
import { comfyAuthenticatedFetch } from '@/infrastructure/auth/ComfyAuthService';
import { isTauriRuntime } from '@/platform/runtime';

interface AuthenticatedMediaState {
  error: Error | null;
  loading: boolean;
  url: string | undefined;
}

export const useAuthenticatedMediaUrl = (
  source: string | null | undefined,
  enabled = true,
): AuthenticatedMediaState => {
  const native = isTauriRuntime();
  const requiresNativeAuthentication = Boolean(native && source && /^https?:\/\//i.test(source));
  const [state, setState] = useState<AuthenticatedMediaState>(() => ({
    error: null,
    loading: Boolean(requiresNativeAuthentication && enabled),
    url: requiresNativeAuthentication ? undefined : source || undefined,
  }));

  useEffect(() => {
    if (!source || !enabled) {
      setState({ error: null, loading: false, url: undefined });
      return;
    }

    if (!requiresNativeAuthentication) {
      setState({ error: null, loading: false, url: source });
      return;
    }

    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ error: null, loading: true, url: undefined });

    void comfyAuthenticatedFetch(source, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Media request failed with HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ error: null, loading: false, url: objectUrl });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
          url: undefined,
        });
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [enabled, requiresNativeAuthentication, source]);

  return state;
};
