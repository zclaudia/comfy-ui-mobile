import { ArrowLeft, History, MoreVertical, Network, Pencil, Trash2 } from 'lucide-react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { useAgentText } from './useAgentText';

const tile = 'w-9 h-9 shrink-0 flex items-center justify-center rounded-[10px] border border-white/[0.08] text-[#c8ccd4] disabled:opacity-40';
const tileStyle = { background: 'rgba(255,255,255,0.045)' };

export function ChatHeader({ title, subtitle, onBack, onOpenCanvas, onRename, onHistory, onDelete }: {
  title: string; subtitle?: string; onBack: () => void; onOpenCanvas?: () => void; onRename?: () => void; onHistory?: () => void; onDelete?: () => void;
}) {
  const at = useAgentText();
  const item = 'flex items-center gap-2.5 px-3 h-10 text-[13px] text-[#e9ebef] rounded-[8px] outline-none data-[highlighted]:bg-white/[0.06] cursor-pointer';
  return <header className="shrink-0 z-10 border-b border-white/[0.08] pwa-header" style={{ background: 'rgba(11,12,15,0.86)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' }}>
    <div className="h-14 flex items-center gap-[11px] px-3">
      <button className={tile} style={tileStyle} onClick={onBack} aria-label={at('返回')}><ArrowLeft className="w-[17px] h-[17px]" strokeWidth={1.8} /></button>
      <div className="min-w-0 flex-1">
        <h1 className="text-[14px] font-semibold text-[#e9ebef] leading-[1.25] truncate">{title}</h1>
        {subtitle && <div className="font-mono text-[9px] font-medium text-[#565d6b] tracking-[0.12em] uppercase mt-[3px] truncate">{subtitle}</div>}
      </div>
      {onOpenCanvas && <button data-agent-open-canvas className="h-9 px-3 shrink-0 flex items-center gap-1.5 rounded-[10px] border border-white/[0.08] text-[12px] font-semibold text-[#c8ccd4]" style={tileStyle} onClick={onOpenCanvas}><Network size={15} strokeWidth={1.8} />{at('画布')}</button>}
      {(onRename || onHistory || onDelete) && <Dropdown.Root>
        <Dropdown.Trigger asChild><button className={tile} style={tileStyle} aria-label={at('更多')}><MoreVertical className="w-[17px] h-[17px]" strokeWidth={1.8} /></button></Dropdown.Trigger>
        <Dropdown.Portal><Dropdown.Content align="end" sideOffset={6} className="z-[60] min-w-[180px] p-1 rounded-[12px] border border-white/[0.08] shadow-2xl" style={{ background: '#101217' }}>
          {onRename && <Dropdown.Item className={item} onSelect={() => setTimeout(onRename, 0)}><Pencil size={15} />{at('重命名')}</Dropdown.Item>}
          {onHistory && <Dropdown.Item className={item} onSelect={() => setTimeout(onHistory, 0)}><History size={15} />{at('版本历史')}</Dropdown.Item>}
          {onDelete && <Dropdown.Item className={`${item} text-[#f87c7c]`} onSelect={() => setTimeout(onDelete, 0)}><Trash2 size={15} />{at('删除会话')}</Dropdown.Item>}
        </Dropdown.Content></Dropdown.Portal>
      </Dropdown.Root>}
    </div>
  </header>;
}
