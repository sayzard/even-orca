import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openSettings } from '../src/config.ts';
import { createApps } from '../src/http.ts';
import { OrcaError } from '../src/orca.ts';
import type { ClaudeStatus, OrcaHost } from '../src/orca.ts';
import { loadEven } from '../src/sessions.ts';
import { createSubmission } from '../src/submission.ts';

const session = '70eead21-fc20-4858-8fc7-15baee9ff551';
const shellSession = '6f0d2a8e-0c0b-4c55-9d43-7fb0a3f1e2c4';
const claudeTerminal = 'term_0352007b-76cb-4953-a2b3-cfb1bf7a7b9b';
const shellTerminal = 'term_a47fb333-d452-46dd-b0a0-6772fe5178e4';
const remoteTerminal = 'term_b72603b2-f972-49a7-9d5c-b8d23192ad9b';

async function listen() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

let parentUuid: string | null = null;
function record(type: 'user' | 'assistant', content: unknown, extra: object = {}) {
  // The SDK follows the uuid → parentUuid chain when it reads a transcript.
  const uuid = randomUUID();
  const line = JSON.stringify({
    type, sessionId: session, uuid, parentUuid, isSidechain: false, timestamp: new Date().toISOString(),
    message: { role: type, content }, ...extra,
  });
  parentUuid = uuid;
  return `${line}\n`;
}

test('Orca terminals: discovery, G2 prompt delivery, reply mirroring, and refusals', { timeout: 15_000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'even-orca-link-')));
  const project = join(directory, '.claude', 'projects', directory.replace(/[^a-zA-Z0-9-]/gu, '-'));
  const transcript = join(project, `${session}.jsonl`);
  await mkdir(project, { recursive: true });
  await writeFile(transcript, record('user', 'Orca에서 하던 이전 worktree 작업') + record('assistant', [{ type: 'text', text: '이전 답변' }]));
  const prior = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  // The Even package locates transcripts under the home directory.
  process.env.HOME = directory;
  process.env.CLAUDE_CONFIG_DIR = join(directory, '.claude');

  const state = {
    status: 'idle' as ClaudeStatus,
    incarnation: 'incarnation-1',
    sendError: undefined as OrcaError | undefined,
    sent: [] as string[],
  };
  const terminals = () => [
    { handle: claudeTerminal, incarnationId: state.incarnation, title: '테스트 세션', executionHostId: 'local', agentIdentity: 'claude', connected: true, writable: true },
    // A plain shell and a remote host must never become candidates.
    { handle: shellTerminal, incarnationId: 'shell', title: 'zsh', executionHostId: 'local', connected: true, writable: true },
    { handle: remoteTerminal, incarnationId: 'remote', title: 'remote', executionHostId: 'ssh:box', agentIdentity: 'claude', connected: true, writable: true },
  ];
  const host: OrcaHost = {
    async call(args) {
      if (args[0] === 'terminal' && args[1] === 'list') return { terminals: terminals() };
      if (args[0] === 'terminal' && args[1] === 'show') return { terminal: terminals().find(item => item.handle === args[3]) };
      if (args[0] === 'terminal' && args[1] === 'send') {
        if (state.sendError) throw state.sendError;
        assert.deepEqual([...args.slice(0, 4), ...args.slice(5)], ['terminal', 'send', '--terminal', claudeTerminal, '--enter', '--wait-submit', '8']);
        assert.ok(args[4].startsWith('--text='));
        state.sent.push(args[4].slice('--text='.length));
        state.status = 'busy';
        return { send: { accepted: true, prompt: { stages: ['input_accepted', 'turn_started'], processIncarnation: state.incarnation } } };
      }
      throw new Error(`unexpected orca call ${args.join(' ')}`);
    },
    processes: () => [
      { pid: 4242, sessionId: session, cwd: directory, status: state.status },
      { pid: 4343, sessionId: shellSession, cwd: directory, status: 'idle' },
    ],
    status: (pid, id) => pid === 4242 && id === session ? state.status : undefined,
    terminalOf: async pid => pid === 4242 ? claudeTerminal : pid === 4343 ? shellTerminal : undefined,
  };

  const even = await loadEven({ orcaHost: host, orcaFile: join(directory, 'orca.json'), orcaPollMs: 40 });
  const settings = openSettings(directory);
  const submission = createSubmission(even.sessions, settings.current, async (_configuration, _raw, context) => {
    assert.deepEqual(context.slice(0, 1), ['Orca에서 하던 이전 worktree 작업']);
    return [];
  });
  const mac = await listen();
  // The local app only answers requests addressed to 127.0.0.1:<its port>.
  const port = Number(new URL(mac.url).port);
  const { local, phone } = createApps({ even, submission, settings, token: 'phone-token', adminToken: 'admin', port, defaultProvider: 'claude' });
  mac.server.on('request', local);
  const phoneHttp = await listen();
  phoneHttp.server.on('request', phone);
  const auth = { Authorization: 'Bearer phone-token' };
  const settingsHeaders = { 'Content-Type': 'application/json', 'X-Even-Orca-Settings': '1' };
  t.after(async () => {
    even.stop();
    for (const { server } of [mac, phoneHttp]) { server.closeAllConnections(); server.close(); }
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });

  const found = await fetch(`${mac.url}/local/orca`).then(response => response.json()) as { terminals: { sessionId: string; title: string; attached: boolean; wrapped: boolean; status: string }[] };
  assert.deepEqual(found.terminals.map(item => [item.sessionId, item.title, item.attached, item.wrapped, item.status]), [[session, '테스트 세션', false, false, 'idle']]);
  assert.equal((await fetch(`${phoneHttp.url}/api/sessions`, { headers: auth }).then(response => response.json()) as { sessions: unknown[] }).sessions.length, 0);
  assert.equal((await fetch(`${mac.url}/local/orca/attach`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session }) })).status, 403);
  assert.equal((await fetch(`${mac.url}/local/orca/attach`, { method: 'POST', headers: settingsHeaders, body: JSON.stringify({ sessionId: shellSession }) })).status, 409);
  assert.equal((await fetch(`${mac.url}/local/orca/attach`, { method: 'POST', headers: settingsHeaders, body: JSON.stringify({ sessionId: session }) })).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'orca.json'), 'utf8')), { sessions: [session] });
  const catalog = await fetch(`${phoneHttp.url}/api/sessions`, { headers: auth }).then(response => response.json()) as { sessions: { id: string; title: string; status: string }[] };
  assert.deepEqual(catalog.sessions.map(item => [item.id, item.title, item.status]), [[session, '테스트 세션 · Orca', 'idle']]);

  const stream = await fetch(`${phoneHttp.url}/api/events?sessionId=${session}`, { headers: auth });
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let data = '';
  const until = async (pattern: RegExp) => {
    while (!pattern.test(data)) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      data += decoder.decode(chunk.value, { stream: true });
    }
  };
  const prompt = (text: string, key: string) => fetch(`${phoneHttp.url}/api/prompt`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ sessionId: session, provider: 'claude', text }),
  });
  try {
    // Orca refuses prompts while Claude Code shows a menu: held, not "unknown".
    state.sendError = new OrcaError('agent_prompt_blocked', 'agent is showing a menu');
    const blocked = await prompt('권한 메뉴가 떠 있을 때', 'blocked');
    assert.equal(blocked.status, 409);
    assert.equal(submission.activity()[0].status, 'held');
    state.sendError = undefined;

    assert.equal((await prompt('OK라고 답해', 'first')).status, 202);
    assert.deepEqual(state.sent, ['OK라고 답해']);
    await appendFile(transcript, record('user', 'OK라고 답해')
      + record('assistant', [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls', description: '목록 보기' } }])
      + record('user', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'a.ts' }], { toolUseResult: {} })
      + record('assistant', [{ type: 'text', text: 'OK' }]));
    await delay(120);
    state.status = 'idle';
    await until(/"state":"idle"/);
    assert.match(data, /"type":"user_prompt","text":"OK라고 답해"/);
    assert.match(data, /"type":"text_delta","text":"• OK"/);
    assert.match(data, /"type":"result","success":true,"text":"OK"/);
    assert.doesNotMatch(data, /이전 답변/);
    assert.doesNotMatch(data, /"type":"tool_(?:start|end)"/);
    for (let retry = 0; retry < 50 && submission.activity()[0].status !== 'submitted'; retry++) await delay(20);
    assert.equal(submission.activity()[0].status, 'submitted');

    // A turn typed directly in Orca is mirrored to the G2 as well.
    data = '';
    await appendFile(transcript, record('user', 'Orca에서 직접 입력') + record('assistant', [{ type: 'text', text: '직접 답변' }]));
    state.status = 'busy';
    await delay(120);
    state.status = 'idle';
    await until(/직접 답변[\s\S]*"state":"idle"/);
    assert.match(data, /"type":"user_prompt","text":"Orca에서 직접 입력"/);
    assert.match(data, /"type":"text_delta","text":"• 직접 답변"/);
    const history = await fetch(`${phoneHttp.url}/api/sessions/${session}/history?limit=10`, { headers: auth })
      .then(response => response.json()) as { history: { role: string; text: string }[] };
    assert.ok(history.history.some(row => row.role === 'assistant' && row.text === '• 직접 답변'));
    assert.ok(history.history.some(row => row.role === 'user' && row.text === 'Orca에서 직접 입력'));

    const interrupt = await fetch(`${phoneHttp.url}/api/interrupt`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session }),
    });
    assert.equal(interrupt.status, 409);

    // A restarted terminal process is a different target: never send into it.
    state.incarnation = 'incarnation-2';
    assert.equal((await prompt('다른 프로세스로 가면 안 됨', 'second')).status, 409);
    assert.deepEqual(state.sent, ['OK라고 답해']);
    assert.equal((await fetch(`${phoneHttp.url}/api/sessions`, { headers: auth }).then(response => response.json()) as { sessions: unknown[] }).sessions.length, 0);
  } finally { await reader.cancel(); }
});
