import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentType, AgentMessage, ThreadSummary } from '@rca/shared';

// 저장 경로: ~/.rca/data/
const DATA_DIR = join(homedir(), '.rca', 'data');
const THREADS_FILE = join(DATA_DIR, 'threads.json');
const MESSAGES_DIR = join(DATA_DIR, 'messages');

// 초기화 (디렉토리 생성)
function ensureDirs(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!existsSync(MESSAGES_DIR)) {
    mkdirSync(MESSAGES_DIR, { recursive: true });
  }
}

// ─── Threads ───

interface StoredThreads {
  [agentType: string]: ThreadSummary[];
}

export function loadAllThreads(): Map<AgentType, ThreadSummary[]> {
  ensureDirs();
  try {
    if (!existsSync(THREADS_FILE)) return new Map();
    const raw = readFileSync(THREADS_FILE, 'utf-8');
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

export function loadThreads(agentType: AgentType): ThreadSummary[] {
  const all = loadAllThreads();
  return all.get(agentType) || [];
}

export function saveThread(agentType: AgentType, thread: ThreadSummary): void {
  ensureDirs();
  const all = loadAllThreads();
  const threads = all.get(agentType) || [];
  const idx = threads.findIndex((t) => t.id === thread.id);
  if (idx >= 0) {
    threads[idx] = thread;
  } else {
    threads.push(thread);
  }
  all.set(agentType, threads);

  const obj: StoredThreads = {};
  for (const [key, val] of all) {
    obj[key] = val;
  }
  writeFileSync(THREADS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
}

export function renameThread(agentType: AgentType, threadId: string, title: string): boolean {
  ensureDirs();
  const all = loadAllThreads();
  const threads = all.get(agentType) || [];
  const idx = threads.findIndex((t) => t.id === threadId);
  if (idx < 0) {
    return false;
  }

  threads[idx] = {
    ...threads[idx],
    title,
  };
  all.set(agentType, threads);

  const obj: StoredThreads = {};
  for (const [key, val] of all) {
    obj[key] = val;
  }
  writeFileSync(THREADS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  return true;
}

export function deleteThread(agentType: AgentType, threadId: string): void {
  ensureDirs();
  const all = loadAllThreads();
  const threads = all.get(agentType) || [];
  const filtered = threads.filter((t) => t.id !== threadId);
  all.set(agentType, filtered);

  const obj: StoredThreads = {};
  for (const [key, val] of all) {
    obj[key] = val;
  }
  writeFileSync(THREADS_FILE, JSON.stringify(obj, null, 2), 'utf-8');

  // 메시지 파일도 삭제
  const msgFile = join(MESSAGES_DIR, `${threadId}.json`);
  try {
    if (existsSync(msgFile)) {
      unlinkSync(msgFile);
    }
  } catch {
    // 무시
  }
}

// ─── Messages ───

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
