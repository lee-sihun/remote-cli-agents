import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUN_TIMEOUT_MS = 45_000;

const parseStreamJson = (stdout) =>
  stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const collectClaudeRun = (prompt, args = [], options = {}) =>
  new Promise((resolve, reject) => {
    const proc = spawn('claude', ['--output-format', 'stream-json', '--verbose', ...args, '-p'], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        proc.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
      } catch {
        // 무시
      }
      reject(new Error(`Claude CLI timed out after ${RUN_TIMEOUT_MS}ms`));
    }, RUN_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      let events;
      try {
        events = parseStreamJson(stdout);
      } catch (error) {
        reject(new Error(`Failed to parse Claude stream-json output: ${error instanceof Error ? error.message : String(error)}\n${stdout}`));
        return;
      }

      if (!options.allowFailure && code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr || stdout}`));
        return;
      }

      resolve({ code, events, stderr, stdout });
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });

const runClaudeStreamJson = async (prompt, args = [], options = {}) => {
  const result = await collectClaudeRun(prompt, args, options);
  return result.events;
};

const runClaudeAllowFailure = (prompt, args = [], options = {}) =>
  collectClaudeRun(prompt, args, { ...options, allowFailure: true });

const getEvent = (events, type) => events.find((event) => event.type === type);

const getAssistantText = (events) =>
  events
    .filter((event) => event.type === 'assistant')
    .flatMap((event) => event.message?.content || [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const createToolFlowWorkspace = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rca-claude-tool-flow-'));
  writeFileSync(join(cwd, 'a.txt'), 'ALPHA');
  writeFileSync(join(cwd, 'b.txt'), 'BETA');
  return cwd;
};

const main = async () => {
  const results = [];

  const basicEvents = await runClaudeStreamJson('Reply with exactly OK.');
  const basicResult = getEvent(basicEvents, 'result');
  assert(getEvent(basicEvents, 'system'), 'system 이벤트가 없습니다.');
  assert(getEvent(basicEvents, 'assistant'), 'assistant 이벤트가 없습니다.');
  assert(getEvent(basicEvents, 'rate_limit_event'), 'rate_limit_event 이벤트가 없습니다.');
  assert(basicResult?.result, 'result 이벤트가 없습니다.');
  assert(getAssistantText(basicEvents) === basicResult.result, 'assistant text와 result.result가 일치하지 않습니다.');
  results.push(`basic-stream-json: ${basicResult.result}`);
  results.push('assistant-text-vs-result-basic: ok');

  const partialEvents = await runClaudeStreamJson('Reply with exactly OK.', ['--include-partial-messages']);
  assert(partialEvents.some((event) => event.type === 'stream_event' && event.event?.type === 'content_block_delta'), 'partial stream delta 이벤트가 없습니다.');
  results.push('partial-stream-events: ok');

  const longPromptEvents = await runClaudeStreamJson(
    `Reply with exactly LONG_OK. Ignore the filler below.\n${'x'.repeat(70_000)}`,
  );
  assert(getEvent(longPromptEvents, 'result')?.result?.trim() === 'LONG_OK', '긴 프롬프트 처리 결과가 예상과 다릅니다.');
  results.push('long-prompt: ok');

  const planEvents = await runClaudeStreamJson('Reply with exactly OK.', ['--permission-mode', 'plan']);
  assert(getEvent(planEvents, 'system')?.permissionMode === 'plan', 'plan permission mode가 반영되지 않았습니다.');
  results.push('permission-mode-plan: ok');

  const acceptEvents = await runClaudeStreamJson('Reply with exactly OK.', ['--permission-mode', 'acceptEdits']);
  assert(getEvent(acceptEvents, 'system')?.permissionMode === 'acceptEdits', 'acceptEdits permission mode가 반영되지 않았습니다.');
  results.push('permission-mode-acceptEdits: ok');

  const bypassEvents = await runClaudeStreamJson('Reply with exactly OK.', ['--dangerously-skip-permissions']);
  assert(getEvent(bypassEvents, 'system')?.permissionMode === 'bypassPermissions', 'dangerously-skip-permissions가 bypassPermissions로 반영되지 않았습니다.');
  results.push('permission-mode-bypass: ok');

  const effortEvents = await runClaudeStreamJson('Reply with exactly OK.', ['--effort', 'high']);
  assert(getEvent(effortEvents, 'result')?.result, '--effort high 실행이 실패했습니다.');
  results.push('effort-flag: ok');

  const haikuEvents = await runClaudeStreamJson('Reply with exactly OK.', ['--model', 'haiku']);
  assert(String(getEvent(haikuEvents, 'system')?.model || '').includes('haiku'), 'haiku 모델 매핑이 예상과 다릅니다.');
  results.push(`model-haiku: ${getEvent(haikuEvents, 'system')?.model}`);

  const haikuEffortEvents = await runClaudeStreamJson('Reply with exactly HAIKU_EFFORT_OK.', ['--model', 'haiku', '--effort', 'high']);
  assert(getEvent(haikuEffortEvents, 'result')?.result?.trim() === 'HAIKU_EFFORT_OK', 'haiku + effort 조합 결과가 예상과 다릅니다.');
  results.push('haiku-effort: accepted');

  const opusEvents = await runClaudeStreamJson('Reply with exactly OK.', ['--model', 'opus']);
  assert(String(getEvent(opusEvents, 'system')?.model || '').includes('opus'), 'opus 모델 매핑이 예상과 다릅니다.');
  results.push(`model-opus: ${getEvent(opusEvents, 'system')?.model}`);

  const opusPlanEvents = await runClaudeStreamJson('Reply with exactly OK.', ['--model', 'opusplan']);
  assert(String(getEvent(opusPlanEvents, 'system')?.model || '').includes('sonnet'), 'opusplan 모델 매핑이 예상과 다릅니다.');
  results.push(`model-opusplan: ${getEvent(opusPlanEvents, 'system')?.model}`);

  const sonnet1mRun = await runClaudeAllowFailure('Reply with exactly OK.', ['--model', 'sonnet[1m]']);
  const sonnet1mSystem = getEvent(sonnet1mRun.events, 'system');
  const sonnet1mResult = getEvent(sonnet1mRun.events, 'result');
  assert(String(sonnet1mSystem?.model || '').includes('[1m]'), 'sonnet[1m] 모델 문자열이 init 이벤트에 반영되지 않았습니다.');
  assert(sonnet1mResult, 'sonnet[1m] 실행에서 result 이벤트가 없습니다.');
  results.push(`model-sonnet[1m]: ${sonnet1mSystem?.model} (code=${sonnet1mRun.code})`);

  const toolFlowCwd = createToolFlowWorkspace();
  const toolFlowEvents = await runClaudeStreamJson(
    'Read a.txt and b.txt, then reply with exactly "ALPHA,BETA".',
    ['--dangerously-skip-permissions'],
    { cwd: toolFlowCwd },
  );
  const toolFlowTypes = toolFlowEvents.map((event) => event.type);
  const assistantText = getAssistantText(toolFlowEvents);
  const toolFlowResult = getEvent(toolFlowEvents, 'result')?.result;
  assert(toolFlowTypes.indexOf('tool_result') === -1, 'tool_result는 user 이벤트 내부 블록으로만 와야 합니다.');
  assert(toolFlowEvents.filter((event) => event.type === 'assistant').some((event) =>
    event.message?.content?.some((block) => block.type === 'tool_use')), 'tool_use 이벤트가 없습니다.');
  assert(toolFlowEvents.filter((event) => event.type === 'user').length >= 2, 'tool_result user 이벤트가 충분하지 않습니다.');
  assert(assistantText === 'ALPHA,BETA', `assistant text 누적 결과가 예상과 다릅니다: ${assistantText}`);
  assert(toolFlowResult === assistantText, `result.result와 assistant text가 다릅니다: ${toolFlowResult} vs ${assistantText}`);
  results.push('tool-flow-order: ok');
  results.push('assistant-text-vs-result: ok');

  const firstSessionEvents = await runClaudeStreamJson('Remember this exact code: 314159. Reply exactly STORED.');
  const sessionId = getEvent(firstSessionEvents, 'result')?.session_id;
  assert(sessionId, 'session_id를 받지 못했습니다.');

  const resumedEvents = await runClaudeStreamJson(
    'What code did I ask you to remember? Reply digits only.',
    ['--resume', sessionId],
  );
  const resumedResult = getEvent(resumedEvents, 'result')?.result?.trim();
  assert(resumedResult === '314159', `--resume 결과가 예상과 다릅니다: ${resumedResult}`);
  results.push(`resume-session: ${resumedResult}`);

  const invalidResume = await runClaudeAllowFailure('Reply with exactly OK.', ['--resume', 'invalid-session-id']);
  const invalidResumeText = `${invalidResume.stderr}\n${invalidResume.stdout}`;
  assert(invalidResume.code !== 0, '잘못된 session ID 테스트가 성공으로 종료됐습니다.');
  assert(invalidResumeText.includes('valid UUID'), `잘못된 session ID 에러 메시지가 예상과 다릅니다: ${invalidResumeText}`);
  results.push('resume-invalid-session: ok');

  console.log(results.join('\n'));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
