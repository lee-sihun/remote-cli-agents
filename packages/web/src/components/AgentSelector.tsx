import React from 'react';
import { Bot, ChevronDown } from 'lucide-react';
import type { AgentInfo, AgentStatus, AgentType } from '../lib/protocol';

interface AgentSelectorProps {
  agents: AgentInfo[];
  statuses: Map<AgentType, AgentStatus>;
  activeAgent: AgentType | null;
  onSelect: (agent: AgentType) => void;
}

function statusDot(status?: AgentStatus): string {
  if (!status) return 'bg-[var(--text-muted)]';
  switch (status.state) {
    case 'idle':
      return 'bg-[var(--success)]';
    case 'running':
      return 'bg-[var(--warning)] animate-pulse';
    case 'waiting_approval':
      return 'bg-[var(--warning)]';
    case 'error':
      return 'bg-[var(--error)]';
    default:
      return 'bg-[var(--text-muted)]';
  }
}

export default function AgentSelector({
  agents,
  statuses,
  activeAgent,
  onSelect,
}: AgentSelectorProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  // Close on outside click
  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const active = agents.find((a) => a.type === activeAgent);
  const activeStatus = activeAgent ? statuses.get(activeAgent) : undefined;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors w-full"
      >
        <Bot size={16} className="text-[var(--accent)]" />
        <span className="flex-1 text-left text-sm font-medium truncate">
          {active ? active.name : 'Select Agent'}
        </span>
        {active && (
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${statusDot(activeStatus)}`}
          />
        )}
        <ChevronDown
          size={14}
          className={`text-[var(--text-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl z-50 overflow-hidden animate-fade-in">
          {agents.map((agent) => {
            const s = statuses.get(agent.type);
            return (
              <button
                key={agent.type}
                onClick={() => {
                  onSelect(agent.type);
                  setOpen(false);
                }}
                disabled={!agent.available}
                className={`flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-[var(--bg-tertiary)] transition-colors ${
                  agent.type === activeAgent
                    ? 'bg-[var(--bg-tertiary)]'
                    : ''
                } ${!agent.available ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${statusDot(s)}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {agent.name}
                  </div>
                  <div className="text-xs text-[var(--text-muted)] truncate">
                    {agent.description}
                    {s?.model ? ` - ${s.model}` : ''}
                  </div>
                </div>
                {!agent.available && (
                  <span className="text-xs text-[var(--error)]">
                    unavailable
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
