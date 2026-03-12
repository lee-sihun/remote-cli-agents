import { describe, expect, it } from 'vitest';
import { resolveActiveThreadMeta } from './activeThreadMeta';

describe('resolveActiveThreadMeta', () => {
  it('does not leak stale status into a fresh chat view', () => {
    expect(resolveActiveThreadMeta(null, {
      agent: 'codex',
      state: 'running',
      activeThread: 'old-thread',
      model: 'gpt-5.4',
      contextUsage: {
        used: 120,
        total: 1000,
        percentage: 12,
      },
    })).toEqual({});
  });

  it('uses live agent status for the active running thread', () => {
    expect(resolveActiveThreadMeta('thread-a', {
      agent: 'claude',
      state: 'running',
      activeThread: 'thread-a',
      model: 'sonnet',
      contextUsage: {
        used: 400,
        total: 1000,
        percentage: 40,
      },
    }, {
      id: 'thread-a',
      agentType: 'claude',
      title: 'Thread A',
      messageCount: 1,
      createdAt: 1,
      updatedAt: 1,
      model: 'sonnet',
      contextUsage: {
        used: 350,
        total: 1000,
        percentage: 35,
      },
    })).toEqual({
      model: 'sonnet',
      contextUsage: {
        used: 400,
        total: 1000,
        percentage: 40,
      },
    });
  });

  it('keeps the selected thread summary when another thread is currently running', () => {
    expect(resolveActiveThreadMeta('thread-a', {
      agent: 'codex',
      state: 'running',
      activeThread: 'thread-b',
      model: 'gpt-5.4',
      contextUsage: {
        used: 900,
        total: 1000,
        percentage: 90,
      },
    }, {
      id: 'thread-a',
      agentType: 'codex',
      title: 'Thread A',
      messageCount: 1,
      createdAt: 1,
      updatedAt: 1,
      model: 'gpt-5.3-codex',
      contextUsage: {
        used: 100,
        total: 1000,
        percentage: 10,
      },
    })).toEqual({
      model: 'gpt-5.3-codex',
      contextUsage: {
        used: 100,
        total: 1000,
        percentage: 10,
      },
    });
  });
});
