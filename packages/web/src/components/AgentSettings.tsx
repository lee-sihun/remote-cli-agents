import type { AgentOptionDef } from '../lib/protocol';

interface AgentSettingsProps {
  options: AgentOptionDef[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

const AgentSettings = ({ options, values, onChange }: AgentSettingsProps) => {
  if (options.length === 0) return null;

  // visibleWhen 조건 평가
  const isVisible = (opt: AgentOptionDef) => {
    if (!opt.visibleWhen) return true;
    return Object.entries(opt.visibleWhen).every(([depKey, allowed]) => {
      const current = values[depKey] || options.find((o) => o.key === depKey)?.defaultValue || '';
      return allowed.includes(current);
    });
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {options.filter(isVisible).map((opt) => (
        <div key={opt.key} className="flex items-center gap-1">
          <span className="text-xs text-[var(--text-muted)]">{opt.label}</span>
          {opt.type === 'select' && opt.options ? (
            <select
              value={values[opt.key] || opt.defaultValue || ''}
              onChange={(e) => onChange(opt.key, e.target.value)}
              className="px-2 py-1 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border)] text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] cursor-pointer"
            >
              {opt.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={values[opt.key] || ''}
              onChange={(e) => onChange(opt.key, e.target.value)}
              placeholder={opt.defaultValue || ''}
              className="w-28 px-2 py-1 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border)] text-xs text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            />
          )}
        </div>
      ))}
    </div>
  );
};

export default AgentSettings;
