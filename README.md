# Remote CLI Agents (rca)

CLI 코딩 에이전트(Claude Code, Codex, Gemini CLI)를 웹 브라우저로 원격 조작하는 도구.

스마트폰이나 태블릿에서 QR 코드 하나로 연결해 어디서든 AI 코딩 에이전트를 제어할 수 있습니다.

## 주요 기능

- **다중 에이전트 지원** — Claude Code, Codex, Gemini CLI, 범용 PTY 터미널
- **원격 접속** — LAN 직접 연결 또는 릴레이 서버를 통한 인터넷 접속
- **QR 코드 페어링** — 브라우저에서 QR 코드 스캔으로 즉시 연결
- **구조화된 채팅 UI** — 마크다운 렌더링, 코드 하이라이팅, 툴 호출 시각화
- **승인 워크플로우** — 권한이 필요한 작업의 승인/거부 처리
- **Git 통합** — 브라우저에서 status, commit, push, pull, branch 조작
- **파일 탐색기** — 원격 파일 시스템 탐색 및 파일 내용 미리보기
- **PWA 지원** — 모바일 홈 화면에 설치 가능, 반응형 디자인
- **다크/라이트 테마** — 시스템 설정 연동

## 검증 문서

- [docs/claude-code-checklist.md](docs/claude-code-checklist.md)
- [docs/codex-checklist.md](docs/codex-checklist.md)

## Codex 공식 문서 기준

- [Codex overview](https://developers.openai.com/codex/)
- [Codex CLI](https://developers.openai.com/codex/cli)
- [Codex config](https://developers.openai.com/codex/config)
- [Codex approvals and sandboxing](https://developers.openai.com/codex/security)

## 아키텍처

```
스마트폰 / 태블릿 / 원격 PC
  └─ 웹 클라이언트 (PWA, React 19 + xterm.js)
       └─ WebSocket
            ├─ LAN 모드: ws://192.168.x.x:9470
            └─ 릴레이 모드: wss://relay.example.com

로컬 개발 PC
  └─ Bridge 서버 (Node.js + ws)
       ├─ HTTP: 웹 클라이언트 정적 파일 서빙
       ├─ WebSocket: 클라이언트 연결 처리
       ├─ REST API: /api/health, /api/agents, /api/connection
       └─ 에이전트 어댑터
            ├─ Claude Adapter  → claude -p --output-format stream-json
            ├─ Codex Adapter   → codex app-server (JSON-RPC)
            ├─ Gemini Adapter  → gemini (PTY)
            └─ Generic PTY    → 모든 CLI 도구
```

## 패키지 구조

```
packages/
├── shared/   # 공유 타입 및 프로토콜 정의
├── server/   # Node.js Bridge 서버
└── web/      # React 웹 클라이언트
```

## 시작하기

### 요구사항

- Node.js 18+
- 사용할 에이전트 CLI 중 하나 이상 설치:
  - [Claude Code](https://docs.anthropic.com/ko/docs/claude-code) (`claude`)
  - [Codex CLI](https://developers.openai.com/codex/cli) (`codex`)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`)

### 설치 및 실행

```bash
# 의존성 설치
npm install

# 개발 서버 시작 (서버 + 웹 클라이언트 동시 실행)
npm run dev

# Codex 런타임 스모크 테스트
npm run test:codex

# Codex 브라우저 E2E 테스트 (PinchTab)
npm run test:pinchtab:codex
```

브라우저에서 `http://localhost:9471` 접속 후 표시된 QR 코드를 스캔하거나 URL을 직접 입력해 연결합니다.

### 프로덕션 빌드

```bash
npm run build   # 전체 빌드
npm start       # 프로덕션 서버 시작 (포트 9470)
```

### CLI 직접 실행

```bash
# 전역 설치
npm install -g .

# 실행
rca
```

## 연결 모드

### LAN 모드

서버와 클라이언트가 같은 네트워크에 있을 때 사용. 서버 시작 시 터미널에 출력되는 로컬 IP 주소와 QR 코드로 연결합니다.

### 릴레이 모드

인터넷을 통한 원격 접속이 필요할 때 사용. 세션 기반 인증(sessionId + token)으로 보안을 유지합니다.

```bash
rca --relay wss://your-relay-server.com
```

## 데이터 저장 위치

스레드와 메시지는 로컬에 저장됩니다:

```
~/.rca/data/
├── threads.json          # 스레드 메타데이터
└── messages/             # 스레드별 메시지 파일
```

## 기술 스택

| 영역 | 기술 |
|------|------|
| 서버 | Node.js, TypeScript, ws, node-pty |
| 웹 | React 19, Vite, Tailwind CSS v4, xterm.js |
| 상태관리 | Zustand |
| 통신 | WebSocket (Remodex 패턴) |
| 빌드 | TypeScript, Vite |

## 한마디

> 코딩은 결국 의자에 앉아 키보드를 두드리는 일이지만, 이 도구가 있으면 소파에 누워서 스마트폰으로도 할 수 있습니다. ☕

## 라이선스

MIT
