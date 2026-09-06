import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { LAST_TAB_KEY, TAB_PATHS } from '@/components/agent/binding';
import { TabBar } from './TabBar';

/** Wraps the three top-level pages; each page keeps its own header and scroll container. */
export function TabLayout() {
  const { pathname } = useLocation();
  useEffect(() => {
    if ((TAB_PATHS as string[]).includes(pathname)) { try { localStorage.setItem(LAST_TAB_KEY, pathname); } catch { /* storage unavailable */ } }
  }, [pathname]);
  return <>
    <div className="h-dvh overflow-y-auto" style={{ paddingBottom: 'calc(56px + env(safe-area-inset-bottom))' }}><Outlet /></div>
    <TabBar />
  </>;
}
