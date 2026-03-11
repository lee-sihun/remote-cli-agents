import { useCallback, useState } from 'react';
import { Wifi } from 'lucide-react';
import type { ConnectionStatus } from '../hooks/useWebSocket';

interface ConnectScreenProps {
  status: ConnectionStatus;
  onConnectDirect: (url: string) => void;
}

const ConnectScreen = ({ status, onConnectDirect }: ConnectScreenProps) => {
  const [error, setError] = useState('');
  const [directUrl, setDirectUrl] = useState('');

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

  // 연결 시도 중 → 로딩 스피너
  if (status === 'connecting') {
    return (
      <div className="flex items-center justify-center min-h-screen p-4 bg-[var(--bg-primary)]">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border)] mb-4">
            <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          </div>
          <p className="text-sm text-[var(--text-secondary)]">
            서버에 연결 중...
          </p>
        </div>
      </div>
    );
  }

  // 미연결 / 연결 실패 → URL 입력
  return (
    <div className="flex items-center justify-center min-h-screen p-4 bg-[var(--bg-primary)]">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border)] mb-4">
            <Wifi size={32} className="text-[var(--accent)]" />
          </div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">
            Remote CLI Agents
          </h1>
          <p className="text-[var(--text-secondary)] mt-1 text-sm">
            서버 WebSocket URL을 입력하세요
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/30 text-[var(--error)] text-sm">
            {error}
          </div>
        )}

        <div className="space-y-3 animate-fade-in">
          <div>
            <label className="block text-sm font-medium mb-1.5 text-[var(--text-secondary)]">
              WebSocket URL
            </label>
            <input
              type="url"
              value={directUrl}
              onChange={(e) => setDirectUrl(e.target.value)}
              placeholder="ws://192.168.1.100:9470/ws"
              className="w-full px-3 py-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--input-border)] text-sm font-mono placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleDirectConnect();
              }}
              autoFocus
            />
          </div>
          <button
            onClick={handleDirectConnect}
            disabled={!directUrl.trim()}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-lg bg-[var(--accent)] text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Wifi size={14} />
            연결
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConnectScreen;
