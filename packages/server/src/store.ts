import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentType, AgentMessage, ThreadSummary, Workspace } from '@rca/shared';

// 저장 경로: ~/.rca/data/
const DATA_DIR = join(homedir(), '.rca', 'data');
const WORKSPACES_FILE = join(DATA_DIR, 'workspaces.json');
const THREADS_DIR = join(DATA_DIR, 'threads');
const MESSAGES_DIR = join(DATA_DIR, 'messages');

// 레거시 (마이그레이션용)
const LEGACY_THREADS_FILE = join(DATA_DIR, 'threads.json');

// 초기화 (디렉토리 생성)
function ensureDirs(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!existsSync(THREADS_DIR)) {
    mkdirSync(THREADS_DIR, { recursive: true });
  }
  if (!existsSync(MESSAGES_DIR)) {
    mkdirSync(MESSAGES_DIR, { recursive: true });
  }
}

// ─── Workspaces ───

export function loadWorkspaces(): Workspace[] {
  ensureDirs();
  try {
    if (!existsSync(WORKSPACES_FILE)) return [];
    const raw = readFileSync(WORKSPACES_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveWorkspaces(workspaces: Workspace[]): void {
  ensureDirs();
  writeFileSync(WORKSPACES_FILE, JSON.stringify(workspaces, null, 2), 'utf-8');
}

export function createWorkspace(name: string, path: string): Workspace {
  const workspaces = loadWorkspaces();

  // 같은 경로 중복 방지
  const existing = workspaces.find((w) => w.path === path);
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const workspace: Workspace = {
    id: randomUUID().slice(0, 8),
    name,
    path,
    createdAt: now,
    lastAccessedAt: now,
  };

  workspaces.push(workspace);
  saveWorkspaces(workspaces);
  return workspace;
}

export function updateWorkspace(id: string, name: string): Workspace | null {
  const workspaces = loadWorkspaces();
  const idx = workspaces.findIndex((w) => w.id === id);
  if (idx < 0) return null;

  workspaces[idx] = { ...workspaces[idx], name };
  saveWorkspaces(workspaces);
  return workspaces[idx];
}

export function deleteWorkspace(id: string): boolean {
  const workspaces = loadWorkspaces();
  const filtered = workspaces.filter((w) => w.id !== id);
  if (filtered.length === workspaces.length) return false;

  saveWorkspaces(filtered);

  // 워크스페이스 스레드 파일 삭제
  const threadsFile = join(THREADS_DIR, `${id}.json`);
  try {
    if (existsSync(threadsFile)) {
      // 스레드별 메시지 파일도 삭제
      const threads = loadWorkspaceThreads(id);
      for (const [, agentThreads] of threads) {
        for (const thread of agentThreads) {
          const msgFile = join(MESSAGES_DIR, `${thread.id}.json`);
          try { if (existsSync(msgFile)) unlinkSync(msgFile); } catch { /* 무시 */ }
        }
      }
      unlinkSync(threadsFile);
    }
  } catch { /* 무시 */ }

  return true;
}

export function touchWorkspace(id: string): void {
  const workspaces = loadWorkspaces();
  const idx = workspaces.findIndex((w) => w.id === id);
  if (idx >= 0) {
    workspaces[idx] = { ...workspaces[idx], lastAccessedAt: Date.now() };
    saveWorkspaces(workspaces);
  }
}

export function getWorkspace(id: string): Workspace | undefined {
  return loadWorkspaces().find((w) => w.id === id);
}

// ─── Threads (워크스페이스별) ───

interface StoredThreads {
  [agentType: string]: ThreadSummary[];
}

function workspaceThreadsFile(workspaceId: string): string {
  return join(THREADS_DIR, `${workspaceId}.json`);
}

function loadWorkspaceThreads(workspaceId: string): Map<AgentType, ThreadSummary[]> {
  ensureDirs();
  try {
    const file = workspaceThreadsFile(workspaceId);
    if (!existsSync(file)) return new Map();
    const raw = readFileSync(file, 'utf-8');
    const data: StoredThreads = JSON.parse(raw);
    const map = new Map<AgentType, ThreadSummary[]>();
    for (const [key, val] of Object.entries(data)) {
      map.set(key as AgentType, val);
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveWorkspaceThreads(workspaceId: string, all: Map<AgentType, ThreadSummary[]>): void {
  ensureDirs();
  const obj: StoredThreads = {};
  for (const [key, val] of all) {
    obj[key] = val;
  }
  writeFileSync(workspaceThreadsFile(workspaceId), JSON.stringify(obj, null, 2), 'utf-8');
}

export function loadAllThreads(workspaceId: string): Map<AgentType, ThreadSummary[]> {
  return loadWorkspaceThreads(workspaceId);
}

export function loadThreads(agentType: AgentType, workspaceId: string): ThreadSummary[] {
  const all = loadWorkspaceThreads(workspaceId);
  return all.get(agentType) || [];
}

export function saveThread(agentType: AgentType, thread: ThreadSummary, workspaceId: string): void {
  const all = loadWorkspaceThreads(workspaceId);
  const threads = all.get(agentType) || [];
  const idx = threads.findIndex((t) => t.id === thread.id);
  if (idx >= 0) {
    threads[idx] = thread;
  } else {
    threads.push(thread);
  }
  all.set(agentType, threads);
  saveWorkspaceThreads(workspaceId, all);
}

export function renameThread(agentType: AgentType, threadId: string, title: string, workspaceId: string): boolean {
  const all = loadWorkspaceThreads(workspaceId);
  const threads = all.get(agentType) || [];
  const idx = threads.findIndex((t) => t.id === threadId);
  if (idx < 0) return false;

  threads[idx] = { ...threads[idx], title };
  all.set(agentType, threads);
  saveWorkspaceThreads(workspaceId, all);
  return true;
}

export function deleteThread(agentType: AgentType, threadId: string, workspaceId: string): void {
  const all = loadWorkspaceThreads(workspaceId);
  const threads = all.get(agentType) || [];
  all.set(agentType, threads.filter((t) => t.id !== threadId));
  saveWorkspaceThreads(workspaceId, all);

  // 메시지 파일 삭제
  const msgFile = join(MESSAGES_DIR, `${threadId}.json`);
  try { if (existsSync(msgFile)) unlinkSync(msgFile); } catch { /* 무시 */ }
}

// ─── Messages (변경 없음 - threadId로 고유) ───

const MAX_MESSAGES_PER_THREAD = 200;

export function loadMessages(threadId: string): AgentMessage[] {
  ensureDirs();
  try {
    const file = join(MESSAGES_DIR, `${threadId}.json`);
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function saveMessages(threadId: string, messages: AgentMessage[]): void {
  ensureDirs();
  const trimmed = messages.slice(-MAX_MESSAGES_PER_THREAD);
  const file = join(MESSAGES_DIR, `${threadId}.json`);
  writeFileSync(file, JSON.stringify(trimmed, null, 2), 'utf-8');
}

export function appendMessage(threadId: string, message: AgentMessage): void {
  const existing = loadMessages(threadId);
  existing.push(message);
  saveMessages(threadId, existing);
}

// ─── 마이그레이션: 기존 threads.json → 워크스페이스 기반 ───

export function migrateIfNeeded(defaultCwd: string): void {
  ensureDirs();
  if (!existsSync(LEGACY_THREADS_FILE)) return;

  try {
    const raw = readFileSync(LEGACY_THREADS_FILE, 'utf-8');
    const data: StoredThreads = JSON.parse(raw);

    // default 워크스페이스 생성
    const workspace = createWorkspace(basename(defaultCwd) || 'default', defaultCwd);

    // 기존 스레드를 default 워크스페이스로 이동
    const map = new Map<AgentType, ThreadSummary[]>();
    for (const [key, val] of Object.entries(data)) {
      // workspaceId 추가
      const threads = val.map((t) => ({ ...t, workspaceId: workspace.id }));
      map.set(key as AgentType, threads);
    }
    saveWorkspaceThreads(workspace.id, map);

    // 레거시 파일 삭제
    unlinkSync(LEGACY_THREADS_FILE);
    console.log(`[store] Migrated legacy threads to workspace "${workspace.name}" (${workspace.id})`);
  } catch (err) {
    console.error('[store] Migration failed:', err);
  }
}
