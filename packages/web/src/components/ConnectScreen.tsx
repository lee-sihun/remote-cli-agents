import { useCallback, useState } from 'react';
import { Wifi, RefreshCw } from 'lucide-react';
import type { ConnectionStatus } from '../hooks/useWebSocket';

interface ConnectScreenProps {
  status: ConnectionStatus;
  onReconnect: () => void;
  onConnectDirect: (url: string) => void;
}

const ConnectScreen = ({ status, onReconnect, onConnectDirect }: ConnectScreenProps) => {
  const [error, setError] = useState('');
  const [directUrl, setDirectUrl] = useState('');
  const [showManual, setShowManual] = useState(false);

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
      <div className="flex items-center justify-center min-h-screen p-4 bg-(--bg-primary)">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-(--bg-secondary) border border-(--border) mb-4">
            <div className="w-8 h-8 border-2 border-(--accent) border-t-transparent rounded-full animate-spin" />
          </div>
          <p className="text-sm text-(--text-secondary)">
            서버에 연결 중...
          </p>
        </div>
      </div>
    );
  }

  // 미연결 / 연결 실패
  return (
    <div className="flex items-center justify-center min-h-screen p-4 bg-(--bg-primary)">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-(--bg-secondary) border border-(--border) mb-4">
            <Wifi size={32} className="text-(--accent)" />
          </div>
          <h1 className="text-2xl font-bold text-(--text-primary)">
            Remote CLI Agents
          </h1>
          <p className="text-(--text-secondary) mt-1 text-sm">
            서버와 연결이 끊어졌습니다
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-(--error)/10 border border-(--error)/30 text-(--error) text-sm">
            {error}
          </div>
        )}

        <div className="space-y-3 animate-fade-in">
          {/* 재연결 버튼 */}
          <button
            onClick={onReconnect}
            className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg bg-(--accent) text-white font-medium text-sm hover:opacity-90 transition-opacity"
          >
            <RefreshCw size={16} />
            재연결
          </button>

          {/* 수동 입력 토글 */}
          {!showManual ? (
            <button
              onClick={() => setShowManual(true)}
              className="w-full py-2 text-sm text-(--text-muted) hover:text-(--text-secondary) transition-colors"
            >
              다른 서버에 연결...
            </button>
          ) : (
            <div className="space-y-3 pt-2 border-t border-(--border)">
              <div>
                <label className="block text-sm font-medium mb-1.5 text-(--text-secondary)">
                  WebSocket URL
                </label>
                <input
                  type="url"
                  value={directUrl}
                  onChange={(e) => setDirectUrl(e.target.value)}
                  placeholder="ws://192.168.1.100:9470/ws"
                  className="w-full px-3 py-2.5 rounded-lg bg-(--input-bg) border border-(--input-border) text-sm font-mono placeholder-(--text-muted) focus:border-(--accent) focus:outline-none"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleDirectConnect();
                  }}
                  autoFocus
                />
              </div>
              <button
                onClick={handleDirectConnect}
                disabled={!directUrl.trim()}
                className="w-full flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-lg bg-(--bg-secondary) border border-(--border) text-sm font-medium hover:bg-(--bg-tertiary) transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Wifi size={14} />
                연결
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ConnectScreen;
