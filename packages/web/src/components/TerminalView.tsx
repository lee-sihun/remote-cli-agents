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

    const handleResize = useCallback(() => {
      if (fitAddonRef.current && termRef.current) {
        try {
          fitAddonRef.current.fit();
          onResize(termRef.current.cols, termRef.current.rows);
        } catch {
          // ignore fit errors during setup
        }
      }
    }, [onResize]);

    useEffect(() => {
      if (!containerRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
        theme: {
          background: '#0f172a',
          foreground: '#e2e8f0',
          cursor: '#38bdf8',
          cursorAccent: '#0f172a',
          selectionBackground: '#334155',
          selectionForeground: '#f1f5f9',
          black: '#1e293b',
          red: '#f87171',
          green: '#4ade80',
          yellow: '#fbbf24',
          blue: '#60a5fa',
          magenta: '#c084fc',
          cyan: '#22d3ee',
          white: '#f1f5f9',
          brightBlack: '#475569',
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
          onResize(term.cols, term.rows);
        } catch {
          // ignore
        }
      }, 50);

      // Listen for data (user input)
      const dataDisposable = term.onData((data) => {
        onInput(data);
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
    }, [onInput, onResize, handleResize]);

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
      <div className="terminal-container flex-1 h-full bg-[#0f172a] rounded-lg overflow-hidden">
        <div ref={containerRef} className="h-full w-full" />
      </div>
    );
  },
);

TerminalView.displayName = 'TerminalView';

export default TerminalView;
