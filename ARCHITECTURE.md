# Remote CLI Agents - Architecture Design

## Overview

CLI 코딩 에이전트(Claude Code, Codex, Gemini CLI)를 로컬에서 구동하고
웹 브라우저를 통해 어디서든 원격 조작할 수 있는 도구.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        사용자 디바이스 (폰/태블릿/PC)                │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                    Web Client (PWA)                           │  │
│  │  React + shadcn/ui + xterm.js                                │  │
│  │  - 구조화 뷰: 대화, 코드 diff, 승인 요청                     │  │
│  │  - 터미널 뷰: PTY 폴백용 xterm.js                            │  │
│  └──────────────────────┬────────────────────────────────────────┘  │
│                         │ WebSocket                                 │
└─────────────────────────┼───────────────────────────────────────────┘
                          │
            ┌─────────────┼──────────────┐
            │  (A) LAN 직접  또는  (B) Relay 경유  │
            └─────────────┼──────────────┘
                          │
┌─────────────────────────┼───────────────────────────────────────────┐
│              로컬 머신 (개발 PC)                                     │
│  ┌──────────────────────┴────────────────────────────────────────┐  │
│  │                    Bridge Server                              │  │
│  │  Node.js/Bun + WebSocket + HTTP                               │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │              Agent Manager                               │  │  │
│  │  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │  │  │
│  │  │  │ Claude   │  │ Codex    │  │ Gemini   │  │ Generic│  │  │  │
│  │  │  │ Adapter  │  │ Adapter  │  │ Adapter  │  │  PTY   │  │  │  │
│  │  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘  │  │  │
│  │  │       │              │              │            │       │  │  │
│  │  │  claude -p      codex app-      gemini        node-pty  │  │  │
│  │  │  stream-json    server          CLI            spawn    │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 1. 프로젝트 구조

```
remote-cli-agents/
├── package.json              # 루트 (monorepo workspace)
├── packages/
│   ├── server/               # Bridge Server (npm publish 대상)
│   │   ├── package.json      # bin: { "rca": "./bin/cli.js" }
│   │   ├── bin/
│   │   │   └── cli.js        # CLI 진입점 (rca up, rca relay)
│   │   └── src/
│   │       ├── index.ts              # 서버 시작
│   │       ├── server.ts             # HTTP + WebSocket 서버
│   │       ├── session.ts            # 세션 관리
│   │       ├── qr.ts                 # QR 코드 생성
│   │       ├── adapters/
│   │       │   ├── types.ts          # AgentAdapter 인터페이스
│   │       │   ├── claude.ts         # Claude Code 어댑터
│   │       │   ├── codex.ts          # Codex 어댑터
│   │       │   ├── gemini.ts         # Gemini CLI 어댑터
│   │       │   └── pty.ts            # Generic PTY 어댑터 (폴백)
│   │       ├── relay/
│   │       │   └── relay.ts          # 릴레이 서버 (자체 호스팅용)
│   │       └── handlers/
│   │           ├── git.ts            # Git 명령 핸들러
│   │           └── file.ts           # 파일 관련 핸들러
│   │
│   ├── web/                  # Web Client (PWA)
│   │   ├── package.json
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx
│   │       ├── components/
│   │       │   ├── ChatView.tsx       # 구조화된 대화 뷰
│   │       │   ├── TerminalView.tsx   # xterm.js 터미널 폴백
│   │       │   ├── ThreadList.tsx     # 스레드/세션 목록
│   │       │   ├── CodeBlock.tsx      # 코드 블록 + diff 뷰
│   │       │   ├── ApprovalBar.tsx    # 권한 승인 UI
│   │       │   ├── AgentSelector.tsx  # 에이전트 선택 + 상태
│   │       │   ├── QRScanner.tsx      # QR 스캐너 (카메라)
│   │       │   └── StatusBar.tsx      # 연결 상태
│   │       ├── hooks/
│   │       │   ├── useWebSocket.ts    # WebSocket 연결 관리
│   │       │   └── useAgent.ts        # 에이전트 상태 관리
│   │       ├── lib/
│   │       │   └── protocol.ts        # 프로토콜 타입 정의 (공유)
│   │       └── styles/
│   │
│   └── shared/               # 공유 타입/프로토콜
│       ├── package.json
│       └── src/
│           ├── protocol.ts           # 메시지 프로토콜 정의
│           └── types.ts              # 공유 타입
```

---

## 2. 기술 스택

| 컴포넌트 | 기술 | 근거 |
|---------|------|------|
| **Runtime** | Node.js 20+ | Codex도 Node.js 기반, 호환성 최대화. Bun 옵션은 추후 |
| **Bridge Server** | ws + node:http | 의존성 최소화 (Remodex처럼). Express/Fastify 불필요 |
| **Agent 통신** | child_process.spawn | 각 에이전트 CLI를 자식 프로세스로 생성, stdin/stdout JSON 통신 |
| **PTY 폴백** | node-pty | Gemini CLI 등 구조화 API 없는 에이전트용 |
| **Web Client** | React 19 + Vite | 빠른 빌드, PWA 지원 |
| **UI 컴포넌트** | shadcn/ui + Tailwind | 모바일 친화적, 빠른 개발 |
| **터미널 렌더링** | xterm.js | PTY 폴백 시 브라우저 터미널 |
| **QR 생성** | qrcode-terminal (서버) + qr-scanner (클라이언트) | 서버: 터미널 QR 표시, 클라이언트: 카메라 스캔 |
| **빌드/번들** | tsup (서버), Vite (클라이언트) | 서버는 단일 JS 파일로 번들 |

---

## 3. Agent Adapter 인터페이스

```typescript
// packages/shared/src/protocol.ts

// ─── 통합 메시지 타입 ───

interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;             // 텍스트 내용
  toolCalls?: ToolCall[];      // 도구 호출 (파일 편집, 명령 실행 등)
  reasoning?: string;          // 사고 과정 (지원하는 에이전트만)
  timestamp: number;
}

interface ToolCall {
  id: string;
  name: string;                // 'edit_file', 'bash', 'read_file' 등
  input: Record<string, any>;
  output?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'requires_approval';
}

interface AgentStatus {
  agent: 'claude' | 'codex' | 'gemini' | 'pty';
  state: 'idle' | 'running' | 'waiting_approval' | 'error';
  activeThread?: string;
  model?: string;
}

// ─── 어댑터 인터페이스 ───

interface AgentAdapter {
  readonly name: string;
  readonly type: 'claude' | 'codex' | 'gemini' | 'pty';

  // 라이프사이클
  start(config: AgentConfig): Promise<void>;
  stop(): Promise<void>;
  isAvailable(): Promise<boolean>;  // CLI가 설치되어 있는지 확인

  // 대화
  sendMessage(threadId: string, message: string): void;
  interrupt(threadId: string): void;

  // 이벤트
  onEvent(handler: (event: AgentEvent) => void): void;

  // 상태
  getStatus(): AgentStatus;
  getThreads(): Promise<ThreadSummary[]>;
}

// ─── 이벤트 타입 ───

type AgentEvent =
  | { type: 'message_start'; threadId: string }
  | { type: 'message_delta'; threadId: string; content: string }
  | { type: 'message_complete'; threadId: string; message: AgentMessage }
  | { type: 'tool_start'; threadId: string; tool: ToolCall }
  | { type: 'tool_complete'; threadId: string; tool: ToolCall }
  | { type: 'approval_required'; threadId: string; tool: ToolCall }
  | { type: 'error'; threadId: string; error: string }
  | { type: 'status_change'; status: AgentStatus }
  | { type: 'pty_output'; threadId: string; data: string }  // PTY 모드 전용
```

---

## 4. 에이전트별 통신 방식

### Claude Code Adapter
```
Bridge ──spawn──▶ claude -p --output-format stream-json --input-format stream-json
                  stdin: JSON 메시지 입력
                  stdout: 스트리밍 JSON 이벤트 출력
```
- `--output-format stream-json`으로 구조화된 이벤트 스트림 수신
- 이벤트 타입: `assistant`, `tool_use`, `tool_result`, `result` 등
- `--max-turns`, `--max-budget-usd`로 제어
- `--dangerously-skip-permissions` 또는 권한 프롬프트 릴레이

### Codex Adapter
```
Bridge ──spawn──▶ codex app-server
                  stdin: JSON-RPC 요청
                  stdout: JSON-RPC 응답 + NDJSON 이벤트
```
- 앱 서버 프로세스에는 TUI 전용 플래그를 직접 전달하지 않고, `thread/start` / `thread/resume` / `turn/start` 요청으로 설정을 전달
- JSON-RPC 프로토콜: `initialize`, `model/list`, `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`
- 주요 이벤트: `thread/started`, `turn/started`, `item/agentMessage/delta`, `item/started`, `item/completed`, `thread/tokenUsage/updated`, `turn/completed`
- 승인 요청은 server request (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`)로 받아 브라우저 승인 UI와 연결

### Gemini CLI Adapter (PTY 모드)
```
Bridge ──node-pty.spawn──▶ gemini
                           raw terminal I/O
```
- 구조화 API가 없으므로 PTY로 폴백
- node-pty로 터미널 생성, 입출력을 WebSocket으로 브라우저에 전달
- 클라이언트에서 xterm.js로 렌더링

### Generic PTY Adapter
- 위와 동일하지만 어떤 CLI든 지정 가능
- 설정: `{ command: "aider", args: [] }` 등

---

## 5. 연결 방식 & 릴레이 프로토콜

### 5.1 두 가지 연결 모드

#### (A) LAN 직접 연결
```
Phone Browser ──WebSocket──▶ Bridge Server (192.168.x.x:9470)
```
- 같은 네트워크에서 직접 연결
- Bridge가 시작하면 LAN IP와 포트를 QR로 표시
- 인증: 세션 토큰 (랜덤 UUID)

#### (B) Relay 경유 연결
```
Phone Browser ──WS──▶ Relay Server ◀──WS── Bridge Server
                      (자체호스팅 또는 공개)
```
- Remodex와 동일한 패턴
- Bridge가 `x-role: host`로 릴레이에 연결, 세션 생성
- Client가 `x-role: client`로 같은 세션에 참가
- 릴레이는 메시지를 양방향 전달만 함 (데이터 저장 X)

### 5.2 QR 페이링 플로우

```
1. 사용자: `npx remote-cli-agents` 또는 `rca up` 실행
2. Bridge: 랜덤 세션 ID 생성 (UUID v4)
3. Bridge: 릴레이에 WebSocket 연결 (x-role: host)
4. Bridge: 터미널에 QR 코드 출력

   QR 내용 (JSON):
   {
     "type": "rca",
     "version": 1,
     "relay": "wss://relay-url/relay",
     "sessionId": "abc-123-...",
     "directUrl": "http://192.168.1.100:9470",  // LAN 직접 연결용
     "token": "random-auth-token"
   }

5. 사용자: 폰 브라우저에서 웹 앱 접속
6. 웹 앱: QR 스캔 → 연결 정보 획득
7. 웹 앱: relay에 WebSocket 연결 (x-role: client, 같은 sessionId)
   - 또는 LAN이면 directUrl로 직접 연결
8. 양방향 통신 시작
```

### 5.3 WebSocket 메시지 프로토콜

Remodex의 단순함을 유지하되, 멀티 에이전트를 위한 라우팅 추가:

```typescript
// Client → Server (Bridge)
type ClientMessage =
  | { type: 'send_message'; agentType: string; threadId?: string; content: string }
  | { type: 'interrupt'; agentType: string; threadId: string }
  | { type: 'approve'; agentType: string; threadId: string; toolCallId: string; approved: boolean }
  | { type: 'list_threads'; agentType: string }
  | { type: 'list_agents' }
  | { type: 'select_agent'; agentType: string; config?: AgentConfig }
  | { type: 'pty_input'; agentType: string; threadId: string; data: string }  // PTY용
  | { type: 'pty_resize'; cols: number; rows: number }
  | { type: 'git'; action: string; params?: Record<string, any> }  // git 명령
  | { type: 'ping' }

// Server (Bridge) → Client
type ServerMessage =
  | { type: 'agent_event'; event: AgentEvent }
  | { type: 'agents_list'; agents: AgentInfo[] }
  | { type: 'threads_list'; agentType: string; threads: ThreadSummary[] }
  | { type: 'connection_status'; status: 'connected' | 'disconnected' | 'reconnecting' }
  | { type: 'git_result'; action: string; result: any }
  | { type: 'error'; message: string }
  | { type: 'pong' }
```

### 5.4 릴레이 서버

Remodex의 `relay.js`와 거의 동일한 구조. 핵심만:

```typescript
// 세션 레지스트리
const sessions = new Map<string, {
  host: WebSocket | null;      // Bridge 서버
  clients: Set<WebSocket>;     // 웹 클라이언트들
  history: string[];           // 최근 메시지 (재연결 시 재생)
}>();

// 연결 시:
// - x-role: host → 세션 생성자 (Bridge)
// - x-role: client → 세션 참가자 (웹 클라이언트)
// - host → client 메시지: 브로드캐스트 + history에 저장
// - client → host 메시지: host에게만 전달
```

---

## 6. Web Client (PWA) 설계

### 6.1 화면 구성

```
┌──────────────────────────────────────────┐
│ [≡] Agent: Claude Code ▼  [●] Connected │  ← 상단 바
├──────────────┬───────────────────────────┤
│              │                           │
│  Thread 1    │   [Chat View]             │  ← 구조화 대화 뷰
│  Thread 2 ●  │   User: "Fix the bug"    │     또는
│  Thread 3    │   Assistant: "I'll..."    │   [Terminal View]
│              │   📁 Edit: src/app.ts     │     xterm.js
│  ──────────  │   ✅ Completed            │
│  + New Chat  │                           │
│              │   [Approve] [Reject]      │  ← 승인 바
├──────────────┴───────────────────────────┤
│ [  메시지 입력...                    ▶ ] │  ← 입력 바
└──────────────────────────────────────────┘
```

모바일에서는 사이드바가 햄버거 메뉴로 접힘.

### 6.2 핵심 컴포넌트

- **ChatView**: 마크다운 렌더링, 코드 블록 구문 강조, diff 뷰, 사고 과정 접기/펼치기
- **TerminalView**: xterm.js 기반, PTY 모드 에이전트 전용
- **ApprovalBar**: 에이전트가 권한을 요청할 때 Approve/Reject 버튼 표시
- **AgentSelector**: 설치된 에이전트 목록, 활성 에이전트 전환
- **QRScanner**: 첫 연결 시 QR 스캔 (html5-qrcode 라이브러리)

### 6.3 상태 관리

- **zustand** 또는 **React Context** (경량)
- WebSocket 연결 상태, 에이전트 상태, 스레드 목록, 활성 대화

---

## 7. 보안 모델

| 계층 | 방식 |
|------|------|
| **전송** | WSS (TLS) - 릴레이 모드 시. LAN은 WS도 허용 |
| **인증** | 세션 토큰 (QR에 포함된 랜덤 UUID) |
| **세션 격리** | 세션 ID당 1개 호스트 + N개 클라이언트 |
| **릴레이 투명성** | 릴레이는 메시지 내용을 해석하지 않음, 전달만 |
| **자체 호스팅** | 릴레이 서버를 자체 호스팅 가능 (`rca relay` 명령) |
| **로컬 실행** | 모든 에이전트와 코드는 로컬에서만 실행됨 |

---

## 8. 사용자 플로우

### 설치 & 시작
```bash
# 글로벌 설치
npm install -g remote-cli-agents

# 시작 (설치된 에이전트 자동 감지)
rca up

# 출력:
# 🔍 Detected agents: Claude Code, Codex
# 🌐 Bridge server started on http://192.168.1.100:9470
# 📡 Connected to relay: wss://relay.example.com
#
# Scan this QR with your phone:
# ██████████████████
# ██              ██
# ██  ▄▄▄▄  ▄▄▄  ██
# ...
#
# Or open: http://192.168.1.100:9470
```

### 또는 npx로 설치 없이
```bash
npx remote-cli-agents
```

### 릴레이 자체 호스팅
```bash
rca relay --port 8080
# → wss://your-server.com:8080/relay 로 사용
```

---

## 9. 구현 페이즈

### Phase 1: MVP (핵심 동작)
- [x] 프로젝트 세팅 (monorepo, TypeScript, 빌드)
- [x] Bridge Server 기본 구조 (HTTP + WebSocket)
- [x] Claude Code Adapter (stream-json 모드)
- [x] 릴레이 서버 (Remodex relay.js 포팅)
- [x] QR 코드 생성 & 페어링
- [x] Web Client 기본 UI (대화 뷰, 입력, 연결)
- [x] LAN 직접 연결 + 릴레이 연결

### Phase 2: 멀티 에이전트
- [x] Codex Adapter (app-server JSON-RPC)
- [x] Generic PTY Adapter (node-pty + xterm.js)
- [x] Gemini CLI 지원 (PTY 모드)
- [x] 에이전트 선택 UI
- [x] 스레드 관리 (목록, 전환)

### Phase 3: 편의 기능
- [x] Git 통합 UI (status, commit, push 등)
- [x] 파일 브라우저
- [x] 승인/거부 플로우
- [x] PWA 설치 (모바일 앱처럼)
- [x] 다크/라이트 테마
- [ ] 세션 히스토리 저장 (SQLite)

### Phase 4: 배포 & 완성
- [ ] npm 패키지 publish
- [ ] 공개 릴레이 서버 (옵션)
- [ ] E2E 암호화 (릴레이 구간)
- [ ] 문서화
