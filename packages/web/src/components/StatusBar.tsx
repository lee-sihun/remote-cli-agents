import React from 'react';
import { Wifi, WifiOff, Loader2 } from 'lucide-react';
import type { ConnectionStatus, ReconnectState } from '../hooks/useWebSocket';

interface StatusBarProps {
  status: ConnectionStatus;
  reconnectState: ReconnectState;
  onSettingsClick: () => void;
  className?: string;
}

export default function StatusBar({
  status,
  reconnectState,
  onSettingsClick,
  className = '',
}: StatusBarProps) {
  const statusConfig = {
    connected: {
      icon: Wifi,
      textColor: 'text-(--success)',
      label: '서버 연결됨',
    },
    connecting: {
      icon: Loader2,
      textColor: 'text-(--warning)',
      label: reconnectState.attempt > 0
        ? `재연결 중 ${reconnectState.attempt}/${reconnectState.maxAttempts}`
        : '서버 연결 중',
    },
    disconnected: {
      icon: WifiOff,
      textColor: 'text-(--error)',
      label: '연결 끊김',
    },
  };

  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <button
      onClick={onSettingsClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-(--bg-tertiary) transition-colors text-sm ${className}`}
      title="서버 연결 상태"
    >
      <Icon
        size={14}
        className={`${config.textColor} ${status === 'connecting' ? 'animate-spin' : ''}`}
      />
      <span className={`${config.textColor} hidden sm:inline`}>
        {config.label}
      </span>
    </button>
  );
}
