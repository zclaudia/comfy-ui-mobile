import { DraftCopyConflict } from './DraftWorkingCopy';
import type { DraftCopyRecord, DraftCopyStore } from './DraftWorkingCopy';
import { canvasEnvironmentKey } from './DraftCanvasCache';
import type { DraftCanvasCache, DraftCanvasContext, DraftCanvasEnvironment } from './DraftCanvasCache';

/** Deliberately separate from ComfyMobileUI/workflows and its cloud-sync outbox. */
export class IndexedDBDraftCopyStore implements DraftCopyStore, DraftCanvasCache {
  private database?: Promise<IDBDatabase>;
  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('ComfyMobileAgentDrafts', 2);
        request.onupgradeneeded = () => {
          for (const name of ['copies', 'canvasContexts', 'canvasEnvironments']) {
            if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'key' });
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); this.database = undefined; };
          resolve(db);
        };
      }).catch(error => { this.database = undefined; throw error; });
    }
    return this.database;
  }
  async readCanvasContext(key: string) {
    const db = await this.open();
    return new Promise<{ context: DraftCanvasContext; environment: DraftCanvasEnvironment } | undefined>((resolve, reject) => {
      const tx = db.transaction(['canvasContexts', 'canvasEnvironments'], 'readonly');
      let context: DraftCanvasContext | undefined; let environment: DraftCanvasEnvironment | undefined;
      const request = tx.objectStore('canvasContexts').get(key);
      request.onsuccess = () => {
        context = request.result;
        if (!context) return;
        const env = tx.objectStore('canvasEnvironments').get(canvasEnvironmentKey(context.baseUrl, context.serverId));
        env.onsuccess = () => { environment = env.result; };
      };
      tx.oncomplete = () => resolve(context && environment ? { context, environment } : undefined);
      tx.onabort = () => reject(tx.error ?? new Error('Draft context read aborted'));
      tx.onerror = () => reject(tx.error);
    });
  }
  async saveCanvasContext(context: DraftCanvasContext, environment: DraftCanvasEnvironment) {
    if (environment.key !== canvasEnvironmentKey(context.baseUrl, context.serverId)) throw new Error('Invalid canvas environment identity');
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['canvasContexts', 'canvasEnvironments'], 'readwrite');
      tx.objectStore('canvasContexts').put(context); tx.objectStore('canvasEnvironments').put(environment);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('Draft context write aborted'));
      tx.onerror = () => reject(tx.error);
    });
  }
  async read(key: string): Promise<DraftCopyRecord | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('copies', 'readonly');
      const request = tx.objectStore('copies').get(key);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error ?? new Error('Draft read aborted'));
      tx.onerror = () => reject(tx.error);
    });
  }
  async compareAndSwap(key: string, expectedEpoch: number | undefined, next: DraftCopyRecord): Promise<void> {
    if (next.key !== key || next.epoch !== (expectedEpoch ?? 0) + 1) throw new Error('Invalid draft checkpoint');
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('copies', 'readwrite');
      const store = tx.objectStore('copies');
      const request = store.get(key);
      let conflict = false;
      request.onsuccess = () => {
        if (request.result?.epoch !== expectedEpoch) { conflict = true; tx.abort(); }
        else store.put(next);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(conflict ? new DraftCopyConflict() : tx.error ?? new Error('Draft checkpoint aborted'));
      tx.onerror = () => reject(tx.error);
    });
  }
}
