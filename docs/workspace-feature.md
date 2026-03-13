# 워크스페이스 기능 기획

## 개요

서버 로컬 PC의 여러 프로젝트 폴더를 **워크스페이스** 단위로 관리하여,
웹 UI에서 원격으로 작업 영역을 전환하며 독립적으로 사용할 수 있게 한다.

## 핵심 개념

- **워크스페이스** = 이름 + 서버 로컬 절대 경로
- 각 워크스페이스는 독립된 스레드(대화) 목록을 가짐
- 에이전트 실행 시 해당 워크스페이스 경로가 `cwd`로 전달
- 서버 재시작 후에도 워크스페이스 목록 유지 (`~/.rca/data/workspaces.json`)

## UI 레이아웃

```
┌─ Sidebar ────────────────────┐
│  📂 Workspace: my-project  ▼ │  ← 워크스페이스 선택 (최상단)
│  ─────────────────────────── │
│  🤖 Claude Code            ▼ │  ← 에이전트 선택
│  ─────────────────────────── │
│  🔍 Search threads...        │
│  ┌────────────────────────┐  │
│  │ Thread A (running)     │  │  ← 현재 워크스페이스의 스레드만
│  │ Thread B               │  │
│  └────────────────────────┘  │
│  [+ New Chat]                │
└──────────────────────────────┘
```

## 데이터 모델

```typescript
interface Workspace {
  id: string;              // nanoid 고유 ID
  name: string;            // 표시 이름 (기본: 폴더명)
  path: string;            // 서버 절대 경로
  createdAt: number;       // 생성 시간 (epoch ms)
  lastAccessedAt: number;  // 최근 접근 시간
}
```

## 저장 구조

```
~/.rca/data/
├── workspaces.json           # Workspace[]
├── threads/
│   ├── {workspaceId}.json    # 워크스페이스별 스레드 목록
│   └── default.json          # 기존 스레드 마이그레이션
└── messages/
    └── {threadId}.json       # (기존과 동일)
```

## 프로토콜

### Client → Server

| 메시지 타입 | 필드 | 설명 |
|---|---|---|
| `list_workspaces` | - | 워크스페이스 목록 요청 |
| `create_workspace` | `name`, `path` | 새 워크스페이스 생성 |
| `update_workspace` | `id`, `name?` | 워크스페이스 수정 |
| `delete_workspace` | `id` | 워크스페이스 삭제 |
| `browse_directory` | `path` | 폴더 브라우저 (디렉토리만 반환) |

### Server → Client

| 메시지 타입 | 필드 | 설명 |
|---|---|---|
| `workspaces_list` | `workspaces` | 워크스페이스 목록 |
| `workspace_created` | `workspace` | 생성된 워크스페이스 |
| `workspace_deleted` | `id` | 삭제된 워크스페이스 ID |
| `directory_list` | `path`, `entries` | 디렉토리 목록 (폴더만) |

### 기존 메시지 변경

- `list_threads`: `workspaceId` 필드 추가
- `send_message`: `workspaceId` 필드 추가 (config.cwd 자동 설정)
- `threads_list`: `workspaceId` 필드 추가

## UI 흐름

### 워크스페이스 선택

드롭다운에서 기존 워크스페이스 선택 또는 "새 워크스페이스" 클릭

### 새 워크스페이스 생성 (폴더 브라우저)

1. 모달 열기
2. 서버의 디렉토리 트리를 탐색 (lazy loading)
3. 폴더 선택 시 이름 자동 채움 (수정 가능)
4. "만들기" 클릭 → `create_workspace` 전송

### 워크스페이스 전환

1. 드롭다운에서 선택
2. 스레드 목록이 해당 워크스페이스 것으로 교체
3. `lastAccessedAt` 갱신
4. 에이전트 선택 상태는 유지

## 스레드 격리

- 스레드 저장: `threads/{workspaceId}.json`
- `list_threads` 요청 시 `workspaceId` 기준으로 필터
- 새 메시지 전송 시 워크스페이스 `path` → `config.cwd`

## 마이그레이션

서버 시작 시 기존 `threads.json`이 존재하면:
1. `default` 워크스페이스 자동 생성 (path = 서버 시작 cwd)
2. 기존 스레드를 `threads/default.json`으로 이동
3. 기존 `threads.json` 삭제

## 선행 작업

- Gemini CLI / Generic PTY 어댑터 제거 (추후 재구현 예정)
- `AgentType`을 `"claude" | "codex"`로 축소
