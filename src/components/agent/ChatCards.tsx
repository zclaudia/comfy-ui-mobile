import { useAgentText } from './useAgentText';

export function NoticeCard({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  const at = useAgentText();
  return <div role="status" data-agent-card="notice" className="rounded-[10px] border border-[#f0a35b]/30 bg-[#f0a35b]/[0.08] px-3 py-2.5 text-[12px] text-[#f0a35b] flex items-center gap-3">
    <span className="flex-1">{at(text)}</span>
    {action && onAction && <button className="font-semibold shrink-0" onClick={onAction}>{at(action)}</button>}
  </div>;
}

export function RetryNotice({ attempt, max, delayMs }: { attempt: number; max: number; delayMs: number }) {
  const at = useAgentText();
  return <p data-agent-card="retry" className="text-[11px] text-[#f0a35b]/90">{at('模型请求失败，{{seconds}} 秒后重试（第 {{attempt}}/{{max}} 次）', { seconds: Math.max(1, Math.round(delayMs / 1000)), attempt, max })}</p>;
}
