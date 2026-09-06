import { create } from 'zustand';

/** Whether any agent session has an active task. Fed by the session list and chat pages; read by the tab bar badge. */
interface AgentActivityState { active: boolean; setActive: (active: boolean) => void }
export const useAgentActivityStore = create<AgentActivityState>(set => ({ active: false, setActive: active => set({ active }) }));
