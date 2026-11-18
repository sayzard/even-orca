import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSettings } from '../src/config.ts';
import { createOpenAIEditor } from '../src/correction.ts';
import { createApps } from '../src/http.ts';
import { openApiKey, writeEnvKey } from '../src/secrets.ts';
import type { KeyCheck } from '../src/secrets.ts';
import { loadEven } from '../src/sessions.ts';
import type { Sessions, Target } from '../src/sessions.ts';
import { createSubmission } from '../src/submission.ts';

const key = `sk-proj-${'a1B2'.repeat(10)}`;
const other = `sk-${'Zz9_'.repeat(8)}`;

test('writes the key into .env, keeps other lines, and restricts the file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'even-orca-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, '.env');
  await writeFile(file, `# comment\nEVEN_ORCA_PORT=3466\nEVEN_ORCA_OPENAI_API_KEY=${other}\nOPENAI_API_KEY=untouched\nexport EVEN_ORCA_OPENAI_API_KEY=duplicate\n`);
  writeEnvKey(file, key);
  assert.equal(await readFile(file, 'utf8'), `# comment\nEVEN_ORCA_PORT=3466\nEVEN_ORCA_OPENAI_API_KEY=${key}\nOPENAI_API_KEY=untouched\n`);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const fresh = join(directory, 'new.env');
  writeEnvKey(fresh, key);
  assert.equal(await readFile(fresh, 'utf8'), `EVEN_ORCA_OPENAI_API_KEY=${key}\n`);
});

test('accepts only well-formed keys that OpenAI does not reject', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'even-orca-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, '.env');
  let check: KeyCheck = 'invalid';
  const apiKey = openApiKey({ envFile, verify: async () => check });
  assert.deepEqual(apiKey.status(), { configured: false });
  await assert.rejects(apiKey.set('not-a-key'), /sk-로 시작/);
  await assert.rejects(apiKey.set(key), /거부/);
  await assert.rejects(readFile(envFile), { code: 'ENOENT' });
  check = 'unknown';
  assert.equal(await apiKey.set(` ${key} `), 'unknown');
  assert.equal(apiKey.current(), key);
  assert.deepEqual(apiKey.status(), { configured: true });
  assert.match(await readFile(envFile, 'utf8'), new RegExp(`EVEN_ORCA_OPENAI_API_KEY=${key}`));
  assert.equal(openApiKey({ env: ` ${other} `, envFile }).current(), other);
});

test('settings can set the key but never read it back, and prompts wait for a key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'even-orca-key-http-'));
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  const envFile = join(directory, '.env');
  const apiKey = openApiKey({ envFile, verify: async () => 'valid' });
  const target: Target = { id: '244efa00-3aac-4a43-9289-e505e7f385c5', provider: 'claude', cwd: directory, identity: {} };
  const sent: string[] = [];
  const sessions: Sessions = {
    target: (_provider, id) => id === target.id ? target : undefined,
    list: () => [target],
    status: async () => 'idle',
    history: async () => [],
    context: async () => [],
    async send(_session, text) { sent.push(text); return { sessionId: target.id, provider: 'claude' }; },
    messages: () => [],
  };
  const settings = openSettings(directory);
  // The real editor: with no key it must fail before any request is made.
  const submission = createSubmission(sessions, settings.current, createOpenAIEditor(apiKey.current, 'http://127.0.0.1:9/v1'));
  const even = await loadEven({ orcaFile: join(directory, 'orca.json') });
  t.after(() => even.stop());
  const { local } = createApps({ even, submission, settings, apiKey, token: 'phone-token', adminToken: 'admin', port, defaultProvider: 'claude' });
  server.on('request', local);

  await assert.rejects(submission.submit('claude', target.id, '테스트해'), /OpenAI API 키가 없습니다/);
  assert.equal(submission.activity()[0].status, 'held');
  assert.deepEqual(sent, []);

  assert.deepEqual(await fetch(`${url}/local/openai-key`).then(response => response.json()), { configured: false });
  const save = (headers: Record<string, string>) => fetch(`${url}/local/openai-key`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ key }),
  });
  assert.equal((await save({})).status, 403);
  const saved = await save({ 'X-Even-Orca-Settings': '1' });
  assert.equal(saved.status, 200);
  const body = await saved.text();
  assert.deepEqual(JSON.parse(body), { configured: true, verified: true });
  assert.equal(body.includes(key), false);
  assert.equal((await fetch(`${url}/local/openai-key`).then(response => response.text())).includes(key), false);
  assert.equal(apiKey.current(), key);
  const rejected = await fetch(`${url}/local/openai-key`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Even-Orca-Settings': '1' }, body: JSON.stringify({ key: 'oops' }),
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json() as { error: string }).error, /sk-로 시작/);
});
