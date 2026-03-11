import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateThreadId } from './protocol';

describe('generateThreadId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefers crypto.randomUUID when available', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => 'uuid-thread-id',
    });

    expect(generateThreadId()).toBe('uuid-thread-id');
  });

  it('falls back to a timestamp-based id when crypto.randomUUID is missing', () => {
    vi.stubGlobal('crypto', {});

    expect(generateThreadId()).toMatch(/^thread-\d+-[a-z0-9]+$/);
  });
});
