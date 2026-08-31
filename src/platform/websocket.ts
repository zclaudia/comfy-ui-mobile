import { isTauriRuntime } from './runtime';
import { getNativeGatewayAuthorization } from './gatewaySession';

export const PLATFORM_WEBSOCKET_CONNECTING = 0;
export const PLATFORM_WEBSOCKET_OPEN = 1;
export const PLATFORM_WEBSOCKET_CLOSING = 2;
export const PLATFORM_WEBSOCKET_CLOSED = 3;

export interface PlatformWebSocketMessageEvent {
  data: string | ArrayBuffer | Blob;
}

export interface PlatformWebSocketCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface PlatformWebSocket {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: PlatformWebSocketMessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: PlatformWebSocketCloseEvent) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

class TauriWebSocketAdapter implements PlatformWebSocket {
  readyState = PLATFORM_WEBSOCKET_CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: PlatformWebSocketMessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: PlatformWebSocketCloseEvent) => void) | null = null;

  private socket: import('@tauri-apps/plugin-websocket').default | null = null;
  private removeListener: (() => void) | null = null;
  private closeRequested: { code: number; reason: string } | null = null;
  private closeEmitted = false;

  constructor(private readonly url: string) {
    void this.connect();
  }

  private async connect(): Promise<void> {
    try {
      const { default: TauriWebSocket } = await import('@tauri-apps/plugin-websocket');
      const authorization = getNativeGatewayAuthorization(this.url);
      const socket = await TauriWebSocket.connect(this.url, {
        ...(authorization ? { headers: { Authorization: authorization } } : {}),
        maxMessageSize: 64 * 1024 * 1024,
        maxFrameSize: 16 * 1024 * 1024,
      });

      if (this.closeRequested) {
        await socket.disconnect();
        this.emitClose(this.closeRequested.code, this.closeRequested.reason, true);
        return;
      }

      this.socket = socket;
      this.removeListener = socket.addListener((message) => {
        switch (message.type) {
          case 'Text':
            this.onmessage?.({ data: message.data });
            break;
          case 'Binary':
            this.onmessage?.({ data: Uint8Array.from(message.data).buffer });
            break;
          case 'Close':
            this.emitClose(
              message.data?.code ?? 1000,
              message.data?.reason ?? '',
              true,
            );
            break;
          default:
            break;
        }
      });

      this.readyState = PLATFORM_WEBSOCKET_OPEN;
      this.onopen?.(new Event('open'));
    } catch (error) {
      this.readyState = PLATFORM_WEBSOCKET_CLOSED;
      this.onerror?.(new ErrorEvent('error', {
        error,
        message: error instanceof Error ? error.message : 'Tauri WebSocket connection failed',
      }));
      this.emitClose(1006, 'Connection failed', false);
    }
  }

  send(data: string | ArrayBuffer): void {
    if (!this.socket || this.readyState !== PLATFORM_WEBSOCKET_OPEN) {
      throw new DOMException('WebSocket is not open', 'InvalidStateError');
    }

    const payload = typeof data === 'string'
      ? data
      : Array.from(new Uint8Array(data));
    void this.socket.send(payload).catch((error) => {
      this.onerror?.(new ErrorEvent('error', {
        error,
        message: error instanceof Error ? error.message : 'Tauri WebSocket send failed',
      }));
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === PLATFORM_WEBSOCKET_CLOSED) return;
    this.closeRequested = { code, reason };
    this.readyState = PLATFORM_WEBSOCKET_CLOSING;

    if (!this.socket) return;
    void this.socket.disconnect()
      .then(() => this.emitClose(code, reason, true))
      .catch((error) => {
        this.onerror?.(new ErrorEvent('error', {
          error,
          message: error instanceof Error ? error.message : 'Tauri WebSocket close failed',
        }));
        this.emitClose(1006, 'Disconnect failed', false);
      });
  }

  private emitClose(code: number, reason: string, wasClean: boolean): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.removeListener?.();
    this.removeListener = null;
    this.socket = null;
    this.readyState = PLATFORM_WEBSOCKET_CLOSED;
    this.onclose?.({ code, reason, wasClean });
  }
}

export const createPlatformWebSocket = (url: string): PlatformWebSocket => {
  if (isTauriRuntime()) return new TauriWebSocketAdapter(url);
  return new WebSocket(url) as unknown as PlatformWebSocket;
};
