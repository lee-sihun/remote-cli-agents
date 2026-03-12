# Codex 어댑터 체크포인트 리스트

> 작성일: 2026-03-12
> 대상: `packages/server/src/adapters/codex.ts`, `packages/web/src/App.tsx`, `packages/web/src/components/MessageInput.tsx`
> 목적: RCA의 Codex 기능을 실사용 가능 수준으로 검증하고 회귀를 막기 위한 기준 문서
> 비고: `[x]`는 현재 코드, Vitest, 로컬 `codex` CLI 스모크 테스트, 또는 공식 OpenAI 문서/로컬 app-server 프로토콜 생성물로 확인한 항목
> 실행 메모:
> - 단위 테스트: `npm test -- --run packages/server/src/adapters/codex.test.ts`
> - 런타임 스모크 테스트: `npm run test:codex`
> - PinchTab 브라우저 E2E: `npm run test:pinchtab:codex`
> - 전체 회귀: `npm test`

---

## 0. 문서 기준선

- [x] OpenAI 공식 Codex 문서를 1차 기준으로 사용 (`/codex`, `/codex/cli`, `/codex/config`, `/codex/security`)
- [x] 문서 재검증 시 웹 검색은 OpenAI 공식 도메인만 대상으로 제한
- [x] 문서와 함께 로컬 `codex --help`, `codex app-server --help`, `npm run test:codex` 결과를 함께 비교

## 1. CLI / app-server 정합성

- [x] `codex app-server` 실행 시 `--model`, `--full-auto`, `--ask-for-approval` 같은 TUI 전용 플래그를 붙이지 않음
- [x] app-server 초기화는 `initialize` JSON-RPC로 수행
- [x] `model/list` 결과를 사용해 Codex 모델 선택 UI를 동적으로 구성
- [x] fallback 옵션도 현재 로컬 CLI 기준(`gpt-5.4`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`)으로 정렬

## 2. 설정 옵션

- [x] 모델 선택값이 실제 `turn/start` / `thread/start`에 반영
- [x] Approval 옵션이 `on-request`, `untrusted`, `never` 정책과 일치
- [x] Access 옵션이 `workspace-write`, `danger-full-access`, `read-only`와 일치
- [x] `gpt-5.4` 전용 Speed 옵션(`Standard`, `Fast`)을 분리 노출
- [x] Fast 관련 옵션은 `gpt-5.4` 선택 시에만 노출
- [x] Reasoning 옵션은 app-server `supportedReasoningEfforts` 기준으로 구성

## 3. 스레드 라이프사이클

- [x] 새 스레드는 `thread/start` 후 `turn/start`
- [x] 저장된 스레드는 `thread/resume` 후 `turn/start`
- [x] `turn/interrupt`가 현재 `turnId`를 사용
- [x] 앱 재시작 후 디스크의 Codex 스레드를 다시 읽어 UI 목록 복원

## 4. 이벤트 파싱

- [x] `item/agentMessage/delta`를 assistant 스트리밍으로 누적
- [x] `turn/started`, `turn/completed`를 상태 전환에 사용
- [x] `thread/tokenUsage/updated`를 Context UI에 반영
- [x] `model/rerouted` 발생 시 현재 스레드 모델 표시값 갱신
- [x] `item/started` / `item/completed`에서 command/fileChange/mcp/dynamic tool을 ToolCall로 변환

## 5. 승인 워크플로우

- [x] `item/commandExecution/requestApproval` 요청을 브라우저 승인 UI로 릴레이
- [x] `item/fileChange/requestApproval` 요청을 브라우저 승인 UI로 릴레이
- [x] `item/permissions/requestApproval` 기본 응답 경로 지원
- [x] 승인/거부 결과를 동일한 JSON-RPC `id`로 응답

## 6. 영속성

- [x] 사용자 메시지 저장
- [x] assistant 완료 메시지 저장
- [x] 스레드별 model / contextUsage / config 스냅샷 저장
- [ ] Codex 자체 세션 파일과 RCA 저장 메시지의 장기 일관성 심층 검증

## 7. 자동화 테스트 범위

- [x] app-server spawn 인자 검증
- [x] `model/list` 기반 옵션 구성 검증
- [x] 새 스레드 `thread/start` + `turn/start` 페이로드 검증
- [x] 저장 스레드 `thread/resume` + interrupt 검증
- [x] approval request/response 검증
- [x] 로컬 Codex CLI 실환경 스모크 테스트 스크립트 추가
- [x] PinchTab 기반 Codex 브라우저 E2E 시나리오 추가
  - 범위: 에이전트 전환, 동적 모델 목록, `gpt-5.4` Fast 표시 조건, 리로드 후 Codex UI 복원
  - 실응답/토큰 스트림은 `npm run test:codex`가 담당

## 8. 추가 확인 필요

- [ ] `gpt-5.4` Fast가 계정/모델 조합별로 실제 허용되는지 장기 검증
- [ ] permission request 세부 응답(`scope=session`, 정책 amendment) UI 확장
- [ ] request user input / elicitation 류 server request UI 대응
