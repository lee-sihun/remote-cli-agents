import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage, QRPayload } from '../lib/protocol';
import { parseQRPayload, buildWebSocketUrl } from '../lib/protocol';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

interface UseWebSocketOptions {
  onMessage?: (msg: ServerMessage) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 5000;
const PING_INTERVAL = 25000;

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [payload, setPayload] = useState<QRPayload | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectDelay = useRef(RECONNECT_MIN);
  const messageBuffer = useRef<ClientMessage[]>([]);
  const intentionalClose = useRef(false);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const updateStatus = useCallback((s: ConnectionStatus) => {
    setStatus(s);
    optionsRef.current.onStatusChange?.(s);
  }, []);

  const cleanup = useCallback(() => {
    if (pingTimer.current) {
      clearInterval(pingTimer.current);
      pingTimer.current = null;
    }
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
  }, []);

  const connectToUrl = useCallback((wsUrl: string) => {
    cleanup();
    if (wsRef.current) {
      intentionalClose.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }

    intentionalClose.current = false;
    updateStatus('connecting');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      updateStatus('connected');
      reconnectDelay.current = RECONNECT_MIN;

      // Flush buffered messages
      const buffered = messageBuffer.current.splice(0);
      for (const msg of buffered) {
        ws.send(JSON.stringify(msg));
      }

      // Start ping
      pingTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, PING_INTERVAL);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        if (msg.type === 'pong') return;
        optionsRef.current.onMessage?.(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      cleanup();
      if (!intentionalClose.current) {
        updateStatus('disconnected');
        // Auto-reconnect with exponential backoff
        reconnectTimer.current = setTimeout(() => {
          reconnectDelay.current = Math.min(
            reconnectDelay.current * 1.5,
            RECONNECT_MAX,
          );
          connectToUrl(wsUrl);
        }, reconnectDelay.current);
      } else {
        updateStatus('disconnected');
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }, [cleanup, updateStatus]);

  const connect = useCallback(
    (qrPayload: QRPayload) => {
      setPayload(qrPayload);
      // Save for auto-reconnect
      try {
        localStorage.setItem('rca_last_connection', JSON.stringify(qrPayload));
      } catch {
        // ignore
      }
      const url = buildWebSocketUrl(qrPayload);
      connectToUrl(url);
    },
    [connectToUrl],
  );

  const connectDirect = useCallback(
    (wsUrl: string) => {
      // For manual URL entry (ws:// or wss://)
      setPayload(null);
      try {
        localStorage.setItem('rca_last_direct_url', wsUrl);
      } catch {
        // ignore
      }
      connectToUrl(wsUrl);
    },
    [connectToUrl],
  );

  const disconnect = useCallback(() => {
    cleanup();
    intentionalClose.current = true;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    updateStatus('disconnected');
    setPayload(null);
    try {
      localStorage.removeItem('rca_last_connection');
      localStorage.removeItem('rca_last_direct_url');
    } catch {
      // ignore
    }
  }, [cleanup, updateStatus]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    } else {
      messageBuffer.current.push(msg);
    }
  }, []);

  // Auto-reconnect from saved connection on mount
  useEffect(() => {
    // Check URL params first (QR 스캔 → 리다이렉트)
    const params = new URLSearchParams(window.location.search);
    const qrParam = params.get('qr');
    if (qrParam) {
      const decoded = parseQRPayload(decodeURIComponent(qrParam));
      if (decoded) {
        connect(decoded);
        window.history.replaceState({}, '', window.location.pathname);
        return;
      }
    }

    // Check localStorage (이전 연결 복원)
    try {
      const saved = localStorage.getItem('rca_last_connection');
      if (saved) {
        const parsed = parseQRPayload(saved);
        if (parsed) {
          connect(parsed);
          return;
        }
      }
      const directUrl = localStorage.getItem('rca_last_direct_url');
      if (directUrl) {
        connectDirect(directUrl);
        return;
      }
    } catch {
      // ignore
    }

    // 서버에서 직접 서빙되는 경우 자동 연결
    // Vite dev 서버(9471)가 아니면 현재 호스트로 WebSocket 연결 시도
    const { hostname, port, protocol } = window.location;
    const isDevServer = port === '9471' || port === '5173';
    if (!isDevServer && hostname) {
      const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
      const autoUrl = `${wsProtocol}//${hostname}${port ? ':' + port : ''}/ws`;
      connectDirect(autoUrl);
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      intentionalClose.current = true;
      cleanup();
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [cleanup]);

  return {
    status,
    payload,
    connect,
    connectDirect,
    disconnect,
    send,
  };
}
