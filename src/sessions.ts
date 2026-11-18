import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import type { Request, Response, Router } from 'express';
import type { Provider } from './config.ts';

const require = createRequire(import.meta.url);
export const evenPackage = dirname(require.resolve('@evenrealities/even-terminal/package.json'));
export const evenCli = join(evenPackage, 'bin', 'cli.js');
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
export const agentName = (value: unknown): Provider | undefined => value === 'claude' || value === 'claude-sync' ? 'claude' : value === 'codex' ? 'codex' : undefined;

interface TextBlock { type: string; text?: string }
interface HistoryRow { role: string; text: string }
interface CodexThread { id: string; cwd?: string; name?: string; status?: { type?: string; activeFlags?: string[] } }
interface CodexTurn { items?: { type: string; content?: TextBlock[] }[] }
interface CodexClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  threadRead(id: string, includeTurns: boolean): Promise<CodexThread | null>;
  threadStart(params: { cwd: string }): Promise<CodexThread | null>;
  threadTurnsList(params: Record<string, unknown>): Promise<{ data: CodexTurn[]; nextCursor: string | null }>;
}
interface EvenProvider {
  getHistory(id: string, limit: number): Promise<HistoryRow[]>;
  getStatus(id: string): { state: string } | undefined;
  prompt(id: string, text: string): Promise<{ sessionId: string; provider: string }>;
}
interface ClaudeWrap { status: string; submitting: boolean; submitPrompt(text: string): void }
interface ClaudeTransport {
  attach(server: Server): void;
  wrapped(id: string): ClaudeWrap | undefined;
  wrappers: Map<string, { cwd: string; sessionId: string | null }>;
}
interface ClaudeMessage {
  type: string;
  parent_tool_use_id?: string | null;
  parent_agent_id?: string | null;
  message?: { content?: string | TextBlock[] };
}
interface EvenMessage { id: number; type: string; text?: string }
interface CodexLease { cwd: string; pid: number; expires: number; live: boolean }
export interface Target {
  id: string;
  provider: Provider;
  cwd: string;
  identity: object;
}

function textFromBlocks(content: string | TextBlock[] | undefined) {
  return typeof content === 'string' ? content : (content ?? []).flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
}

function running(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function codexHistory<T>(read: Promise<T[]>) {
  try { return await read; }
  catch (error) {
    // A newly started thread is live but has no saved rollout until its
    // first user prompt. Other read failures must still hold the submission.
    if (error instanceof Error && /not materialized yet.*before first user message/iu.test(error.message)) return [];
    throw error;
  }
}

export interface Sessions {
  target(provider: Provider, id: string): Target | undefined;
  list(provider: Provider, cwd?: string): Target[];
  status(target: Target): Promise<string>;
  history(target: Target, limit: number): Promise<HistoryRow[]>;
  context(target: Target): Promise<string[]>;
  send(target: Target, text: string): Promise<{ sessionId: string; provider: string }>;
  messages(id: string, after: number): EvenMessage[];
}

export async function loadEven() {
  // These paths and contracts belong to the pinned npm package. Keep all of
  // them in this adapter so package changes cannot affect prompt correction.
  const load = (path: string): Promise<unknown> => import(pathToFileURL(join(evenPackage, path)).href);
  const sdkPath = createRequire(join(evenPackage, 'package.json')).resolve('@anthropic-ai/claude-agent-sdk');
  const [core, events, hook, startup, sdk] = await Promise.all([
    load('dist/routes/core.js'), load('dist/routes/events.js'),
    load('dist/claude-sync/hook-receiver.js'), load('dist/startup/common.js'),
    import(pathToFileURL(sdkPath).href) as Promise<unknown>,
  ]) as [
    { default: Router; getProvider(name: Provider): EvenProvider; codexClient: CodexClient; claudeSyncTransport: ClaudeTransport; emitBridgeMessage(id: string, message: object): void },
    { default: Router; getMessages(id: string, after: number): EvenMessage[] },
    { handleHookRequest(req: Request, res: Response, emit: typeof core.emitBridgeMessage, transport: ClaudeTransport): void },
    { printQRCode(text: string): void; stopCodexAppServer(): void },
    { getSessionMessages(id: string, options: { dir: string }): Promise<ClaudeMessage[]> },
  ];
  const { codexClient, claudeSyncTransport } = core;
  const codexLeases = new Map<string, CodexLease>();

  function target(provider: Provider, id: string): Target | undefined {
    if (provider === 'claude') {
      const wrap = claudeSyncTransport.wrapped(id);
      const connection = [...claudeSyncTransport.wrappers.values()].find(item => item.sessionId === id);
      if (wrap && connection) return { id, provider, cwd: connection.cwd, identity: wrap };
      return undefined;
    }
    const lease = codexLeases.get(id);
    if (!lease) return undefined;
    if (lease.expires < Date.now() || !running(lease.pid)) {
      codexLeases.delete(id);
      return undefined;
    }
    return lease.live ? { id, provider, cwd: lease.cwd, identity: lease } : undefined;
  }

  const sessions: Sessions = {
    target,
    list(provider, cwd) {
      const ids = provider === 'claude'
        ? [...claudeSyncTransport.wrappers.values()].map(wrapper => wrapper.sessionId)
        : [...codexLeases.keys()];
      return ids.flatMap(id => {
        const active = id && target(provider, id);
        return active && (!cwd || active.cwd === cwd) ? [active] : [];
      });
    },
    async status(session) {
      if (target(session.provider, session.id)?.identity !== session.identity) return 'disconnected';
      if (session.provider === 'claude') {
        const wrapper = session.identity as ClaudeWrap;
        return wrapper.submitting ? 'busy' : wrapper.status;
      }
      const result = await codexClient.threadRead(session.id, false);
      if (!result || result.id !== session.id || !result.status?.type) return 'disconnected';
      const status = result.status.type;
      if (status === 'active') return result.status.activeFlags?.length ? 'awaiting' : 'busy';
      return status === 'idle' ? 'idle' : 'disconnected';
    },
    history(session, limit) {
      const history = core.getProvider(session.provider).getHistory(session.id, limit);
      return session.provider === 'codex' ? codexHistory(history) : history;
    },
    async context(session) {
      if (session.provider === 'claude') {
        const history = await sdk.getSessionMessages(session.id, { dir: session.cwd });
        return history.filter(row => row.type === 'user' && !row.parent_tool_use_id && !row.parent_agent_id)
          .map(row => textFromBlocks(row.message?.content)).filter(Boolean).slice(-5);
      }
      return codexHistory((async () => {
        const prompts: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 3 && prompts.length < 5; page++) {
          const result = await codexClient.threadTurnsList({
            threadId: session.id, limit: 10, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}),
          });
          for (const turn of result.data) {
            for (const item of [...(turn.items ?? [])].reverse()) {
              if (item.type !== 'userMessage') continue;
              const text = textFromBlocks(item.content);
              if (text) prompts.push(text);
            }
          }
          if (!result.nextCursor || result.nextCursor === cursor) break;
          cursor = result.nextCursor;
        }
        return prompts.slice(0, 5).reverse();
      })());
    },
    async send(session, text) {
      if (target(session.provider, session.id)?.identity !== session.identity) throw new Error('Session disconnected');
      if (session.provider === 'claude') {
        // Calling the bound wrapper avoids the official provider's fallback
        // to starting a separate SDK agent when the wrapper disappears.
        const wrapper = session.identity as ClaudeWrap;
        if (wrapper.status !== 'idle' || wrapper.submitting) throw new Error('Session is busy');
        wrapper.submitPrompt(text);
        return { sessionId: session.id, provider: 'claude' };
      }
      return core.getProvider('codex').prompt(session.id, text);
    },
    messages: events.getMessages,
  };

  return {
    sessions,
    events: events.default,
    core: core.default,
    onHook: (req: Request, res: Response) => hook.handleHookRequest(req, res, core.emitBridgeMessage, claudeSyncTransport),
    attachClaude: (server: Server) => claudeSyncTransport.attach(server),
    emit: core.emitBridgeMessage,
    printQR: startup.printQRCode,
    stop() { startup.stopCodexAppServer(); void codexClient.close().catch(() => {}); },
    async enrollCodex(cwd: string, pid: number, resumeId?: string) {
      if (!running(pid)) throw new Error('Codex launcher has exited');
      await codexClient.connect();
      const thread = resumeId ? await codexClient.threadRead(resumeId, false) : await codexClient.threadStart({ cwd });
      if (!thread || !validId(thread.id) || !thread.cwd) throw new Error('Codex session could not be opened');
      const nativeCwd = await realpath(thread.cwd);
      if (nativeCwd !== await realpath(cwd)) throw new Error('Run the launcher in the same Orca workspace as the Codex session');
      target('codex', thread.id); // Expire an abandoned lease before reserving the ID.
      if (codexLeases.has(thread.id)) throw new Error('This Codex session is already linked');
      codexLeases.set(thread.id, { pid, cwd, expires: Date.now() + 12_000, live: false });
      return thread.id;
    },
    heartbeatCodex(id: string, pid: number, cwd: string) {
      if (!running(pid)) throw new Error('Codex launcher has exited');
      const lease = codexLeases.get(id);
      if (!lease || lease.expires < Date.now() || lease.pid !== pid || lease.cwd !== cwd) throw new Error('Codex link expired');
      lease.live = true;
      lease.expires = Date.now() + 12_000;
    },
    releaseCodex(id: string, pid: number) {
      if (codexLeases.get(id)?.pid === pid) codexLeases.delete(id);
    },
  };
}
