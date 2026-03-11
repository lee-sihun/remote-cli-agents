import { spawn } from 'node:child_process';

const runClaudeJson = (prompt, args = []) =>
  new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--output-format', 'json', '--verbose', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr || stdout}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Failed to parse Claude JSON output: ${error instanceof Error ? error.message : String(error)}\n${stdout}`));
      }
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });

const runClaudeExpectFailure = (prompt, args = []) =>
  new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--output-format', 'json', '--verbose', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        reject(new Error(`claude가 실패해야 하는 테스트에서 성공했습니다: ${stdout}`));
        return;
      }

      resolve((stderr || stdout).trim());
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });

const getEvent = (events, type) => events.find((event) => event.type === type);

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const main = async () => {
  const results = [];

  const basicEvents = await runClaudeJson('Reply with exactly OK.');
  const basicResult = getEvent(basicEvents, 'result');
  assert(getEvent(basicEvents, 'system'), 'system 이벤트가 없습니다.');
  assert(getEvent(basicEvents, 'assistant'), 'assistant 이벤트가 없습니다.');
  assert(basicResult?.result, 'result 이벤트가 없습니다.');
  results.push(`basic-stream-json: ${basicResult.result}`);

  const planEvents = await runClaudeJson('Reply with exactly OK.', ['--permission-mode', 'plan']);
  assert(getEvent(planEvents, 'system')?.permissionMode === 'plan', 'plan permission mode가 반영되지 않았습니다.');
  results.push('permission-mode-plan: ok');

  const acceptEvents = await runClaudeJson('Reply with exactly OK.', ['--permission-mode', 'acceptEdits']);
  assert(getEvent(acceptEvents, 'system')?.permissionMode === 'acceptEdits', 'acceptEdits permission mode가 반영되지 않았습니다.');
  results.push('permission-mode-acceptEdits: ok');

  const bypassEvents = await runClaudeJson('Reply with exactly OK.', ['--dangerously-skip-permissions']);
  assert(getEvent(bypassEvents, 'system')?.permissionMode === 'bypassPermissions', 'dangerously-skip-permissions가 bypassPermissions로 반영되지 않았습니다.');
  results.push('permission-mode-bypass: ok');

  const effortEvents = await runClaudeJson('Reply with exactly OK.', ['--effort', 'high']);
  assert(getEvent(effortEvents, 'result')?.result, '--effort high 실행이 실패했습니다.');
  results.push('effort-flag: ok');

  const firstSessionEvents = await runClaudeJson('Remember this exact code: 314159. Reply exactly STORED.');
  const sessionId = getEvent(firstSessionEvents, 'result')?.session_id;
  assert(sessionId, 'session_id를 받지 못했습니다.');

  const resumedEvents = await runClaudeJson(
    'What code did I ask you to remember? Reply digits only.',
    ['--resume', sessionId],
  );
  const resumedResult = getEvent(resumedEvents, 'result')?.result?.trim();
  assert(resumedResult === '314159', `--resume 결과가 예상과 다릅니다: ${resumedResult}`);
  results.push(`resume-session: ${resumedResult}`);

  const invalidResume = await runClaudeExpectFailure('Reply with exactly OK.', ['--resume', 'invalid-session-id']);
  assert(invalidResume.includes('valid UUID'), `잘못된 session ID 에러 메시지가 예상과 다릅니다: ${invalidResume}`);
  results.push('resume-invalid-session: ok');

  console.log(results.join('\n'));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
