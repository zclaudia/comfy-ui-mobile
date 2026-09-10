import type { Draft, Revision } from '../../shared/types/agentWorkspace';
import type { IObjectInfo } from '../../shared/types/comfy/IComfyObjectInfo';

export interface DraftCanvasContext {
  key: string; baseUrl: string; serverId: string; draft: Draft; revision: Revision; cachedAt: number;
}
export interface DraftCanvasEnvironment { key: string; objectInfo: IObjectInfo; cachedAt: number }
export interface DraftCanvasCache {
  readCanvasContext(key: string): Promise<{ context: DraftCanvasContext; environment: DraftCanvasEnvironment } | undefined>;
  saveCanvasContext(context: DraftCanvasContext, environment: DraftCanvasEnvironment): Promise<void>;
}
export const canvasContextKey = (baseUrl: string, sessionId: string, draftId: string, revision: number) =>
  JSON.stringify([baseUrl.replace(/\/$/, ''), sessionId, draftId, revision]);
export const canvasEnvironmentKey = (baseUrl: string, serverId: string) => JSON.stringify([baseUrl.replace(/\/$/, ''), serverId]);
