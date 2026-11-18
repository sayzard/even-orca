import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultSettings, openSettings, parseSettings } from '../src/config.ts';
import { correct, createOpenAIEditor, validPrompt } from '../src/correction.ts';
import { createApps } from '../src/http.ts';
import { loadEven } from '../src/sessions.ts';
import type { Sessions, Target } from '../src/sessions.ts';
import { createSubmission } from '../src/submission.ts';

const a = '244efa00-3aac-4a43-9289-e505e7f385c5';
const b = '041149fc-6c2f-4df9-b994-6637a4d9e85e';
const c = 'f691ad37-3bbb-4b0a-a690-300bdcc3ad2f';

async function listen() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

function sessionFixture() {
  const first: Target = { id: a, provider: 'claude', cwd: '/first', identity: {} };
  const second: Target = { id: b, provider: 'codex', cwd: '/second', identity: {} };
  const delivered: Array<{ id: string; text: string }> = [];
  const state = { phase: 'idle', failSend: false, first };
  const sessions: Sessions = {
    target: (provider, id) => [state.first, second].find(session => session.provider === provider && session.id === id),
    list: provider => [state.first, second].filter(session => session.provider === provider),
    status: async session => session.id === a ? state.phase : 'idle',
    history: async () => [],
    context: async session => [session.id === a ? 'Orca worktree에서 auth.ts를 고쳐' : 'Even app의 Bluetooth'],
    async send(session, text) {
      delivered.push({ id: session.id, text });
      if (state.failSend) throw new Error('connection lost after write');
      return { sessionId: session.id, provider: session.provider };
    },
    messages: (id, after) => delivered.flatMap((item, index) => item.id === id && index + 1 > after
      ? [{ id: index + 1, type: 'user_prompt', text: item.text }] : []),
  };
  return { sessions, delivered, state };
}

test('dictionary, context, and explicit self-correction preserve coding literals', async () => {
  const settings = parseSettings({ ...defaultSettings, terms: [{ heard: '워크 트리', preferred: 'worktree' }] });
  const result = await correct(async (configuration, transcript, history) => {
    assert.equal(configuration.model, 'gpt-6.2-sol');
    assert.match(transcript, /^음, worktree를/);
    assert.deepEqual(history, ['src/auth.ts 쪽 코드를 봐 줘']);
    return [
      { from: '음, ', to: '' },
      { from: '오스 티에스', to: 'src/auth.ts' },
      { from: '3개 변경해, 아니, 2개 변경해', to: '2개 변경해' },
      { from: '배포하지 마', to: '배포해' },
      { from: '--dry-run', to: '--force' },
      { from: 'worktree', to: 'branch' },
    ];
  }, settings, '음, 워크 트리를 확인하고 오스 티에스에서 3개 변경해, 아니, 2개 변경해. --dry-run으로 하고 배포하지 마.', ['src/auth.ts 쪽 코드를 봐 줘']);
  assert.equal(result, 'worktree를 확인하고 src/auth.ts에서 2개 변경해. --dry-run으로 하고 배포하지 마.');
});

test('tool events stay off the G2 stream unless enabled, including for older settings files', () => {
  const { showTools: _omitted, ...older } = defaultSettings;
  assert.equal(parseSettings(older).showTools, false);
  assert.equal(parseSettings({ ...defaultSettings, showTools: true }).showTools, true);
  assert.throws(() => parseSettings({ ...defaultSettings, showTools: 'yes' }), /도구 실행 표시/);
});

test('keeps accurate and ambiguous text, including literals and protected prefixes', async () => {
  const raw = '`fooBar`를 3회 호출해. 설정 설정을 확인해.';
  const result = await correct(async () => [
    { from: '설정', to: 'config' }, { from: '3회', to: '4회' },
    { from: '`fooBar`', to: '`fooBaz`' }, { from: '호출해', to: '--force로 호출해' },
    { from: '확인해', to: '확인해\x1b[201~' },
  ], defaultSettings, raw, []);
  assert.equal(result, raw);
  assert.equal(validPrompt(' /exit'), false);
  assert.equal(validPrompt('/Users/me/project/src/app.ts를 확인해'), true);
  assert.equal(validPrompt('!ls'), false);
  assert.equal(validPrompt('\u001b hi'), false);
});

test('restores a unique context path and removes an explicitly abandoned prefix', async () => {
  const raw = '배포하지 마. 테스트 3개 지워, 아니, 테스트 2개 추가해. 오스 티에스를 확인해.';
  const result = await correct(async () => [
    { from: '배포하지 마. 테스트 3개 지워, 아니, ', to: '' },
    { from: '테스트 3개 지워, 아니, ', to: '' },
    { from: '오스 티에스', to: 'auth.ts' },
  ], defaultSettings, raw, ['이번 파일은 src/auth.ts야.']);
  assert.equal(result, '배포하지 마. 테스트 2개 추가해. src/auth.ts를 확인해.');
});

test('single submission per request, isolated history, and no fallback on failure', async () => {
  const { sessions, delivered, state } = sessionFixture();
  const history: string[][] = [];
  const submission = createSubmission(sessions, () => defaultSettings, async (_settings, text, recent) => {
    history.push(recent);
    await delay(20);
    if (text.includes('보정 실패')) throw new Error('mock api timeout');
    return [];
  });
  const [first, duplicate] = await Promise.all([
    submission.submit('claude', a, '테스트 추가해', 'a'),
    submission.submit('claude', a, '테스트 추가해', 'b'),
  ]);
  assert.deepEqual(first, duplicate);
  assert.deepEqual(await submission.submit('claude', a, '테스트 추가해', 'b'), first);
  await submission.submit('codex', b, '테스트 추가해', 'a');
  assert.deepEqual(history, [['Orca worktree에서 auth.ts를 고쳐'], ['Even app의 Bluetooth']]);
  assert.deepEqual(delivered.map(item => item.id), [a, b]);
  assert.equal(submission.activity()[0].status, 'submitted');
  state.phase = 'awaiting';
  await assert.rejects(submission.submit('claude', a, '승인 시도해'), { status: 409 });
  state.phase = 'idle';
  await assert.rejects(submission.submit('claude', a, '보정 실패'), { status: 503 });
  assert.equal(delivered.length, 2);
});

test('never submits into a replaced session after correction', async () => {
  const { sessions, delivered, state } = sessionFixture();
  const guarded: Sessions = { ...sessions, status: async session => sessions.target(session.provider, session.id)?.identity === session.identity ? 'idle' : 'disconnected' };
  const submission = createSubmission(guarded, () => defaultSettings, async () => {
    state.first = { ...state.first, identity: {} };
    return [];
  });
  await assert.rejects(submission.submit('claude', a, '테스트 추가해'), { status: 409 });
  assert.equal(delivered.length, 0);
});

test('does not resend when transport fails after a write', async () => {
  const { sessions, delivered, state } = sessionFixture();
  state.failSend = true;
  const submission = createSubmission(sessions, () => defaultSettings, async () => []);
  await assert.rejects(submission.submit('claude', a, '테스트 추가해'), { status: 502 });
  assert.equal(submission.activity()[0].status, 'unknown');
  await assert.rejects(submission.submit('claude', a, '재시도해'), { status: 409 });
  assert.equal(delivered.length, 1);
});

test('OpenAI Responses request carries editable settings and bounded text', async t => {
  const { server, url } = await listen();
  t.after(() => server.close());
  let captured: { model: string; reasoning: { effort: string }; text: { format: { type: string } }; store: boolean; input: string } | undefined;
  server.on('request', async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.url, '/v1/responses');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"edits":[]}' }] }],
    }));
  });
  const result = await correct(createOpenAIEditor('test-key', `${url}/v1`), { ...defaultSettings, model: 'gpt-6-luna', effort: 'none' }, '시작해', Array(10).fill('맥락'.repeat(1000)));
  assert.equal(result, '시작해');
  assert.ok(captured);
  assert.equal(captured.model, 'gpt-6-luna');
  assert.equal(captured.reasoning.effort, 'none');
  assert.equal(captured.text.format.type, 'json_schema');
  assert.equal(captured.store, false);
  const input = JSON.parse(captured.input) as { transcript: string; recentUserPrompts: string[] };
  assert.equal(input.transcript, '시작해');
  assert.equal(input.recentUserPrompts.join('').length, 2200);
});

test('Even protocol binds a real Claude wrapper transport and streams its reply', { timeout: 5500 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'even-orca-test-')));
  const claudeConfig = join(directory, 'claude');
  const project = join(claudeConfig, 'projects', directory.replace(/[^a-zA-Z0-9-]/gu, '-'));
  await mkdir(project, { recursive: true });
  const priorConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const meta = { sessionId: a, cwd: directory, isSidechain: false, timestamp: new Date().toISOString() };
  await writeFile(join(project, `${a}.jsonl`), [
    { ...meta, type: 'user', uuid: b, parentUuid: null, message: { role: 'user', content: '직접 입력한 이전 worktree 작업' } },
    { ...meta, type: 'assistant', uuid: c, parentUuid: b, message: { role: 'assistant', content: [{ type: 'text', text: '에이전트 답변' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const { server, port, url } = await listen();
  const even = await loadEven();
  const settings = openSettings(directory);
  const token = 'test-phone-token';
  const auth = { Authorization: `Bearer ${token}` };
  const submission = createSubmission(even.sessions, settings.current, async (_configuration, _raw, context) => {
    assert.deepEqual(context, ['직접 입력한 이전 worktree 작업']);
    return [];
  });
  const { local, phone } = createApps({
    even, submission, settings, token, adminToken: 'admin', port, defaultProvider: 'claude',
    pairingUrl: 'http://192.168.1.42:3466?token=test-phone-token&defaultProvider=claude',
  });
  even.attachClaude(server);
  server.on('request', local);
  const phoneHttp = await listen();
  phoneHttp.server.on('request', phone);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/claude-sync/ws`);
  const input: string[] = [];
  ws.addEventListener('message', event => {
    const data = JSON.parse(String(event.data));
    if (data.type === 'stdin') input.push(data.text);
  });
  t.after(async () => {
    ws.close();
    server.closeAllConnections();
    server.close();
    phoneHttp.server.closeAllConnections();
    phoneHttp.server.close();
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorConfig;
    await rm(directory, { recursive: true, force: true });
  });
  await once(ws, 'open');
  const hello = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'hello', wrapperId: 'test-wrapper', cwd: directory }));
  await hello;
  const hook = async (event: string, payload = {}) => fetch(`${url}/api/claude-sync/hook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, wrapperId: 'test-wrapper', payload: { session_id: a, ...payload } }),
  });
  assert.equal((await hook('SessionStart')).status, 204);
  assert.equal((await fetch(`${phoneHttp.url}/settings`)).status, 404);
  assert.equal((await fetch(`${phoneHttp.url}/api/sessions`)).status, 401);
  assert.equal((await fetch(`${url}/settings`)).status, 200);
  const root = await fetch(`${url}/`, { redirect: 'manual' });
  assert.deepEqual([root.status, root.headers.get('location')], [302, '/settings']);
  assert.equal((await fetch(`${phoneHttp.url}/`, { redirect: 'manual' })).status, 404);
  assert.match(await fetch(`${url}/local/pairing.svg`).then(response => response.text()), /<svg/);
  assert.equal((await fetch(`${phoneHttp.url}/local/pairing.svg`)).status, 404);
  const changed = await fetch(`${url}/local/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Even-Orca-Settings': '1' },
    body: JSON.stringify({ ...defaultSettings, terms: [{ preferred: 'worktree', heard: '워크 트리' }] }),
  });
  assert.equal(changed.status, 200);
  assert.equal(openSettings(directory).current().terms[0].preferred, 'worktree');
  const catalog = await fetch(`${phoneHttp.url}/api/sessions`, { headers: auth }).then(res => res.json()) as { sessions: { id: string }[] };
  assert.deepEqual(catalog.sessions.map(session => session.id), [a]);
  const stream = await fetch(`${phoneHttp.url}/api/events?sessionId=${a}`, { headers: auth });
  const reader = stream.body!.getReader();
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /:ok/);
    const prompt = async () => fetch(`${phoneHttp.url}/api/prompt`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': 'one' },
      body: JSON.stringify({ sessionId: a, provider: 'claude', text: '워크 트리를 확인해' }),
    });
    assert.deepEqual((await Promise.all([prompt(), prompt()])).map(response => response.status), [202, 202]);
    for (let retry = 0; retry < 25 && input.length < 2; retry++) await delay(20);
    assert.deepEqual(input, ['\x1b[200~worktree를 확인해\x1b[201~', '\r']);
    assert.equal((await hook('UserPromptSubmit', { prompt: 'worktree를 확인해' })).status, 204);
    even.emit(a, { type: 'tool_start', name: 'Bash', toolId: 'tool-1' });
    even.emit(a, { type: 'tool_end', name: 'Bash', toolId: 'tool-1', summary: 'Bash ls' });
    assert.equal((await hook('Stop', { last_assistant_message: 'worktree 확인 완료' })).status, 204);
    const decoder = new TextDecoder();
    let data = '';
    while (!data.includes('worktree 확인 완료') || !data.includes('"state":"idle"')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      data += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(data, /worktree를 확인해/);
    assert.match(data, /"state":"idle"/);
    assert.doesNotMatch(data, /"type":"tool_(?:start|end)"/);
    assert.match(data, /"type":"text_delta","text":"• worktree 확인 완료"/);
    assert.match(data, /"type":"result","success":true,"text":"worktree 확인 완료"/);
    const types = async () => (await fetch(`${phoneHttp.url}/api/messages?sessionId=${a}&provider=claude`, { headers: auth })
      .then(response => response.json()) as { messages: { type: string }[] }).messages.map(message => message.type);
    assert.equal((await types()).some(type => type.startsWith('tool_')), false);
    settings.update({ ...settings.current(), showTools: true });
    assert.deepEqual((await types()).filter(type => type.startsWith('tool_')), ['tool_start', 'tool_end']);
  } finally { await reader.cancel(); }
});
