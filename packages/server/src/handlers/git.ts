import { execFile } from 'node:child_process';

// Git 명령 실행 옵션
interface GitExecOptions {
  cwd: string;
  maxBuffer?: number;
}

// Git 명령 결과
interface GitResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// 허용된 git 액션 목록 (보안)
const ALLOWED_ACTIONS = new Set([
  'status',
  'log',
  'diff',
  'commit',
  'push',
  'pull',
  'branches',
  'checkout',
  'stage',
  'unstage',
  'stash',
  'stash_pop',
]);

// Git 명령 핸들러
export async function handleGit(
  action: string,
  params: Record<string, unknown> = {},
  cwd: string,
): Promise<GitResult> {
  if (!ALLOWED_ACTIONS.has(action)) {
    return { success: false, error: `Unknown git action: ${action}` };
  }

  try {
    switch (action) {
      case 'status':
        return await gitStatus(cwd);
      case 'log':
        return await gitLog(cwd, params);
      case 'diff':
        return await gitDiff(cwd, params);
      case 'commit':
        return await gitCommit(cwd, params);
      case 'push':
        return await gitPush(cwd, params);
      case 'pull':
        return await gitPull(cwd, params);
      case 'branches':
        return await gitBranches(cwd);
      case 'checkout':
        return await gitCheckout(cwd, params);
      case 'stage':
        return await gitStage(cwd, params);
      case 'unstage':
        return await gitUnstage(cwd, params);
      case 'stash':
        return await gitStash(cwd, params);
      case 'stash_pop':
        return await gitStash(cwd, { action: 'pop' });
      default:
        return { success: false, error: `Unhandled action: ${action}` };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// git 명령 실행 유틸리티
function execGit(args: string[], options: GitExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: options.cwd,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 5, // 5MB
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// 종료코드 1 허용 버전 (git diff --no-index 용: diff 존재 시 code=1이 정상)
function execGitAllowFail(args: string[], options: GitExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: options.cwd,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 5,
    }, (error, stdout, stderr) => {
      if (error && !stdout.trim()) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// porcelain v2 상태코드 → human-readable 변환
function parseV2StatusCode(code: string): string {
  switch (code) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'M': return 'modified';
    case 'C': return 'copied';
    default:   return 'modified';
  }
}

async function gitStatus(cwd: string): Promise<GitResult> {
  const output = await execGit(
    ['status', '--porcelain=v2', '--branch', '-u'],
    { cwd },
  );

  let branch = '';
  let ahead = 0;
  let behind = 0;

  const stagedFiles: Array<{ path: string; status: string }> = [];
  const unstagedFiles: Array<{ path: string; status: string }> = [];

  for (const line of output.split('\n')) {
    // 브랜치 정보 헤더
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      // "+2 -1" 형태
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match) {
        ahead = parseInt(match[1], 10);
        behind = parseInt(match[2], 10);
      }
    } else if (line.startsWith('1 ')) {
      // 일반 변경: "1 XY sub mH mI mW hH hI path"
      // path는 마지막 필드이며 공백 포함 가능
      const m = /^1 (\S{2}) \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/.exec(line);
      if (m) {
        const x = m[1][0] ?? ' ';
        const y = m[1][1] ?? ' ';
        const filePath = m[2];
        if (x !== '.' && x !== ' ') stagedFiles.push({ path: filePath, status: parseV2StatusCode(x) });
        if (y !== '.' && y !== ' ') unstagedFiles.push({ path: filePath, status: parseV2StatusCode(y) });
      }
    } else if (line.startsWith('2 ')) {
      // rename/copy: "2 XY sub mH mI mW hH hI X score newPath\torigPath"
      const m = /^2 (\S{2}) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)\t(.+)$/.exec(line);
      if (m) {
        const x = m[1][0] ?? ' ';
        const y = m[1][1] ?? ' ';
        const newPath = m[2];
        if (x !== '.' && x !== ' ') stagedFiles.push({ path: newPath, status: 'renamed' });
        if (y !== '.' && y !== ' ') unstagedFiles.push({ path: newPath, status: 'renamed' });
      }
    } else if (line.startsWith('u ')) {
      // 충돌: "u XY sub mH mI mW mB hH hI hB path"
      const m = /^u \S{2} \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/.exec(line);
      if (m) {
        unstagedFiles.push({ path: m[1], status: 'conflicted' });
      }
    } else if (line.startsWith('? ')) {
      // untracked
      unstagedFiles.push({ path: line.slice(2), status: 'untracked' });
    }
  }

  return {
    success: true,
    data: {
      branch,
      ahead,
      behind,
      stagedFiles,
      unstagedFiles,
      clean: stagedFiles.length === 0 && unstagedFiles.length === 0,
    },
  };
}

async function gitLog(
  cwd: string,
  params: Record<string, unknown>,
): Promise<GitResult> {
  const count = typeof params.count === 'number' ? params.count : 20;
  const format = '%H|%h|%an|%ae|%at|%s';

  const output = await execGit(
    ['log', `--format=${format}`, `-n`, String(count)],
    { cwd },
  );

  const commits = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, author, email, timestamp, subject] = line.split('|');
      return {
        hash,
        shortHash,
        author,
        email,
        timestamp: parseInt(timestamp, 10) * 1000,
        subject,
      };
    });

  return { success: true, data: { commits } };
}

async function gitDiff(
  cwd: string,
  params: Record<string, unknown>,
): Promise<GitResult> {
  const file = typeof params.file === 'string' ? params.file : undefined;
  const staged = Boolean(params.staged);

  // untracked 파일은 git diff로 내용이 없음 → git diff --no-index 사용
  if (file && !staged) {
    const isUntracked = await checkUntracked(cwd, file);
    if (isUntracked) {
      // --no-index는 diff 존재 시 exit code 1 반환이 정상 → stdout을 살리는 래퍼 사용
      const output = await execGitAllowFail(
        ['diff', '--no-index', '--', '/dev/null', file],
        { cwd },
      );
      return { success: true, data: { diff: output, file, staged } };
    }
  }

  const args = ['diff'];
  if (staged) args.push('--cached');
  if (file) args.push('--', file);

  const output = await execGit(args, { cwd });
  return { success: true, data: { diff: output, file, staged } };
}

// untracked 파일 여부 확인
async function checkUntracked(cwd: string, file: string): Promise<boolean> {
  try {
    const output = await execGit(
      ['ls-files', '--others', '--exclude-standard', '--', file],
      { cwd },
    );
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

async function gitCommit(
  cwd: string,
  params: Record<string, unknown>,
): Promise<GitResult> {
  const message = params.message;
  if (typeof message !== 'string' || !message.trim()) {
    return { success: false, error: 'Commit message is required' };
  }

  const args = ['commit', '-m', message];

  const output = await execGit(args, { cwd });
  return { success: true, data: { output: output.trim() } };
}

async function gitPush(
  cwd: string,
  params: Record<string, unknown>,
): Promise<GitResult> {
  const args = ['push'];

  if (typeof params.remote === 'string') {
    args.push(params.remote);
  }

  if (typeof params.branch === 'string') {
    args.push(params.branch);
  }

  const output = await execGit(args, { cwd });
  return { success: true, data: { output: output.trim() } };
}

async function gitPull(
  cwd: string,
  params: Record<string, unknown>,
): Promise<GitResult> {
  const args = ['pull'];

  if (typeof params.remote === 'string') {
    args.push(params.remote);
  }

  if (typeof params.branch === 'string') {
    args.push(params.branch);
  }

  const output = await execGit(args, { cwd });
  return { success: true, data: { output: output.trim() } };
}

async function gitBranches(cwd: string): Promise<GitResult> {
  const output = await execGit(['branch', '-a', '--format=%(refname:short)|%(HEAD)'], { cwd });

  const branches = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, head] = line.split('|');
      return {
        name: name.trim(),
        current: head?.trim() === '*',
        remote: name.trim().startsWith('remotes/') || name.trim().startsWith('origin/'),
      };
    })
    // HEAD 심볼릭 ref 및 origin/HEAD 노이즈 제거
    .filter((b) => !b.name.endsWith('/HEAD'));

  return { success: true, data: { branches } };
}

async function gitCheckout(
  cwd: string,
  params: Record<string, unknown>,
): Promise<GitResult> {
  const target = params.branch || params.file;
  if (typeof target !== 'string') {
    return { success: false, error: 'Branch or file name is required' };
  }

  // 브랜치 전환은 switch 우선, 파일 복구는 checkout
  if (params.branch) {
    // 원격 트래킹 브랜치 처리: remotes/origin/feature 또는 origin/feature
    const remoteMatch = /^(?:remotes\/)?origin\/(.+)$/.exec(target);
    if (remoteMatch) {
      const localName = remoteMatch[1];
      const output = await execGit(['switch', '-c', localName, '--track', target], { cwd });
      return { success: true, data: { output: output.trim() } };
    }
    const args = params.create
      ? ['switch', '-c', target]
      : ['switch', target];
    const output = await execGit(args, { cwd });
    return { success: true, data: { output: output.trim() } };
  }

  const output = await execGit(['checkout', '--', target], { cwd });
  return { success: true, data: { output: output.trim() } };
}

// 파일 스테이징 (git add)
async function gitStage(
  cwd: string,
  params: Record<string, unknown>,
): Promise<GitResult> {
  const file = params.file;
  const args = ['add'];

  if (typeof file === 'string') {
    args.push('--', file);
  } else {
    // 전체 스테이징
    args.push('.');
  }

  const output = await execGit(args, { cwd });
  return { success: true, data: { output: output.trim() } };
}

// 파일 언스테이징 (git restore --staged)
async function gitUnstage(
  cwd: string,
  params: Record<string, unknown>,
): Promise<GitResult> {
  const file = params.file;
  const args = ['restore', '--staged'];

  if (typeof file === 'string') {
    args.push('--', file);
  } else {
    // 전체 언스테이징
    args.push('.');
  }

  const output = await execGit(args, { cwd });
  return { success: true, data: { output: output.trim() } };
}

async function gitStash(
  cwd: string,
  params: Record<string, unknown>,
): Promise<GitResult> {
  const subcommand = typeof params.action === 'string' ? params.action : 'push';
  const args = ['stash', subcommand];

  if (subcommand === 'push' && typeof params.message === 'string') {
    args.push('-m', params.message);
  }

  const output = await execGit(args, { cwd });
  return { success: true, data: { output: output.trim() } };
}
