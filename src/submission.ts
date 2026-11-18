import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Provider, Settings } from './config.ts';
import { correct, validPrompt } from './correction.ts';
import type { SuggestEdits } from './correction.ts';
import type { Sessions, Target } from './sessions.ts';
import { NotDelivered } from './orca.ts';

export class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Activity {
  id: string;
  provider: Provider;
  sessionId: string;
  startedAt: string;
  raw: string;
  corrected?: string;
  status: 'correcting' | 'accepted' | 'submitted' | 'held' | 'unknown';
  detail?: string;
  elapsed?: number;
}

interface Receipt { ok: true; sessionId: string; provider: string }
interface Repeated {
  digest: string;
  receipt: Promise<Receipt>;
  expires: number;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out')), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

export function createSubmission(sessions: Sessions, getSettings: () => Settings, suggest: SuggestEdits) {
  const activity: Activity[] = [];
  const repeated = new Map<string, Repeated>();
  const inFlight = new Map<string, Repeated>();
  const uncertain = new WeakSet<object>();

  async function observe(entry: Activity, destination: Target, cursor: number, text: string) {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      const messages = sessions.messages(destination.id, cursor);
      if (messages.some(message => message.type === 'user_prompt' && message.text?.trim() === text)) {
        entry.status = 'submitted';
        uncertain.delete(destination.identity);
        return;
      }
      if (sessions.target(destination.provider, destination.id)?.identity !== destination.identity) break;
      await delay(120, undefined, { ref: false });
    }
    entry.status = 'unknown';
    entry.detail = '입력 전달 여부 미확인. Orca에서 확인하세요.';
  }

  async function processPrompt(provider: Provider, id: string, raw: string): Promise<Receipt> {
    const started = performance.now();
    const entry: Activity = { id: randomUUID(), provider, sessionId: id, startedAt: new Date().toISOString(), raw, status: 'correcting' };
    activity.unshift(entry);
    activity.length = Math.min(activity.length, 20);
    let sending = false;
    let claimed: Target | undefined;
    try {
      const destination = sessions.target(provider, id);
      if (!destination) throw new RequestError(409, 'Orca 세션이 연결되어 있지 않습니다.');
      claimed = destination;
      if (uncertain.has(destination.identity)) throw new RequestError(409, '이전 입력 전달을 확인할 수 없습니다. Orca에서 확인하고 연동 세션을 다시 여세요.');
      const assertIdle = async () => {
        const status = await withTimeout(sessions.status(destination), 2000).catch(() => 'disconnected');
        if (status !== 'idle') throw new RequestError(409, status === 'disconnected'
          ? 'Orca 세션이 연결되어 있지 않습니다.' : 'Orca가 작업 중이거나 권한 입력을 기다리고 있습니다.');
      };
      await assertIdle();
      const history = await withTimeout(sessions.context(destination), 2500).catch(() => {
        throw new RequestError(503, '같은 Orca 세션의 입력 기록을 읽지 못했습니다.');
      });
      const settings = getSettings();
      entry.corrected = await correct(suggest, settings, raw, history).catch(() => {
        throw new RequestError(503, 'OpenAI 보정에 실패했습니다. API 키, 모델, effort 또는 연결을 확인하세요.');
      });
      await assertIdle();
      const cursor = sessions.messages(id, 0).at(-1)?.id ?? 0;
      uncertain.add(destination.identity);
      sending = true;
      // Orca's own delivery check waits up to 8 seconds for the turn to start.
      const result = await withTimeout(sessions.send(destination, entry.corrected), destination.via === 'orca' ? 20_000 : 5000);
      if (result.sessionId !== id) throw new Error('Session receipt did not match');
      entry.status = 'accepted';
      void observe(entry, destination, cursor, entry.corrected);
      return { ok: true, ...result };
    } catch (error) {
      // A refusal from Orca (or a failed pre-send check) proves nothing was written.
      const refused = error instanceof NotDelivered;
      if (refused && claimed) uncertain.delete(claimed.identity);
      entry.status = sending && !refused ? 'unknown' : 'held';
      const failure = refused ? new RequestError(409, error.message)
        : sending ? new RequestError(502, 'Orca에 입력이 전달됐는지 확인할 수 없습니다. Orca에서 확인하세요.')
        : error instanceof RequestError ? error : new RequestError(503, 'Orca 입력을 보류했습니다.');
      entry.detail = failure.message;
      throw failure;
    } finally {
      entry.elapsed = Math.round(performance.now() - started);
    }
  }

  return {
    activity: () => activity,
    submit(provider: Provider, id: string, text: unknown, requestId?: string): Promise<Receipt> {
      if (!validPrompt(text)) throw new RequestError(400, '일반 텍스트 프롬프트를 입력하세요.');
      const raw = text.trim();
      const sessionKey = `${provider}:${id}`;
      const digest = createHash('sha256').update(raw).digest('base64url');
      const requestKey = `${sessionKey}:${requestId ? `id:${requestId}` : `text:${digest}`}`;
      const now = Date.now();
      for (const [key, entry] of repeated) if (entry.expires < now) repeated.delete(key);
      const prior = repeated.get(requestKey);
      if (prior) {
        if (prior.digest !== digest) throw new RequestError(409, '같은 요청 ID에 다른 입력이 전달되었습니다.');
        return prior.receipt;
      }
      const pending = inFlight.get(sessionKey);
      if (pending) {
        if (pending.digest === digest) {
          const duplicate = { ...pending, expires: Infinity };
          repeated.set(requestKey, duplicate);
          const complete = () => { duplicate.expires = Date.now() + (requestId ? 60_000 : 1800); };
          void pending.receipt.then(complete, complete);
          return pending.receipt;
        }
        throw new RequestError(409, '이 세션의 이전 입력을 보정 중입니다.');
      }
      const entry: Repeated = { digest, expires: Infinity, receipt: processPrompt(provider, id, raw) };
      inFlight.set(sessionKey, entry);
      repeated.set(requestKey, entry);
      const complete = () => {
        inFlight.delete(sessionKey);
        entry.expires = Date.now() + (requestId ? 60_000 : 1800);
      };
      void entry.receipt.then(complete, complete);
      return entry.receipt;
    },
  };
}
