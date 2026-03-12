import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const RUN_TIMEOUT_MS = 60_000;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createCodexClient() {
  const proc = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  const rl = createInterface({ input: proc.stdout });
  const notifications = [];
  const pending = new Map();
  let requestId = 0;

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (typeof parsed.id === 'number' && parsed.method === undefined) {
      const entry = pending.get(parsed.id);
      if (!entry) {
        return;
      }
      pending.delete(parsed.id);
      clearTimeout(entry.timer);
      if (parsed.error) {
        entry.reject(new Error(parsed.error.message));
      } else {
        entry.resolve(parsed.result);
      }
      return;
    }

    notifications.push(parsed);
  });

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  function send(method, params) {
    const id = ++requestId;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex RPC timeout: ${method}`));
      }, RUN_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
    });
  }

  async function close() {
    try {
      proc.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
    } catch {
      // ignore
    }
  }

  return { close, notifications, proc, send, stderr: () => stderr };
}

async function main() {
  const client = createCodexClient();

  try {
    await client.send('initialize', {
      clientInfo: { name: 'rca-codex-smoke', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });

    const modelList = await client.send('model/list', {
      cursor: null,
      includeHidden: false,
    });
    assert(Array.isArray(modelList?.data) && modelList.data.length > 0, 'model/list 결과가 비어 있습니다.');

    const threadStart = await client.send('thread/start', {
      cwd: process.cwd(),
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      model: 'gpt-5.4',
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });

    const threadId = threadStart?.thread?.id;
    assert(typeof threadId === 'string' && threadId.length > 0, 'thread/start에서 thread id를 받지 못했습니다.');

    const turnStart = await client.send('turn/start', {
      threadId,
      input: [{
        type: 'text',
        text: 'Respond with exactly RCA_CODEX_SMOKE_OK',
        text_elements: [],
      }],
      model: 'gpt-5.4',
      effort: 'low',
    });

    assert(turnStart?.turn?.id, 'turn/start 응답에 turn id가 없습니다.');

    const startedAt = Date.now();
    while (Date.now() - startedAt < RUN_TIMEOUT_MS) {
      const hasDelta = client.notifications.some((entry) => entry.method === 'item/agentMessage/delta');
      const completed = client.notifications.find((entry) => entry.method === 'turn/completed');
      if (hasDelta && completed) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const deltas = client.notifications
      .filter((entry) => entry.method === 'item/agentMessage/delta')
      .map((entry) => entry.params?.delta || '')
      .join('');
    const completed = client.notifications.find((entry) => entry.method === 'turn/completed');
    const tokenUsage = client.notifications.find((entry) => entry.method === 'thread/tokenUsage/updated');

    assert(deltas.includes('RCA_CODEX_SMOKE_OK'), `assistant delta가 예상과 다릅니다: ${deltas}`);
    assert(completed, 'turn/completed 알림을 받지 못했습니다.');
    assert(tokenUsage, 'thread/tokenUsage/updated 알림을 받지 못했습니다.');

    console.log(`codex-models: ${modelList.data.map((model) => model.model).join(', ')}`);
    console.log(`codex-turn: ${turnStart.turn.id}`);
    console.log(`codex-reply: ${deltas}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error));
  process.exitCode = 1;
});
