import type { AgentAttachmentKind } from '../../infrastructure/api/AgentApi';

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
/** Uploads land in ComfyUI's input folder under this subfolder so they never collide with the user's own assets. */
export const ATTACHMENT_SUBFOLDER = 'agent-chat';
export const ACCEPT = 'image/*,video/*,audio/*';

const imageExt = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|heic|heif)$/i;
const videoExt = /\.(mp4|webm|mkv|mov|m4v|avi)$/i;
const audioExt = /\.(wav|mp3|flac|ogg|m4a|aac|opus)$/i;

/** Mobile browsers sometimes omit the MIME type for camera captures, so the extension breaks ties. */
export function attachmentKind(file: { name: string; type?: string }): AgentAttachmentKind {
  const type = file.type ?? '';
  if (type.startsWith('image/') || imageExt.test(file.name)) return 'image';
  if (type.startsWith('video/') || videoExt.test(file.name)) return 'video';
  if (type.startsWith('audio/') || audioExt.test(file.name)) return 'audio';
  return 'file';
}

/** Returns a translatable rejection reason, or null when the file may be attached. */
export function rejectReason(file: { name: string; size: number; type?: string }, current: number): string | null {
  if (current >= MAX_ATTACHMENTS) return '最多添加 {{count}} 个附件';
  if (file.size > MAX_ATTACHMENT_BYTES) return '文件过大，单个附件不能超过 200MB';
  if (attachmentKind(file) === 'file') return '仅支持图片、视频和音频';
  return null;
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
