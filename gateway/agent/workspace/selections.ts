import { randomUUID } from 'node:crypto';
import { AgentHttpError, activeStates } from '../store.js';
import { canonicalJson } from './digest.js';
import { WorkspaceRepository } from './repository.js';
import type { Selection } from './types.js';

export interface SelectionRequest { requestId: string; question: string; candidates: Selection['candidates']; multiple?: boolean }

/** Selection and resumption are one durable transaction; a UI focus change never answers a question. */
export class WorkspaceSelections {
  constructor(readonly repository: WorkspaceRepository) {}
  get(sessionId: string, id: string): Selection {
    const row = this.repository.db.prepare('SELECT data FROM workspace_selections WHERE session_id=? AND id=?').get(sessionId, id);
    if (!row) throw new AgentHttpError(404, '本对话中找不到该选择问题');
    return JSON.parse(String(row.data));
  }
  request(sessionId: string, taskId: string, input: SelectionRequest): Selection {
    return this.repository.transaction(() => {
      const task = this.repository.store.task(taskId);
      if (task.sessionId !== sessionId || !task.workspace) throw new AgentHttpError(404, '本对话中找不到该任务');
      const prior = this.repository.db.prepare("SELECT data FROM workspace_selections WHERE task_id=? AND json_extract(data,'$.requestId')=?").get(taskId, input.requestId);
      if (prior) {
        const selection = JSON.parse(String(prior.data)) as Selection;
        if (canonicalJson({ question: selection.question, candidates: selection.candidates, multiple: selection.multiple }) !== canonicalJson({ question: input.question, candidates: input.candidates, multiple: input.multiple ?? false })) throw new AgentHttpError(409, '选择请求 ID 已用于另一个问题');
        return selection;
      }
      if (task.state !== 'running' || task.workspace.waitingReason || task.workspace.activeRunId) throw new AgentHttpError(409, '请等待当前操作完成后再提问');
      if (!input.requestId || input.requestId.length > 100 || !input.question.trim() || input.question.length > 1000 || input.candidates.length > 12) throw new AgentHttpError(422, '选择问题或候选数量不合法');
      const keys = new Set<string>();
      for (const candidate of input.candidates) {
        if (candidate.type === 'asset') this.repository.asset(sessionId, candidate.assetId);
        else {
          this.repository.draft(sessionId, candidate.draftId);
          if (candidate.revision !== undefined) this.repository.revision(sessionId, candidate.draftId, candidate.revision);
        }
        const key = canonicalJson(candidate);
        if (keys.has(key)) throw new AgentHttpError(422, '选择候选不能重复');
        keys.add(key);
      }
      const selection: Selection = { ...input, multiple: input.multiple ?? false, id: randomUUID(), sessionId, taskId, state: 'pending', created: Date.now() };
      this.repository.db.prepare('INSERT INTO workspace_selections VALUES(?,?,?,?)').run(selection.id, sessionId, taskId, JSON.stringify(selection));
      task.workspace.waitingReason = { type: 'selection', questionId: selection.id };
      task.state = 'waiting_user'; task.pausedAt = Date.now();
      this.repository.store.update(task);
      this.repository.store.event(sessionId, taskId, 'selection_requested', { selection });
      this.repository.store.event(sessionId, taskId, 'state', { state: task.state, waitingReason: task.workspace.waitingReason });
      return selection;
    });
  }
  answer(sessionId: string, taskId: string, questionId: string, input: { selectedIndices: number[]; answer?: string }): Selection {
    return this.repository.transaction(() => {
      const selection = this.get(sessionId, questionId);
      const task = this.repository.store.task(taskId);
      const waiting = task.workspace?.waitingReason;
      if (selection.taskId !== taskId || task.sessionId !== sessionId) throw new AgentHttpError(404, '选择问题不属于此任务');
      if (selection.state !== 'pending' || task.state !== 'waiting_user' || waiting?.type !== 'selection' || waiting.questionId !== questionId) throw new AgentHttpError(409, '该选择问题已经回答或过期');
      const answer = input.answer?.trim();
      if ((!input.selectedIndices.length && !answer) || (answer?.length ?? 0) > 4000) throw new AgentHttpError(422, '请选择候选或补充说明');
      if (!selection.multiple && input.selectedIndices.length > 1) throw new AgentHttpError(422, '此问题只能选择一个候选');
      if (new Set(input.selectedIndices).size !== input.selectedIndices.length || input.selectedIndices.some(index => !Number.isInteger(index) || index < 0 || index >= selection.candidates.length)) throw new AgentHttpError(422, '选择的候选不存在');
      const next: Selection = { ...selection, state: 'answered', selectedIndices: input.selectedIndices, ...(answer ? { answer } : {}), answeredAt: Date.now() };
      this.repository.db.prepare('UPDATE workspace_selections SET data=? WHERE id=?').run(JSON.stringify(next), questionId);
      if (task.pausedAt) task.deadline += Date.now() - task.pausedAt;
      task.pausedAt = undefined; task.workspace!.waitingReason = undefined; task.state = 'queued';
      // Persist exact selected objects, not only a human-visible ordinal that could change after pagination.
      task.messages.push({ role: 'user', content: `Selection answer (user data): ${JSON.stringify({ questionId, selected: input.selectedIndices.map(index => selection.candidates[index]), answer })}` });
      this.repository.store.update(task);
      this.repository.store.event(sessionId, taskId, 'selection_resolved', { selection: next });
      this.repository.store.event(sessionId, taskId, 'state', { state: task.state });
      return next;
    });
  }
  cancelForTask(sessionId: string, taskId: string) {
    return this.repository.transaction(() => {
      const task = this.repository.store.task(taskId);
      if (task.sessionId !== sessionId || activeStates.includes(task.state)) throw new AgentHttpError(409, '任务尚未停止');
      const rows = this.repository.db.prepare("SELECT id FROM workspace_selections WHERE task_id=? AND json_extract(data,'$.state')='pending'").all(taskId);
      for (const row of rows) {
        const selection = { ...this.get(sessionId, String(row.id)), state: 'cancelled' as const };
        this.repository.db.prepare('UPDATE workspace_selections SET data=? WHERE id=?').run(JSON.stringify(selection), selection.id);
        this.repository.store.event(sessionId, taskId, 'selection_resolved', { selection });
      }
    });
  }
}
