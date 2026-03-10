import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

interface TerminalViewProps {
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export interface TerminalViewHandle {
  write: (data: string) => void;
  clear: () => void;
  focus: () => void;
}

const TerminalView = React.forwardRef<TerminalViewHandle, TerminalViewProps>(
  ({ onInput, onResize }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);

    // Ref 패턴: 콜백이 변경되어도 터미널 재생성 방지
    const onInputRef = useRef(onInput);
    onInputRef.current = onInput;
    const onResizeRef = useRef(onResize);
    onResizeRef.current = onResize;

    const handleResize = useCallback(() => {
      if (fitAddonRef.current && termRef.current) {
        try {
          fitAddonRef.current.fit();
          onResizeRef.current(termRef.current.cols, termRef.current.rows);
        } catch {
          // ignore fit errors during setup
        }
      }
    }, []);

    useEffect(() => {
      if (!containerRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
        theme: {
          background: '#161616',
          foreground: '#ececec',
          cursor: '#a78bfa',
          cursorAccent: '#161616',
          selectionBackground: '#363636',
          selectionForeground: '#ececec',
          black: '#1c1c1c',
          red: '#f87171',
          green: '#4ade80',
          yellow: '#fbbf24',
          blue: '#60a5fa',
          magenta: '#c084fc',
          cyan: '#22d3ee',
          white: '#ececec',
          brightBlack: '#6b6b6b',
          brightRed: '#fca5a5',
          brightGreen: '#86efac',
          brightYellow: '#fde68a',
          brightBlue: '#93c5fd',
          brightMagenta: '#d8b4fe',
          brightCyan: '#67e8f9',
          brightWhite: '#ffffff',
        },
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      term.open(containerRef.current);

      // Try WebGL renderer for performance
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
        });
        term.loadAddon(webglAddon);
      } catch {
        // Fall back to canvas renderer
      }

      // Initial fit
      setTimeout(() => {
        try {
          fitAddon.fit();
          onResizeRef.current(term.cols, term.rows);
        } catch {
          // ignore
        }
      }, 50);

      // Listen for data (user input) - ref 사용으로 최신 핸들러 참조
      const dataDisposable = term.onData((data) => {
        onInputRef.current(data);
      });

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      // Resize observer
      const observer = new ResizeObserver(() => {
        handleResize();
      });
      observer.observe(containerRef.current);

      return () => {
        dataDisposable.dispose();
        observer.disconnect();
        term.dispose();
        termRef.current = null;
        fitAddonRef.current = null;
      };
    }, [handleResize]); // handleResize는 이제 안정적 (빈 의존성)

    // Expose handle
    React.useImperativeHandle(
      ref,
      () => ({
        write: (data: string) => {
          termRef.current?.write(data);
        },
        clear: () => {
          termRef.current?.clear();
        },
        focus: () => {
          termRef.current?.focus();
        },
      }),
      [],
    );

    return (
      <div className="terminal-container flex-1 h-full bg-[#161616] rounded-lg overflow-hidden">
        <div ref={containerRef} className="h-full w-full" />
      </div>
    );
  },
);

TerminalView.displayName = 'TerminalView';

export default TerminalView;
