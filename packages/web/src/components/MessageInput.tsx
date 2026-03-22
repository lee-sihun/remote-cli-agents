import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Loader2, ChevronDown, Check } from 'lucide-react';
import type { AgentOptionDef, ContextUsage } from '../lib/protocol';

// ─── 인라인 셀렉트 (입력창 내부용) ───

interface InlineSelectProps {
  options: { value: string; label: string }[];
  testId?: string;
  value: string;
  onChange: (value: string) => void;
}

const InlineSelect = ({ options, testId, value, onChange }: InlineSelectProps) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const label = options.find((o) => o.value === value)?.label || 'Select';

  // 외부 클릭 시 닫기
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        data-testid={testId}
        className={`flex items-center gap-1 px-2 py-1 rounded-lg transition-colors cursor-pointer text-xs ${
          open
            ? 'bg-(--bg-tertiary) text-(--text-secondary)'
            : 'text-(--text-muted) hover:bg-(--bg-tertiary)'
        }`}
      >
        <span>{label}</span>
        <ChevronDown
          size={10}
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[140px] rounded-xl bg-(--bg-secondary) border border-(--border) shadow-lg z-50 animate-fade-in overflow-hidden">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={`flex items-center justify-between w-full px-3 py-2 text-xs text-left transition-colors ${
                o.value === value
                  ? 'text-(--accent) bg-(--bg-tertiary)/50'
                  : 'text-(--text-secondary) hover:bg-(--bg-tertiary)/50 hover:text-(--text-primary)'
              }`}
            >
              <span>{o.label}</span>
              {o.value === value && <Check size={10} className="text-(--accent) shrink-0 ml-2" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Props ───

interface MessageInputProps {
  onSend: (content: string) => void;
  onInterrupt: () => void;
  isRunning: boolean;
  disabled: boolean;
  /** 모델/추론 옵션 (입력창 내부 표시) */
  inputOptions: AgentOptionDef[];
  /** 하단 툴바 옵션 */
  footerOptions: AgentOptionDef[];
  /** 현재 설정값 */
  settingValues: Record<string, string>;
  onSettingChange: (key: string, value: string) => void;
  /** 컨텍스트 사용량 */
  contextUsage?: ContextUsage;
}

const MessageInput = ({
  onSend,
  onInterrupt,
  isRunning,
  disabled,
  inputOptions,
  footerOptions,
  settingValues,
  onSettingChange,
  contextUsage,
}: MessageInputProps) => {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [isMobileComposer, setIsMobileComposer] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    // 모바일 터치 화면에서는 Enter를 줄바꿈으로 유지
    const mediaQuery = window.matchMedia('(max-width: 768px) and (pointer: coarse)');
    const syncMobileComposer = () => {
      setIsMobileComposer(mediaQuery.matches);
    };

    syncMobileComposer();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', syncMobileComposer);
    } else {
      mediaQuery.addListener(syncMobileComposer);
    }

    return () => {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', syncMobileComposer);
      } else {
        mediaQuery.removeListener(syncMobileComposer);
      }
    };
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
    if (editorRef.current) {
      editorRef.current.textContent = '';
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) {
        return;
      }

      const shouldSendWithEnter = !isMobileComposer || e.ctrlKey || e.metaKey;

      if (e.key === 'Enter' && !e.shiftKey && shouldSendWithEnter) {
        e.preventDefault();
        if (isRunning) return;
        handleSend();
      }
    },
    [handleSend, isMobileComposer, isRunning],
  );

  const handleInput = useCallback(() => {
    const text = editorRef.current?.textContent || '';
    setValue(text);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }, []);

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
    const text = editorRef.current?.textContent || '';
    setValue(text);
  }, []);

  // visibleWhen 조건 평가
  const isVisible = (opt: AgentOptionDef) => {
    if (!opt.visibleWhen) return true;
    return Object.entries(opt.visibleWhen).every(([depKey, allowed]) => {
      const current = settingValues[depKey] || inputOptions.find((o) => o.key === depKey)?.defaultValue || '';
      return allowed.includes(current);
    });
  };

  const visibleInputOptions = inputOptions.filter(isVisible);
  const visibleFooterOptions = footerOptions.filter(isVisible);
  const hasInputOptions = visibleInputOptions.length > 0;
  const isEmpty = !value;

  return (
    <div className="p-3 sm:p-4">
      <div className="max-w-4xl mx-auto">
        {/* 메인 입력 컨테이너 — CSS class 대신 인라인 스타일 */}
        <div
          className="rounded-2xl bg-(--input-bg)"
          style={{
            boxShadow: focused
              ? 'inset 0 0 0 1px var(--accent)'
              : 'inset 0 0 0 1px var(--input-border)',
            transition: 'box-shadow 0.15s',
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        >
          {/* contentEditable 입력 영역 */}
          <div className="relative">
            <div
              ref={editorRef}
              contentEditable={!(disabled && !isRunning)}
              role="textbox"
              aria-multiline="true"
              aria-placeholder={isRunning ? 'Agent is working...' : 'Send a message...'}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onPaste={handlePaste}
              className="w-full px-4 pt-3 pb-2 text-sm text-(--text-primary) outline-none overflow-y-auto empty:before:content-[attr(aria-placeholder)] empty:before:text-(--text-muted) empty:before:pointer-events-none"
              style={{ maxHeight: '400px', minHeight: '1.5em', wordBreak: 'break-word' }}
              suppressContentEditableWarning
            />
            {disabled && !isRunning && (
              <div className="absolute inset-0 opacity-50 cursor-not-allowed" />
            )}
          </div>

          {/* 하단 툴바 (모델/추론 + 전송 버튼) */}
          <div className="flex items-center justify-between px-2 pb-2">
            {/* 왼쪽: 모델/추론 셀렉터 */}
            <div className="flex items-center gap-0.5">
              {hasInputOptions && visibleInputOptions.map((opt) => {
                if (opt.type !== 'select' || !opt.options) return null;
                return (
                  <InlineSelect
                    key={opt.key}
                    options={opt.options}
                    testId={`input-option-${opt.key}`}
                    value={settingValues[opt.key] || opt.defaultValue || ''}
                    onChange={(v) => onSettingChange(opt.key, v)}
                  />
                );
              })}
            </div>

            {/* 오른쪽: 전송/중단 버튼 */}
            <div>
              {isRunning ? (
                <button
                  onClick={onInterrupt}
                  className="flex items-center justify-center w-8 h-8 rounded-full bg-(--error) text-white hover:opacity-90 transition-opacity"
                  title="Stop agent"
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={isEmpty || disabled}
                  className="flex items-center justify-center w-8 h-8 rounded-full bg-(--text-primary) text-(--bg-primary) hover:opacity-80 transition-opacity disabled:opacity-20 disabled:cursor-not-allowed"
                  title="Send message"
                >
                  {disabled ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <ArrowUp size={16} strokeWidth={2.5} />
                  )}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 하단 영역: 모드 (왼쪽) + 컨텍스트 사용량 (오른쪽) */}
        {(visibleFooterOptions.length > 0 || contextUsage) && (
          <div className="flex items-center justify-between px-1 pt-1.5">
            {/* 왼쪽: 모드 셀렉터 */}
            <div className="flex items-center gap-0.5">
              {visibleFooterOptions.map((option) => {
                if (option.type !== 'select' || !option.options) return null;
                return (
                  <InlineSelect
                    key={option.key}
                    options={option.options}
                    testId={`footer-option-${option.key}`}
                    value={settingValues[option.key] || option.defaultValue || ''}
                    onChange={(v) => onSettingChange(option.key, v)}
                  />
                );
              })}
            </div>

            {/* 오른쪽: 컨텍스트 사용량 */}
            <div className="flex items-center gap-2 text-xs text-(--text-muted)">
              {contextUsage ? (
                <>
                  <span>Context</span>
                  <div className="w-16 h-1.5 rounded-full bg-(--bg-tertiary) overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        contextUsage.percentage > 80 ? 'bg-(--error)'
                          : contextUsage.percentage > 50 ? 'bg-(--warning)'
                          : 'bg-(--accent)'
                      }`}
                      style={{ width: `${contextUsage.percentage}%` }}
                    />
                  </div>
                  <span>{contextUsage.percentage}%</span>
                </>
              ) : (
                <span className="text-(--text-muted)/50">Context —</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageInput;
