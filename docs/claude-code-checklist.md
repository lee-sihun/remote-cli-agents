# Claude Code 어댑터 체크포인트 리스트

> 작성일: 2026-03-11
> 대상: `packages/server/src/adapters/claude.ts`, `server.ts`, `store.ts`, `packages/web/src/`
> 목적: Codex 등 외부 검증용
> 비고: `[x]`는 현재 코드, 자동화 테스트(Vitest), 또는 실환경 `claude` CLI 검증으로 확인한 항목
> 실행 메모: 실환경 스모크 테스트는 `npm run test:claude`

---

## 1. 프로세스 라이프사이클

### 1-1. stdin 관리
- [x] `-p` 모드에서 `proc.stdin.write(message)` → `proc.stdin.end()` 호출
- [ ] stdin 닫힌 상태에서 `approve()` 호출 시 stdin.write 가능한지 확인
- [ ] `--resume` 세션에서 stdin end 후 프로세스가 정상 동작하는지 확인
- [ ] 매우 긴 프롬프트 (수만 자) stdin 전달 시 버퍼 오버플로 가능성

### 1-2. 프로세스 종료
- [ ] Windows에서 `proc.kill()` (SIGTERM 없이) 실제로 프로세스 트리 전체 종료되는지
- [ ] `shell: true`로 생성된 프로세스에서 kill 시 자식 프로세스(cmd.exe → claude.exe)도 종료되는지
- [ ] 타임아웃 (5분) 이후 프로세스가 실제로 종료되는지
- [ ] `close` 이벤트가 `kill()` 후 확실히 발생하는지 (zombie 프로세스 가능성)

### 1-3. 동시 실행
- [x] 같은 threadId로 `sendMessage` 연속 호출 시 이전 프로세스 kill → 새 프로세스 spawn 정상 동작
- [x] kill 후 `close` 이벤트의 `messageCompleted` 체크가 새 프로세스와 충돌하지 않는지
- [ ] 다른 threadId로 동시 실행 시 `status.activeThread`가 마지막 스레드만 추적 (의도된 동작인지)

---

## 2. stream-json 이벤트 파싱

### 2-1. 이벤트 타입 처리
- [x] `assistant` 이벤트: `message.content` 배열에서 text, thinking, tool_use 추출 정확성
- [x] `user` 이벤트: `tool_result` 매칭이 `tool_use_id` 기반으로 정확한지
- [x] `result` 이벤트: `session_id`, `model`, `cost_usd`, `usage` 추출 정확성
- [ ] 미처리 이벤트 타입: `system`은 처리 추가. `rate_limit_event`는 실환경 확인됐고 현재는 명시적으로 무시
- [x] Claude Code가 `--output-format stream-json`에서 실제로 어떤 이벤트를 보내는지 CLI 직접 검증

### 2-2. 텍스트 델타 vs 전체 텍스트
- [ ] `assistant` 이벤트의 `text`가 델타(증분)인지 전체 텍스트인지 확인
- [ ] `accumulatedText`에 중복 누적되지 않는지 (같은 텍스트가 여러 이벤트로 오는 경우)
- [ ] `result.result` 텍스트와 `accumulatedText`가 동일한 내용인지 (중복 가능성)

### 2-3. tool_use / tool_result 흐름
- [ ] `tool_use` → `tool_result` 순서가 항상 보장되는지
- [ ] `tool_result.tool_use_id`가 항상 존재하는지 (fallback으로 `lastToolCallId` 사용 중)
- [ ] 다중 tool_use가 한 `assistant` 이벤트에 올 수 있는지
- [ ] `tool_result` 없이 다음 `assistant`가 오는 경우 (도구 실행 실패 시)
- [ ] `pendingToolCalls` Map에 남은 채 result 이벤트가 오면 status가 'completed'로 처리되는지

---

## 3. 세션 연속성 (--resume)

### 3-1. sessionId 흐름
- [x] `result.session_id` → `threadInfo.sessionId` → `saveThreadMeta` (디스크) → `start()` (복원) → `--resume` 전달
- [x] `--resume`으로 이전 대화를 실제로 이어가는지 (Claude Code가 컨텍스트 유지)
- [ ] 잘못된/만료된 sessionId로 `--resume` 시 에러 처리
- [x] 서버 재시작 후 디스크에서 sessionId 복원 → `--resume` 동작 확인

### 3-2. 메시지 히스토리
- [ ] `store.appendMessage`로 저장된 메시지와 `--resume`으로 복원된 Claude 내부 히스토리 일치 여부
- [ ] 사용자 메시지가 `spawnClaude` 내에서 push + appendMessage 되는데, `--resume` 시 Claude가 이미 알고 있는 메시지와 중복되지 않는지
- [ ] `MAX_MESSAGES_PER_THREAD = 200` 제한으로 오래된 메시지 잘림 시 UI와 불일치

---

## 4. 컨텍스트 사용량

### 4-1. 토큰 계산
- [ ] `input_tokens + cache_read_input_tokens` 합산이 전체 입력 컨텍스트를 정확히 반영하는지
- [ ] `cache_creation_input_tokens`가 `input_tokens`의 부분집합인지 (Anthropic API 문서 확인)
- [ ] `output_tokens`가 컨텍스트 윈도우 사용량에 포함되어야 하는지 (output도 다음 턴의 input에 포함됨)

### 4-2. 컨텍스트 윈도우 크기 추정
- [ ] 모델명 기반 추정 (`1m` → 100만, 나머지 → 20만)이 현재 모델 라인업과 일치하는지
- [x] `result.modelUsage[*].contextWindow`가 있으면 실제 값을 우선 사용
- [ ] `sonnet`, `opus`, `haiku` 각각의 실제 컨텍스트 윈도우 크기
- [ ] `opusplan` 같은 커스텀 모델명 처리

### 4-3. 스레드별 관리
- [x] `threadInfo.contextUsage`와 `this.status.contextUsage` 동기화 (스레드 전환 시)
- [ ] 디스크에서 복원된 contextUsage가 실제 Claude 세션 상태와 일치하는지

---

## 5. 에러 처리

### 5-1. stderr 처리
- [ ] Claude Code stderr 출력이 항상 에러인지 (info/warning 수준 출력도 있을 수 있음)
- [ ] stderr 청크가 분할되어 올 때 불완전한 에러 메시지가 클라이언트에 전달되는지
- [x] stderr → error 이벤트와 close → error 이벤트 중복 방지 (`stderrEmitted` 플래그)

### 5-2. 프로세스 에러
- [x] `proc.on('error')` (spawn 실패): streamingBuffers 정리 + 에러 전파 확인
- [x] `proc.on('close')` (비정상 종료): `messageCompleted` 없을 때 fallback 메시지 생성 확인
- [x] exit code 0이지만 result 이벤트 없는 경우 처리 (빈 응답)

### 5-3. 이벤트 핸들러
- [x] `emit()` 내부 catch에서 `console.error` 로깅 확인
- [ ] WebSocket 전송 실패가 에이전트 동작에 영향 주지 않는지

---

## 6. 서버-클라이언트 동기화

### 6-1. 스레드 목록 복원
- [x] 서버 시작 시 `store.loadThreads('claude')` → `threads` Map 복원
- [ ] 클라이언트 연결 시 `list_threads` → `getThreads()` 반환값에 모든 스레드 포함
- [ ] 클라이언트 새로고침 시 localStorage `activeAgent`/`activeThread` → `get_thread_state` 흐름

### 6-2. 스트리밍 상태 동기화
- [x] `streamingBuffers`에 현재 진행 중인 content + toolCalls 정확히 추적
- [ ] `get_thread_state` 응답에 streaming 상태가 포함되는지
- [ ] 스레드 전환 시 이전 스레드의 스트리밍 이벤트가 계속 브로드캐스트되는데 클라이언트에서 올바른 스레드에 매핑하는지

### 6-3. 상태 전환
- [ ] `running` → `idle` 전환: `hasActiveThreads` 체크 로직
- [ ] 여러 스레드 동시 실행 시 `status.activeThread`가 단일 값만 추적 (다른 스레드는 running 표시 안 됨)
- [ ] 클라이언트의 `isRunning` 체크: `agentStatus.activeThread === store.activeThread`

---

## 7. 설정 관리

### 7-1. 모델 설정
- [ ] `--model` 플래그에 전달되는 모델명이 Claude Code가 인식하는 형식인지
- [ ] `sonnet`, `opus`, `haiku` → Claude Code의 실제 모델명 매핑
- [ ] `sonnet[1m]`, `opusplan` 같은 커스텀 값이 CLI에서 동작하는지
  - 실환경 메모: `sonnet[1m]`은 CLI에서 모델 문자열로 수용되지만 현재 계정에서는 rate limit으로 완료 검증 실패

### 7-2. 권한 모드
- [x] `--dangerously-skip-permissions` (bypassPermissions) 동작 확인
- [x] `--permission-mode plan/acceptEdits` 동작 확인
- [ ] 권한 모드 변경 시 실행 중 프로세스에 영향 없는지 (config만 갱신)

### 7-3. effortLevel
- [x] `--effort` 플래그 동작 확인
- [x] 어댑터가 `CLAUDE_CODE_EFFORT_LEVEL` 대신 `--effort`를 사용하도록 정렬
- [ ] Haiku에서 effortLevel 무시 처리 확인

---

## 8. 데이터 영속성

### 8-1. 디스크 저장
- [ ] `store.saveThread` 호출 시점: spawnClaude 시작, result 이벤트, close 이벤트
- [ ] `store.appendMessage` 호출 시점: 사용자 메시지, 어시스턴트 메시지 (result/close)
- [ ] 동기 I/O (`writeFileSync`) 사용 시 이벤트 루프 블로킹 영향
- [x] `MAX_MESSAGES_PER_THREAD = 200` 제한 적용

### 8-2. 데이터 무결성
- [ ] 프로세스 비정상 종료 시 마지막 메시지가 저장되는지
- [ ] 동시 writeFileSync 호출 시 파일 손상 가능성 (같은 threads.json에 동시 쓰기)
- [ ] `loadMessages` → `push` → `saveMessages` 패턴에서 race condition 가능성

---

## 9. 클라이언트 측 (useAgent.ts, App.tsx)

### 9-1. 스레드 전환
- [ ] `handleSelectThread` → `get_thread_state` 전송 → 메시지/스트리밍/상태 복원
- [x] 이전 스레드의 스트리밍 데이터가 새 스레드 선택 후에도 남아 있지 않는지
- [x] `streamingContent` / `activeToolCalls` 정리 시점

### 9-2. message_complete 처리
- [x] `activeToolCalls`에 있던 도구가 `message.toolCalls`에도 추가되는 로직 (중복 가능성)
- [x] `message_complete` 후 `streamingContent` 삭제 확인
- [ ] 서버에서 `message_complete` 없이 연결 끊김 시 UI 상태

### 9-3. 새 대화 생성
- [ ] `handleSendMessage`에서 `threadId` 생성 (클라이언트) vs `server.ts`의 `randomUUID()` (서버) 중복 확인
- [ ] `threadId` 형식: 클라이언트 `Date.now()-random` vs 서버 UUID → 불일치 문제 없는지

---

## 10. 보안/안정성

- [ ] `CLAUDECODE` 환경변수 삭제 (중첩 실행 방지) 동작 확인
- [ ] `shell: true` (Windows)에서 명령어 인젝션 가능성 (프롬프트가 stdin으로 전달되므로 낮음)
- [x] WebSocket 메시지 크기 제한 (1MB) 적용 확인
- [ ] 토큰/인증 검증이 WebSocket 업그레이드 시 올바르게 동작하는지
