import { execFileSync, spawn } from 'node:child_process';

if (process.platform !== 'win32') {
  console.log('skip: non-windows');
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const listPingProcesses = () => {
  try {
    const raw = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'PING.EXE' -or $_.Name -eq 'ping.exe' } | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf8' },
    ).trim();

    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
};

const before = new Set(listPingProcesses().map((proc) => proc.ProcessId));

const proc = spawn('ping -t 127.0.0.1', {
  shell: true,
  stdio: ['ignore', 'ignore', 'ignore'],
  windowsHide: true,
});

await sleep(1500);

const during = listPingProcesses().find((item) => item.ParentProcessId === proc.pid);
if (!during) {
  throw new Error('shell: true 하위 ping 프로세스를 찾지 못했습니다.');
}

let closeCode = 'not-closed';
proc.on('close', (code) => {
  closeCode = code === null ? 'null' : String(code);
});

execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
await sleep(2000);

const after = listPingProcesses().filter((item) => !before.has(item.ProcessId));
if (after.some((item) => item.ProcessId === during.ProcessId)) {
  throw new Error(`taskkill 이후에도 자식 ping 프로세스가 남아 있습니다: ${during.ProcessId}`);
}

if (closeCode === 'not-closed') {
  throw new Error('taskkill 이후 close 이벤트가 확인되지 않았습니다.');
}

console.log(`windows-shell-kill: ok (parent=${proc.pid}, child=${during.ProcessId}, close=${closeCode})`);
