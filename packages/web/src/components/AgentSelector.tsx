import React from 'react';
import { ChevronDown } from 'lucide-react';
import type { AgentInfo, AgentType } from '../lib/protocol';
import AgentLogo, { getAgentBrandLabel } from './AgentLogo';

interface AgentSelectorProps {
  agents: AgentInfo[];
  activeAgent: AgentType | null;
  onSelect: (agent: AgentType) => void;
}

export default function AgentSelector({
  agents,
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

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        data-testid="agent-selector-button"
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-(--bg-secondary) border border-(--border) hover:bg-(--bg-tertiary) transition-colors w-full"
      >
        {activeAgent ? (
          <AgentLogo agent={activeAgent} size={16} className="text-(--accent) shrink-0" />
        ) : (
          <div className="w-4 h-4 shrink-0" />
        )}
        <span className="flex-1 text-left text-sm font-medium truncate">
          {active ? active.name : 'Select Agent'}
        </span>
        <ChevronDown
          size={14}
          className={`text-(--text-muted) transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-(--bg-secondary) border border-(--border) rounded-lg shadow-xl z-50 overflow-hidden animate-fade-in">
          {agents.map((agent) => {
            return (
              <button
                key={agent.type}
                onClick={() => {
                  onSelect(agent.type);
                  setOpen(false);
                }}
                disabled={!agent.available}
                className={`flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-(--bg-tertiary) transition-colors ${
                  agent.type === activeAgent
                    ? 'bg-(--bg-tertiary)'
                    : ''
                } ${!agent.available ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <AgentLogo agent={agent.type} size={16} className="text-(--accent) shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {agent.name}
                  </div>
                  <div className="text-xs text-(--text-muted) truncate">
                    {getAgentBrandLabel(agent.type)}
                  </div>
                </div>
                {!agent.available && (
                  <span className="text-xs text-(--error)">
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
