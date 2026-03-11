import React, { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  User,
  Bot,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Wrench,
  Brain,
  Check,
  X,
  Loader2,
  Clock,
} from 'lucide-react';
import type { AgentMessage, ToolCall } from '../lib/protocol';
import CodeBlock from './CodeBlock';

interface ChatViewProps {
  messages: AgentMessage[];
  streamingContent: string | null;
  activeToolCalls?: ToolCall[];
}

// ─── Tool Call Card ───

function ToolCallCard({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = React.useState(false);

  const statusIcon = {
    pending: <Clock size={12} className="text-(--text-muted)" />,
    running: <Loader2 size={12} className="text-(--warning) animate-spin" />,
    completed: <Check size={12} className="text-(--success)" />,
    failed: <X size={12} className="text-(--error)" />,
    abandoned: <AlertCircle size={12} className="text-(--text-muted)" />,
    requires_approval: (
      <AlertCircle size={12} className="text-(--warning)" />
    ),
  };

  const statusLabel = {
    pending: 'Pending',
    running: 'Running...',
    completed: 'Done',
    failed: 'Failed',
    abandoned: 'Abandoned',
    requires_approval: 'Needs approval',
  };

  return (
    <div className="my-2 rounded-lg border border-(--border) overflow-hidden bg-(--bg-primary)/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-(--bg-tertiary)/50 transition-colors"
      >
        <Wrench size={12} className="text-(--accent) shrink-0" />
        <span className="text-xs font-mono font-medium flex-1 truncate">
          {tool.name}
        </span>
        {statusIcon[tool.status]}
        <span className="text-xs text-(--text-muted)">
          {statusLabel[tool.status]}
        </span>
        {expanded ? (
          <ChevronDown size={12} className="text-(--text-muted)" />
        ) : (
          <ChevronRight size={12} className="text-(--text-muted)" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-(--border) p-3 space-y-2">
          {tool.input && Object.keys(tool.input).length > 0 && (
            <div>
              <div className="text-xs font-medium text-(--text-muted) mb-1">
                Input
              </div>
              <pre className="text-xs font-mono bg-(--bg-primary) rounded p-2 overflow-x-auto max-h-48 overflow-y-auto">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          )}
          {tool.output && (
            <div>
              <div className="text-xs font-medium text-(--text-muted) mb-1">
                Output
              </div>
              <pre className="text-xs font-mono bg-(--bg-primary) rounded p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
                {tool.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Reasoning Block ───

function ReasoningBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="my-2 rounded-lg border border-(--border) overflow-hidden bg-(--bg-primary)/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-(--bg-tertiary)/50 transition-colors"
      >
        <Brain size={12} className="text-purple-400 shrink-0" />
        <span className="text-xs font-medium text-purple-400 flex-1">
          Thinking...
        </span>
        {expanded ? (
          <ChevronDown size={12} className="text-(--text-muted)" />
        ) : (
          <ChevronRight size={12} className="text-(--text-muted)" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-(--border) p-3">
          <div className="text-xs text-(--text-secondary) whitespace-pre-wrap leading-relaxed">
            {content}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Message Bubble ───

function MessageBubble({ message }: { message: AgentMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end mb-4 animate-slide-right">
        <div className="max-w-[85%] sm:max-w-[70%]">
          <div className="bg-(--user-bubble) text-(--user-bubble-text) rounded-2xl rounded-br-md px-4 py-2.5">
            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          </div>
          <div className="text-right mt-1">
            <span className="text-xs text-(--text-muted)">
              {new Date(message.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
        </div>
        <div className="shrink-0 ml-2 flex items-start">
          <div className="w-7 h-7 rounded-full bg-(--user-bubble) flex items-center justify-center">
            <User size={14} className="text-white" />
          </div>
        </div>
      </div>
    );
  }

  if (message.role === 'system') {
    return (
      <div className="flex justify-center mb-4 animate-fade-in">
        <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-(--bg-secondary) border border-(--border)">
          <AlertCircle size={14} className="text-(--warning)" />
          <span className="text-xs text-(--text-secondary)">
            {message.content}
          </span>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="flex justify-start mb-4 animate-slide-left">
      <div className="shrink-0 mr-2 flex items-start">
        <div className="w-7 h-7 rounded-full bg-(--accent) flex items-center justify-center">
          <Bot size={14} className="text-white" />
        </div>
      </div>
      <div className="max-w-[85%] sm:max-w-[70%] min-w-0">
        {message.reasoning && <ReasoningBlock content={message.reasoning} />}

        {message.toolCalls?.map((tool) => (
          <ToolCallCard key={tool.id} tool={tool} />
        ))}

        {message.content && (
          <div className="bg-(--assistant-bubble) text-(--assistant-bubble-text) rounded-2xl rounded-bl-md px-4 py-2.5">
            <div className="markdown-content text-sm">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || '');
                    const inline =
                      !className &&
                      typeof children === 'string' &&
                      !children.includes('\n');
                    if (inline) {
                      return (
                        <code className={className} {...props}>
                          {children}
                        </code>
                      );
                    }
                    return (
                      <CodeBlock language={match?.[1]}>
                        {String(children).replace(/\n$/, '')}
                      </CodeBlock>
                    );
                  },
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          </div>
        )}

        <div className="mt-1">
          <span className="text-xs text-(--text-muted)">
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Streaming Indicator ───

function StreamingBubble({ content, toolCalls }: { content: string; toolCalls?: ToolCall[] }) {
  return (
    <div className="flex justify-start mb-4">
      <div className="shrink-0 mr-2 flex items-start">
        <div className="w-7 h-7 rounded-full bg-(--accent) flex items-center justify-center">
          <Bot size={14} className="text-white" />
        </div>
      </div>
      <div className="max-w-[85%] sm:max-w-[70%] min-w-0">
        {/* 스트리밍 중 tool calls */}
        {toolCalls && toolCalls.length > 0 && (
          <div className="mb-1">
            {toolCalls.map((tool) => (
              <ToolCallCard key={tool.id} tool={tool} />
            ))}
          </div>
        )}

        <div className="bg-(--assistant-bubble) text-(--assistant-bubble-text) rounded-2xl rounded-bl-md px-4 py-2.5">
          {content ? (
            <div className="markdown-content text-sm">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || '');
                    const inline =
                      !className &&
                      typeof children === 'string' &&
                      !children.includes('\n');
                    if (inline) {
                      return (
                        <code className={className} {...props}>
                          {children}
                        </code>
                      );
                    }
                    return (
                      <CodeBlock language={match?.[1]}>
                        {String(children).replace(/\n$/, '')}
                      </CodeBlock>
                    );
                  },
                }}
              >
                {content}
              </ReactMarkdown>
              <span className="inline-block w-2 h-4 bg-(--accent) ml-0.5 animate-blink" />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-(--accent)" />
              <span className="text-sm text-(--text-muted)">
                Thinking...
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Chat View ───

export default function ChatView({
  messages,
  streamingContent,
  activeToolCalls,
}: ChatViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);

  // Track scroll position
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function handleScroll() {
      if (!container) return;
      const threshold = 100;
      isNearBottom.current =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        threshold;
    }

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-scroll when new messages arrive
  useEffect(() => {
    if (isNearBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, streamingContent]);

  if (messages.length === 0 && !streamingContent) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center">
          <Bot size={48} className="mx-auto text-(--text-muted) mb-4" />
          <h2 className="text-lg font-medium text-(--text-secondary) mb-1">
            Start a conversation
          </h2>
          <p className="text-sm text-(--text-muted) max-w-sm">
            Send a message to begin working with your coding agent. You can ask
            it to write code, debug issues, or explore your project.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="max-w-4xl mx-auto">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {streamingContent !== null && (
          <StreamingBubble content={streamingContent} toolCalls={activeToolCalls} />
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
