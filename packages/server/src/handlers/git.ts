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

// porcelain XY 상태코드 → human-readable 변환
function parseStatusCode(code: string): string {
  switch (code) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'M': return 'modified';
    case '?': return 'untracked';
    default:   return 'modified';
  }
}

// 병합 충돌 XY 조합
const CONFLICT_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

async function gitStatus(cwd: string): Promise<GitResult> {
  const [statusOutput, branchOutput] = await Promise.all([
    execGit(['status', '--porcelain', '-u'], { cwd }),
    execGit(['branch', '--show-current'], { cwd }),
  ]);

  const files = statusOutput
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const x = line[0] ?? ' '; // index (staged)
      const y = line[1] ?? ' '; // worktree (unstaged)
      const rawPath = line.slice(3);
      // Rename/Copy: "old -> new" 형태에서 새 경로만 추출
      const path = (x === 'R' || x === 'C')
        ? (rawPath.split(' -> ').at(-1) ?? rawPath)
        : rawPath;

      if (CONFLICT_XY.has(`${x}${y}`)) {
        return { path, status: 'conflicted', staged: false };
      }

      const staged = x !== ' ' && x !== '?';
      const code = staged ? x : y;
      return { path, status: parseStatusCode(code), staged };
    });

  return {
    success: true,
    data: {
      branch: branchOutput.trim(),
      files,
      clean: files.length === 0,
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
  const args = ['diff'];

  if (params.staged) {
    args.push('--cached');
  }

  if (typeof params.file === 'string') {
    args.push('--', params.file);
  }

  const output = await execGit(args, { cwd });
  return { success: true, data: { diff: output } };
}

async function gitCommit(
  cwd: string,
  params: Record<string, unknown>,
): Promise<GitResult> {
  const message = params.message;
  if (typeof message !== 'string' || !message.trim()) {
    return { success: false, error: 'Commit message is required' };
  }

  // stage 여부
  const args = ['commit'];
  if (params.all) {
    args.push('-a');
  }
  args.push('-m', message);

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
      };
    });

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

  const args = ['checkout'];

  if (params.create) {
    args.push('-b');
  }

  args.push(target);

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
