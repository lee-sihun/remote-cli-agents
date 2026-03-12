import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const START_TIMEOUT_MS = 90_000;
const ACTION_TIMEOUT_MS = 45_000;
const WAIT_TIMEOUT_MS = 60_000;
const WAIT_INTERVAL_MS = 1_000;
const CHAT_SELECTOR = '[data-testid="chat-view"]';
const AGENT_SELECTOR = '[data-testid="agent-selector-button"]';
const MODEL_SELECTOR = '[data-testid="input-option-model"]';
let appPort = 9570;
let appUrl = `http://127.0.0.1:${appPort}/`;
let pinchtabPort = 9868;
let pinchtabUrl = `http://127.0.0.1:${pinchtabPort}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`JSON 파싱 실패:\n${output}`);
  }
}

function trimLog(log) {
  return log.slice(-8_000);
}

function startProcess(label, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout = trimLog(stdout + chunk.toString());
  });
  child.stderr.on('data', (chunk) => {
    stderr = trimLog(stderr + chunk.toString());
  });

  return {
    child,
    label,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function stopProcess(processInfo) {
  if (!processInfo?.child || processInfo.child.exitCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(processInfo.child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } catch {
      // ignore
    }
  } else {
    processInfo.child.kill('SIGTERM');
  }

  await Promise.race([
    new Promise((resolve) => processInfo.child.once('exit', resolve)),
    sleep(5_000),
  ]);
}

async function waitFor(check, message, timeoutMs = WAIT_TIMEOUT_MS) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await check();
    if (result) {
      return result;
    }
    await sleep(WAIT_INTERVAL_MS);
  }

  throw new Error(message);
}

async function waitForAppHealth() {
  return waitFor(async () => {
    try {
      const response = await fetch(`${appUrl}api/health`);
      if (!response.ok) {
        return null;
      }
      return response.json();
    } catch {
      return null;
    }
  }, '앱 서버가 준비되지 않았습니다.', START_TIMEOUT_MS);
}

function runPinchtab(args, options = {}) {
  try {
    return execFileSync('pinchtab', args, {
      encoding: 'utf8',
      env: { ...process.env, PINCHTAB_URL: pinchtabUrl },
      shell: process.platform === 'win32',
      timeout: options.timeout ?? ACTION_TIMEOUT_MS,
    }).trim();
  } catch (error) {
    const stdout = error.stdout?.toString() || '';
    const stderr = error.stderr?.toString() || '';
    throw new Error(`pinchtab ${args.join(' ')} failed\n${stdout}\n${stderr}`.trim());
  }
}

async function waitForPinchtabHealth() {
  await waitFor(() => {
    try {
      const output = runPinchtab(['health']);
      const health = parseJson(output);
      return health.status === 'ok' ? health : null;
    } catch {
      return null;
    }
  }, 'PinchTab 서버가 준비되지 않았습니다.', START_TIMEOUT_MS);
}

function snap(selector) {
  const args = ['snap', '-c'];
  if (selector) {
    args.push('-s', selector);
  }
  return runPinchtab(args);
}

function extractRefs(snapshot, role, text) {
  const refs = [];
  const lines = snapshot.split(/\r?\n/);
  const lowerText = text.toLowerCase();

  for (const line of lines) {
    const match = line.match(/^(e\d+):([^\s]+)\s*(?:"([^"]*)")?/);
    if (!match) {
      continue;
    }

    const [, ref, currentRole, label = ''] = match;
    if (currentRole !== role) {
      continue;
    }
    if (!label.toLowerCase().includes(lowerText)) {
      continue;
    }
    refs.push(ref);
  }

  return refs;
}

function extractRef(snapshot, role, text) {
  return extractRefs(snapshot, role, text)[0] || null;
}

function click(ref) {
  runPinchtab(['click', ref]);
}

async function waitForConnected() {
  return waitFor(() => {
    const main = snap();
    if (
      main.includes('button "Connected"')
      && main.includes('textbox "Send a message..."')
      && !main.includes('dialog "연결 설정"')
    ) {
      return main;
    }
    return null;
  }, '앱이 연결 상태로 전환되지 않았습니다.');
}

async function clickButtonByText(text) {
  const ref = await waitFor(() => {
    const snapshot = snap();
    return extractRef(snapshot, 'button', text);
  }, `버튼을 찾지 못했습니다: ${text}`);
  click(ref);
}

async function selectAgent(agentName) {
  const selectorSnapshot = await waitFor(() => {
    const snapshot = snap(AGENT_SELECTOR);
    return extractRef(snapshot, 'button', '') ? snapshot : null;
  }, '에이전트 셀렉터를 찾지 못했습니다.');
  click(extractRef(selectorSnapshot, 'button', ''));
  const itemRef = await waitFor(() => {
    const snapshot = snap();
    return extractRef(snapshot, 'button', agentName);
  }, `에이전트 선택 항목을 찾지 못했습니다: ${agentName}`);
  click(itemRef);
}

async function ensureCodexSelected() {
  await waitForConnected();

  const selectorSnapshot = snap(AGENT_SELECTOR);
  if (selectorSnapshot.includes('button "Codex"')) {
    return;
  }

  await selectAgent('Codex');
  await waitFor(() => {
    const next = snap();
    return next.includes('button "Codex"') ? next : null;
  }, 'Codex 에이전트 전환이 반영되지 않았습니다.');
  await waitForConnected();
}

async function openNewChat() {
  await clickButtonByText('New Chat');
  await waitFor(() => {
    const chat = snap(CHAT_SELECTOR);
    return chat.includes('Start a conversation') ? chat : null;
  }, '새 대화 화면이 열리지 않았습니다.');
}

async function assertSnapshotContains(text) {
  await waitFor(() => {
    const current = snap();
    return current.includes(text) ? current : null;
  }, `스냅샷에서 텍스트를 찾지 못했습니다: ${text}`);
}

async function selectModel(targetLabel) {
  const modelSnapshot = await waitFor(() => {
    const current = snap(MODEL_SELECTOR);
    return extractRef(current, 'button', '') ? current : null;
  }, '모델 선택 버튼을 찾지 못했습니다.');
  click(extractRef(modelSnapshot, 'button', ''));

  const option = await waitFor(() => {
    const current = snap();
    const label = targetLabel || pickNonFastModel(current);
    if (!label) {
      return null;
    }
    const ref = extractRef(current, 'button', label);
    if (!ref) {
      return null;
    }
    return { label, ref };
  }, `모델 옵션을 찾지 못했습니다: ${targetLabel || 'non-fast model'}`);
  click(option.ref);

  await waitFor(() => {
    const current = snap(MODEL_SELECTOR);
    return current.includes(`button "${option.label}"`) ? current : null;
  }, `모델 선택이 반영되지 않았습니다: ${option.label}`);

  return option.label;
}

function pickNonFastModel(snapshot) {
  const candidates = [];
  const lines = snapshot.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^e\d+:button "([^"]+)"/);
    if (!match) {
      continue;
    }

    const label = match[1];
    const normalized = label.toLowerCase();
    if (!normalized.includes('gpt-5')) {
      continue;
    }
    if (normalized.includes('5.4')) {
      continue;
    }
    candidates.push(label);
  }

  return candidates[0] || null;
}

async function assertSpeedFooterHidden() {
  await waitFor(() => {
    const current = snap();
    return current.includes('button "Standard"') || current.includes('button "Fast"') ? null : 'hidden';
  }, '비대상 모델에서 Speed 옵션이 숨겨지지 않았습니다.');
}

async function waitForVisibleSpeedButton(expectedLabel) {
  return waitFor(() => {
    const current = snap();
    const standardRef = extractRef(current, 'button', 'Standard');
    if (standardRef) {
      if (expectedLabel && expectedLabel !== 'Standard') {
        return null;
      }
      return { current, label: 'Standard', ref: standardRef };
    }

    const fastRef = extractRef(current, 'button', 'Fast');
    if (fastRef) {
      if (expectedLabel && expectedLabel !== 'Fast') {
        return null;
      }
      return { current, label: 'Fast', ref: fastRef };
    }

    return null;
  }, expectedLabel ? `Speed 옵션이 ${expectedLabel} 상태로 보이지 않습니다.` : 'Speed 선택 버튼을 찾지 못했습니다.');
}

async function ensureSpeed(targetLabel) {
  const speedButton = await waitForVisibleSpeedButton();
  if (speedButton.label === targetLabel) {
    return;
  }

  click(speedButton.ref);

  const optionRef = await waitFor(() => {
    const current = snap();
    const refs = extractRefs(current, 'button', targetLabel);
    return refs.find((ref) => ref !== speedButton.ref) || refs[refs.length - 1] || null;
  }, `Speed 옵션을 찾지 못했습니다: ${targetLabel}`);
  click(optionRef);

  await waitForVisibleSpeedButton(targetLabel);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('빈 포트를 찾지 못했습니다.')));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function assertCodexOptions() {
  await assertSnapshotContains('button "On Request"');
  await assertSnapshotContains('button "Workspace Write"');
  await selectModel('gpt-5.4');
  await waitForVisibleSpeedButton();

  await ensureSpeed('Fast');

  await selectModel();
  await assertSpeedFooterHidden();

  await selectModel('gpt-5.4');
  await waitForVisibleSpeedButton('Fast');
}

async function assertCodexOptionsAfterReload() {
  await assertSnapshotContains('button "On Request"');
  await assertSnapshotContains('button "Workspace Write"');
  await waitFor(() => {
    const current = snap(MODEL_SELECTOR);
    return current.includes('button "gpt-5.4"') ? current : null;
  }, '리로드 후 gpt-5.4 모델이 유지되지 않았습니다.');
  await waitForVisibleSpeedButton('Fast');
}

async function main() {
  appPort = await getFreePort();
  pinchtabPort = await getFreePort();
  appUrl = `http://127.0.0.1:${appPort}/`;
  pinchtabUrl = `http://127.0.0.1:${pinchtabPort}`;

  const appServer = startProcess('app', 'node', ['packages/server/dist/index.js', '--port', String(appPort), '--no-relay']);
  const pinchServer = startProcess('pinchtab', 'pinchtab', [], {
    PINCHTAB_PORT: String(pinchtabPort),
    PINCHTAB_HEADLESS: 'true',
  });
  let failed = true;

  try {
    await waitForAppHealth();
    await waitForPinchtabHealth();

    runPinchtab(['nav', appUrl], { timeout: 60_000 });

    await ensureCodexSelected();
    await openNewChat();
    await assertCodexOptions();

    runPinchtab(['nav', appUrl], { timeout: 60_000 });
    await ensureCodexSelected();
    await openNewChat();
    await assertCodexOptionsAfterReload();

    console.log('pinchtab-codex-options: ok (gpt-5.4 standard/fast + hidden on non-5.4)');
    console.log('pinchtab-codex-reload: ok (fast persisted across model switch and reload)');
    failed = false;
  } finally {
    await stopProcess(appServer);
    await stopProcess(pinchServer);

    if (failed) {
      console.error(`[app stdout]\n${appServer.stdout()}`);
      console.error(`[app stderr]\n${appServer.stderr()}`);
      console.error(`[pinchtab stdout]\n${pinchServer.stdout()}`);
      console.error(`[pinchtab stderr]\n${pinchServer.stderr()}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
