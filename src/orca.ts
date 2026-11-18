import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Attaches the bridge to Claude Code sessions that already run in Orca
// terminals, without the Even wrapper. Orca supplies the terminal list and
// prompt delivery (`orca terminal send`); Claude Code's own session records
// (~/.claude/sessions/<pid>.json) supply the session ID and busy/idle state;
// the transcript supplies the reply, mapped by the Even package's own
// WrappedSession so the G2 sees the same message shapes as a wrapped session.

export type ClaudeStatus = 'idle' | 'busy' | 'waiting';
export type LinkStatus = 'idle' | 'busy' | 'awaiting' | 'disconnected';

export interface ClaudeProcess { pid: number; sessionId: string; cwd: string; status?: ClaudeStatus }

export interface OrcaHost {
  /** Runs `orca <args> --json` and resolves with its `result`; rejects with OrcaError. */
  call(args: string[], timeoutMs?: number): Promise<unknown>;
  /** Live interactive Claude Code processes on this Mac. */
  processes(): ClaudeProcess[];
  /** Current status of one process's session, or undefined once it is gone or replaced. */
  status(pid: number, sessionId: string): ClaudeStatus | undefined;
  /** The Orca terminal handle a process inherited from its terminal. */
  terminalOf(pid: number): Promise<string | undefined>;
}

export interface Candidate {
  sessionId: string;
  handle: string;
  incarnationId: string;
  pid: number;
  cwd: string;
  title: string;
  status: LinkStatus;
  attached: boolean;
  wrapped: boolean;
}

/** Message shapes come from the pinned Even package; see sessions.ts. */
export interface WrappedTurn {
  phase: string;
  cursor: number;
  lastText: string;
  beginTurn(): void;
  drain(): void;
  finish(finalText?: string): void;
  dispose(): void;
  readLines(): string[];
}
export type WrappedTurnClass = new (
  sessionId: string, emit: (id: string, message: object) => void, sendStdin: (data: string) => void,
) => WrappedTurn;

export class OrcaError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Raised when the prompt was provably not written to the terminal. */
export class NotDelivered extends Error {}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const handlePattern = /^term_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const statuses = new Set<string>(['idle', 'busy', 'waiting']);

interface RawTerminal {
  handle?: unknown; incarnationId?: unknown; title?: unknown; worktreePath?: unknown;
  executionHostId?: unknown; agentIdentity?: unknown; connected?: unknown; writable?: unknown; orphaned?: unknown;
}

function usable(terminal: RawTerminal): terminal is RawTerminal & { handle: string; incarnationId: string } {
  // A plain shell would execute dictated text as a command, so only terminals
  // Orca recognizes as running Claude Code are ever candidates.
  return typeof terminal.handle === 'string' && handlePattern.test(terminal.handle)
    && typeof terminal.incarnationId === 'string' && terminal.executionHostId === 'local'
    && terminal.agentIdentity === 'claude' && terminal.connected === true
    && terminal.writable === true && terminal.orphaned !== true;
}

export function orcaBinary() {
  // A menu bar app has no login-shell PATH, so prefer the app bundle's CLI.
  const bundled = '/Applications/Orca.app/Contents/Resources/bin/orca';
  return process.env.EVEN_ORCA_ORCA_BIN || (existsSync(bundled) ? bundled : 'orca');
}

function claudeSessionsDir() {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions');
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readProcess(path: string): ClaudeProcess | undefined {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const { pid, sessionId, cwd, status, kind } = record;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 1 || typeof sessionId !== 'string' || !uuid.test(sessionId)) return undefined;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || (kind !== undefined && kind !== 'interactive')) return undefined;
    return { pid: pid as number, sessionId, cwd, status: typeof status === 'string' && statuses.has(status) ? status as ClaudeStatus : undefined };
  } catch { return undefined; }
}

function execute(file: string, args: string[], timeout: number) {
  return new Promise<{ stdout: string; failed: boolean }>((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error && !stdout) return reject(error);
      resolve({ stdout, failed: Boolean(error) });
    });
  });
}

export function createOrcaHost(binary = orcaBinary()): OrcaHost {
  return {
    async call(args, timeoutMs = 8000) {
      let output: { stdout: string; failed: boolean };
      try { output = await execute(binary, [...args, '--json'], timeoutMs); }
      catch (error) {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        throw new OrcaError(missing ? 'orca_missing' : 'orca_failed', missing ? 'Orca CLI를 찾을 수 없습니다.' : 'Orca CLI 실행에 실패했습니다.');
      }
      let reply: { ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
      try { reply = JSON.parse(output.stdout) as typeof reply; }
      catch { throw new OrcaError('orca_output', 'Orca CLI 응답을 해석하지 못했습니다.'); }
      if (reply.ok !== true) {
        const code = typeof reply.error?.code === 'string' ? reply.error.code : 'orca_error';
        throw new OrcaError(code, typeof reply.error?.message === 'string' ? reply.error.message : code);
      }
      return reply.result;
    },
    processes() {
      const directory = claudeSessionsDir();
      let names: string[];
      try { names = readdirSync(directory); } catch { return []; }
      return names.filter(name => /^\d+\.json$/u.test(name))
        .flatMap(name => readProcess(join(directory, name)) ?? [])
        .filter(item => alive(item.pid));
    },
    status(pid, sessionId) {
      if (!alive(pid)) return undefined;
      const current = readProcess(join(claudeSessionsDir(), `${pid}.json`));
      return current?.sessionId === sessionId ? current.status ?? undefined : undefined;
    },
    async terminalOf(pid) {
      // `ps -E` appends the environment to the command line. Orca exports the
      // terminal handle to every process in its terminals.
      const { stdout } = await execute('/bin/ps', ['-E', '-ww', '-p', String(pid), '-o', 'command='], 3000).catch(() => ({ stdout: '' }));
      if (!/\bclaude\b/u.test(stdout)) return undefined;
      const tokens = stdout.split(/\s+/u).filter(token => token.startsWith('ORCA_TERMINAL_HANDLE='));
      const handle = tokens.length === 1 ? tokens[0].slice('ORCA_TERMINAL_HANDLE='.length) : undefined;
      return handle && handlePattern.test(handle) ? handle : undefined;
    },
  };
}

interface Receipt { send?: { accepted?: unknown; prompt?: { stages?: unknown; processIncarnation?: unknown } } }

function userText(line: string) {
  try {
    const record = JSON.parse(line) as { type?: string; isMeta?: boolean; toolUseResult?: unknown; message?: { content?: unknown } };
    if (record.type !== 'user' || record.isMeta || record.toolUseResult !== undefined) return undefined;
    const content = record.message?.content;
    if (typeof content === 'string') return content.trim() || undefined;
    if (!Array.isArray(content) || content.some(block => block?.type === 'tool_result')) return undefined;
    const text = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text as string).join('\n').trim();
    return text || undefined;
  } catch { return undefined; }
}

export class OrcaSession {
  readonly id: string;
  readonly handle: string;
  readonly incarnationId: string;
  readonly pid: number;
  readonly cwd: string;
  title: string;
  closed = false;
  private readonly host: OrcaHost;
  private readonly emit: (id: string, message: object) => void;
  private readonly turn: WrappedTurn;
  private readonly onClose: (session: OrcaSession) => void;
  private settled: number;
  private pending: string | undefined;
  private sending = false;
  private idleSince = 0;
  private waitingNotified = false;

  constructor(candidate: Candidate, options: {
    host: OrcaHost; emit: (id: string, message: object) => void; WrappedTurn: WrappedTurnClass; onClose(session: OrcaSession): void;
  }) {
    this.id = candidate.sessionId;
    this.handle = candidate.handle;
    this.incarnationId = candidate.incarnationId;
    this.pid = candidate.pid;
    this.cwd = candidate.cwd;
    this.title = candidate.title;
    this.host = options.host;
    this.emit = options.emit;
    this.onClose = options.onClose;
    // Prompts go through `orca terminal send`, and permission or question
    // answers stay in Orca, so the Even session never writes to the PTY.
    this.turn = new options.WrappedTurn(this.id, this.emit, () => {});
    this.settled = this.turn.readLines().length;
  }

  status(): LinkStatus {
    if (this.closed) return 'disconnected';
    const current = this.host.status(this.pid, this.id);
    if (!current) return 'disconnected';
    if (current === 'waiting') return 'awaiting';
    return current === 'idle' && this.turn.phase === 'idle' && !this.sending ? 'idle' : 'busy';
  }

  /** Mirrors turns from Claude Code's state, including turns typed in Orca. */
  poll() {
    if (this.closed) return;
    const current = this.host.status(this.pid, this.id);
    if (!current) return this.close();
    if (current === 'waiting' && !this.waitingNotified) {
      this.waitingNotified = true;
      this.emit(this.id, { type: 'notification', title: 'Orca 확인 필요', message: 'Claude Code가 권한이나 선택을 기다립니다. Orca 터미널에서 응답하세요.' });
    } else if (current !== 'waiting') this.waitingNotified = false;
    if (current !== 'idle') {
      this.idleSince = 0;
      if (this.turn.phase === 'idle') this.startTurn(this.pending);
      return;
    }
    if (this.turn.phase === 'idle' || this.sending) return;
    // Let the transcript writer finish its last record before closing the turn.
    if (!this.idleSince) this.idleSince = Date.now();
    else if (Date.now() - this.idleSince >= 350) this.finishTurn();
  }

  async send(text: string) {
    if (this.closed || this.sending) throw new NotDelivered('Orca 세션이 사용 중입니다.');
    const shown = await this.host.call(['terminal', 'show', '--terminal', this.handle], 5000)
      .catch(() => { throw new NotDelivered('Orca 터미널을 확인하지 못했습니다.'); }) as { terminal?: RawTerminal };
    if (!shown.terminal || !usable(shown.terminal) || shown.terminal.incarnationId !== this.incarnationId) {
      this.close();
      throw new NotDelivered('Orca 터미널이 바뀌었거나 닫혔습니다. 다시 연결하세요.');
    }
    if (this.status() !== 'idle') throw new NotDelivered('Orca 세션이 작업 중이거나 응답을 기다립니다.');
    this.sending = true;
    this.pending = text;
    let receipt: Receipt;
    try {
      // `--text=<value>` keeps a prompt that starts with `--` from being parsed
      // as a flag; the CLI passes the rest of the argument through verbatim.
      receipt = await this.host.call(['terminal', 'send', '--terminal', this.handle, `--text=${text}`, '--enter', '--wait-submit', '8'], 15_000) as Receipt;
    } catch (error) {
      this.pending = undefined;
      // Orca refuses a prompt while Claude Code shows a permission or trust
      // menu; argument errors are rejected by the CLI before any input.
      if (error instanceof OrcaError && error.code === 'agent_prompt_blocked') {
        throw new NotDelivered('Claude Code가 Orca에서 응답을 기다리고 있어 입력을 보류했습니다.');
      }
      if (error instanceof OrcaError && error.code === 'invalid_argument') throw new NotDelivered('Orca가 입력 형식을 거부했습니다.');
      throw error;
    } finally { this.sending = false; }
    const prompt = receipt.send?.prompt;
    if (receipt.send?.accepted !== true || (prompt?.processIncarnation !== undefined && prompt.processIncarnation !== this.incarnationId)) {
      this.pending = undefined;
      throw new Error('Orca did not accept the prompt for this terminal');
    }
    // Without turn_started the prompt is accepted but unproven; the next busy
    // poll starts the turn with the pending text.
    if (Array.isArray(prompt?.stages) && prompt.stages.includes('turn_started')) this.startTurn(text);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.turn.dispose();
    this.onClose(this);
  }

  private startTurn(prompt?: string) {
    if (this.turn.phase !== 'idle') return;
    this.pending = undefined;
    const lines = this.turn.readLines();
    const text = prompt ?? lines.slice(this.settled).map(userText).find(Boolean);
    if (text) this.emit(this.id, { type: 'user_prompt', text });
    this.turn.beginTurn();
    // beginTurn skips everything already on disk; replay this turn's records.
    this.turn.cursor = Math.min(this.settled, lines.length);
    this.turn.drain();
  }

  private finishTurn() {
    this.idleSince = 0;
    this.turn.drain();
    this.turn.finish(this.turn.lastText || undefined);
    this.settled = this.turn.readLines().length;
  }
}

export function createOrcaLink(options: {
  host: OrcaHost;
  emit: (id: string, message: object) => void;
  WrappedTurn: WrappedTurnClass;
  isWrapped(sessionId: string): boolean;
  load(): string[];
  save(sessionIds: string[]): void;
  pollMs?: number;
}) {
  const { host, emit, WrappedTurn, isWrapped } = options;
  const linked = new Map<string, OrcaSession>();
  const chosen = new Set(options.load().filter(id => uuid.test(id)));
  const timer = setInterval(() => {
    // A wrapper that later claims the same session owns its events; mirroring
    // it here as well would send every reply to the G2 twice.
    for (const session of linked.values()) {
      if (isWrapped(session.id)) session.close();
      else session.poll();
    }
  }, options.pollMs ?? 500);
  timer.unref();

  async function discover(): Promise<Candidate[]> {
    const listed = await host.call(['terminal', 'list'], 8000) as { terminals?: RawTerminal[] };
    const terminals = (listed.terminals ?? []).filter(usable);
    const processes = host.processes();
    const handles = await Promise.all(processes.map(item => host.terminalOf(item.pid)));
    return terminals.flatMap(terminal => {
      const owners = processes.filter((_, index) => handles[index] === terminal.handle);
      // Several Claude processes in one terminal cannot be told apart safely.
      if (owners.length !== 1) return [];
      const [owner] = owners;
      const session = linked.get(owner.sessionId);
      const status = session?.status() ?? (owner.status === 'idle' ? 'idle' : owner.status === 'waiting' ? 'awaiting' : owner.status ? 'busy' : 'disconnected');
      return [{
        sessionId: owner.sessionId, handle: terminal.handle, incarnationId: terminal.incarnationId, pid: owner.pid, cwd: owner.cwd,
        title: typeof terminal.title === 'string' && terminal.title.trim() ? terminal.title.trim().slice(0, 80) : owner.cwd,
        status, attached: Boolean(session && !session.closed), wrapped: isWrapped(owner.sessionId),
      }];
    });
  }

  function open(candidate: Candidate) {
    const current = linked.get(candidate.sessionId);
    if (current && !current.closed && current.handle === candidate.handle && current.incarnationId === candidate.incarnationId) return current;
    current?.close();
    const session = new OrcaSession(candidate, {
      host, emit, WrappedTurn, onClose: closed => { if (linked.get(closed.id) === closed) linked.delete(closed.id); },
    });
    linked.set(candidate.sessionId, session);
    return session;
  }

  return {
    discover,
    get: (sessionId: string) => {
      const session = linked.get(sessionId);
      return session && !session.closed ? session : undefined;
    },
    list: () => [...linked.values()].filter(session => !session.closed),
    owns: (identity: unknown): identity is OrcaSession => identity instanceof OrcaSession,
    async attach(sessionId: string) {
      if (!uuid.test(sessionId)) throw new Error('잘못된 세션 ID입니다.');
      if (isWrapped(sessionId)) throw new Error('이미 Even 래퍼로 연결된 세션입니다.');
      const candidate = (await discover()).find(item => item.sessionId === sessionId);
      if (!candidate) throw new Error('Orca에서 이 Claude Code 세션을 찾지 못했습니다.');
      chosen.add(sessionId);
      options.save([...chosen]);
      return open(candidate);
    },
    detach(sessionId: string) {
      chosen.delete(sessionId);
      options.save([...chosen]);
      linked.get(sessionId)?.close();
    },
    /** Reattaches sessions chosen earlier that are still open in Orca. */
    async restore() {
      if (!chosen.size) return [];
      const candidates = await discover();
      return candidates.filter(item => chosen.has(item.sessionId) && !item.wrapped).map(open);
    },
    stop() {
      clearInterval(timer);
      for (const session of linked.values()) session.close();
    },
  };
}

export type OrcaLink = ReturnType<typeof createOrcaLink>;
