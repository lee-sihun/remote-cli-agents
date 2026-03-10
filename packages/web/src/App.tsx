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
} from 'lucide-react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAgentStore } from './hooks/useAgent';
import type { AgentType, ClientMessage, ServerMessage } from './lib/protocol';
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

  // Store
  const store = useAgentStore();

  // WebSocket
  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      store.processServerMessage(msg);

      // Forward PTY output to terminal
      if (
        msg.type === 'agent_event' &&
        msg.event.type === 'pty_output'
      ) {
        terminalRef.current?.write(msg.event.data);
      }
    },
    [store],
  );

  const handleStatusChange = useCallback(
    (s: 'disconnected' | 'connecting' | 'connected') => {
      store.setConnectionStatus(s);
    },
    [store],
  );

  const ws = useWebSocket({
    onMessage: handleMessage,
    onStatusChange: handleStatusChange,
  });

  // Request initial data on connect
  useEffect(() => {
    if (ws.status === 'connected') {
      ws.send({ type: 'list_agents' });
    }
  }, [ws.status, ws]);

  // Request threads when agent changes
  useEffect(() => {
    if (ws.status === 'connected' && store.activeAgent) {
      ws.send({ type: 'list_threads', agentType: store.activeAgent });
      ws.send({
        type: 'select_agent',
        agentType: store.activeAgent,
      });
    }
  }, [ws.status, store.activeAgent, ws]);

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

  // Check if agent is running
  const agentStatus = store.activeAgent
    ? store.agentStatuses.get(store.activeAgent)
    : undefined;
  const isRunning = agentStatus?.state === 'running';

  // Current thread approvals
  const currentApprovals = store.pendingApprovals.filter(
    (a) =>
      (!store.activeThread || a.threadId === store.activeThread) &&
      (!store.activeAgent || a.agentType === store.activeAgent),
  );

  // Handlers
  const handleSendMessage = useCallback(
    (content: string) => {
      if (!store.activeAgent) return;
      const threadId = store.activeThread || undefined;

      // Add optimistic user message
      if (threadId) {
        store.addUserMessage(threadId, content);
      }

      ws.send({
        type: 'send_message',
        agentType: store.activeAgent,
        threadId,
        content,
      });
    },
    [store, ws],
  );

  const handleInterrupt = useCallback(() => {
    if (!store.activeAgent || !store.activeThread) return;
    ws.send({
      type: 'interrupt',
      agentType: store.activeAgent,
      threadId: store.activeThread,
    });
  }, [store, ws]);

  const handleApproval = useCallback(
    (
      agentType: AgentType,
      threadId: string,
      toolCallId: string,
      approved: boolean,
    ) => {
      ws.send({ type: 'approve', agentType, threadId, toolCallId, approved });
    },
    [ws],
  );

  const handleSelectAgent = useCallback(
    (agent: AgentType) => {
      store.setActiveAgent(agent);
      store.setActiveThread(null);
    },
    [store],
  );

  const handleSelectThread = useCallback(
    (threadId: string) => {
      store.setActiveThread(threadId);
      setSidebarOpen(false);
    },
    [store],
  );

  const handleNewChat = useCallback(() => {
    store.setActiveThread(null);
    setSidebarOpen(false);
  }, [store]);

  const handleTerminalInput = useCallback(
    (data: string) => {
      if (!store.activeAgent || !store.activeThread) return;
      ws.send({
        type: 'pty_input',
        agentType: store.activeAgent,
        threadId: store.activeThread,
        data,
      });
    },
    [store, ws],
  );

  const handleTerminalResize = useCallback(
    (cols: number, rows: number) => {
      ws.send({ type: 'pty_resize', cols, rows });
    },
    [ws],
  );

  const handleGitSend = useCallback(
    (msg: ClientMessage) => {
      ws.send(msg);
    },
    [ws],
  );

  // Show connect screen if not connected
  if (ws.status !== 'connected' && store.connectionStatus !== 'connected') {
    return (
      <ConnectScreen
        status={ws.status}
        onConnect={ws.connect}
        onConnectDirect={ws.connectDirect}
      />
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg-primary)]">
      {/* Sidebar overlay (mobile) */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-30 md:hidden sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed md:static inset-y-0 left-0 z-40 w-72 bg-[var(--bg-secondary)] border-r border-[var(--border)] flex flex-col transform transition-transform md:transform-none ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        } sidebar-panel`}
      >
        {/* Sidebar header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <h1 className="font-bold text-sm">RCA</h1>
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-1 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors md:hidden"
          >
            <X size={18} />
          </button>
        </div>

        {/* Agent selector */}
        <div className="p-3 border-b border-[var(--border)]">
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
        <div className="p-3 border-t border-[var(--border)]">
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
        <header className="flex items-center justify-between px-3 sm:px-4 py-2 border-b border-[var(--border)] bg-[var(--bg-primary)]">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors md:hidden"
            >
              <Menu size={18} />
            </button>
            <div className="hidden sm:flex items-center gap-2">
              {store.activeAgent && (
                <span className="text-sm font-medium text-[var(--text-secondary)]">
                  {store.agents.find((a) => a.type === store.activeAgent)
                    ?.name || store.activeAgent}
                </span>
              )}
              {agentStatus?.model && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                  {agentStatus.model}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1">
            {/* View mode toggle (for PTY-capable agents) */}
            {isPtyAgent && (
              <div className="flex items-center bg-[var(--bg-secondary)] rounded-lg p-0.5 mr-2">
                <button
                  onClick={() => setViewMode('chat')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    viewMode === 'chat'
                      ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  <MessageSquare size={12} />
                  Chat
                </button>
                <button
                  onClick={() => setViewMode('terminal')}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    viewMode === 'terminal'
                      ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
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
                  ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                  : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
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
                  ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                  : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
              }`}
              title="File explorer"
            >
              <FolderOpen size={16} />
            </button>

            {/* Theme toggle */}
            <button
              onClick={theme.toggle}
              className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors text-[var(--text-muted)]"
              title={theme.dark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme.dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>

            {/* Disconnect */}
            <button
              onClick={ws.disconnect}
              className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors text-[var(--text-muted)]"
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
            <ChatView
              messages={currentMessages}
              streamingContent={currentStreaming}
            />
          )}

          {/* Approval bar */}
          <ApprovalBar
            approvals={currentApprovals}
            onApprove={handleApproval}
          />

          {/* Input */}
          {viewMode === 'chat' && (
            <MessageInput
              onSend={handleSendMessage}
              onInterrupt={handleInterrupt}
              isRunning={isRunning}
              disabled={!store.activeAgent || ws.status !== 'connected'}
            />
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
