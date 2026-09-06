import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { chooseDefaultTab, LAST_TAB_KEY } from '@/components/agent/binding';
import { useAgentStatus } from '@/components/agent/useAgentStatus';

/** `/` decides the landing tab: the remembered one, otherwise by assistant availability. */
export function RootRedirect() {
  let lastTab: string | null = null;
  try { lastTab = localStorage.getItem(LAST_TAB_KEY); } catch { /* storage unavailable */ }
  const { state } = useAgentStatus();
  if (state === 'loading') return <div className="h-dvh flex items-center justify-center" style={{ background: '#0b0c0f' }}><Loader2 className="animate-spin text-[#71798a]" size={20} /></div>;
  return <Navigate to={chooseDefaultTab(lastTab, state === 'ready')} replace />;
}
