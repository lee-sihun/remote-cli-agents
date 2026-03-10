import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import type { FileEntry } from '@rca/shared';

// 디렉토리 탐색 공격 방지용 경로 검증
function validatePath(requestedPath: string, baseCwd: string): string {
  const resolved = resolve(baseCwd, requestedPath);
  const rel = relative(baseCwd, resolved);

  // 상위 디렉토리로의 탈출 방지
  if (rel.startsWith('..') || resolve(baseCwd, rel) !== resolved) {
    throw new Error('Path traversal detected');
  }

  return resolved;
}

// 디렉토리 목록 조회
export async function listDirectory(
  requestedPath: string,
  cwd: string,
): Promise<FileEntry[]> {
  const safePath = validatePath(requestedPath, cwd);
  const entries = await readdir(safePath, { withFileTypes: true });

  const results: FileEntry[] = [];

  for (const entry of entries) {
    // 숨김 파일 제외 (선택적 — 포함하고 싶으면 제거)
    const entryPath = join(safePath, entry.name);
    let entryType: 'file' | 'directory' = 'file';

    if (entry.isDirectory()) {
      entryType = 'directory';
    } else if (!entry.isFile()) {
      continue; // 심볼릭 링크 등 기타 타입은 스킵
    }

    let size: number | undefined;
    let modified: number | undefined;

    try {
      const info = await stat(entryPath);
      size = info.isFile() ? info.size : undefined;
      modified = info.mtimeMs;
    } catch {
      // stat 실패 시 무시
    }

    results.push({
      name: entry.name,
      type: entryType,
      size,
      modified,
    });
  }

  // 디렉토리 우선 정렬, 그 후 이름순
  results.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return results;
}

// 파일 내용 읽기
export async function readFileContent(
  requestedPath: string,
  cwd: string,
): Promise<string> {
  const safePath = validatePath(requestedPath, cwd);

  // 파일인지 확인
  const info = await stat(safePath);
  if (!info.isFile()) {
    throw new Error('Path is not a file');
  }

  // 파일 크기 제한 (10MB)
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  if (info.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(info.size / 1024 / 1024).toFixed(1)}MB). Max: 10MB`);
  }

  const content = await readFile(safePath, 'utf-8');
  return content;
}
