import { applyTranscriptEvent, appendUserMessage, initialTranscriptState } from '@zclaudia/agent-transcript-kit';
import type { TranscriptEvent, TranscriptState } from '@zclaudia/agent-transcript-kit';
import type { AgentEvent, AgentTask } from '../../../infrastructure/api/AgentApi';

/** seq is global, so gaps within a session are normal. Never infer missing events from seq+1. */
export function buildTranscript(events: AgentEvent[], tasks: AgentTask[] = [], caughtUp = false): TranscriptState {
  let state = initialTranscriptState;
  const seen = new Set<number>();
  const apply = (event: TranscriptEvent) => { state = applyTranscriptEvent(state, event); };
  const tools = new Set(events.filter(e => e.kind === 'tool_started' || e.kind === 'tool_finished').map(e => `${e.taskId}:${e.data.callId}`));
  // Older gateways put args and results only on the legacy `tool` event, which is skipped as a duplicate card below.
  // Lift its payload onto the started/finished pair so those sessions still expand; newer events carry it directly.
  const details = new Map(events.filter(e => e.kind === 'tool' && e.data.callId).map(e => [`${e.taskId}:${e.data.callId}`, e.data]));
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    const { data, taskId, kind, seq, created } = event;
    const id = `event:${seq}`;
    if (kind === 'user') {
      state = appendUserMessage(state, { kind: 'user_message', id, text: String(data.text ?? ''), createdAt: created });
      continue;
    }
    if (taskId) apply({ type: 'turn_started', turnId: taskId, at: created });
    if (kind === 'assistant' && taskId) {
      apply({ type: 'text_delta', turnId: taskId, delta: `${data.text ?? ''}\n\n` });
    } else if (['tool_started', 'tool_finished', 'tool'].includes(kind) && taskId) {
      if (kind === 'tool' && data.callId && tools.has(`${taskId}:${data.callId}`)) continue;
      const toolCallId = String(data.callId || id);
      const detail = (data.callId ? details.get(`${taskId}:${data.callId}`) : undefined) ?? (kind === 'tool' ? data : undefined);
      apply({ type: 'tool_started', turnId: taskId, toolCallId, name: String(data.name || '工具'), input: data.args ?? detail?.args, at: created });
      if (kind !== 'tool_started') apply({ type: 'tool_finished', turnId: taskId, toolCallId, isError: kind === 'tool' ? !!data.result?.error : !!data.isError, errorMessage: data.errorMessage, result: data.result ?? detail?.result ?? (data.diagnostics ? { diagnostics: data.diagnostics } : undefined), at: created });
    } else if (kind === 'state' && taskId) {
      if (data.state === 'completed') apply({ type: 'turn_finished', turnId: taskId, at: created });
      if (data.state === 'failed') apply({ type: 'turn_failed', turnId: taskId, error: String(data.error || '任务未完成'), at: created });
      if (data.state === 'cancelled') apply({ type: 'turn_cancelled', turnId: taskId, at: created });
    } else if (['workflow', 'result', 'execution_error', 'saved', 'context'].includes(kind)) {
      if (taskId) apply({ type: 'custom_block', turnId: taskId, blockId: id, blockType: kind, payload: event });
      else apply({ type: 'marker', markerId: id, markerType: kind, payload: event, at: created });
    }
  }
  // Only reconcile once all history pages have arrived. Newer task snapshots must not end a partial replay.
  if (caughtUp) for (const task of tasks) {
    if (!state.items.some(i => i.kind === 'assistant_turn' && i.id === task.id)) continue;
    if (task.state === 'completed') apply({ type: 'turn_finished', turnId: task.id });
    if (task.state === 'failed') apply({ type: 'turn_failed', turnId: task.id, error: task.error || '任务未完成' });
    if (task.state === 'cancelled') apply({ type: 'turn_cancelled', turnId: task.id });
  }
  // A recovered task can finish without replaying a read-only call interrupted by a process exit.
  // Missing finish evidence is not success; stop the spinner while retaining that distinction.
  return { ...state, items: state.items.map(item => item.kind === 'assistant_turn' && item.status !== 'streaming'
    ? { ...item, toolCalls: Object.fromEntries(Object.entries(item.toolCalls).map(([id, call]) => [id, call.status === 'running' ? { ...call, status: 'cancelled' as const } : call])) }
    : item) };
}
