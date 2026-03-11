import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Menu,
  X,
  Sun,
  Moon,
  GitBranch,
  FolderOpen,
  Terminal,
  MessageSquare,
  LogOut,
  Loader2,
  Square,
} from 'lucide-react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAgentStore } from './hooks/useAgent';
import type { AgentType, ClientMessage, ServerMessage } from './lib/protocol';
import { generateThreadId } from './lib/protocol';
import ConnectScreen from './components/ConnectScreen';
import ChatView from './components/ChatView';
import TerminalView from './components/TerminalView';
import type { TerminalViewHandle } from './components/TerminalView';
import ThreadList from './components/ThreadList';
import AgentSelector from './components/AgentSelector';
import StatusBar from './components/StatusBar';
import MessageInput from './components/MessageInput';
import ApprovalBar from './components/ApprovalBar';
import GitPanel from './components/GitPanel';
import FileExplorer from './components/FileExplorer';

function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem('rca_theme') !== 'light';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    document.documentElement.classList.toggle('light', !dark);
    try {
      localStorage.setItem('rca_theme', dark ? 'dark' : 'light');
    } catch {
      // ignore
    }
  }, [dark]);

  return { dark, toggle: () => setDark((d) => !d) };
}

export default function App() {
  const theme = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [gitPanelOpen, setGitPanelOpen] = useState(false);
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'chat' | 'terminal'>('chat');

  const terminalRef = useRef<TerminalViewHandle>(null);

  // Store (ref 패턴으로 안정적인 콜백 유지)
  const store = useAgentStore();
  const storeRef = useRef(store);
  storeRef.current = store;

  // WebSocket (ref 패턴으로 콜백이 항상 최신 store 사용)
  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      storeRef.current.processServerMessage(msg);

      // Forward PTY output to terminal
      if (
        msg.type === 'agent_event' &&
        msg.event.type === 'pty_output'
      ) {
        terminalRef.current?.write(msg.event.data);
      }
    },
    [],
  );

  const handleStatusChange = useCallback(
    (s: 'disconnected' | 'connecting' | 'connected') => {
      storeRef.current.setConnectionStatus(s);
    },
    [],
  );

  const ws = useWebSocket({
    onMessage: handleMessage,
    onStatusChange: handleStatusChange,
  });
  const wsRef = useRef(ws);
  wsRef.current = ws;

  // Request initial data on connect + 활성 스레드 자동 복원
  useEffect(() => {
    if (ws.status === 'connected') {
      ws.send({ type: 'list_agents' });

      // 저장된 activeAgent/activeThread 복원
      const s = storeRef.current;
      if (s.activeAgent) {
        ws.send({ type: 'list_threads', agentType: s.activeAgent });
        ws.send({ type: 'select_agent', agentType: s.activeAgent });

        // 활성 스레드 상태 복원 (메시지 + 스트리밍 + 에이전트 상태)
        if (s.activeThread) {
          ws.send({ type: 'get_thread_state', agentType: s.activeAgent, threadId: s.activeThread });
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.status]);

  // Request threads when agent changes
  const prevAgentRef = useRef<AgentType | null>(store.activeAgent);
  useEffect(() => {
    if (ws.status === 'connected' && store.activeAgent) {
      // 에이전트가 변경되었을 때만 (동일 에이전트 중복 요청 방지)
      if (prevAgentRef.current !== store.activeAgent) {
        ws.send({ type: 'list_threads', agentType: store.activeAgent });
      }
      prevAgentRef.current = store.activeAgent;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.status, store.activeAgent]);

  // Determine if current agent uses PTY mode
  const isPtyAgent =
    store.activeAgent === 'pty' || store.activeAgent === 'gemini';

  // Auto-switch view mode based on agent type
  useEffect(() => {
    if (isPtyAgent) {
      setViewMode('terminal');
    } else {
      setViewMode('chat');
    }
  }, [isPtyAgent]);

  // Get current thread messages
  const currentMessages = store.activeThread
    ? store.messages.get(store.activeThread) || []
    : [];
  const currentStreaming = store.activeThread
    ? store.streamingContent.get(store.activeThread) ?? null
    : null;
  const currentToolCalls = store.activeThread
    ? store.activeToolCalls.get(store.activeThread) || []
    : [];

  // Check if agent is running
  const agentStatus = store.activeAgent
    ? store.agentStatuses.get(store.activeAgent)
    : undefined;
  const isRunning = agentStatus?.state === 'running'
    && agentStatus?.activeThread === store.activeThread;

  // 컨텍스트 사용량: agentStatus 우선, 없으면 스레드 저장값 fallback
  const activeThreadSummary = store.activeAgent && store.activeThread
    ? store.threads.get(store.activeAgent)?.find((t) => t.id === store.activeThread)
    : undefined;
  const contextUsage = agentStatus?.contextUsage || activeThreadSummary?.contextUsage;

  // Current thread approvals
  const currentApprovals = store.pendingApprovals.filter(
    (a) =>
      (!store.activeThread || a.threadId === store.activeThread) &&
      (!store.activeAgent || a.agentType === store.activeAgent),
  );

  // 현재 에이전트 설정 옵션
  const currentAgentInfo = store.agents.find((a) => a.type === store.activeAgent);
  const currentAgentOptions = currentAgentInfo?.options || [];
  const currentAgentSettings = store.activeAgent
    ? store.agentSettings.get(store.activeAgent) || {}
    : {};

  // Handlers (ref 패턴: 의존성 없이 안정적인 참조)
  const handleSendMessage = useCallback(
    (content: string) => {
      const s = storeRef.current;
      if (!s.activeAgent) return;

      // 새 대화: threadId를 클라이언트에서 생성
      const threadId = s.activeThread || generateThreadId();
      if (!s.activeThread) {
        s.setActiveThread(threadId);
      }

      s.addUserMessage(threadId, content);

      wsRef.current.send({
        type: 'send_message',
        agentType: s.activeAgent,
        threadId,
        content,
      });
    },
    [],
  );

  const handleInterrupt = useCallback(() => {
    const s = storeRef.current;
    if (!s.activeAgent || !s.activeThread) return;
    wsRef.current.send({
      type: 'interrupt',
      agentType: s.activeAgent,
      threadId: s.activeThread,
    });
  }, []);

  const handleApproval = useCallback(
    (
      agentType: AgentType,
      threadId: string,
      toolCallId: string,
      approved: boolean,
    ) => {
      wsRef.current.send({ type: 'approve', agentType, threadId, toolCallId, approved });
    },
    [],
  );

  const handleSelectAgent = useCallback(
    (agent: AgentType) => {
      storeRef.current.setActiveAgent(agent);
      storeRef.current.setActiveThread(null);
    },
    [],
  );

  const handleSelectThread = useCallback(
    (threadId: string) => {
      storeRef.current.setActiveThread(threadId);
      setSidebarOpen(false);

      // 전체 스레드 상태 복원 (메시지 + 스트리밍 + 에이전트 상태)
      const agent = storeRef.current.activeAgent;
      if (agent) {
        wsRef.current.send({ type: 'get_thread_state', agentType: agent, threadId });
      }
    },
    [],
  );

  const handleNewChat = useCallback(() => {
    storeRef.current.setActiveThread(null);
    setSidebarOpen(false);
  }, []);

  const handleTerminalInput = useCallback(
    (data: string) => {
      const s = storeRef.current;
      if (!s.activeAgent || !s.activeThread) return;
      wsRef.current.send({
        type: 'pty_input',
        agentType: s.activeAgent,
        threadId: s.activeThread,
        data,
      });
    },
    [],
  );

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      wsRef.current.send({ type: 'pty_resize', cols, rows });
    },
    [],
  );

  const handleGitSend = useCallback(
    (msg: ClientMessage) => {
      wsRef.current.send(msg);
    },
    [],
  );

  const handleAgentSettingChange = useCallback(
    (key: string, value: string) => {
      const s = storeRef.current;
      if (!s.activeAgent) return;

      const prev = s.agentSettings.get(s.activeAgent) || {};
      const updated = { ...prev, [key]: value };
      s.setAgentSettings(s.activeAgent, updated);

      // 서버에 설정 전달
      wsRef.current.send({
        type: 'select_agent',
        agentType: s.activeAgent,
        config: {
          type: s.activeAgent,
          model: updated.model || undefined,
          permissionMode: updated.permissionMode || updated.approvalMode || undefined,
          ...updated,
        },
      });
    },
    [],
  );

  // Show connect screen if not connected
  if (ws.status !== 'connected' && store.connectionStatus !== 'connected') {
    return (
      <ConnectScreen
        status={ws.status}
        onReconnect={ws.reconnect}
        onConnectDirect={ws.connectDirect}
      />
    );
  }

  return (
    <div className="flex overflow-hidden bg-(--bg-primary)" style={{ height: '100dvh' }}>
      {/* Sidebar overlay (mobile) */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-30 md:hidden sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-40 w-72 bg-(--bg-secondary) border-r border-(--border) flex flex-col transform transition-transform md:transform-none ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        } sidebar-panel`}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-(--border)">
          <h1 className="font-bold text-sm">RCA</h1>
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-1 rounded-lg hover:bg-(--bg-tertiary) transition-colors md:hidden"
          >
            <X size={18} />
          </button>
        </div>

        {/* Agent selector */}
        <div className="p-3 border-b border-(--border)">
          <AgentSelector
            agents={store.agents}
            statuses={store.agentStatuses}
            activeAgent={store.activeAgent}
            onSelect={handleSelectAgent}
          />
        </div>

        {/* Thread list */}
        <div className="flex-1 overflow-hidden">
          <ThreadList
            threads={store.threads}
            activeAgent={store.activeAgent}
            activeThread={store.activeThread}
            onSelectThread={handleSelectThread}
            onNewChat={handleNewChat}
          />
        </div>

        {/* Sidebar footer */}
        <div className="p-3 border-t border-(--border)">
          <StatusBar
            status={ws.status}
            payload={ws.payload}
            onSettingsClick={() => ws.disconnect()}
          />
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between px-3 sm:px-4 py-2 border-b border-(--border) bg-(--bg-primary)">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-lg hover:bg-(--bg-tertiary) transition-colors md:hidden"
            >
              <Menu size={18} />
            </button>
            <div className="hidden sm:flex items-center gap-2">
              {store.activeAgent && (
                <span className="text-sm font-medium text-(--text-secondary)">
                  {store.agents.find((a) => a.type === store.activeAgent)
                    ?.name || store.activeAgent}
                </span>
              )}
              {agentStatus?.model && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-(--bg-tertiary) text-(--text-muted)">
                  {agentStatus.model}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1">
            {/* View mode toggle (for PTY-capable agents) */}
            {isPtyAgent && (
              <div className="flex items-center bg-(--bg-secondary) rounded-lg p-0.5 mr-2">
                <button
                  onClick={() => setViewMode('chat')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    viewMode === 'chat'
                      ? 'bg-(--bg-tertiary) text-(--text-primary)'
                      : 'text-(--text-muted) hover:text-(--text-secondary)'
                  }`}
                >
                  <MessageSquare size={12} />
                  Chat
                </button>
                <button
                  onClick={() => setViewMode('terminal')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    viewMode === 'terminal'
                      ? 'bg-(--bg-tertiary) text-(--text-primary)'
                      : 'text-(--text-muted) hover:text-(--text-secondary)'
                  }`}
                >
                  <Terminal size={12} />
                  Terminal
                </button>
              </div>
            )}

            {/* Git panel button */}
            <button
              onClick={() => {
                setFilePanelOpen(false);
                setGitPanelOpen(!gitPanelOpen);
              }}
              className={`p-2 rounded-lg transition-colors ${
                gitPanelOpen
                  ? 'bg-(--accent)/10 text-(--accent)'
                  : 'hover:bg-(--bg-tertiary) text-(--text-muted)'
              }`}
              title="Git panel"
            >
              <GitBranch size={16} />
            </button>

            {/* File explorer button */}
            <button
              onClick={() => {
                setGitPanelOpen(false);
                setFilePanelOpen(!filePanelOpen);
              }}
              className={`p-2 rounded-lg transition-colors ${
                filePanelOpen
                  ? 'bg-(--accent)/10 text-(--accent)'
                  : 'hover:bg-(--bg-tertiary) text-(--text-muted)'
              }`}
              title="File explorer"
            >
              <FolderOpen size={16} />
            </button>

            {/* Theme toggle */}
            <button
              onClick={theme.toggle}
              className="p-2 rounded-lg hover:bg-(--bg-tertiary) transition-colors text-(--text-muted)"
              title={theme.dark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme.dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>

            {/* Disconnect */}
            <button
              onClick={ws.disconnect}
              className="p-2 rounded-lg hover:bg-(--bg-tertiary) transition-colors text-(--text-muted)"
              title="Disconnect"
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>

        {/* Main view */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {viewMode === 'terminal' ? (
            <div className="flex-1 p-2 sm:p-4">
              <TerminalView
                ref={terminalRef}
                onInput={handleTerminalInput}
                onResize={handleTerminalResize}
              />
            </div>
          ) : (
            <div className="flex-1 flex flex-col relative min-h-0 overflow-hidden">
              <ChatView
                messages={currentMessages}
                streamingContent={currentStreaming}
                activeToolCalls={currentToolCalls}
              />

              {/* 실행 중 오버레이 (채팅 영역 하단) */}
              {isRunning && (
                <div className="absolute bottom-0 left-0 right-0 flex justify-center pb-3 pointer-events-none z-10">
                  <button
                    onClick={handleInterrupt}
                    className="pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-full bg-(--bg-secondary) border border-(--border) shadow-lg text-xs text-(--text-muted) hover:bg-(--bg-tertiary) hover:text-(--text-primary) transition-colors"
                  >
                    <Loader2 size={12} className="animate-spin" />
                    <span>Agent is working...</span>
                    <Square size={10} fill="currentColor" className="text-(--error)" />
                    <span className="text-(--error)">Stop</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Approval bar */}
          <ApprovalBar
            approvals={currentApprovals}
            onApprove={handleApproval}
          />

          {/* Input + settings */}
          {viewMode === 'chat' && (
            <div className="bg-(--bg-primary)">
              <MessageInput
                onSend={handleSendMessage}
                onInterrupt={handleInterrupt}
                isRunning={isRunning}
                disabled={!store.activeAgent || ws.status !== 'connected'}
                inputOptions={currentAgentOptions.filter((o) => o.key === 'model' || o.key === 'effortLevel')}
                modeOption={currentAgentOptions.find((o) => o.key === 'permissionMode' || o.key === 'approvalMode') || null}
                settingValues={currentAgentSettings}
                onSettingChange={handleAgentSettingChange}
                contextUsage={contextUsage}
              />
            </div>
          )}
        </div>
      </main>

      {/* Side panels */}
      <GitPanel
        open={gitPanelOpen}
        onClose={() => setGitPanelOpen(false)}
        onSend={handleGitSend}
        gitResults={store.gitResults}
      />

      <FileExplorer
        open={filePanelOpen}
        onClose={() => setFilePanelOpen(false)}
        onSend={handleGitSend}
        fileEntries={store.fileEntries}
        fileContent={store.fileContent}
      />
    </div>
  );
}
