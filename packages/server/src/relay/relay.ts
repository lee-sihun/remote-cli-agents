import type { WebSocketServer, WebSocket } from 'ws';

// 세션 레지스트리 항목
interface RelaySession {
  host: WebSocket | null;
  clients: Set<WebSocket>;
  history: string[];
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
}

// 릴레이 통계
export interface RelayStats {
  activeSessions: number;
  totalConnections: number;
  sessions: Array<{
    sessionId: string;
    hasHost: boolean;
    clientCount: number;
    historySize: number;
    createdAt: number;
  }>;
}

const MAX_HISTORY = 1000;
const HEARTBEAT_INTERVAL = 30_000;
const CLEANUP_DELAY = 60_000;

// 세션 레지스트리
const sessions = new Map<string, RelaySession>();

// WebSocket에 메타데이터 부착용
interface RelayWebSocket extends WebSocket {
  _relaySessionId?: string;
  _relayRole?: 'host' | 'client';
  _isAlive?: boolean;
}

export function setupRelay(wss: WebSocketServer): void {
  // heartbeat
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const rws = ws as RelayWebSocket;
      if (rws._isAlive === false) {
        rws.terminate();
        return;
      }
      rws._isAlive = false;
      rws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws: WebSocket, request) => {
    const rws = ws as RelayWebSocket;
    rws._isAlive = true;

    rws.on('pong', () => {
      rws._isAlive = true;
    });

    // 헤더에서 역할 및 세션 정보 추출
    const headers = request.headers;
    const role = (headers['x-role'] as string) || '';
    const sessionId = (headers['x-session-id'] as string) || '';
    const token = (headers['x-token'] as string) || '';

    if (!sessionId) {
      rws.close(4000, 'Missing session ID');
      return;
    }

    rws._relaySessionId = sessionId;
    rws._relayRole = role as 'host' | 'client';

    if (role === 'host') {
      handleHostConnection(rws, sessionId, token);
    } else if (role === 'client') {
      handleClientConnection(rws, sessionId, token);
    } else {
      rws.close(4001, 'Invalid role');
      return;
    }

    // 메시지 처리
    rws.on('message', (data) => {
      const message = typeof data === 'string' ? data : data.toString();
      const session = sessions.get(sessionId);

      if (!session) return;

      if (rws._relayRole === 'host') {
        // host -> 모든 client에 브로드캐스트 + 히스토리 저장
        session.history.push(message);
        if (session.history.length > MAX_HISTORY) {
          session.history.shift();
        }

        for (const client of session.clients) {
          if (client.readyState === 1 /* WebSocket.OPEN */) {
            client.send(message);
          }
        }
      } else if (rws._relayRole === 'client') {
        // client -> host에게만 전달
        if (session.host && session.host.readyState === 1) {
          session.host.send(message);
        }
      }
    });

    // 연결 종료 처리
    rws.on('close', () => {
      handleDisconnection(rws, sessionId);
    });

    rws.on('error', () => {
      handleDisconnection(rws, sessionId);
    });
  });
}

function handleHostConnection(ws: RelayWebSocket, sessionId: string, _token: string): void {
  let session = sessions.get(sessionId);

  if (!session) {
    // 새 세션 생성
    session = {
      host: ws,
      clients: new Set(),
      history: [],
      cleanupTimer: null,
      createdAt: Date.now(),
    };
    sessions.set(sessionId, session);
    console.log(`[relay] Session created: ${sessionId}`);
  } else {
    // 기존 세션에 호스트 재연결
    session.host = ws;

    // 정리 타이머 취소
    if (session.cleanupTimer) {
      clearTimeout(session.cleanupTimer);
      session.cleanupTimer = null;
    }

    console.log(`[relay] Host reconnected to session: ${sessionId}`);
  }

  // 호스트에게 연결 확인 전송
  ws.send(JSON.stringify({
    type: 'relay_connected',
    sessionId,
    clientCount: session.clients.size,
  }));
}

function handleClientConnection(ws: RelayWebSocket, sessionId: string, _token: string): void {
  const session = sessions.get(sessionId);

  if (!session) {
    ws.close(4004, 'Session not found');
    return;
  }

  // 정리 타이머 취소
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
  }

  session.clients.add(ws);

  // 히스토리 재생
  for (const msg of session.history) {
    if (ws.readyState === 1) {
      ws.send(msg);
    }
  }

  // 호스트에 클라이언트 연결 알림
  if (session.host && session.host.readyState === 1) {
    session.host.send(JSON.stringify({
      type: 'client_connected',
      clientCount: session.clients.size,
    }));
  }

  console.log(`[relay] Client joined session ${sessionId} (${session.clients.size} clients)`);
}

function handleDisconnection(ws: RelayWebSocket, sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (ws._relayRole === 'host') {
    session.host = null;
    console.log(`[relay] Host disconnected from session: ${sessionId}`);

    // 모든 클라이언트에 호스트 연결 해제 알림
    for (const client of session.clients) {
      if (client.readyState === 1) {
        client.send(JSON.stringify({
          type: 'host_disconnected',
        }));
      }
    }
  } else if (ws._relayRole === 'client') {
    session.clients.delete(ws);
    console.log(`[relay] Client left session ${sessionId} (${session.clients.size} clients)`);

    // 호스트에 클라이언트 수 업데이트
    if (session.host && session.host.readyState === 1) {
      session.host.send(JSON.stringify({
        type: 'client_disconnected',
        clientCount: session.clients.size,
      }));
    }
  }

  // 세션 정리 확인: host와 client 모두 없으면 타이머 시작
  if (!session.host && session.clients.size === 0) {
    console.log(`[relay] Session ${sessionId} empty, scheduling cleanup in ${CLEANUP_DELAY / 1000}s`);

    session.cleanupTimer = setTimeout(() => {
      // 재확인 후 삭제
      const s = sessions.get(sessionId);
      if (s && !s.host && s.clients.size === 0) {
        sessions.delete(sessionId);
        console.log(`[relay] Session cleaned up: ${sessionId}`);
      }
    }, CLEANUP_DELAY);
  }
}

export function getRelayStats(): RelayStats {
  let totalConnections = 0;
  const sessionList: RelayStats['sessions'] = [];

  for (const [sessionId, session] of sessions) {
    const hasHost = session.host !== null && session.host.readyState === 1;
    const clientCount = session.clients.size;
    totalConnections += (hasHost ? 1 : 0) + clientCount;

    sessionList.push({
      sessionId,
      hasHost,
      clientCount,
      historySize: session.history.length,
      createdAt: session.createdAt,
    });
  }

  return {
    activeSessions: sessions.size,
    totalConnections,
    sessions: sessionList,
  };
}
