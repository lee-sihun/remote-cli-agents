import { useEffect } from 'react';
import { Loader2, RefreshCw, Wifi, WifiOff, X } from 'lucide-react';
import type { ConnectionStatus, ReconnectState } from '../hooks/useWebSocket';

interface ConnectScreenProps {
  open: boolean;
  status: ConnectionStatus;
  reconnectState: ReconnectState;
  onClose: () => void;
  onReconnect: () => void;
}

const ConnectScreen = ({
  open,
  status,
  reconnectState,
  onClose,
  onReconnect,
}: ConnectScreenProps) => {
  useEffect(() => {
    if (!open) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  const statusInfo = {
    connected: {
      icon: Wifi,
      iconClassName: 'text-(--success)',
      title: '현재 연결됨',
      description: '연결 상태를 확인하고 필요하면 다시 연결할 수 있습니다.',
    },
    connecting: {
      icon: Loader2,
      iconClassName: 'text-(--warning) animate-spin',
      title: reconnectState.attempt > 0
        ? `자동 재연결 ${reconnectState.attempt}/${reconnectState.maxAttempts}`
        : '서버 연결 중',
      description: reconnectState.attempt > 0
        ? '연결이 끊겨 자동으로 다시 붙는 중입니다.'
        : '서버 연결을 시도하고 있습니다.',
    },
    disconnected: {
      icon: WifiOff,
      iconClassName: 'text-(--error)',
      title: reconnectState.exhausted ? '자동 재연결 실패' : '연결이 끊어졌습니다',
      description: reconnectState.exhausted
        ? '자동 재연결 시도를 모두 마쳤습니다. 직접 다시 시도해주세요.'
        : '필요하면 바로 재연결할 수 있습니다.',
    },
  }[status];

  const StatusIcon = statusInfo.icon;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-modal-title"
        className="w-full max-w-md rounded-t-3xl border border-(--border) bg-(--bg-primary) p-5 shadow-2xl animate-fade-in sm:rounded-3xl sm:p-6"
        style={{ animationDuration: '0.16s' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-(--border) bg-(--bg-secondary)">
              <StatusIcon size={22} className={statusInfo.iconClassName} />
            </div>
            <div>
              <h2 id="connection-modal-title" className="text-lg font-semibold text-(--text-primary)">
                서버 연결
              </h2>
              <p className="mt-1 text-sm font-medium text-(--text-primary)">
                {statusInfo.title}
              </p>
              <p className="mt-1 text-sm text-(--text-secondary)">
                {statusInfo.description}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-(--text-muted) transition-colors hover:bg-(--bg-secondary) hover:text-(--text-primary)"
            aria-label="서버 연결 창 닫기"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          {reconnectState.attempt > 0 && (
            <div className="rounded-2xl border border-(--border) bg-(--bg-secondary) px-4 py-3 text-sm text-(--text-secondary)">
              자동 재연결 시도:
              {' '}
              <span className="font-medium text-(--text-primary)">
                {reconnectState.attempt}/{reconnectState.maxAttempts}
              </span>
              {reconnectState.nextDelayMs !== null && status === 'connecting' && (
                <>
                  {' '}
                  <span className="text-(--text-muted)">
                    다음 시도 예정
                  </span>
                </>
              )}
            </div>
          )}

          <button
            onClick={onReconnect}
            className="w-full flex items-center justify-center gap-2 rounded-2xl bg-(--accent) px-4 py-3 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            {status === 'connecting' ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <RefreshCw size={16} />
            )}
            지금 다시 시도
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConnectScreen;
