import React, { useCallback, useRef, useState } from 'react';
import { ArrowUp, Square, Loader2, Zap, ChevronDown } from 'lucide-react';
import type { AgentOptionDef, ContextUsage } from '../lib/protocol';

// ─── 인라인 셀렉트 (입력창 내부용) ───

interface InlineSelectProps {
  icon?: React.ReactNode;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}

const InlineSelect = ({ icon, options, value, onChange }: InlineSelectProps) => {
  const label = options.find((o) => o.value === value)?.label || 'Select';

  return (
    <label className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-(--bg-tertiary) transition-colors cursor-pointer text-xs text-(--text-muted) relative">
      {icon}
      <span>{label}</span>
      <ChevronDown size={10} />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 opacity-0 cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
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
  /** 모드 옵션 (하단 툴바 표시) */
  modeOption: AgentOptionDef | null;
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
  modeOption,
  settingValues,
  onSettingChange,
  contextUsage,
}: MessageInputProps) => {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
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
      const ta = e.target;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    },
    [],
  );

  // visibleWhen 조건 평가
  const isVisible = (opt: AgentOptionDef) => {
    if (!opt.visibleWhen) return true;
    return Object.entries(opt.visibleWhen).every(([depKey, allowed]) => {
      const current = settingValues[depKey] || inputOptions.find((o) => o.key === depKey)?.defaultValue || '';
      return allowed.includes(current);
    });
  };

  const visibleInputOptions = inputOptions.filter(isVisible);
  const hasInputOptions = visibleInputOptions.length > 0;

  return (
    <div className="p-3 sm:p-4">
      <div className="max-w-4xl mx-auto">
        {/* 메인 입력 컨테이너 */}
        <div className="rounded-2xl bg-(--input-bg) border border-(--input-border) focus-within:border-(--accent) transition-colors overflow-hidden">
          {/* textarea */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? 'Agent is working...' : 'Send a message...'}
            disabled={disabled && !isRunning}
            rows={1}
            className="w-full px-4 pt-3 pb-1 bg-transparent border-none text-sm placeholder-(--text-muted) focus:outline-none focus:ring-0 resize-none disabled:opacity-50"
            style={{ maxHeight: '200px' }}
          />

          {/* 하단 툴바 (모델/추론 + 전송 버튼) */}
          <div className="flex items-center justify-between px-2 pb-2">
            {/* 왼쪽: 모델/추론 셀렉터 */}
            <div className="flex items-center gap-0.5">
              {hasInputOptions && visibleInputOptions.map((opt) => {
                if (opt.type !== 'select' || !opt.options) return null;
                return (
                  <InlineSelect
                    key={opt.key}
                    icon={opt.key === 'model' ? <Zap size={12} /> : undefined}
                    options={opt.options}
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
                  disabled={!value.trim() || disabled}
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
        {(modeOption || contextUsage) && (
          <div className="flex items-center justify-between px-1 pt-1.5">
            {/* 왼쪽: 모드 셀렉터 */}
            <div>
              {modeOption && modeOption.type === 'select' && modeOption.options && (
                <InlineSelect
                  options={modeOption.options}
                  value={settingValues[modeOption.key] || modeOption.defaultValue || ''}
                  onChange={(v) => onSettingChange(modeOption.key, v)}
                />
              )}
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
