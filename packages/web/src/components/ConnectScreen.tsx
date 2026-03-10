import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Link,
  Clipboard,
  Wifi,
  ArrowRight,
  X,
  Smartphone,
} from 'lucide-react';
import type { QRPayload } from '../lib/protocol';
import { parseQRPayload } from '../lib/protocol';
import type { ConnectionStatus } from '../hooks/useWebSocket';

interface ConnectScreenProps {
  status: ConnectionStatus;
  onConnect: (payload: QRPayload) => void;
  onConnectDirect: (url: string) => void;
}

export default function ConnectScreen({
  status,
  onConnect,
  onConnectDirect,
}: ConnectScreenProps) {
  const [mode, setMode] = useState<'menu' | 'qr-paste' | 'camera' | 'url'>(
    'menu',
  );
  const [error, setError] = useState('');
  const [qrText, setQrText] = useState('');
  const [directUrl, setDirectUrl] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Clean up camera on mode change
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [mode]);

  const startCamera = useCallback(async () => {
    setMode('camera');
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch (err) {
      setError(
        'Camera access denied. Please paste the QR code data manually instead.',
      );
      setMode('qr-paste');
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const handleQrPaste = useCallback(() => {
    setError('');
    const payload = parseQRPayload(qrText.trim());
    if (payload) {
      onConnect(payload);
    } else {
      setError('Invalid QR payload. Expected JSON with type: "rca".');
    }
  }, [qrText, onConnect]);

  const handleDirectConnect = useCallback(() => {
    setError('');
    const url = directUrl.trim();
    if (!url) {
      setError('Please enter a WebSocket URL.');
      return;
    }
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      setError('URL must start with ws:// or wss://');
      return;
    }
    onConnectDirect(url);
  }, [directUrl, onConnectDirect]);

  const handlePasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setQrText(text);
      const payload = parseQRPayload(text.trim());
      if (payload) {
        onConnect(payload);
      }
    } catch {
      // Clipboard access may be denied
    }
  }, [onConnect]);

  return (
    <div className="flex items-center justify-center min-h-screen p-4 bg-[var(--bg-primary)]">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[var(--bg-secondary)] border border-[var(--border)] mb-4">
            <Smartphone size={32} className="text-[var(--accent)]" />
          </div>
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">
            Remote CLI Agents
          </h1>
          <p className="text-[var(--text-secondary)] mt-1 text-sm">
            Connect to your development machine
          </p>
        </div>

        {/* Connection status */}
        {status === 'connecting' && (
          <div className="mb-4 p-3 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/30 text-center">
            <div className="flex items-center justify-center gap-2 text-[var(--warning)]">
              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              <span className="text-sm">Connecting...</span>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/30 text-[var(--error)] text-sm">
            {error}
          </div>
        )}

        {/* Menu mode */}
        {mode === 'menu' && (
          <div className="space-y-3 animate-fade-in">
            <button
              onClick={startCamera}
              className="flex items-center gap-3 w-full p-4 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors text-left"
            >
              <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--accent)]/10">
                <Camera size={20} className="text-[var(--accent)]" />
              </div>
              <div className="flex-1">
                <div className="font-medium text-sm">Scan QR Code</div>
                <div className="text-xs text-[var(--text-muted)]">
                  Use camera to scan connection QR
                </div>
              </div>
              <ArrowRight size={16} className="text-[var(--text-muted)]" />
            </button>

            <button
              onClick={() => {
                setMode('qr-paste');
                setError('');
              }}
              className="flex items-center gap-3 w-full p-4 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors text-left"
            >
              <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--accent)]/10">
                <Clipboard size={20} className="text-[var(--accent)]" />
              </div>
              <div className="flex-1">
                <div className="font-medium text-sm">Paste QR Data</div>
                <div className="text-xs text-[var(--text-muted)]">
                  Paste the JSON payload from QR code
                </div>
              </div>
              <ArrowRight size={16} className="text-[var(--text-muted)]" />
            </button>

            <button
              onClick={() => {
                setMode('url');
                setError('');
              }}
              className="flex items-center gap-3 w-full p-4 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--bg-tertiary)] transition-colors text-left"
            >
              <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--accent)]/10">
                <Link size={20} className="text-[var(--accent)]" />
              </div>
              <div className="flex-1">
                <div className="font-medium text-sm">Manual URL</div>
                <div className="text-xs text-[var(--text-muted)]">
                  Enter WebSocket URL directly
                </div>
              </div>
              <ArrowRight size={16} className="text-[var(--text-muted)]" />
            </button>
          </div>
        )}

        {/* Camera mode */}
        {mode === 'camera' && (
          <div className="animate-fade-in">
            <div className="relative rounded-xl overflow-hidden bg-black mb-4">
              <video
                ref={videoRef}
                className="w-full aspect-square object-cover"
                playsInline
                muted
              />
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-48 h-48 border-2 border-white/50 rounded-lg" />
              </div>
            </div>
            <p className="text-center text-xs text-[var(--text-muted)] mb-3">
              Point camera at the QR code shown on your dev machine.
              <br />
              Or paste the data manually below.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  stopCamera();
                  setMode('qr-paste');
                }}
                className="flex-1 py-2 px-4 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-sm hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                Paste Instead
              </button>
              <button
                onClick={() => {
                  stopCamera();
                  setMode('menu');
                }}
                className="py-2 px-4 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-sm hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        )}

        {/* QR Paste mode */}
        {mode === 'qr-paste' && (
          <div className="animate-fade-in space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1.5 text-[var(--text-secondary)]">
                QR Code Payload (JSON)
              </label>
              <textarea
                value={qrText}
                onChange={(e) => setQrText(e.target.value)}
                placeholder='{"type":"rca","version":1,"sessionId":"...","directUrl":"ws://...","token":"..."}'
                rows={5}
                className="w-full px-3 py-2.5 rounded-lg bg-[var(--input-bg)] border border-[var(--input-border)] text-sm font-mono placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none resize-none"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handlePasteFromClipboard}
                className="flex items-center gap-1.5 py-2 px-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-sm hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                <Clipboard size={14} />
                Paste
              </button>
              <button
                onClick={handleQrPaste}
                disabled={!qrText.trim()}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 px-4 rounded-lg bg-[var(--accent)] text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Wifi size={14} />
                Connect
              </button>
            </div>
            <button
              onClick={() => setMode('menu')}
              className="w-full py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              Back
            </button>
          </div>
        )}

        {/* URL mode */}
        {mode === 'url' && (
          <div className="animate-fade-in space-y-3">
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
              />
            </div>
            <button
              onClick={handleDirectConnect}
              disabled={!directUrl.trim()}
              className="w-full flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-lg bg-[var(--accent)] text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Wifi size={14} />
              Connect
            </button>
            <button
              onClick={() => setMode('menu')}
              className="w-full py-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              Back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
