# Remote CLI Agents (rca)

CLI 코딩 에이전트(Claude Code, Codex, Gemini CLI)를 웹 브라우저로 원격 조작하는 도구.

## 아키텍처

- Monorepo: `packages/shared`, `packages/server`, `packages/web`
- Server: Node.js + ws + node-pty 기반 Bridge 서버
- Web Client: React 19 + Vite + Tailwind CSS v4 + xterm.js (PWA)
- Connection: Cloudflare 터널 + LAN 직접 연결
- Agent Adapters: Claude Code (stream-json), Codex (JSON-RPC), Gemini/Generic (PTY)

## 주요 명령어

```bash
npm install           # 모든 워크스페이스 의존성 설치
npm run dev           # 개발 서버 + 웹 클라이언트 시작
npm run build         # 전체 빌드
npm start             # 프로덕션 서버 시작
```

## 가드레일

- 의존성 최소화
- node-pty는 선택적 (동적 import + try-catch)
- 모든 에이전트 CLI 실행은 로컬에서만 수행
- 시크릿/토큰은 코드에 포함하지 않음 - 런타임 생성
- 모바일 우선 반응형 디자인

---

# 프로젝트 규칙

## 네이밍 컨벤션

### TypeScript / React

| 대상 | 규칙 | 예시 |
|------|------|------|
| 컴포넌트 파일 | PascalCase 
| 훅 파일 | camelCase + `use` 접두사 
| 스토어 파일 | camelCase + `use` 접두사 
| 유틸리티 파일 | camelCase 
| 컴포넌트명 | PascalCase 
| Props 타입 | PascalCase + `Props` 접미사 
| 타입/인터페이스 | PascalCase 
| 변수/함수 | camelCase 
| Zustand 스토어 | `use` + PascalCase + `Store` 

## 코딩 컨벤션

### React 컴포넌트

- **화살표 함수** + **Props 인라인 구조분해** 패턴 사용:
  ```tsx
  const UserProfile = ({ name, age }: UserProfileProps) => {
    return <div>{name}</div>;
  };

  export default UserProfile;
  ```
- Props 타입은 `interface`로 정의, 컴포넌트 바로 위에 선언
- 기본 export는 `export default` 사용 (컴포넌트)
- 훅/유틸리티는 named export 사용

### 컴포넌트 설계

- 컴포넌트 분리와 훅 모듈화를 철저히 유지
- 오버엔지니어링 지양, 장기 유지보수 가능한 단순한 코드 작성
- 한 파일이 과도하게 커지면 분리 검토

### 주석

- 기술 용어를 제외하면 **한글**로 작성
- **키워드/명사형** 스타일 사용 
- 불필요한 주석 지양 — 코드로 의도가 명확하면 주석 생략

### 커밋 
- 커밋 메시지는 **한글**로 작성
- feat:, fix:, refactor: 등 **커밋 타입**을 명확히 사용
- 커밋 메시지는 **명사형**으로 작성 (예: "로그인 기능 추가", "버그 수정" 등)

### 작업 흐름 
- 단계별 작업 흐름을 명확히 정의
- 각 단계 별 작업 완료 후 **코드 리뷰** 및 **디버깅**, **테스트**를 철저히 수행
- 각 단계 별 작업이 완료되면 **커밋**을 통해 변경 사항을 기록 
