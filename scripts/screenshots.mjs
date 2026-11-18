// Regenerates the README screenshots from the real pages with demo data, so
// no personal paths or sessions appear: `npm run screenshots`.
// Requires Google Chrome; set CHROME to use another Chromium binary.
import express from 'express';
import QRCode from 'qrcode';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const session = '5f2c9a1e-7b44-4c1d-9e6a-0d3b8c2f41aa';
const other = '9a7e3c52-1f08-4b6d-a2c4-6e5d1b0f9c33';
const now = Date.now();

const settings = { model: 'gpt-6.2-sol', effort: 'low', showTools: false, terms: [
  { heard: 'work tree', preferred: 'worktree' }, { heard: 'use off', preferred: 'useAuth' },
] };
const activity = [
  { id: 'a2', provider: 'claude', sessionId: session, startedAt: new Date(now - 40_000).toISOString(), raw: 'check the work tree and run the off tests', corrected: 'check the worktree and run the auth tests', status: 'submitted', elapsed: 2310 },
  { id: 'a1', provider: 'claude', sessionId: session, startedAt: new Date(now - 300_000).toISOString(), raw: 'open use off in the login page', corrected: 'open useAuth in the login page', status: 'submitted', elapsed: 1980 },
];
const terminals = [
  { sessionId: session, handle: 'term_demo-1', incarnationId: 'demo', pid: 1, cwd: '/Users/me/projects/shop-api', title: 'Fix login flow', status: 'idle', attached: true, wrapped: false },
  { sessionId: other, handle: 'term_demo-2', incarnationId: 'demo', pid: 2, cwd: '/Users/me/projects/docs', title: 'Docs cleanup', status: 'busy', attached: false, wrapped: false },
];
let id = 0;
const feed = (lang) => {
  const text = lang === 'ko'
    ? ['worktree에서 auth 테스트를 실행해', '• worktree에서 auth 테스트를 실행합니다.', '• auth 테스트 24개가 모두 통과했습니다. 로그인할 때 세션 토큰이 만료되기 전에 갱신되고, 예전 재시도 루프는 제거했습니다.']
    : ['check the worktree and run the auth tests', '• Running the auth tests in the worktree.', '• All 24 auth tests pass. The login flow now refreshes the session token before it expires, and the old retry loop is gone.'];
  const messages = [
    { type: 'user_prompt', text: text[0] }, { type: 'status', state: 'busy' },
    { type: 'status', state: 'text_start' }, { type: 'text_delta', text: text[1] }, { type: 'status', state: 'text_end' },
    { type: 'status', state: 'text_start' }, { type: 'text_delta', text: text[2] }, { type: 'status', state: 'text_end' },
    { type: 'result', success: true, text: text[2] }, { type: 'status', state: 'idle' },
  ].map(message => ({ id: ++id, ...message }));
  return { sessionId: session, state: 'idle', sessions: [{ id: session, label: terminals[0].title, provider: 'claude' }], messages };
};

const app = express();
app.use('/assets', express.static(join(root, 'public')));
app.get('/settings', (_req, res) => res.sendFile(join(root, 'public', 'settings.html')));
app.get('/preview', (_req, res) => res.sendFile(join(root, 'public', 'preview.html')));
app.get('/local/settings', (_req, res) => res.json(settings));
app.get('/local/openai-key', (_req, res) => res.json({ configured: true }));
app.get('/local/activity', (_req, res) => res.json({ activity, targets: [{ id: session, provider: 'claude', cwd: terminals[0].cwd }], pairingAvailable: true }));
app.get('/local/orca', (_req, res) => res.json({ terminals }));
app.get('/local/pairing.svg', async (_req, res) => res.type('svg').send(await QRCode.toString('http://192.168.1.20:3466?token=demo&defaultProvider=claude&name=Even%20Orca', { type: 'svg', margin: 4 })));
app.get('/local/preview-feed', (req, res) => {
  // preview.js does not forward ?lang to the feed; read it from the page URL.
  const lang = new URL(req.get('referer') ?? 'http://localhost/').searchParams.get('lang');
  res.json(Number(req.query.after) > 0 ? { ...feed(lang), messages: [] } : feed(lang));
});

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const out = join(root, 'docs', 'images');
mkdirSync(out, { recursive: true });

function capture(path, file, width, height) {
  // A fresh profile per shot: first-visit state (QR open) and no saved language.
  const profile = mkdtempSync(join(tmpdir(), 'even-orca-shot-'));
  return new Promise((resolve, reject) => execFile(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, '--virtual-time-budget=5000', `--screenshot=${join(out, file)}`, `${base}${path}`,
  ], error => { rmSync(profile, { recursive: true, force: true }); return error ? reject(error) : resolve(); }));
}

try {
  for (const lang of ['en', 'ko']) {
    const suffix = lang === 'en' ? '' : '-ko';
    await capture(`/settings?lang=${lang}`, `settings${suffix}.png`, 980, 1700);
    await capture(`/preview?lang=${lang}`, `preview${suffix}.png`, 980, 672);
  }
  console.log(`Saved screenshots to ${out}`);
} finally { server.close(); }
