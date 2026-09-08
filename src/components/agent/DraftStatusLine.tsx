import { FolderInput, Loader2 } from 'lucide-react';
import type { AgentSession } from '@/infrastructure/api/AgentApi';
import { useAgentText } from './useAgentText';
import { chipButton } from './chatStyles';

/** One line above the composer: where the draft stands relative to the library, and the way into the save panel. */
export function DraftStatusLine({ session, saving, canSave, onSave }: { session: AgentSession; saving: boolean; canSave: boolean; onSave: () => void }) {
  const at = useAgentText();
  const op = session.librarySaveOp, last = session.lastLibrarySave;
  let text: string; let tone = 'text-[#8a919e]';
  if (saving) { text = at('正在保存到工作流库…'); tone = 'text-[#5b8af5]'; }
  else if (op && (op.state === 'applying' || op.state === 'reconciling')) { text = at('上次保存未确认，正在核对'); tone = 'text-[#f0a35b]'; }
  else if (op && (op.state === 'failed' || op.state === 'conflict') && (!last || last.opId !== op.opId)) { text = `${at('未能保存到工作流库，草稿已保留')}${op.result?.error ? `：${op.result.error}` : ''}`; tone = 'text-[#f0a35b]'; }
  else if (last && last.draftVersion < session.version) text = at('草稿有新修改（版本 {{version}} 已保存到「{{name}}」）', { version: last.draftVersion, name: last.name });
  else if (last) { text = at('已保存到「{{name}}」', { name: last.name }); tone = 'text-[#4ade80]'; }
  else if (session.version > 0) text = at('草稿已保存');
  else return null;
  return <div data-agent-draft-status className="flex items-center gap-2 min-w-0">
    <span className={`flex-1 min-w-0 truncate text-[11.5px] ${tone}`}>{saving && <Loader2 size={12} className="inline animate-spin mr-1" />}{text}</span>
    {session.version > 0 && <button data-agent-save-library className={chipButton} disabled={!canSave} onClick={onSave}><FolderInput size={13} />{at('保存到工作流库')}</button>}
  </div>;
}
