import { execFileSync } from 'node:child_process';

const APP_URL = 'http://127.0.0.1:9570/';
const PINCHTAB_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 60_000;
const WAIT_INTERVAL_MS = 1_000;

function runPinchtab(args, options = {}) {
  try {
    return execFileSync('pinchtab', args, {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: options.timeout ?? PINCHTAB_TIMEOUT_MS,
    }).trim();
  } catch (error) {
    const stdout = error.stdout?.toString() || '';
    const stderr = error.stderr?.toString() || '';
    throw new Error(`pinchtab ${args.join(' ')} failed\n${stdout}\n${stderr}`.trim());
  }
}

function parseJson(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`JSON 파싱 실패:\n${output}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(check, message, timeoutMs = WAIT_TIMEOUT_MS) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await check();
    if (result) return result;
    await sleep(WAIT_INTERVAL_MS);
  }

  throw new Error(message);
}

function snap(selector) {
  const args = ['snap', '-c'];
  if (selector) {
    args.push('-s', selector);
  }
  return runPinchtab(args);
}

function extractRef(snapshot, role, text) {
  const lines = snapshot.split(/\r?\n/);
  const lowerText = text.toLowerCase();

  for (const line of lines) {
    const match = line.match(/^(e\d+):([^\s]+)\s*(?:"([^"]*)")?/);
    if (!match) continue;

    const [, ref, currentRole, label = ''] = match;
    if (currentRole !== role) continue;
    if (label.toLowerCase().includes(lowerText)) {
      return ref;
    }
  }

  return null;
}

function click(ref) {
  runPinchtab(['click', ref]);
}

function type(ref, text) {
  runPinchtab(['type', ref, text], { timeout: 45_000 });
}

async function waitForConnected() {
  return waitFor(() => {
    const main = snap('main');
    if (main.includes('textbox "Send a message..."') && main.includes('button "Send message"')) {
      return main;
    }
    return null;
  }, '앱이 연결 상태로 전환되지 않았습니다.');
}

async function sendPrompt(prompt, expectedReply) {
  const aside = await waitFor(() => {
    const currentAside = snap('aside');
    const ref = extractRef(currentAside, 'button', 'New Chat');
    return ref ? ref : null;
  }, 'New Chat 버튼을 찾지 못했습니다.');

  click(aside);

  const main = await waitForConnected();
  const textboxRef = extractRef(main, 'textbox', 'Send a message...');
  if (!textboxRef) {
    throw new Error('메시지 입력창을 찾지 못했습니다.');
  }

  type(textboxRef, prompt);

  const updatedMain = await waitFor(() => {
    const nextMain = snap('main');
    return nextMain.includes(prompt) ? nextMain : null;
  }, `입력한 프롬프트가 화면에 반영되지 않았습니다: ${prompt}`);

  const sendButtonRef = extractRef(updatedMain, 'button', 'Send message');
  if (!sendButtonRef) {
    throw new Error('전송 버튼을 찾지 못했습니다.');
  }

  click(sendButtonRef);

  await waitFor(() => {
    const nextMain = snap('main');
    return nextMain.includes(`StaticText "${expectedReply}"`) ? nextMain : null;
  }, `응답이 완료되지 않았습니다: ${expectedReply}`);
}

async function selectThreadByLabel(label) {
  const aside = await waitFor(() => {
    const currentAside = snap('aside');
    const ref = extractRef(currentAside, 'button', label);
    return ref ? { currentAside, ref } : null;
  }, `스레드 버튼을 찾지 못했습니다: ${label}`);

  click(aside.ref);
}

async function assertMainContains(text) {
  await waitFor(() => {
    const main = snap('main');
    return main.includes(`StaticText "${text}"`) ? main : null;
  }, `메인 영역에서 텍스트를 찾지 못했습니다: ${text}`);
}

async function assertMainNotContains(text) {
  await waitFor(() => {
    const main = snap('main');
    return !main.includes(`StaticText "${text}"`) ? main : null;
  }, `메인 영역에 남아 있으면 안 되는 텍스트가 있습니다: ${text}`);
}

async function ensureAppReady() {
  const response = await fetch(APP_URL);
  if (!response.ok) {
    throw new Error(`앱 서버 응답이 비정상입니다: ${response.status}`);
  }

  const health = parseJson(runPinchtab(['health']));
  if (health.status !== 'ok') {
    throw new Error('PinchTab 서버 상태가 비정상입니다.');
  }
}

async function main() {
  await ensureAppReady();

  runPinchtab(['nav', APP_URL], { timeout: 45_000 });
  await waitForConnected();

  const firstToken = `PINCHTAB_E2E_A_${Date.now()}`;
  await sendPrompt(`Reply with exactly ${firstToken}.`, firstToken);
  await assertMainContains(firstToken);

  runPinchtab(['nav', APP_URL], { timeout: 45_000 });
  await waitForConnected();
  await assertMainContains(firstToken);

  const secondToken = `PINCHTAB_E2E_B_${Date.now()}`;
  await sendPrompt(`Reply with exactly ${secondToken}.`, secondToken);
  await assertMainContains(secondToken);
  await assertMainNotContains(firstToken);

  await selectThreadByLabel(firstToken);
  await assertMainContains(firstToken);
  await assertMainNotContains(secondToken);

  console.log(`pinchtab-reload: ok (${firstToken})`);
  console.log(`pinchtab-thread-switch: ok (${firstToken} -> ${secondToken})`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
