import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './runtime';
import { getNativeGatewayAuthorization } from './gatewaySession';
import { withComfyAuth } from '@/infrastructure/auth/ComfyAuthService';

const mimeTypes: Record<string, string> = {
  avi: 'video/x-msvideo', gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', mkv: 'video/x-matroska',
  mov: 'video/quicktime', mp4: 'video/mp4', png: 'image/png', webm: 'video/webm', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4',
};
export const getMediaMimeType = (filename: string): string | undefined => mimeTypes[filename.split('.').pop()?.toLowerCase() ?? ''];

/**
 * Native builds hand the URL to the Android download manager; browsers use an anchor.
 * `url` is the plain ComfyUI /view URL; `href` is an already-authenticated URL for the anchor fallback.
 */
export async function downloadMedia({ url, href, filename }: { url: string; href?: string; filename: string }): Promise<void> {
  if (isTauriRuntime() && /^https?:\/\//i.test(url)) {
    const nativeUrl = withComfyAuth(url);
    await invoke('plugin:media-download|enqueue_download', {
      payload: { url: nativeUrl, filename, authorization: getNativeGatewayAuthorization(nativeUrl), mimeType: getMediaMimeType(filename) },
    });
    return;
  }
  const link = document.body.appendChild(document.createElement('a'));
  link.download = filename;
  link.href = href ?? url;
  link.click();
  link.remove();
}
