import { Link } from 'react-router-dom';
import { Loader2, RefreshCw, Server } from 'lucide-react';
import { useAgentText } from './useAgentText';
import type { AgentAvailability } from './useAgentStatus';

const primary = 'h-11 w-full rounded-[10px] bg-[#3069f0] text-[13px] font-semibold text-white flex items-center justify-center gap-2 hover:bg-[#3f78f5] transition-colors';
const secondary = 'h-11 w-full rounded-[10px] border border-white/[0.08] bg-white/[0.045] text-[13px] font-semibold text-[#c8ccd4] flex items-center justify-center gap-2';

/** Shown inside the 对话 tab while the assistant cannot be used. `ready` never renders this. */
export function AgentGuide({ state, onRetry }: { state: Exclude<AgentAvailability, 'ready'>; onRetry: () => void }) {
  const at = useAgentText();
  if (state === 'loading') return <div className="flex-1 flex items-center justify-center text-[#71798a]"><Loader2 className="animate-spin" size={20} /></div>;
  const gateway = state === 'no-gateway';
  return <div className="flex-1 min-h-0 px-6 flex flex-col items-center justify-center gap-4 text-center" data-agent-guide={state}>
    <div className="w-[52px] h-[52px] rounded-[14px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center"><Server size={26} strokeWidth={1.6} className="text-[#71798a]" /></div>
    <h2 className="text-[16px] font-semibold text-[#e9ebef]">{at(gateway ? '助手需要通过 Gateway 连接' : state === 'no-provider' ? '等待管理员配置语言模型' : '暂时无法连接助手')}</h2>
    <p className="text-[12.5px] leading-relaxed text-[#66758a] max-w-[300px]">{at(gateway
      ? '你现在直连的是 ComfyUI。对话助手运行在 Comfy Mobile Gateway 上，负责理解需求、修改工作流和在后台等待生成。工作流库和画廊不受影响，可以照常使用。'
      : state === 'no-provider' ? 'Gateway 已连接，但还没有配置语言模型。管理员在 Gateway 的 .env 里填好 AGENT_LLM_* 后，这里就可以开始对话。'
      : '已连接 Gateway，但助手接口没有响应。可能是 Gateway 未启用助手或正在重启。')}</p>
    {gateway && <div className="w-full flex flex-col gap-2 text-left">
      {[at('在服务器上部署 Gateway，并在其配置里启用助手和语言模型'), at('在连接设置里把服务器地址改为 Gateway 地址并登录')].map((text, index) => <div key={index} className="flex items-start gap-2.5 p-3 rounded-[10px] border border-white/[0.07] bg-[#101217]">
        <span className="w-5 h-5 shrink-0 rounded-md bg-[#3069f0]/15 text-[#5b8af5] font-mono text-[10px] font-semibold flex items-center justify-center">{index + 1}</span>
        <span className="text-[12px] leading-relaxed text-[#c8ccd4]">{text}</span>
      </div>)}
    </div>}
    <div className="w-full flex flex-col gap-2 mt-1">
      {gateway ? <Link to="/settings/server" className={primary}>{at('打开连接设置')}</Link> : <button className={primary} onClick={onRetry}><RefreshCw size={14} />{at('重新检查')}</button>}
      {gateway && <a className={secondary} href="https://github.com/zhvala/comfy-ui-mobile/blob/main/docs/connection_guide_zh.md" target="_blank" rel="noreferrer">{at('查看 Gateway 部署指南')}</a>}
    </div>
  </div>;
}
