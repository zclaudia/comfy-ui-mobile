import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import { Image as ImageIcon, MessageSquare, Network } from 'lucide-react';
import { useAgentActivityStore } from '@/ui/store/agentActivityStore';
import { TAB_PATHS, type TabPath } from '@/components/agent/binding';

const icons: Record<TabPath, typeof MessageSquare> = { '/chats': MessageSquare, '/workflows': Network, '/outputs': ImageIcon };

export function TabBar() {
  const { t } = useTranslation();
  const active = useAgentActivityStore(s => s.active);
  const labels: Record<TabPath, string> = { '/chats': t('tabs.chats', '对话'), '/workflows': t('tabs.workflows', '工作流'), '/outputs': t('tabs.gallery', '画廊') };
  return <nav data-tab-bar className="fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08]" style={{ background: 'rgba(15,17,22,0.96)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', paddingBottom: 'var(--nav-bar-inset, env(safe-area-inset-bottom, 0px))' }}>
    <div className="h-14 px-3 flex items-stretch">
      {TAB_PATHS.map(path => { const Icon = icons[path]; return <NavLink key={path} to={path} className={({ isActive }) => `flex-1 flex flex-col items-center justify-center gap-[3px] relative text-[10.5px] ${isActive ? 'text-[#5b8af5] font-semibold' : 'text-[#71798a] font-medium'}`}>
        <Icon size={22} strokeWidth={1.8} />
        <span>{labels[path]}</span>
        {path === '/chats' && active && <span data-tab-badge className="absolute top-1.5 left-[calc(50%+8px)] w-[7px] h-[7px] rounded-full bg-[#3069f0] border-[1.5px] border-[#0f1116]" />}
      </NavLink>; })}
    </div>
  </nav>;
}
