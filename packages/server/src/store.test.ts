import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, ThreadSummary } from '@rca/shared';

describe('store', () => {
  let tempHomeDir: string;

  beforeEach(() => {
    tempHomeDir = mkdtempSync(join(tmpdir(), 'rca-store-test-'));
    vi.resetModules();
    vi.doMock('node:os', () => ({
      homedir: () => tempHomeDir,
    }));
  });

  afterEach(() => {
    vi.doUnmock('node:os');
    vi.resetModules();
    rmSync(tempHomeDir, { recursive: true, force: true });
  });

  it('deleteThread removes metadata and message file together', async () => {
    const store = await import('./store.ts');
    const thread: ThreadSummary = {
      id: 'thread-delete',
      agentType: 'claude',
      title: 'Delete target',
      messageCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const message: AgentMessage = {
      id: 'message-1',
      role: 'assistant',
      content: 'saved',
      timestamp: 1,
    };

    store.saveThread('claude', thread);
    store.appendMessage(thread.id, message);

    const messageFile = join(tempHomeDir, '.rca', 'data', 'messages', `${thread.id}.json`);
    expect(existsSync(messageFile)).toBe(true);

    store.deleteThread('claude', thread.id);

    expect(store.loadThreads('claude')).toEqual([]);
    expect(store.loadMessages(thread.id)).toEqual([]);
    expect(existsSync(messageFile)).toBe(false);
  });

  it('appendMessage keeps only the latest 200 messages', async () => {
    const store = await import('./store.ts');

    for (let index = 0; index < 205; index += 1) {
      store.appendMessage('thread-trim', {
        id: `message-${index}`,
        role: 'user',
        content: `content-${index}`,
        timestamp: index,
      });
    }

    const messages = store.loadMessages('thread-trim');
    expect(messages).toHaveLength(200);
    expect(messages[0]?.content).toBe('content-5');
    expect(messages.at(-1)?.content).toBe('content-204');
  });
});
