import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { syncCloudWorkflows } from '@/infrastructure/sync/CloudWorkflowSyncService';
import {
  emitWorkflowSyncStatus,
  WORKFLOW_LOCAL_CHANGE_EVENT,
} from '@/infrastructure/sync/WorkflowSyncEvents';
import { useConnectionStore } from '@/ui/store/connectionStore';

const CloudWorkflowSyncController = () => {
  const serverUrl = useConnectionStore((state) => state.url);
  const isConnected = useConnectionStore((state) => state.isConnected);
  const debounceTimer = useRef<number | null>(null);
  const rerunRequested = useRef(false);
  const running = useRef(false);

  const synchronize = useCallback(async () => {
    if (!serverUrl || !useConnectionStore.getState().isConnected) {
      emitWorkflowSyncStatus({ state: 'offline', message: 'Using local workflow cache' });
      return;
    }
    if (running.current) {
      rerunRequested.current = true;
      return;
    }

    running.current = true;
    emitWorkflowSyncStatus({ state: 'syncing', message: 'Synchronizing workflows' });
    try {
      const result = await syncCloudWorkflows(serverUrl);
      const syncedAt = new Date().toISOString();
      if (result.conflicts) {
        emitWorkflowSyncStatus({
          state: 'conflict',
          syncedAt,
          message: `${result.conflicts} workflow conflict${result.conflicts === 1 ? '' : 's'} preserved`,
        });
        toast.warning('Workflow sync conflict preserved', {
          description: 'Both the cloud version and a timestamped local conflict copy are available.',
        });
      } else if (result.errors.length) {
        emitWorkflowSyncStatus({ state: 'error', syncedAt, message: result.errors[0] });
      } else {
        emitWorkflowSyncStatus({ state: 'synced', syncedAt, message: 'Workflows synchronized' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('Cloud workflow synchronization failed:', error);
      emitWorkflowSyncStatus({ state: 'error', message });
    } finally {
      running.current = false;
      if (rerunRequested.current) {
        rerunRequested.current = false;
        void synchronize();
      }
    }
  }, [serverUrl]);

  useEffect(() => {
    if (!isConnected) {
      emitWorkflowSyncStatus({ state: 'offline', message: 'Using local workflow cache' });
      return;
    }
    void synchronize();

    const interval = window.setInterval(() => void synchronize(), 30_000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void synchronize();
    };
    const handleOnline = () => void synchronize();
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('online', handleOnline);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
    };
  }, [isConnected, synchronize]);

  useEffect(() => {
    const scheduleSync = () => {
      if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
      debounceTimer.current = window.setTimeout(() => void synchronize(), 1_200);
    };
    window.addEventListener(WORKFLOW_LOCAL_CHANGE_EVENT, scheduleSync);
    return () => {
      window.removeEventListener(WORKFLOW_LOCAL_CHANGE_EVENT, scheduleSync);
      if (debounceTimer.current !== null) window.clearTimeout(debounceTimer.current);
    };
  }, [synchronize]);

  return null;
};

export default CloudWorkflowSyncController;

