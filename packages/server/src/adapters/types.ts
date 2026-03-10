import type {
  AgentType,
  AgentConfig,
  AgentEvent,
  AgentStatus,
  ThreadSummary,
} from '@rca/shared';

// AgentAdapter 인터페이스 - 모든 에이전트 어댑터가 구현해야 하는 계약
export interface AgentAdapter {
  readonly name: string;
  readonly type: AgentType;

  // 라이프사이클
  start(config: AgentConfig): Promise<void>;
  stop(): Promise<void>;
  isAvailable(): Promise<boolean>;

  // 대화
  sendMessage(threadId: string, message: string): void;
  interrupt(threadId: string): void;

  // 이벤트
  onEvent(handler: (event: AgentEvent) => void): void;

  // 상태
  getStatus(): AgentStatus;
  getThreads(): Promise<ThreadSummary[]>;
}

// 이벤트 핸들러 타입
export type AgentEventHandler = (event: AgentEvent) => void;
