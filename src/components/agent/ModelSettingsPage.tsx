import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Eye, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import type { AgentModel, AgentModelInput, AgentModels } from '@/infrastructure/api/AgentApi';
import { SimpleConfirmDialog } from '@/components/ui/SimpleConfirmDialog';
import { ChatHeader } from './ChatHeader';
import { useAgentStatus } from './useAgentStatus';
import { useAgentText } from './useAgentText';

const empty: AgentModelInput = { name: '', model: '', baseUrl: '', contextWindow: 32768, maxOutputTokens: 2500, vision: false };
const field = 'w-full h-11 px-3 rounded-xl border border-white/10 bg-white/5 text-sm outline-none focus:border-blue-500';
const button = 'h-10 px-3 rounded-xl border border-white/10 bg-white/5 text-sm disabled:opacity-40';

export default function ModelSettingsPage() {
  const at = useAgentText();
  const navigate = useNavigate();
  const { api, state } = useAgentStatus();
  const [data, setData] = useState<AgentModels | null>(null);
  const [editing, setEditing] = useState<AgentModel | 'new' | null>(null);
  const [form, setForm] = useState<AgentModelInput>(empty);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<AgentModel | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setData(null); setEditing(null); setKey(''); setClearKey(false); setError(''); }, [api]);
  useEffect(() => {
    const controller = new AbortController();
    if (state === 'no-gateway' || state === 'loading') return;
    void api.models(controller.signal).then(value => { if (!controller.signal.aborted) { setData(value); setError(''); } })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '加载模型失败'); });
    return () => controller.abort();
  }, [api, state, attempt]);
  const edit = (model: AgentModel | 'new') => {
    setEditing(model); setError(''); setKey(''); setClearKey(false);
    setForm(model === 'new' ? { ...empty } : { name: model.name, model: model.model, baseUrl: model.baseUrl, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, vision: model.vision });
  };
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  }
  async function save() {
    const input = { ...form, ...(clearKey ? { apiKey: '' } : key.trim() ? { apiKey: key.trim() } : {}) };
    await api.saveModel(input, editing && editing !== 'new' ? editing.id : undefined);
    setEditing(null); setKey(''); setClearKey(false);
    setData(await api.models());
  }
  const valid = !!form.name.trim() && !!form.model.trim() && !!form.baseUrl.trim()
    && Number.isInteger(form.contextWindow) && form.contextWindow >= 8192 && form.contextWindow <= 2_000_000
    && Number.isInteger(form.maxOutputTokens) && form.maxOutputTokens >= 256 && form.maxOutputTokens <= 128_000 && form.maxOutputTokens <= form.contextWindow / 4;

  return <main className="h-dvh flex flex-col text-[#e9ebef] bg-[#0b0c0f]">
    <ChatHeader title={at('助手模型')} onBack={() => navigate(-1)} />
    <div className="flex-1 overflow-y-auto px-4 py-5 pb-10 w-full max-w-2xl mx-auto space-y-5" style={{ paddingBottom: 'max(2.5rem, env(safe-area-inset-bottom))' }}>
      <p className="text-sm leading-6 text-slate-400">{at('配置用于对话和上下文压缩的语言模型。切换模型从下一条消息生效，所有设备共享配置。')}</p>
      {state === 'no-gateway' && <button className={button} onClick={() => navigate('/settings/server')}>{at('打开连接设置')}</button>}
      {error && <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200 break-words">{at(error)} {!editing && <button className="ml-3 underline" onClick={() => setAttempt(n => n + 1)}>{at('重试')}</button>}</div>}
      {!data && !error && state !== 'no-gateway' && <Loader2 className="animate-spin" aria-label={at('正在加载')} />}
      {data && !editing && <>
        <div className="space-y-3">{data.models.map(model => <article key={model.id} className={`rounded-2xl p-4 border ${model.id === data.activeId ? 'border-blue-500/50 bg-blue-500/10' : 'border-white/10 bg-white/[0.03]'}`}>
          <div className="flex items-start gap-2"><div className="flex-1 min-w-0"><h2 className="font-semibold break-words">{model.name}</h2><p className="text-xs text-slate-400 mt-1 break-all">{model.model}</p></div>{model.id === data.activeId && <span className="text-xs text-blue-300 flex items-center gap-1 shrink-0"><Check size={14} />{at('当前模型')}</span>}</div>
          <p className="mt-3 text-xs text-slate-400 flex flex-wrap items-center gap-3"><span>{at('上下文窗口')} {model.contextWindow.toLocaleString()} tokens</span><span>{model.vision ? <Eye size={14} className="inline mr-1" /> : null}{at(model.vision ? '支持图片理解' : '仅文本')}</span></p>
          <div className="flex gap-2 mt-4">
            {model.id !== data.activeId && <button disabled={busy} className={`${button} text-blue-300`} onClick={() => void action(async () => { setData(await api.activateModel(model.id)); })}>{at('使用此模型')}</button>}
            <button disabled={busy} className={button} aria-label={`${at('编辑')} ${model.name}`} onClick={() => edit(model)}><Pencil size={14} className="inline mr-1.5" />{at('编辑')}</button>
            <button disabled={busy} className={`${button} ml-auto text-slate-400`} aria-label={`${at('删除')} ${model.name}`} onClick={() => setDeleting(model)}><Trash2 size={15} /></button>
          </div>
        </article>)}</div>
        <button className="h-11 w-full rounded-xl bg-[#3069f0] text-sm font-semibold flex justify-center items-center gap-2" onClick={() => edit('new')}><Plus size={16} />{at('添加模型')}</button>
      </>}
      {editing && <form className="space-y-4" onSubmit={e => { e.preventDefault(); if (valid) void action(save); }}>
        <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
          <h2 className="font-semibold">{at(editing === 'new' ? '添加模型' : '编辑模型')}</h2>
          {(['name', 'model', 'baseUrl'] as const).map((name, i) => <label key={name} className="block space-y-1.5"><span className="text-sm text-slate-300">{at(['显示名称', '模型 ID', 'API 地址'][i])}</span>
            <input className={field} required type={name === 'baseUrl' ? 'url' : 'text'} maxLength={name === 'baseUrl' ? 2000 : 200} value={form[name]} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={['My assistant', 'model-id', 'https://api.example.com/v1'][i]} onChange={e => setForm(previous => ({ ...previous, [name]: e.target.value }))} />
          </label>)}
          <p className="text-xs text-slate-500">{at('使用兼容 OpenAI Chat Completions 的 API 地址，通常以 /v1 结尾。')}</p>
          <label className="block space-y-1.5"><span className="text-sm text-slate-300">{at('API 密钥')}</span><input className={field} type="password" autoComplete="new-password" maxLength={4096} value={key} disabled={clearKey} placeholder={at(editing !== 'new' && editing.hasApiKey ? '已保存，留空保留原密钥' : '无需鉴权的服务可留空')} onChange={e => setKey(e.target.value)} /></label>
          {editing !== 'new' && editing.hasApiKey && <label className="flex gap-2 items-center text-xs text-slate-400"><input type="checkbox" checked={clearKey} onChange={e => setClearKey(e.target.checked)} />{at('清除已保存的密钥')}</label>}
          <p className="text-xs text-slate-500">{at('密钥仅保存在 Gateway，不会回传到 App。更改 API 地址时需重新填写密钥。')}</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1.5"><span className="text-sm text-slate-300">{at('上下文窗口')} <small>tokens</small></span><input className={field} type="number" inputMode="numeric" min={8192} max={2_000_000} step={1} required value={form.contextWindow || ''} onChange={e => setForm(previous => ({ ...previous, contextWindow: Number(e.target.value) }))} /></label>
            <label className="block space-y-1.5"><span className="text-sm text-slate-300">{at('输出上限')} <small>tokens</small></span><input className={field} type="number" inputMode="numeric" min={256} max={Math.min(128_000, form.contextWindow / 4)} step={1} required value={form.maxOutputTokens || ''} onChange={e => setForm(previous => ({ ...previous, maxOutputTokens: Number(e.target.value) }))} /></label>
          </div>
          <p className="text-xs leading-5 text-slate-500">{at('按模型实际能力填写。接近上下文预算时自动摘要较早内容，保留近期消息与完整聊天记录。输出上限最多为窗口的四分之一。')}</p>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-white/10 p-3"><span><span className="text-sm">{at('支持图片理解')} (Vision)</span><span className="block text-xs text-slate-500 mt-1">{at('关闭后仅发送附件路径，不向语言模型发送图片。')}</span></span><input type="checkbox" role="switch" className="w-5 h-5 accent-blue-500" checked={form.vision} onChange={e => setForm(previous => ({ ...previous, vision: e.target.checked }))} /></label>
          <div className="flex gap-3"><button type="button" className={button} onClick={() => { setEditing(null); setKey(''); setError(''); }}>{at('取消')}</button><button type="submit" disabled={!valid || busy} className="flex-1 h-11 rounded-xl bg-[#3069f0] font-semibold text-sm disabled:opacity-40">{at(busy ? '正在保存' : '保存')}</button></div>
        </fieldset>
      </form>}
    </div>
    <SimpleConfirmDialog isOpen={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => { const model = deleting; setDeleting(null); if (model) void action(async () => { setData(await api.deleteModel(model.id)); }); }} title={at('删除模型')} message={at('删除此模型配置及密钥，聊天记录会保留。')} confirmText={at('删除')} cancelText={at('取消')} />
  </main>;
}
