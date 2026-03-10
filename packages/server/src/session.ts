import { randomUUID } from 'node:crypto';

// 세션 정보
interface SessionInfo {
  sessionId: string;
  token: string;
  createdAt: number;
  clients: Set<string>;
}

// 세션 관리자
class SessionManager {
  private sessions = new Map<string, SessionInfo>();

  // 새 세션 생성
  create(): { sessionId: string; token: string } {
    const sessionId = randomUUID();
    const token = randomUUID();

    this.sessions.set(sessionId, {
      sessionId,
      token,
      createdAt: Date.now(),
      clients: new Set(),
    });

    return { sessionId, token };
  }

  // 토큰 검증
  validateToken(sessionId: string, token: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.token === token;
  }

  // 세션 존재 확인
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  // 세션 정보 조회
  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  // 클라이언트 추가
  addClient(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.clients.add(clientId);
    }
  }

  // 클라이언트 제거
  removeClient(sessionId: string, clientId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.clients.delete(clientId);
    }
  }

  // 연결된 클라이언트 수
  getClientCount(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    return session ? session.clients.size : 0;
  }

  // 세션 삭제
  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  // 모든 세션 정리
  clear(): void {
    this.sessions.clear();
  }
}

// 싱글톤 내보내기
export const sessionManager = new SessionManager();
