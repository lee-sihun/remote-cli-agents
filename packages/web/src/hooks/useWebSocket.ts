import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage, QRPayload } from '../lib/protocol';
import { parseQRPayload, buildWebSocketUrl } from '../lib/protocol';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface ReconnectState {
  attempt: number;
  maxAttempts: number;
  nextDelayMs: number | null;
  exhausted: boolean;
}

interface UseWebSocketOptions {
  onMessage?: (msg: ServerMessage) => void;
  onStatusChange?: (status: ConnectionStatus) => void;
}

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 5000;
const RECONNECT_ATTEMPTS = 5;
const PING_INTERVAL = 25000;
const EMPTY_RECONNECT_STATE: ReconnectState = {
  attempt: 0,
  maxAttempts: RECONNECT_ATTEMPTS,
  nextDelayMs: null,
  exhausted: false,
};

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [payload, setPayload] = useState<QRPayload | null>(null);
  const [reconnectState, setReconnectState] = useState<ReconnectState>(EMPTY_RECONNECT_STATE);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectDelay = useRef(RECONNECT_MIN);
  const reconnectAttempt = useRef(0);
  const messageBuffer = useRef<ClientMessage[]>([]);
  const intentionalClose = useRef(false);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const updateStatus = useCallback((s: ConnectionStatus) => {
    setStatus(s);
    optionsRef.current.onStatusChange?.(s);
  }, []);

  const resetReconnectState = useCallback(() => {
    reconnectAttempt.current = 0;
    reconnectDelay.current = RECONNECT_MIN;
    setReconnectState(EMPTY_RECONNECT_STATE);
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
    const previousSocket = wsRef.current;
    if (previousSocket) {
      intentionalClose.current = true;
      previousSocket.close();
    }

    intentionalClose.current = false;
    updateStatus('connecting');

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) {
        return;
      }
      updateStatus('connected');
      resetReconnectState();

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
      if (wsRef.current !== ws) {
        return;
      }
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage;
        if (msg.type === 'pong') return;
        optionsRef.current.onMessage?.(msg);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) {
        return;
      }

      cleanup();
      wsRef.current = null;

      if (intentionalClose.current) {
        updateStatus('disconnected');
        return;
      }

      const nextAttempt = reconnectAttempt.current + 1;
      if (nextAttempt > RECONNECT_ATTEMPTS) {
        setReconnectState({
          attempt: reconnectAttempt.current,
          maxAttempts: RECONNECT_ATTEMPTS,
          nextDelayMs: null,
          exhausted: true,
        });
        updateStatus('disconnected');
        return;
      }

      reconnectAttempt.current = nextAttempt;
      const nextDelay = reconnectDelay.current;
      setReconnectState({
        attempt: nextAttempt,
        maxAttempts: RECONNECT_ATTEMPTS,
        nextDelayMs: nextDelay,
        exhausted: false,
      });
      updateStatus('connecting');

      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = Math.min(
          reconnectDelay.current * 1.5,
          RECONNECT_MAX,
        );
        connectToUrl(wsUrl);
      }, nextDelay);
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  }, [cleanup, resetReconnectState, updateStatus]);

  const connect = useCallback(
    (qrPayload: QRPayload) => {
      setPayload(qrPayload);
      resetReconnectState();
      // Save for auto-reconnect
      try {
        localStorage.setItem('rca_last_connection', JSON.stringify(qrPayload));
      } catch {
        // ignore
      }
      const url = buildWebSocketUrl(qrPayload);
      connectToUrl(url);
    },
    [connectToUrl, resetReconnectState],
  );

  const connectDirect = useCallback(
    (wsUrl: string) => {
      // For manual URL entry (ws:// or wss://)
      setPayload(null);
      resetReconnectState();
      try {
        localStorage.setItem('rca_last_direct_url', wsUrl);
      } catch {
        // ignore
      }
      connectToUrl(wsUrl);
    },
    [connectToUrl, resetReconnectState],
  );

  const disconnect = useCallback(() => {
    cleanup();
    intentionalClose.current = true;
    resetReconnectState();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    updateStatus('disconnected');
    setPayload(null);
    // localStorage 유지 → 재연결 시 활용
  }, [cleanup, resetReconnectState, updateStatus]);

  // /api/connection에서 토큰 가져와 /ws 직접 연결 (same-origin 전용)
  const connectFromApi = useCallback(() => {
    const { hostname, port, protocol } = window.location;
    const origin = `${protocol}//${hostname}${port ? ':' + port : ''}`;
    const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
    const wsBase = `${wsProtocol}//${hostname}${port ? ':' + port : ''}/ws`;

    fetch(`${origin}/api/connection`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.token && data?.sessionId) {
          // 토큰 포함 직접 연결 (relay 경유 안함)
          connectDirect(`${wsBase}?token=${data.token}&sessionId=${data.sessionId}`);
        } else {
          connectDirect(wsBase);
        }
      })
      .catch(() => {
        connectDirect(wsBase);
      });
  }, [connectDirect]);

  // 재연결
  const reconnect = useCallback(() => {
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

    if (window.location.hostname) {
      connectFromApi();
    }
  }, [connect, connectDirect, connectFromApi]);

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

    // 자동 연결 (same-origin 또는 Vite proxy 경유)
    if (window.location.hostname) {
      connectFromApi();
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

  // 안정적인 반환 객체 (매 렌더링마다 새 객체 생성 방지)
  return useMemo(
    () => ({
      status,
      payload,
      reconnectState,
      connect,
      connectDirect,
      disconnect,
      reconnect,
      send,
    }),
    [status, payload, reconnectState, connect, connectDirect, disconnect, reconnect, send],
  );
}
