import type { SourceRef } from '../../infrastructure/api/AgentApi';

export const LAST_TAB_KEY = 'comfy_mobile_last_tab';
export type TabPath = '/chats' | '/workflows' | '/outputs';
export const TAB_PATHS: TabPath[] = ['/chats', '/workflows', '/outputs'];

/** Suggestion chips prefill the composer with these; the assistant picks the template from the description. */
export const NEW_CHAT_PRESETS = {
  image: '生成一张 1024×1024 的图片：',
  video: '用 H3 生成一段 1 秒的短视频：',
} as const;

/** Library workflows are addressed across devices by `serverId + workflowId`; the server id is the normalised ComfyUI origin. */
export function serverIdOf(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

export function chooseDefaultTab(lastTab: string | null, agentAvailable: boolean): TabPath {
  if (lastTab === '/chats' && !agentAvailable) return '/workflows';
  if (lastTab && (TAB_PATHS as string[]).includes(lastTab)) return lastTab as TabPath;
  return agentAvailable ? '/chats' : '/workflows';
}

/** Names new sessions get before anyone renames them; they must fall through to the preview. Keep in sync with `agentUI.新对话` (and the older `新工作流`). */
export const SESSION_NAME_PLACEHOLDERS = new Set(['新对话', 'New chat', '新しいチャット', '새 대화', '新工作流', 'New workflow', '新しいワークフロー', '새 워크플로']);

/** A name the user actually chose → the first message → the fallback. The source workflow's name is never the title. */
export function sessionTitle(session: { name?: string; preview?: string; sourceRef?: SourceRef }, fallback: string): string {
  const name = session.name?.trim();
  if (name && !SESSION_NAME_PLACEHOLDERS.has(name)) return name;
  return session.preview?.trim() || fallback;
}

/** Session-list timestamps. Kept next to the other pure chat helpers so the list pages share one implementation. */
export function relativeTime(timestamp: number, now: number, at: (text: string, values?: Record<string, string | number>) => string): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return at('刚刚');
  if (minutes < 60) return at('{{count}} 分钟前', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return at('{{count}} 小时前', { count: hours });
  const days = Math.round(hours / 24);
  if (days < 7) return at('{{count}} 天前', { count: days });
  return new Date(timestamp).toLocaleDateString();
}
