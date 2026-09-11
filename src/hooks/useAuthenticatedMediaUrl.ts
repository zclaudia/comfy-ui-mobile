import { useEffect, useState } from 'react';
import { comfyAuthenticatedFetch } from '@/infrastructure/auth/ComfyAuthService';
import { isTauriRuntime } from '@/platform/runtime';

interface AuthenticatedMediaState {
  error: Error | null;
  loading: boolean;
  url: string | undefined;
}

/**
 * Authenticated blob cache shared by every consumer of this hook (gallery video first-frames,
 * chat video covers, session thumbnails...). Gallery list changes and tab switches remount
 * these components constantly; without the cache each remount re-downloaded the whole media
 * file just to re-extract the same first frame. Entries leave the cache only on eviction,
 * never on component unmount, so the same source always resolves to the same blob URL.
 */
const BLOB_CACHE_LIMIT = 24;
const BLOB_CACHE_BYTES = 192 * 1024 * 1024;
const blobCache = new Map<string, { url: string; bytes: number }>();
const blobCacheInflight = new Map<string, Promise<string>>();
let blobCacheBytes = 0;

const blobCacheGet = (source: string): string | undefined => {
  const entry = blobCache.get(source);
  if (!entry) return undefined;
  blobCache.delete(source);
  blobCache.set(source, entry); // refresh LRU position
  return entry.url;
};

const blobCacheEvict = () => {
  while (blobCache.size > BLOB_CACHE_LIMIT || (blobCache.size > 1 && blobCacheBytes > BLOB_CACHE_BYTES)) {
    const oldest = blobCache.keys().next().value;
    if (oldest === undefined) break;
    const entry = blobCache.get(oldest);
    blobCache.delete(oldest);
    if (entry) blobCacheBytes -= entry.bytes;
    if (entry) URL.revokeObjectURL(entry.url);
  }
};

const blobCacheFetch = (source: string): Promise<string> => {
  const existing = blobCacheInflight.get(source);
  if (existing) return existing;
  const promise = comfyAuthenticatedFetch(source)
    .then((response) => {
      if (!response.ok) throw new Error(`Media request failed with HTTP ${response.status}`);
      return response.blob();
    })
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      blobCache.set(source, { url, bytes: blob.size });
      blobCacheBytes += blob.size;
      blobCacheEvict();
      blobCacheInflight.delete(source);
      return url;
    })
    .catch((error) => {
      blobCacheInflight.delete(source);
      throw error;
    });
  blobCacheInflight.set(source, promise);
  return promise;
};

export const useAuthenticatedMediaUrl = (
  source: string | null | undefined,
  enabled = true,
): AuthenticatedMediaState => {
  const native = isTauriRuntime();
  const requiresNativeAuthentication = Boolean(native && source && /^https?:\/\//i.test(source));
  const cachedUrl = source && requiresNativeAuthentication ? blobCacheGet(source) : undefined;
  const [state, setState] = useState<AuthenticatedMediaState>(() => ({
    error: null,
    loading: Boolean(requiresNativeAuthentication && enabled && !cachedUrl),
    url: requiresNativeAuthentication ? cachedUrl : source || undefined,
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

    // Cache hits (including entries added by another consumer while this effect was queued)
    // resolve synchronously and never touch the network.
    const cached = blobCacheGet(source);
    if (cached) {
      setState({ error: null, loading: false, url: cached });
      return;
    }

    let cancelled = false;
    setState({ error: null, loading: true, url: undefined });

    // Not tied to this component's lifecycle on purpose: the fetched blob is shared via the
    // cache, so an early unmount must not abort a download other tiles will reuse.
    void blobCacheFetch(source)
      .then((url) => {
        if (!cancelled) setState({ error: null, loading: false, url });
      })
      .catch((error) => {
        if (!cancelled) setState({
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
          url: undefined,
        });
      });

    return () => { cancelled = true; };
  }, [enabled, requiresNativeAuthentication, source]);

  return state;
};
