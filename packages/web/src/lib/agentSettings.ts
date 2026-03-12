import type { AgentConfig, AgentOptionDef, AgentType } from './protocol';

export function mergeAgentSettings(
  options: AgentOptionDef[],
  settings?: Partial<Record<string, unknown>> | AgentConfig,
): Record<string, string> {
  const merged = Object.fromEntries(
    options.map((option) => [option.key, option.defaultValue || '']),
  ) as Record<string, string>;

  if (!settings) {
    return merged;
  }

  const source = settings as Record<string, unknown>;
  for (const option of options) {
    const value = source[option.key];
    if (typeof value === 'string') {
      merged[option.key] = value;
    }
  }

  return merged;
}

export function isOptionVisible(
  option: AgentOptionDef,
  settings: Record<string, string>,
  options: AgentOptionDef[],
): boolean {
  if (!option.visibleWhen) {
    return true;
  }

  return Object.entries(option.visibleWhen).every(([dependencyKey, allowedValues]) => {
    const currentValue = settings[dependencyKey]
      || options.find((candidate) => candidate.key === dependencyKey)?.defaultValue
      || '';
    return allowedValues.includes(currentValue);
  });
}

export function buildAgentConfig(
  options: AgentOptionDef[],
  agentType: AgentType,
  settings: Record<string, string>,
): AgentConfig {
  const config: AgentConfig = { type: agentType };
  const configRecord = config as unknown as Record<string, string>;

  for (const option of options) {
    if (!isOptionVisible(option, settings, options)) {
      continue;
    }

    const value = settings[option.key];
    if (!value) {
      continue;
    }

    configRecord[option.key] = value;
  }

  return config;
}

export function sameSettings(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] || '') !== (b[key] || '')) {
      return false;
    }
  }
  return true;
}

export function resolveNewChatSettings(
  options: AgentOptionDef[],
  currentSettings?: Record<string, string>,
  threadConfig?: AgentConfig,
): Record<string, string> {
  if (currentSettings && Object.keys(currentSettings).length > 0) {
    return mergeAgentSettings(options, currentSettings);
  }

  if (threadConfig) {
    return mergeAgentSettings(options, threadConfig);
  }

  return mergeAgentSettings(options);
}
