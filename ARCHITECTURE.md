# Remote CLI Agents - Architecture Design

## Overview

CLI 코딩 에이전트(Claude Code, Codex, Gemini CLI)를 로컬에서 구동하고
웹 브라우저를 통해 원격 조작하는 구조.

현재 연결 모델은 `Bridge 서버 + 직접 WebSocket + 선택적 Cloudflare 터널`이다.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        사용자 디바이스 (폰/태블릿/PC)                │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Web Client (PWA)                           │  │
│  │  React 19 + Vite + xterm.js                                  │  │
│  │  - 대화 / diff / 승인 요청 / 파일 탐색 / Git                 │  │
│  └──────────────────────┬────────────────────────────────────────┘  │
│                         │ WebSocket (/ws)                           │
└─────────────────────────┼───────────────────────────────────────────┘
                          │
                ┌─────────┴─────────┐
                │  (A) LAN 직접 연결 │
                │  (B) 터널 경유 연결 │
                └─────────┬─────────┘
                          │
┌─────────────────────────┼───────────────────────────────────────────┐
│              로컬 머신 (개발 PC)                                     │
│  ┌──────────────────────┴────────────────────────────────────────┐  │
│  │                    Bridge Server                              │  │
│  │  Node.js + HTTP + WebSocket                                  │  │
│  │  - 정적 웹 서빙                                              │  │
│  │  - /api/health, /api/agents, /api/connection                 │  │
│  │  - /ws 연결 및 세션 토큰 검증                                │  │
│  │  - Claude / Codex / PTY 어댑터 관리                          │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## 프로젝트 구조

```
remote-cli-agents/
├── package.json
├── packages/
│   ├── shared/               # 공유 타입/프로토콜
│   ├── server/               # Bridge 서버
│   │   ├── bin/cli.js
│   │   └── src/
│   │       ├── index.ts
│   │       ├── server.ts
│   │       ├── session.ts
│   │       ├── qr.ts
│   │       ├── tunnel.ts
│   │       ├── adapters/
│   │       └── handlers/
│   └── web/                  # React 웹 클라이언트
│       ├── src/
│       │   ├── App.tsx
│       │   ├── components/
│       │   ├── hooks/
│       │   └── lib/
│       └── vite.config.ts
└── scripts/
```

## 연결 방식

### 1. LAN 직접 연결

- 서버가 LAN IP 기준 `directUrl`을 생성한다.
- 웹은 `/api/connection`에서 `sessionId`, `token`, `directUrl`을 받아 `/ws`로 연결한다.
- 같은 네트워크에서 가장 단순한 경로다.

### 2. Cloudflare 터널 연결

- `RCA_NO_TUNNEL`이 없으면 서버 시작 시 Quick Tunnel을 시도한다.
- 성공하면 `directUrl`을 터널 주소로 교체한다.
- 웹은 동일하게 `/ws` 경로로 연결한다.
- 터널 생성 실패 시 LAN 모드로 자동 폴백한다.

## QR 페어링 플로우

1. 사용자가 `rca` 또는 `npm start`를 실행한다.
2. 서버가 세션 ID와 토큰을 생성한다.
3. 필요 시 Cloudflare 터널을 연다.
4. QR에는 현재 접속용 `directUrl`이 들어간다.
5. 브라우저는 `/api/connection`을 조회해 최신 세션 토큰을 받는다.
6. 브라우저는 `/ws?token=...&sessionId=...` 로 연결한다.

## 보안 모델

- 세션별 토큰 기반 WebSocket 업그레이드 검증
- 에이전트 CLI는 항상 로컬 머신에서만 실행
- 외부 터널은 HTTP/WebSocket 전달만 담당
- 시크릿과 토큰은 런타임 생성, 코드 저장 금지

## 기술 선택

| 컴포넌트 | 기술 | 비고 |
|---------|------|------|
| Runtime | Node.js | Codex/Claude CLI와 호환성 우선 |
| Server | `node:http` + `ws` | 의존성 최소화 |
| Tunnel | `cloudflared` Quick Tunnel | 인터넷 접속 기본 경로 |
| Web | React 19 + Vite + Tailwind CSS v4 | PWA, 모바일 대응 |
| Terminal fallback | xterm.js | PTY 계열 CLI 대응 |

## 운영 메모

- 개발 중 웹은 Vite 프록시로 `/api`, `/ws`를 앱 서버에 연결한다.
- 프로덕션은 Bridge 서버가 웹 정적 파일과 WebSocket을 함께 제공한다.
- 연결 관련 디버깅은 `packages/server/src/index.ts`, `packages/server/src/server.ts`, `packages/web/src/hooks/useWebSocket.ts`를 기준으로 본다.
