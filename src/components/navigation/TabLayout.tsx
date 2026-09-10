import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { LAST_TAB_KEY, TAB_PATHS } from '@/components/agent/binding';
import { TabBar } from './TabBar';

/** Wraps the three top-level pages; each page keeps its own header and scroll container. */
export function TabLayout() {
  const { pathname, state } = useLocation();
  // Fixed bars inside the tabbed pages ignore the wrapper padding, so they read this variable instead.
  useEffect(() => {
    document.documentElement.style.setProperty('--tab-bar-height', 'calc(56px + var(--nav-bar-inset, env(safe-area-inset-bottom, 0px)))');
    return () => { document.documentElement.style.removeProperty('--tab-bar-height'); };
  }, []);
  useEffect(() => {
    // A diverted landing (the remembered chat tab was unavailable) must not overwrite the remembered tab.
    if ((state as { diverted?: boolean } | null)?.diverted) return;
    if ((TAB_PATHS as string[]).includes(pathname)) { try { localStorage.setItem(LAST_TAB_KEY, pathname); } catch { /* storage unavailable */ } }
  }, [pathname, state]);
  return <>
    <div className="h-dvh overflow-y-auto" style={{ paddingBottom: 'var(--tab-bar-height, calc(56px + var(--nav-bar-inset, env(safe-area-inset-bottom, 0px))))' }}><Outlet /></div>
    <TabBar />
  </>;
}
