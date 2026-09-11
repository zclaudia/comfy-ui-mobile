import { useCallback, useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ArrowUp, ImagePlus, Plus, Square } from 'lucide-react';
import { ACCEPT } from './attachments';
import { PendingAttachments } from './ChatAttachments';
import { useAgentText } from './useAgentText';
import type { LocalAttachment } from './useAttachments';

const MAX_LENGTH = 8000;
const MAX_HEIGHT = 168; // ~7 lines before the textarea scrolls

/** Pill-style composer: auto-growing textarea, attach button, paste-to-attach and a send button that lights up when a message is ready.
 * While a task runs the send button becomes a stop button and the placeholder reports progress, replacing the old standalone status bar. */
export function ChatComposer({ value, onChange, disabled, placeholder, attachments, onAddFiles, onPickFromLibrary, onRemoveAttachment, onRetryAttachment, canSend, onSend, running, runningLabel, onStop }: {
  value: string; onChange: (value: string) => void; disabled: boolean; placeholder: string;
  attachments: LocalAttachment[]; onAddFiles: (files: File[]) => void; onPickFromLibrary?: () => void; onRemoveAttachment: (id: string) => void; onRetryAttachment: (id: string) => void;
  canSend: boolean; onSend: () => void;
  running?: boolean; runningLabel?: string; onStop?: () => void;
}) {
  const at = useAgentText();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const resize = useCallback(() => {
    const el = textarea.current; if (!el) return;
    el.style.height = '0px';
    const next = Math.min(el.scrollHeight, MAX_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, []);
  useEffect(resize, [value, resize]);

  // Desktop: Enter sends, Shift+Enter breaks a line. Touch keyboards keep Enter as newline and send via the button; Ctrl/⌘+Enter always sends.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const finePointer = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches;
    if (e.ctrlKey || e.metaKey || (finePointer && !e.shiftKey)) { e.preventDefault(); if (canSend) onSend(); }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    onAddFiles(files);
  };

  const hasAttachments = attachments.length > 0;
  const nearLimit = value.length > MAX_LENGTH - 500;
  const showStop = Boolean(running && onStop);
  return <form data-agent-composer className={`rounded-[22px] border transition-colors ${showStop ? 'border-[#3069f0]/40' : disabled ? 'border-white/[0.06] opacity-60' : 'border-white/[0.1] focus-within:border-[#3069f0]/60 focus-within:shadow-[0_0_0_3px_rgba(48,105,240,0.15)]'}`} style={{ background: '#14161c' }}
    onSubmit={e => { e.preventDefault(); if (canSend) onSend(); }}>
    {hasAttachments && <div className="px-3 pt-2.5"><PendingAttachments items={attachments} onRemove={onRemoveAttachment} onRetry={onRetryAttachment} /></div>}
    <div className="flex items-end gap-1.5 pl-2 pr-2 py-2">
      <input ref={picker} type="file" accept={ACCEPT} multiple hidden onChange={e => { onAddFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <button type="button" aria-label={at('添加图片或文件')} disabled={disabled} onClick={() => picker.current?.click()}
        className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-[#c8ccd4] bg-white/[0.06] active:bg-white/[0.12] disabled:opacity-40 transition-colors"><Plus size={19} strokeWidth={2} /></button>
      {onPickFromLibrary && <button type="button" aria-label={at('从相册选择')} disabled={disabled} onClick={onPickFromLibrary}
        className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-[#c8ccd4] bg-white/[0.06] active:bg-white/[0.12] disabled:opacity-40 transition-colors"><ImagePlus size={19} strokeWidth={2} /></button>}
      <textarea ref={textarea} aria-label={at('给助手的消息')} value={value} onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} rows={1} maxLength={MAX_LENGTH} disabled={disabled} placeholder={showStop && runningLabel ? runningLabel : placeholder}
        className="flex-1 min-w-0 min-h-[36px] py-2 px-1.5 resize-none bg-transparent text-[14px] leading-[20px] text-[#e9ebef] placeholder:text-[#5c6675] focus:outline-none disabled:cursor-not-allowed" />
      {showStop
        ? <button type="button" aria-label={at('停止生成')} onClick={onStop}
            className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center bg-[#f25555]/15 text-[#f87c7c] border border-[#f25555]/40 active:scale-95 transition-all"><Square size={14} fill="currentColor" /></button>
        : <button type="submit" aria-label={at('发送消息')} disabled={!canSend}
            className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center transition-all ${canSend ? 'bg-[#3069f0] text-white shadow-[0_2px_10px_rgba(48,105,240,0.45)] active:scale-95' : 'bg-white/[0.06] text-[#565d6b]'}`}><ArrowUp size={19} strokeWidth={2.4} /></button>}
    </div>
    {nearLimit && <p className="px-4 pb-2 -mt-1 text-right font-mono text-[10px] text-[#66758a]">{value.length}/{MAX_LENGTH}</p>}
  </form>;
}
