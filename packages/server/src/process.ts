import { execFile, type ChildProcess } from 'node:child_process';

export function terminateChildProcess(
  proc: ChildProcess | null | undefined,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (!proc) return;

  if (process.platform === 'win32' && proc.pid) {
    execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], (error) => {
      if (!error) return;

      try {
        proc.kill();
      } catch {
        // 종료 폴백 무시
      }
    });
    return;
  }

  try {
    proc.kill(signal);
  } catch {
    // 종료 폴백 무시
  }
}
