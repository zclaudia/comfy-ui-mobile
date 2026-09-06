import { Check, Download, Network } from 'lucide-react';
import { toast } from 'sonner';
import { downloadMedia } from '@/platform/mediaDownload';
import { withComfyAuth } from '@/infrastructure/auth/ComfyAuthService';
import { useAgentText } from './useAgentText';
import { AgentMedia, type AgentMediaOutput } from './AgentMedia';
import { accentChip, chipButton } from './chatStyles';

export function WorkflowChangeCard({ version, summary, operations, mirrored, onOpenCanvas }: { version: number; summary: string; operations?: unknown; mirrored: boolean; onOpenCanvas?: () => void }) {
  const at = useAgentText();
  return <article data-agent-card="workflow" className="rounded-[10px] border border-white/[0.07] p-3 space-y-2" style={{ background: '#101217' }}>
    <div className="flex items-center gap-2">
      <Network size={15} strokeWidth={1.8} className="text-[#5b8af5]" />
      <span className="text-[12.5px] font-semibold">{at('工作流已更新')}</span>
      <span className="font-mono text-[10px] text-[#5b8af5]">V{version}</span>
      <span className="flex-1" />
      {mirrored && <span className="font-mono text-[10px] text-[#565d6b]">{at('已写入工作流库')}</span>}
    </div>
    <p className="text-[12px] leading-relaxed text-[#9aa3b2]">{at(summary)}</p>
    {!!operations && <details className="text-xs"><summary className="cursor-pointer text-[#8a919e]">{at('查看改动')}</summary><pre className="mt-2 whitespace-pre-wrap break-all text-[#9aa3b2]">{JSON.stringify(operations, null, 2)}</pre></details>}
    {onOpenCanvas && <div><button className={accentChip} onClick={onOpenCanvas}><Network size={13} />{at('在画布查看')}</button></div>}
  </article>;
}

export function ResultCard({ version, outputs, baseUrl }: { version: number; outputs: AgentMediaOutput[]; baseUrl: string }) {
  const at = useAgentText();
  async function save(output: AgentMediaOutput) {
    const url = withComfyAuth(`${baseUrl}/view?${new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: output.type })}`);
    try { await downloadMedia({ url, filename: output.filename }); toast.success(at('已开始保存 {{name}}', { name: output.filename })); }
    catch { toast.error(at('保存失败')); }
  }
  return <article data-agent-card="result" className="rounded-[10px] border border-[#34c77b]/25 p-3 space-y-2.5" style={{ background: '#101217' }}>
    <div className="flex items-center gap-2"><Check size={15} strokeWidth={1.8} className="text-[#4ade80]" /><span className="text-[12.5px] font-semibold">{at('生成结果')}</span><span className="font-mono text-[10px] text-[#5b8af5]">V{version}</span></div>
    {outputs.length ? <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{outputs.map((output, index) => <div key={index} className="space-y-1.5"><AgentMedia baseUrl={baseUrl} output={output} index={index} /><button className={chipButton} onClick={() => void save(output)}><Download size={13} />{at('保存到相册')}</button></div>)}</div>
      : <p className="text-[12px] text-[#9aa3b2]">{at('执行完成，但没有返回可预览媒体。')}</p>}
  </article>;
}

export function ErrorCard({ title, detail }: { title: string; detail: string }) {
  const at = useAgentText();
  return <article data-agent-card="error" className="rounded-[10px] border border-[#f25555]/30 bg-[#f25555]/[0.06] p-3 space-y-2">
    <p className="text-[12.5px] font-semibold text-[#f87c7c]">{at(title)}</p>
    <details className="text-xs"><summary className="cursor-pointer text-[#8a919e]">{at('查看诊断')}</summary><pre className="mt-2 whitespace-pre-wrap break-all text-[#9aa3b2]">{detail}</pre></details>
  </article>;
}

export function NoticeCard({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  const at = useAgentText();
  return <div role="status" data-agent-card="notice" className="rounded-[10px] border border-[#f0a35b]/30 bg-[#f0a35b]/[0.08] px-3 py-2.5 text-[12px] text-[#f0a35b] flex items-center gap-3">
    <span className="flex-1">{at(text)}</span>
    {action && onAction && <button className="font-semibold shrink-0" onClick={onAction}>{at(action)}</button>}
  </div>;
}
