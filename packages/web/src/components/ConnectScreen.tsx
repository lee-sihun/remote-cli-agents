import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Wifi, WifiOff, X } from 'lucide-react';
import type { ConnectionStatus, ReconnectState } from '../hooks/useWebSocket';

interface ConnectScreenProps {
  open: boolean;
  status: ConnectionStatus;
  reconnectState: ReconnectState;
  onClose: () => void;
  onReconnect: () => void;
  onConnectDirect: (url: string) => void;
}

const ConnectScreen = ({
  open,
  status,
  reconnectState,
  onClose,
  onReconnect,
  onConnectDirect,
}: ConnectScreenProps) => {
  const [error, setError] = useState('');
  const [directUrl, setDirectUrl] = useState('');
  const [showManual, setShowManual] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

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

  useEffect(() => {
    if (open && showManual) {
      inputRef.current?.focus();
    }
  }, [open, showManual]);

  const handleDirectConnect = useCallback(() => {
    setError('');
    const url = directUrl.trim();
    if (!url) {
      setError('WebSocket URL을 입력해주세요.');
      return;
    }
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      setError('URL은 ws:// 또는 wss://로 시작해야 합니다.');
      return;
    }
    onConnectDirect(url);
  }, [directUrl, onConnectDirect]);

  if (!open) {
    return null;
  }

  const statusInfo = {
    connected: {
      icon: Wifi,
      iconClassName: 'text-(--success)',
      title: '현재 연결됨',
      description: '필요하면 다시 연결하거나 다른 서버로 전환할 수 있습니다.',
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
        ? '자동 재연결 시도를 모두 마쳤습니다. 직접 다시 시도하거나 다른 서버를 입력하세요.'
        : '필요하면 바로 재연결하거나 다른 서버 주소를 입력할 수 있습니다.',
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
                연결 설정
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
            aria-label="연결 설정 닫기"
          >
            <X size={16} />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-(--error)/10 border border-(--error)/30 text-(--error) text-sm">
            {error}
          </div>
        )}

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

          {!showManual ? (
            <button
              onClick={() => setShowManual(true)}
              className="w-full rounded-2xl border border-(--border) bg-(--bg-secondary) px-4 py-3 text-sm text-(--text-secondary) transition-colors hover:bg-(--bg-tertiary) hover:text-(--text-primary)"
            >
              다른 서버 연결
            </button>
          ) : (
            <div className="space-y-3 rounded-2xl border border-(--border) bg-(--bg-secondary) p-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-(--text-secondary)">
                  WebSocket URL
                </label>
                <input
                  ref={inputRef}
                  type="url"
                  value={directUrl}
                  onChange={(e) => setDirectUrl(e.target.value)}
                  placeholder="ws://192.168.1.100:9470/ws"
                  className="w-full rounded-xl border border-(--input-border) bg-(--input-bg) px-3 py-2.5 font-mono text-sm placeholder-(--text-muted) focus:border-(--accent) focus:outline-none"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleDirectConnect();
                  }}
                />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  onClick={handleDirectConnect}
                  disabled={!directUrl.trim()}
                  className="flex-1 rounded-xl bg-(--bg-tertiary) px-4 py-2.5 text-sm font-medium transition-colors hover:bg-(--bg-hover) disabled:cursor-not-allowed disabled:opacity-40"
                >
                  직접 연결
                </button>
                <button
                  onClick={() => setShowManual(false)}
                  className="rounded-xl border border-(--border) px-4 py-2.5 text-sm text-(--text-secondary) transition-colors hover:bg-(--bg-tertiary) hover:text-(--text-primary)"
                >
                  접기
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ConnectScreen;
