import { describe, expect, it } from 'vitest';
import { parseClientMessagePayload } from './server.ts';

describe('parseClientMessagePayload', () => {
  it('rejects payloads larger than 1MB', () => {
    const raw = JSON.stringify({
      type: 'send_message',
      agentType: 'claude',
      threadId: 'thread-1',
      content: 'a'.repeat(1024 * 1024),
    });

    const result = parseClientMessagePayload(raw);

    expect(result).toEqual({
      ok: false,
      message: 'Message too large',
    });
  });

  it('rejects invalid JSON payloads', () => {
    const result = parseClientMessagePayload('{invalid-json');

    expect(result).toEqual({
      ok: false,
      message: 'Invalid JSON',
    });
  });

  it('parses valid client messages', () => {
    const result = parseClientMessagePayload(JSON.stringify({
      type: 'ping',
    }));

    expect(result).toEqual({
      ok: true,
      message: {
        type: 'ping',
      },
    });
  });
});
