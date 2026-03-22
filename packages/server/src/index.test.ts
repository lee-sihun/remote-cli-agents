import { describe, expect, it } from 'vitest';
import { parseArgs } from './index.js';

describe('parseArgs', () => {
  it('reads default values from environment variables', () => {
    const args = parseArgs(['node', 'rca'], {
      RCA_PORT: '9570',
      RCA_NO_TUNNEL: '1',
      RCA_CWD: '/tmp/rca-dev',
    });

    expect(args.port).toBe(9570);
    expect(args.noTunnel).toBe(true);
    expect(args.cwd).toBe('/tmp/rca-dev');
  });

  it('prefers CLI arguments over environment defaults', () => {
    const args = parseArgs(
      ['node', 'rca', '--port', '9680', '--cwd', '/tmp/override'],
      {
        RCA_PORT: '9570',
        RCA_CWD: '/tmp/rca-dev',
      },
    );

    expect(args.port).toBe(9680);
    expect(args.cwd).toBe('/tmp/override');
  });
});
