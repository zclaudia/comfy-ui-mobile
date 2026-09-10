import type { WorkflowEditorStorage } from '../../components/workflow/WorkflowEditorStorage';
import type { Draft, Asset, AssetBinding } from '../../shared/types/agentWorkspace';
import type { IComfyWorkflow } from '../../shared/types/app/IComfyWorkflow';
import type { IComfyJson } from '../../shared/types/app/IComfyJson';
import { DraftWorkingCopy, draftCopyKey, draftContentSnapshot } from './DraftWorkingCopy';
import type { DraftContent, DraftCopyIdentity } from './DraftWorkingCopy';

// Mirrors the adapted loader inputs. New loader families require a declared role in the compiler too.
export const draftLoaderInputs: Readonly<Record<string, { inputName: string; kind: Asset['kind']; role: string }>> = {
  LoadImage: { inputName: 'image', kind: 'image', role: 'reference_image' },
  LoadVideo: { inputName: 'file', kind: 'video', role: 'reference_video' },
  LoadAudio: { inputName: 'audio', kind: 'audio', role: 'reference_audio' },
};

/** Deleting a loader deletes its binding. A raw widget change cannot retarget an existing binding. */
export function bindingsForCanvas(canvas: IComfyJson, bindings: AssetBinding[]): AssetBinding[] {
  return bindings.filter(binding => {
    const node = canvas.nodes.find(node => String(node.id) === binding.nodeId);
    if (!node) return false;
    const loader = draftLoaderInputs[node.type];
    if (!loader || loader.inputName !== binding.inputName || loader.role !== binding.role
      || node.widgets_values?.[0] !== `asset:${binding.assetId}`) {
      throw new Error('Change this media input through the draft asset picker');
    }
    return true;
  }).map(binding => ({ ...binding }));
}

/** The canvas token and binding form one local checkpoint and one server revision. */
export function bindDraftAsset(content: DraftContent, nodeId: string, asset: Asset, sessionId: string): DraftContent {
  if (asset.sessionId !== sessionId) throw new Error('The asset belongs to another session');
  const next = draftContentSnapshot(content);
  const node = next.canvas.nodes.find(node => String(node.id) === nodeId);
  const loader = node && draftLoaderInputs[node.type];
  if (!node || !loader || asset.kind !== loader.kind) throw new Error('Incompatible draft media input');
  const previous = next.bindings.find(binding => binding.nodeId === nodeId && binding.inputName === loader.inputName);
  const binding: AssetBinding = { id: previous?.id ?? crypto.randomUUID(), nodeId, inputName: loader.inputName,
    role: loader.role, assetId: asset.id };
  if (previous) next.bindings = next.bindings.map(item => item.id === previous.id ? binding : item);
  else next.bindings.push(binding);
  if (next.bindings.length > 8) throw new Error('Too many draft media inputs');
  node.widgets_values = [...(node.widgets_values ?? [])];
  node.widgets_values[0] = `asset:${asset.id}`;
  return next;
}

export class DraftWorkflowStorage implements WorkflowEditorStorage {
  readonly id: string;
  constructor(readonly copy: DraftWorkingCopy, readonly draft: Draft, identity: DraftCopyIdentity, private summary: () => string) {
    if (draft.id !== identity.draftId || draft.sessionId !== identity.sessionId) throw new Error('Invalid editor draft identity');
    this.id = `agent-draft:${draftCopyKey(identity)}`;
  }
  async load(): Promise<IComfyWorkflow> {
    const { canvas } = this.copy.content();
    return { id: this.id, name: this.draft.name, createdAt: new Date(this.draft.created),
      workflow_json: canvas, nodeCount: canvas.nodes.length, isValid: true };
  }
  async checkpoint(canvas: IComfyJson) {
    await this.copy.checkpoint({ canvas, bindings: bindingsForCanvas(canvas, this.copy.content().bindings) });
  }
  async save(workflow: IComfyWorkflow) {
    if (workflow.id !== this.id) throw new Error('Refusing to save a different document through the draft editor');
    await this.checkpoint(workflow.workflow_json);
    await this.copy.flush(this.summary());
  }
}
