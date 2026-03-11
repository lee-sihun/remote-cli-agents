import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { terminateChildProcess } from './process.ts';

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: childProcessMock.execFile,
  };
});

describe('terminateChildProcess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    childProcessMock.execFile.mockImplementation((_: string, __: string[], callback?: (error: Error | null) => void) => {
      callback?.(null);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses taskkill on Windows to terminate the full process tree', () => {
    const proc = {
      pid: 4242,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    terminateChildProcess(proc);

    if (process.platform === 'win32') {
      expect(childProcessMock.execFile).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '4242', '/T', '/F'],
        expect.any(Function),
      );
      expect(proc.kill).not.toHaveBeenCalled();
    } else {
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    }
  });

  it('falls back to proc.kill when taskkill fails on Windows', () => {
    const proc = {
      pid: 5252,
      kill: vi.fn(),
    } as unknown as ChildProcess;

    childProcessMock.execFile.mockImplementation((_: string, __: string[], callback?: (error: Error | null) => void) => {
      callback?.(new Error('taskkill failed'));
    });

    terminateChildProcess(proc, 'SIGINT');

    if (process.platform === 'win32') {
      expect(proc.kill).toHaveBeenCalledWith();
    } else {
      expect(proc.kill).toHaveBeenCalledWith('SIGINT');
    }
  });
});
