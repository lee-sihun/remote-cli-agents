import React from 'react';
import { Wifi, WifiOff, Loader2, Settings } from 'lucide-react';
import type { ConnectionStatus } from '../hooks/useWebSocket';
import type { QRPayload } from '../lib/protocol';

interface StatusBarProps {
  status: ConnectionStatus;
  payload: QRPayload | null;
  onSettingsClick: () => void;
}

export default function StatusBar({
  status,
  payload,
  onSettingsClick,
}: StatusBarProps) {
  const statusConfig = {
    connected: {
      color: 'bg-[var(--success)]',
      textColor: 'text-[var(--success)]',
      icon: Wifi,
      label: 'Connected',
    },
    connecting: {
      color: 'bg-[var(--warning)]',
      textColor: 'text-[var(--warning)]',
      icon: Loader2,
      label: 'Reconnecting...',
    },
    disconnected: {
      color: 'bg-[var(--error)]',
      textColor: 'text-[var(--error)]',
      icon: WifiOff,
      label: 'Disconnected',
    },
  };

  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <button
      onClick={onSettingsClick}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors text-sm"
      title="Connection settings"
    >
      <span className="relative flex items-center">
        <span
          className={`w-2 h-2 rounded-full ${config.color} ${status === 'connecting' ? 'animate-pulse' : ''}`}
        />
      </span>
      <Icon
        size={14}
        className={`${config.textColor} ${status === 'connecting' ? 'animate-spin' : ''}`}
      />
      <span className={`${config.textColor} hidden sm:inline`}>
        {config.label}
      </span>
      {payload?.relay && status === 'connected' && (
        <span className="text-[var(--text-muted)] text-xs hidden sm:inline">
          (relay)
        </span>
      )}
      <Settings size={14} className="text-[var(--text-muted)]" />
    </button>
  );
}
