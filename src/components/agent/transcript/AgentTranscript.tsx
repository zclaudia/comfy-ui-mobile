import { useAgentText } from '../useAgentText';
import { copyText } from '../../../platform/clipboard';
import { useMemo, type ReactNode } from 'react';
import { ToolCallCard, TranscriptCapabilitiesProvider } from '@zclaudia/agent-transcript-kit/react';
import '@zclaudia/agent-transcript-kit/transcript.css';
import type { AgentEvent, AgentTask } from '../../../infrastructure/api/AgentApi';
import { AgentMarkdown } from '../AgentMarkdown';
import { buildTranscript } from './adapter';
import './theme.css';

const names: Record<string, string> = {
  get_node_schema: '查看节点参数', get_workflow: '检查当前工作流', get_run: '查看生成状态',
  inspect_environment: '检查可用模型', search_templates: '查找工作流模板', inspect_workflow: '检查当前工作流',
  create_from_template: '创建模板工作流', create_model_workflow: '创建模型工作流', create_workflow: '创建工作流', create_workflow_from_template: '创建模板工作流',
  validate_workflow: '验证工作流', patch_workflow: '调整工作流', apply_workflow_patch: '调整工作流',
  submit_preview: '提交生成任务', save_workflow_version: '保存工作流版本',
};
const statuses: Record<string, string> = { queued: '等待助手处理', running: '正在处理', waiting_comfy: 'ComfyUI 正在生成', reconciling: '正在核对提交状态' };


export function AgentTranscript({ events, tasks, caughtUp, renderContent }: {
  events: AgentEvent[]; tasks: AgentTask[]; caughtUp: boolean; renderContent: (event: AgentEvent) => ReactNode;
}) {
  const at = useAgentText();
  const capabilities = useMemo(() => ({ copyText, labels: { copy: at('复制'), copied: at('已复制'), copyFailed: at('复制失败，请长按选择代码后复制') } }), [at]);
  const transcript = useMemo(() => buildTranscript(events, tasks, caughtUp), [events, tasks, caughtUp]);
  return <TranscriptCapabilitiesProvider value={capabilities}><section aria-label={at('对话记录')} className="agent-transcript space-y-4">
    {transcript.items.map(item => {
      if (item.kind === 'user_message') return <article key={item.id} className="ml-8 rounded-2xl bg-blue-600/20 border border-blue-500/20 p-4 text-sm"><p className="text-xs text-slate-500 mb-1">{at('你')}</p><div className="whitespace-pre-wrap break-words">{item.text}</div></article>;
      if (item.kind === 'marker') return <div key={item.id}>{renderContent(item.payload as AgentEvent)}</div>;
      const task = tasks.find(t => t.id === item.id);
      return <article key={item.id} data-agent-turn={item.id} className="min-w-0 rounded-2xl border border-white/5 bg-white/[0.035] p-3 text-sm leading-7">
        <p className="text-xs text-slate-500 mb-3">{at('助手')}</p>
        <div className="space-y-3">{item.blocks.map((block, index) => {
          if (block.kind === 'text') return <AgentMarkdown key={`text:${index}`}>{block.text}</AgentMarkdown>;
          if (block.kind === 'custom') return <div key={block.id}>{renderContent(block.payload as AgentEvent)}</div>;
          if (block.kind !== 'tool_call') return null;
          const call = item.toolCalls[block.toolCallId];
          if (!call) return null;
          const summary = call.status === 'running' ? '执行中' : call.status === 'error' ? '未完成' : call.status === 'cancelled' ? '已停止等待' : call.name === 'submit_preview' ? '已提交，生成结果见下方' : '已完成';
          return <ToolCallCard key={call.id} toolCall={call} displayName={at(names[call.name] ?? '执行工作流操作')} displaySummary={at(summary)} renderExpanded={() => <div className="break-words text-xs"><p>{at(names[call.name] ?? call.name)} · {at(summary)}</p>{call.errorMessage && <p>{at(call.errorMessage)}</p>}{!!call.result && <pre className="whitespace-pre-wrap">{JSON.stringify(call.result, null, 2)}</pre>}</div>} />;
        })}</div>
        {item.status === 'failed' && <p role="alert" className="text-amber-300 mt-3">{at(item.error || '任务未完成')}</p>}
        <p className="text-xs text-slate-500 mt-3" data-turn-status={item.status}>{at(item.status === 'complete' ? '本轮完成' : item.status === 'cancelled' ? '助手已停止；已提交的生成可能继续运行' : item.status === 'failed' ? '本轮未完成' : statuses[task?.state ?? ''] ?? '正在处理')}</p>
      </article>;
    })}
  </section></TranscriptCapabilitiesProvider>;
}
