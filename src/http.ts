import express from 'express';
import QRCode from 'qrcode';
import { timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import { agentName, validId } from './sessions.ts';
import { RequestError } from './submission.ts';
import type { Provider } from './config.ts';
import type { openSettings } from './config.ts';
import type { createSubmission } from './submission.ts';
import type { loadEven } from './sessions.ts';
import type { ApiKey } from './secrets.ts';

const publicPath = fileURLToPath(new URL('../public/', import.meta.url));
const remoteRoutes = new Set(['GET /info', 'GET /update-check', 'POST /permission-response', 'POST /question-response', 'POST /interrupt']);
const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error instanceof RequestError ? error.status : error?.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
  res.status(status).json({ error: error instanceof RequestError ? error.message : '요청을 처리하지 못했습니다.' });
};

const toolEvents = new Set(['tool_start', 'tool_end']);
const sseEvent = /^id: (\d+)\ndata: (\{.*\})\n\n$/su;
// Marks where each agent paragraph starts on the G2, like Claude Code's ⏺.
// ⏺ (U+23FA) is missing from the G2 firmware fonts, and ● renders at full CJK
// width (20px); • is in the Latin font at 9px.
export const replyMarker = '• ';

interface StreamMessage { type?: unknown; state?: unknown; text?: unknown }

/**
 * Per-stream rewrite of messages bound for the phone: drops hidden types and
 * marks the first text chunk of each agent paragraph. A paragraph starts at a
 * `status: text_start`, so providers that stream many chunks per paragraph
 * get one marker.
 */
function phoneView(hidden: () => Set<string> | undefined) {
  let paragraph = false;
  return <T extends StreamMessage>(message: T): T | undefined => {
    if (message.type === 'status' && message.state === 'text_start') paragraph = true;
    if (typeof message.type === 'string' && hidden()?.has(message.type)) return undefined;
    if (message.type === 'text_delta' && typeof message.text === 'string' && paragraph) {
      paragraph = false;
      return { ...message, text: replyMarker + message.text.replace(/^\s+/u, '') };
    }
    return message;
  };
}

// The pinned Even events router writes each SSE event (live and replayed) as
// one `id: N\ndata: {json}\n\n` chunk, so whole events can be rewritten here.
function rewriteEvents(res: Response, view: ReturnType<typeof phoneView>) {
  const write = res.write.bind(res) as (chunk: unknown, ...rest: unknown[]) => boolean;
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    const event = typeof chunk === 'string' ? sseEvent.exec(chunk) : null;
    if (!event) return write(chunk, ...rest);
    let message: StreamMessage;
    try { message = JSON.parse(event[2]) as StreamMessage; } catch { return write(chunk, ...rest); }
    const shown = view(message);
    if (!shown) {
      const done = rest.find(item => typeof item === 'function') as (() => void) | undefined;
      done?.();
      return true;
    }
    return write(shown === message ? chunk : `id: ${event[1]}\ndata: ${JSON.stringify(shown)}\n\n`, ...rest);
  }) as typeof res.write;
}

function tokenMatches(value: unknown, expected: string) {
  if (typeof value !== 'string') return false;
  const supplied = Buffer.from(value);
  const secret = Buffer.from(expected);
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}

function bearer(req: Request) {
  return req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
}

export function createApps(options: {
  even: Awaited<ReturnType<typeof loadEven>>;
  submission: ReturnType<typeof createSubmission>;
  settings: ReturnType<typeof openSettings>;
  /** Write-only OpenAI key in .env; omitted in tests that do not need it. */
  apiKey?: ApiKey;
  token: string;
  adminToken: string;
  port: number;
  defaultProvider: Provider;
  pairingUrl?: string;
}) {
  const { even, submission, settings, token, adminToken, port, defaultProvider } = options;
  const { sessions } = even;
  const hiddenEvents = () => settings.current().showTools ? undefined : toolEvents;
  const api = express.Router();
  const local = express();
  const phone = express();
  for (const app of [phone, local]) app.disable('x-powered-by');

  const auth: RequestHandler = (req, res, next) => {
    if (!tokenMatches(bearer(req) ?? req.query.token, token)) {
      res.status(401).json({ error: { code: 'auth_failed', message: 'Unauthorized' } });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
  api.use(auth, express.json({ limit: '24kb' }));

  function providerFrom(value: unknown) {
    const provider = value === undefined ? defaultProvider : agentName(value);
    if (!provider) throw new RequestError(400, '지원하지 않는 에이전트입니다.');
    return provider;
  }

  function providerForSession(value: unknown, id: unknown) {
    if (value !== undefined || !validId(id)) return providerFrom(value);
    if (sessions.target(defaultProvider, id)) return defaultProvider;
    const alternate = defaultProvider === 'codex' ? 'claude' : 'codex';
    return sessions.target(alternate, id)?.provider ?? defaultProvider;
  }

  function active(id: unknown, provider: Provider) {
    if (!validId(id)) throw new RequestError(400, 'Even 앱에서 연결된 Orca 세션을 선택하세요.');
    const destination = sessions.target(provider, id);
    if (!destination) throw new RequestError(409, '선택한 Orca 세션이 연결되어 있지 않습니다.');
    return destination;
  }

  api.get('/sessions', async (req, res) => {
    const provider = providerFrom(req.query.provider);
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : undefined;
    const rows = await Promise.all(sessions.list(provider, cwd).slice(0, 40).map(async session => ({
      id: session.id,
      cwd: session.cwd,
      provider,
      title: session.label
        ? `${session.label} · Orca`
        : `${basename(session.cwd)} · ${provider === 'claude' ? 'Claude Code' : 'Codex'} · ${session.id.slice(-8)}`,
      timestamp: new Date().toISOString(),
      status: await sessions.status(session).catch(() => 'disconnected'),
    })));
    res.json({ sessions: rows.filter(session => session.status !== 'disconnected') });
  });

  api.post('/prompt', async (req, res) => {
    const { sessionId, provider, text, requestId } = req.body ?? {};
    if (!validId(sessionId)) throw new RequestError(400, 'Even 앱에서 연결된 Orca 세션을 선택하세요.');
    const key = req.get('Idempotency-Key') ?? requestId;
    if (key !== undefined && (typeof key !== 'string' || !/^[\w.-]{1,128}$/u.test(key))) {
      throw new RequestError(400, '요청 ID 형식이 잘못되었습니다.');
    }
    const selected = providerForSession(provider, sessionId);
    const result = await submission.submit(selected, sessionId, text, key);
    res.status(202).json(result);
  });

  api.get('/sessions/:id/history', async (req, res) => {
    const destination = active(req.params.id, providerForSession(req.query.provider, req.params.id));
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 10, 10));
    const history = (await sessions.history(destination, limit)).map(row => row.role === 'assistant' && row.text.trim()
      ? { ...row, text: replyMarker + row.text.replace(/^\s+/u, '') } : row);
    res.json({ history });
  });
  api.get('/status', async (req, res) => {
    const destination = active(req.query.sessionId, providerForSession(req.query.provider, req.query.sessionId));
    res.json({ state: await sessions.status(destination), sessionId: destination.id, provider: destination.provider });
  });
  api.get('/messages', async (req, res) => {
    const destination = active(req.query.sessionId, providerForSession(req.query.provider, req.query.sessionId));
    const after = Math.max(0, Number(req.query.after) || 0);
    const view = phoneView(hiddenEvents);
    const messages = sessions.messages(destination.id, after).flatMap(message => view(message) ?? []);
    res.json({ messages, state: await sessions.status(destination), sessionId: destination.id, provider: destination.provider });
  });
  api.get('/events', (req, res, next) => {
    // Flutter builds may omit provider on SSE. Resolve the exact UUID against
    // the linked targets rather than guessing the current/default agent.
    const id = req.query.sessionId;
    const requested = req.query.provider;
    if (!validId(id)) throw new RequestError(400, '세션 ID가 필요합니다.');
    if (requested !== undefined) active(id, providerFrom(requested));
    else if (!sessions.target('claude', id) && !sessions.target('codex', id)) {
      throw new RequestError(409, '선택한 Orca 세션이 연결되어 있지 않습니다.');
    }
    rewriteEvents(res, phoneView(hiddenEvents));
    even.events(req, res, next);
  });
  api.use((req, res, next) => {
    const route = `${req.method} ${req.path}`;
    if (!remoteRoutes.has(route)) return next();
    if (req.method === 'POST') {
      const destination = active(req.body?.sessionId, providerForSession(req.body?.provider, req.body?.sessionId));
      // Without the wrapper's hooks these would reach the SDK provider, which
      // does not own the session. Orca shows the native prompt instead.
      if (destination.via === 'orca') throw new RequestError(409, '이 세션의 권한, 선택, 중단은 Orca 터미널에서 직접 처리하세요.');
      req.body.provider = destination.provider;
    }
    even.core(req, res, next);
  });
  phone.use('/api', api);
  phone.use(errorHandler);

  local.use((req, res, next) => {
    if (req.get('host') !== `127.0.0.1:${port}` && req.get('host') !== `localhost:${port}`) {
      return res.status(403).end();
    }
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  });
  local.post('/api/claude-sync/hook', express.json({ limit: '2mb' }), even.onHook);
  local.use('/api', api);
  local.get('/', (_req, res) => res.redirect('/settings'));
  local.get('/settings', (_req, res) => res.sendFile('settings.html', { root: publicPath }));
  local.get('/local/pairing.svg', async (_req, res) => {
    if (!options.pairingUrl) return res.sendStatus(404);
    const qr = await QRCode.toString(options.pairingUrl, { type: 'svg', margin: 4 });
    return res.type('svg').send(qr);
  });
  local.use('/assets', express.static(publicPath, { index: false, redirect: false }));
  local.get('/local/settings', (_req, res) => res.json(settings.current()));
  // Write-only: the page learns whether a key is set, never the key.
  local.get('/local/openai-key', (_req, res) => res.json(options.apiKey?.status() ?? { configured: false }));
  local.put('/local/openai-key', express.json({ limit: '2kb' }), async (req, res) => {
    if (req.get('X-Even-Orca-Settings') !== '1') return res.sendStatus(403);
    if (!options.apiKey) return res.sendStatus(404);
    try {
      const check = await options.apiKey.set(req.body?.key);
      return res.json({ ...options.apiKey.status(), verified: check === 'valid' });
    } catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '키를 저장하지 못했습니다.'); }
  });
  local.put('/local/settings', express.json({ limit: '160kb' }), (req, res) => {
    if (req.get('X-Even-Orca-Settings') !== '1') return res.sendStatus(403);
    try { return res.json(settings.update(req.body)); }
    catch (error) { throw new RequestError(400, error instanceof Error ? error.message : '잘못된 설정입니다.'); }
  });
  const orcaChange = (action: (sessionId: string) => Promise<unknown> | unknown): RequestHandler => async (req, res) => {
    if (req.get('X-Even-Orca-Settings') !== '1') return res.sendStatus(403);
    const sessionId = req.body?.sessionId;
    if (!validId(sessionId)) throw new RequestError(400, '세션 ID가 필요합니다.');
    try { await action(sessionId); }
    catch (error) { throw new RequestError(409, error instanceof Error ? error.message : 'Orca 세션을 연결하지 못했습니다.'); }
    return res.json({ ok: true });
  };
  local.get('/local/orca', async (_req, res) => {
    try { res.json({ terminals: await even.orca.discover() }); }
    catch (error) { res.json({ terminals: [], error: error instanceof Error ? error.message : 'Orca에 연결하지 못했습니다.' }); }
  });
  local.post('/local/orca/attach', express.json({ limit: '2kb' }), orcaChange(id => even.orca.attach(id)));
  local.post('/local/orca/detach', express.json({ limit: '2kb' }), orcaChange(id => even.orca.detach(id)));
  // Mac-only G2 preview: the exact messages the phone receives, for a page
  // that approximates the glasses display (the real one cannot be captured).
  local.get('/preview', (_req, res) => res.sendFile('preview.html', { root: publicPath }));
  local.get('/local/preview-feed', async (req, res) => {
    const targets = [...sessions.list('claude'), ...sessions.list('codex')];
    const target = targets.find(item => item.id === req.query.sessionId) ?? targets[0];
    if (!target) return res.json({ sessions: [], messages: [] });
    const after = Math.max(0, Number(req.query.after) || 0);
    // The paragraph marker depends on earlier messages, so rewrite from the start.
    const view = phoneView(hiddenEvents);
    const messages = sessions.messages(target.id, 0).flatMap(message => view(message) ?? []).filter(message => message.id > after);
    return res.json({
      sessionId: target.id,
      state: await sessions.status(target).catch(() => 'disconnected'),
      sessions: targets.map(item => ({ id: item.id, label: item.label ?? basename(item.cwd), provider: item.provider })),
      messages,
    });
  });
  local.get('/local/activity', (_req, res) => res.json({
    activity: submission.activity(),
    targets: [...sessions.list('claude'), ...sessions.list('codex')].map(({ id, provider, cwd }) => ({ id, provider, cwd })),
    pairingAvailable: Boolean(options.pairingUrl),
  }));
  const admin = express.Router();
  admin.use((req, res, next) => {
    if (!tokenMatches(bearer(req), adminToken)) return res.sendStatus(401);
    next();
  }, express.json({ limit: '8kb' }));
  admin.post('/codex/:action', async (req, res) => {
    const { cwd, pid, id } = req.body ?? {};
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || !Number.isSafeInteger(pid) || pid <= 1 || (id !== undefined && !validId(id))) {
      throw new RequestError(400, '유효한 로컬 Codex 세션을 지정하세요.');
    }
    try {
      if (req.params.action === 'prepare') return res.json({ id: await even.enrollCodex(cwd, pid, id) });
      if (id && req.params.action === 'heartbeat') {
        even.heartbeatCodex(id, pid, cwd);
        return res.json({ ok: true });
      }
      if (id && req.params.action === 'release') {
        even.releaseCodex(id, pid);
        return res.json({ ok: true });
      }
    } catch (error) {
      throw new RequestError(409, error instanceof Error ? error.message : 'Codex 세션을 연결하지 못했습니다.');
    }
    return res.sendStatus(404);
  });
  local.use('/admin', admin);
  local.use(errorHandler);
  return { local, phone };
}
