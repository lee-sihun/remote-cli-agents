import { describe, expect, it } from 'vitest';
import { parseArgs } from './index.js';

describe('parseArgs', () => {
  it('reads default values from environment variables', () => {
    const args = parseArgs(['node', 'rca'], {
      RCA_PORT: '9570',
      RCA_RELAY_URL: 'wss://relay.example.com/relay',
      RCA_NO_RELAY: 'true',
      RCA_NO_TUNNEL: '1',
      RCA_CWD: '/tmp/rca-dev',
    });

    expect(args.port).toBe(9570);
    expect(args.relay).toBe('wss://relay.example.com/relay');
    expect(args.noRelay).toBe(true);
    expect(args.noTunnel).toBe(true);
    expect(args.cwd).toBe('/tmp/rca-dev');
    expect(args.command).toBe('up');
  });

  it('prefers CLI arguments over environment defaults', () => {
    const args = parseArgs(
      ['node', 'rca', '--port', '9680', '--relay', 'wss://override.example.com/relay', '--cwd', '/tmp/override'],
      {
        RCA_PORT: '9570',
        RCA_RELAY_URL: 'wss://relay.example.com/relay',
        RCA_CWD: '/tmp/rca-dev',
      },
    );

    expect(args.port).toBe(9680);
    expect(args.relay).toBe('wss://override.example.com/relay');
    expect(args.cwd).toBe('/tmp/override');
  });
});
