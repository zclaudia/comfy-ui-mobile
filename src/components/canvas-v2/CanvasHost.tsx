import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConnectionStore } from '@/ui/store/connectionStore';
import {
  CanvasBridgeClient,
  setActiveCanvasBridge,
} from '@/services/bridge/CanvasBridgeClient';
import type { BridgeGraphSummary, BridgeNode } from '@/shared/types/bridge';
import type { IComfyJson } from '@/shared/types/app/IComfyJson';
import { resolveGatewayUrl } from '@/config/runtime';
import { CanvasAccessApi, type CanvasAccess } from '@/infrastructure/api/CanvasAccessApi';

interface CanvasHostProps {
  /** Workflow to load into the official frontend once the bridge is ready. */
  workflowJson: IComfyJson | null | undefined;
  /** Identity of the workflow (route id); re-sends load-workflow when it changes. */
  workflowKey: string | null | undefined;
  onNodeSelected?: (node: BridgeNode | null) => void;
  onReady?: (summary: BridgeGraphSummary) => void;
  onGraphMutated?: () => void;
  onManagedExecute?: () => void;
}

/**
 * Canvas v2 host: embeds the official ComfyUI frontend (which loads every
 * custom node's frontend extension natively) and exposes it to the editor
 * through the canvas bridge. All surrounding editor UI stays untouched.
 */
export const CanvasHost: React.FC<CanvasHostProps> = ({
  workflowJson,
  workflowKey,
  onNodeSelected,
  onReady,
  onGraphMutated,
  onManagedExecute,
}) => {
  const { t } = useTranslation();
  const storedUrl = useConnectionStore((s) => s.url);
  const serverUrl = useMemo(
    () => resolveGatewayUrl(storedUrl),
    [storedUrl]
  );

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const clientRef = useRef<CanvasBridgeClient | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [managedReady, setManagedReady] = useState(false);
  const [access, setAccess] = useState<{ serverUrl: string; grant: CanvasAccess } | null>(null);
  const [accessError, setAccessError] = useState(false);
  const accessHealthyRef = useRef(true);
  const managed = !!onManagedExecute;
  const frameUrl = managed ? access?.serverUrl === serverUrl ? `${serverUrl}${access.grant.path}?workspaceExecution=1` : undefined : `${serverUrl}/comfy/`;
  const loadedKeyRef = useRef<string | null>(null);

  // Keep latest callbacks without re-creating the client
  const callbacksRef = useRef({ onNodeSelected, onReady, onGraphMutated, onManagedExecute });
  callbacksRef.current = { onNodeSelected, onReady, onGraphMutated, onManagedExecute };

  useEffect(() => {
    setAccess(null); setAccessError(false); accessHealthyRef.current = true;
    if (!managed) return;
    const api = new CanvasAccessApi(serverUrl);
    const controller = new AbortController();
    let disposed = false;
    let grant: CanvasAccess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!grant || disposed) return;
      try {
        grant = await api.renew(grant, controller.signal);
        if (!disposed) timer = setTimeout(refresh, grant.renewAfterMs);
      } catch { if (!disposed) { accessHealthyRef.current = false; setAccessError(true); } }
    };
    void api.open(controller.signal).then(opened => {
      if (disposed) { void api.release(opened).catch(() => undefined); return; }
      grant = opened; setAccess({ serverUrl, grant });
      timer = setTimeout(refresh, grant.renewAfterMs);
    }).catch(() => { if (!disposed) { accessHealthyRef.current = false; setAccessError(true); } });
    return () => {
      disposed = true; controller.abort(); clearTimeout(timer);
      if (grant) void api.release(grant).catch(() => undefined);
    };
  }, [serverUrl, managed]);

  useEffect(() => {
    setIsReady(false); setManagedReady(false);
    loadedKeyRef.current = null;
    if (!frameUrl) return;
    const client = new CanvasBridgeClient(serverUrl);
    clientRef.current = client;
    setActiveCanvasBridge(client);
    if (iframeRef.current) client.attach(iframeRef.current);
    const readyTimeout = setTimeout(() => { if (!client.lastSummary) setAccessError(true); }, 30000);

    const offReady = client.on('ready', (summary) => {
      clearTimeout(readyTimeout);
      if (accessHealthyRef.current) setAccessError(false);
      setManagedReady(summary.managedExecution === true);
      setIsReady(true);
      loadedKeyRef.current = null; // force (re)load after iframe reloads
      callbacksRef.current.onReady?.(summary);
    });
    const offSelection = client.on('selectionChanged', (node) => {
      callbacksRef.current.onNodeSelected?.(node);
    });
    const offMutated = client.on('graphMutated', () => {
      callbacksRef.current.onGraphMutated?.();
    });
    const offGraph = client.on('graphChanged', summary => { setManagedReady(summary.managedExecution === true); });
    const offExecute = client.on('executionRequested', () => {
      if (client.lastSummary?.managedExecution) callbacksRef.current.onManagedExecute?.();
    });

    return () => {
      clearTimeout(readyTimeout);
      offReady();
      offSelection();
      offMutated();
      offGraph();
      offExecute();
      client.dispose();
      if (clientRef.current === client) clientRef.current = null;
      setActiveCanvasBridge(null);
    };
  }, [serverUrl, frameUrl]);

  // Push the editor's workflow into the official frontend
  useEffect(() => {
    if (!isReady || !workflowJson || !workflowKey) return;
    if (loadedKeyRef.current === workflowKey) return;
    loadedKeyRef.current = workflowKey;
    clientRef.current?.loadWorkflow(workflowJson, !!onManagedExecute);
    // The bridge already fits after loadGraphData, but the iframe canvas may
    // not have its final dimensions yet on first show. Re-fit once the layout
    // has settled so the workflow always lands centered.
    const fitTimer = setTimeout(() => clientRef.current?.fitView(), 350);
    return () => clearTimeout(fitTimer);
  }, [isReady, workflowJson, workflowKey, onManagedExecute]);

  return (
    <div className="absolute inset-0">
      {frameUrl && <iframe
        ref={iframeRef}
        src={frameUrl}
        title="ComfyUI official canvas"
        className="absolute inset-0 h-full w-full border-0 bg-[#0b0c0f]"
        allow="clipboard-read; clipboard-write"
        tabIndex={onManagedExecute && !managedReady ? -1 : undefined}
        style={onManagedExecute && !managedReady ? { pointerEvents: 'none' } : undefined}
      />}
      {(accessError || !isReady || (!!onManagedExecute && !managedReady)) && (
        <div
          className={`${onManagedExecute ? '' : 'pointer-events-none'} absolute inset-0 z-10 flex flex-col items-center justify-center gap-3`}
          style={{ background: 'rgba(11,12,15,0.85)' }}
        >
          {!accessError && <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/[0.08] border-t-[#3069f0]" />}
          <div className="max-w-xs px-4 text-center text-xs text-[#8a919e]">{accessError ? t('workflow.officialCanvasConnectionFailed') : isReady && onManagedExecute && !managedReady
            ? t('workflow.managedCanvasUnavailable') : t('workflow.officialCanvasLoading')}</div>
          <div className="font-mono text-[10px] text-[#565d6b] px-1.5 py-0.5 rounded-[5px] border border-white/10">{serverUrl}</div>
        </div>
      )}
    </div>
  );
};

export default CanvasHost;
