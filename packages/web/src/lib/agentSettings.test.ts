import { describe, expect, it } from 'vitest';
import { CLAUDE_OPTIONS } from '@rca/shared';
import { resolveNewChatSettings } from './agentSettings';

describe('resolveNewChatSettings', () => {
  it('keeps the selected session settings when starting a new chat', () => {
    expect(resolveNewChatSettings(
      CLAUDE_OPTIONS,
      {
        model: 'opus',
        permissionMode: 'plan',
        effortLevel: 'high',
      },
      {
        type: 'claude',
        model: 'sonnet',
        permissionMode: 'acceptEdits',
      },
    )).toEqual({
      model: 'opus',
      permissionMode: 'plan',
      effortLevel: 'high',
    });
  });

  it('falls back to the selected thread config when current settings are empty', () => {
    expect(resolveNewChatSettings(
      CLAUDE_OPTIONS,
      {},
      {
        type: 'claude',
        model: 'sonnet',
        permissionMode: 'acceptEdits',
      },
    )).toEqual({
      model: 'sonnet',
      permissionMode: 'acceptEdits',
      effortLevel: 'medium',
    });
  });
});
