import { describe, expect, it } from 'vitest';
import { CLAUDE_OPTIONS, CODEX_OPTIONS } from '@rca/shared';
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

  it('keeps the selected gpt-5.4 speed mode when starting a new chat', () => {
    expect(resolveNewChatSettings(
      CODEX_OPTIONS,
      {
        model: 'gpt-5.4',
        speedMode: 'fast',
        sandboxMode: 'workspace-write',
      },
      {
        type: 'codex',
        model: 'gpt-5.3-codex',
        sandboxMode: 'read-only',
      },
    )).toEqual({
      model: 'gpt-5.4',
      effortLevel: 'medium',
      approvalMode: 'on-request',
      sandboxMode: 'workspace-write',
      speedMode: 'fast',
    });
  });
});
