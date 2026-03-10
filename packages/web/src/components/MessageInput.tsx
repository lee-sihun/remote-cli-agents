import React, { useCallback, useRef, useState } from 'react';
import { Send, Square, Loader2 } from 'lucide-react';

interface MessageInputProps {
  onSend: (content: string) => void;
  onInterrupt: () => void;
  isRunning: boolean;
  disabled: boolean;
}

export default function MessageInput({
  onSend,
  onInterrupt,
  isRunning,
  disabled,
}: MessageInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isRunning) return;
        handleSend();
      }
    },
    [handleSend, isRunning],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value);
      // Auto-grow
      const ta = e.target;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    },
    [],
  );

  return (
    <div className="border-t border-[var(--border)] bg-[var(--bg-primary)] p-3 sm:p-4">
      <div className="flex items-end gap-2 max-w-4xl mx-auto">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              isRunning ? 'Agent is working...' : 'Send a message...'
            }
            disabled={disabled && !isRunning}
            rows={1}
            className="w-full px-4 py-3 rounded-xl bg-[var(--input-bg)] border border-[var(--input-border)] text-sm placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none resize-none transition-colors disabled:opacity-50"
            style={{ maxHeight: '200px' }}
          />
        </div>

        {isRunning ? (
          <button
            onClick={onInterrupt}
            className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--error)] text-white hover:opacity-90 transition-opacity"
            title="Stop agent"
          >
            <Square size={16} fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!value.trim() || disabled}
            className="shrink-0 flex items-center justify-center w-10 h-10 rounded-xl bg-[var(--accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
            title="Send message"
          >
            {disabled ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Send size={16} />
            )}
          </button>
        )}
      </div>

      {isRunning && (
        <div className="flex items-center justify-center gap-2 mt-2 text-xs text-[var(--text-muted)]">
          <Loader2 size={12} className="animate-spin" />
          <span>Agent is working... Click stop to interrupt</span>
        </div>
      )}
    </div>
  );
}
