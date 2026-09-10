import type { IComfyWorkflow } from '../../shared/types/app/IComfyWorkflow';
import type { IComfyJson } from '../../shared/types/app/IComfyJson';
import type { ReactNode } from 'react';
import type { IObjectInfo } from '../../shared/types/comfy/IComfyObjectInfo';

/** Editor persistence is supplied by its owner. Draft ids must never enter the library outbox. */
export interface WorkflowEditorStorage {
  id: string;
  load(): Promise<IComfyWorkflow | null>;
  save(workflow: IComfyWorkflow): Promise<void>;
}

export interface WorkflowEditorHandle {
  capture(): Promise<IComfyJson>;
  reload(canvas: IComfyJson): Promise<void>;
}

export interface WorkflowEditorIntegration {
  storage: WorkflowEditorStorage;
  loadObjectInfo?(): Promise<IObjectInfo>;
  forceMobileCanvas?: boolean;
  hasUnsavedChanges: boolean;
  checkpoint(canvas: IComfyJson): Promise<void>;
  execute(canvas: IComfyJson): Promise<void>;
  exit(canvas?: IComfyJson): Promise<void>;
  onError(error: unknown): void;
  openHistory(): void;
  renderActions(execute: () => Promise<void>): ReactNode;
  renderParameter?(nodeId: number, inputName: string, currentValue: unknown): ReactNode | undefined;
}
