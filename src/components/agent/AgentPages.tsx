import { useLocation, useNavigate } from 'react-router-dom';
import { useConnectionStore } from '@/ui/store/connectionStore';
import ChatPage from './ChatPage';
import SessionListPage from './SessionListPage';
import { AgentGuide } from './AgentGuide';
import { ChatHeader } from './ChatHeader';
import { useAgentStatus } from './useAgentStatus';
import { useAgentText } from './useAgentText';
import { WorkspaceChatPage } from './workspace/WorkspaceChatPage';
import { WorkspaceSessionListPage } from './workspace/WorkspaceSessionListPage';
import { WorkspaceCanvasPage } from './workspace/WorkspaceCanvasPage';

/** Resolve the wire contract before mounting either client; a V1 snapshot is not a V2 snapshot. */
function ResolvedAgentPage({ list = false, canvas = false }: { list?: boolean; canvas?: boolean }) {
  const { status, state, retry } = useAgentStatus();
  const baseUrl = useConnectionStore(s => s.url);
  const navigate = useNavigate(); const at = useAgentText();
  const location = useLocation();
  if (status && (state === 'ready' || state === 'no-provider')) {
    if (canvas && status.agentSchemaVersion === 2) return <WorkspaceCanvasPage key={`${baseUrl}:${location.pathname}:${location.search}`} baseUrl={baseUrl} />;
    if (status.agentSchemaVersion === 2) return list ? <WorkspaceSessionListPage key={baseUrl} baseUrl={baseUrl} status={status} /> : <WorkspaceChatPage key={baseUrl} baseUrl={baseUrl} status={status} />;
    if (!canvas && (!status.agentSchemaVersion || status.agentSchemaVersion === 1)) return list ? <SessionListPage /> : <ChatPage />;
  }
  return <main className="h-dvh flex flex-col bg-[#0b0c0f] text-[#e9ebef]">
    <ChatHeader title={at('对话')} onBack={() => navigate(list ? '/workflows' : '/chats')} />
    <AgentGuide state={state === 'ready' ? 'error' : state} onRetry={retry} />
  </main>;
}
function AgentPage({ list = false, canvas = false }: { list?: boolean; canvas?: boolean }) {
  const url = useConnectionStore(s => s.url); const authMode = useConnectionStore(s => s.authMode);
  // A connection switch must not mount a client using the previous server's schema during the status effect.
  return <ResolvedAgentPage key={`${authMode}:${url}`} list={list} canvas={canvas} />;
}
export function AgentChatPage() { return <AgentPage />; }
export function AgentSessionListPage() { return <AgentPage list />; }
export function AgentCanvasPage() {
  const baseUrl = useConnectionStore(s => s.url); const authMode = useConnectionStore(s => s.authMode); const location = useLocation();
  return authMode === 'gateway' ? <WorkspaceCanvasPage key={`${baseUrl}:${location.pathname}:${location.search}`} baseUrl={baseUrl} /> : <AgentPage canvas />;
}
