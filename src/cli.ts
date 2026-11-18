import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { newToken, openSettings, portFrom, readJson, stateDir, writeJson } from './config.ts';
import type { Provider, Runtime } from './config.ts';
import { evenCli, loadEven, validId } from './sessions.ts';

const runtimeFile = join(stateDir, 'runtime.json');
const privateIP = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u;

function lanAddress() {
  const interfaces = networkInterfaces();
  const ips = [interfaces.en0, ...Object.values(interfaces)].flatMap(items => items ?? [])
    .filter(item => item.family === 'IPv4' && !item.internal && privateIP.test(item.address))
    .map(item => item.address);
  const requested = process.env.EVEN_ORCA_LAN;
  if (requested === 'off') return undefined;
  if (requested && !ips.includes(requested)) throw new Error('EVEN_ORCA_LAN must be a private IPv4 address assigned to this Mac.');
  return requested ?? ips[0];
}

function listen(server: Server, port: number, host: string) {
  const ready = once(server, 'listening');
  server.listen(port, host);
  return ready;
}

async function serve() {
  try { process.loadEnvFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const apiKey = process.env.EVEN_ORCA_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Set EVEN_ORCA_OPENAI_API_KEY in .env or in the environment before starting the bridge.');
  delete process.env.EVEN_ORCA_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.USE_ORIGINAL_CLAUDE;
  delete process.env.VERBOSE;
  const port = portFrom(process.env.EVEN_ORCA_PORT, 3466);
  const codexPort = portFrom(process.env.EVEN_ORCA_CODEX_PORT, 8766);
  if (port === codexPort) throw new Error('Even and Codex must use different ports.');
  const defaultProvider: Provider = process.env.EVEN_ORCA_PROVIDER === 'codex' ? 'codex' : 'claude';
  const lan = lanAddress();
  process.env.CODEX_APP_SERVER_PORT = String(codexPort);
  process.env.DEFAULT_PROVIDER = defaultProvider;
  const [{ createApps }, { createSubmission }, { createOpenAIEditor }, even] = await Promise.all([
    import('./http.ts'), import('./submission.ts'), import('./correction.ts'), loadEven(),
  ]);
  const settings = openSettings(stateDir);
  const pairFile = join(stateDir, 'pairing.json');
  const previousToken = (readJson(pairFile) as { token?: unknown } | undefined)?.token;
  const token = typeof previousToken === 'string' && /^[\w-]{43}$/u.test(previousToken) ? previousToken : newToken();
  const pairingUrl = lan ? new URL(`http://${lan}:${port}`) : undefined;
  if (pairingUrl) pairingUrl.search = new URLSearchParams({ token, defaultProvider, name: 'Even Orca' }).toString();
  const adminToken = newToken();
  const submission = createSubmission(even.sessions, settings.current, createOpenAIEditor(apiKey));
  const { local, phone } = createApps({ even, submission, settings, token, adminToken, port, defaultProvider, pairingUrl: pairingUrl?.href });
  const localServer = createServer(local);
  const phoneServer = lan ? createServer(phone) : undefined;
  const servers = phoneServer ? [localServer, phoneServer] : [localServer];
  try {
    await listen(localServer, port, '127.0.0.1');
    if (lan && phoneServer) await listen(phoneServer, port, lan);
    if (token !== previousToken) writeJson(pairFile, { token });
    writeJson(runtimeFile, { port, codexPort, adminToken } satisfies Runtime);
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }
  localServer.on('upgrade', (req, socket) => {
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) socket.destroy();
  });
  even.attachClaude(localServer);
  if (pairingUrl) {
    console.log('Scan this QR from Terminal in the Even Realities app.');
    even.printQR(pairingUrl.href);
    console.log(`Server: ${pairingUrl.origin}`);
  } else console.log('No private LAN address selected. Running in Mac-only mode.');
  console.log(`Mac settings: http://127.0.0.1:${port}/settings`);

  function stop() {
    const current = readJson(runtimeFile) as Runtime | undefined;
    if (current?.adminToken === adminToken) rmSync(runtimeFile, { force: true });
    for (const server of servers) { server.close(); server.closeAllConnections(); }
    even.stop();
    // Failsafe for parked local wrapper sockets after the app-server stops.
    setTimeout(() => process.exit(), 600);
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function runtime() {
  const current = readJson(runtimeFile) as Runtime | undefined;
  if (!current?.adminToken) throw new Error('Start the Even Orca bridge first with npm start.');
  return current;
}

async function launch(provider: Provider, args: string[]) {
  const config = runtime();
  const cwd = process.cwd();
  const env = { ...process.env, EVEN_TERMINAL_PORT: String(config.port), CODEX_APP_SERVER_PORT: String(config.codexPort) };
  delete (env as NodeJS.ProcessEnv).EVEN_ORCA_OPENAI_API_KEY;
  const admin = async (action: string, id?: string) => {
    const response = await fetch(`http://127.0.0.1:${config.port}/admin/codex/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.adminToken}` },
      body: JSON.stringify({ id, pid: process.pid, cwd }), signal: AbortSignal.timeout(8500),
    }).catch(() => { throw new Error('Could not reach the Even Orca bridge. Start it first with npm start.'); });
    const payload = await response.json() as { id?: string; error?: string };
    if (!response.ok) throw new Error(payload.error || 'Could not link Codex.');
    return payload.id;
  };

  let id: string | undefined;
  if (provider === 'codex') {
    if (args.length && (args.length !== 2 || !['resume', '--resume'].includes(args[0]) || !validId(args[1]))) {
      throw new Error('Usage: even-orca codex [resume <session-id>]');
    }
    id = await admin('prepare', args[1]);
    if (!validId(id)) throw new Error('Codex did not return a session ID.');
    console.log(`Linked Codex session ${id}`);
  }
  if (provider === 'claude' && args.length && (args.length !== 2 || !['resume', '--resume'].includes(args[0]) || !validId(args[1]))) {
    throw new Error('Usage: even-orca claude [--resume <session-id>]');
  }
  // Connect Codex directly to the same app-server started by the Even package.
  // The package's Claude wrapper owns its PTY and connects by the bridge port.
  const child = provider === 'codex'
    ? spawn('codex', ['--remote', `ws://127.0.0.1:${config.codexPort}`, '-C', cwd, 'resume', id!], { env, stdio: 'inherit' })
    : spawn(process.execPath, [evenCli, 'claude', ...(args.length ? ['--resume', args[1]] : [])], { env, stdio: 'inherit' });
  const exited = once(child, 'exit');
  // Handle a failed spawn even if it occurs while the launcher is enrolling.
  void exited.catch(() => {});
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on('SIGTERM', forward);
  const interrupt = () => { if (!process.stdin.isTTY) child.kill('SIGINT'); };
  process.on('SIGINT', interrupt);
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    if (id) {
      await once(child, 'spawn');
      await admin('heartbeat', id);
      heartbeat = setInterval(() => {
        void admin('heartbeat', id).catch(() => console.error('Even Orca connection lost. Reopen the launcher to reconnect.'));
      }, 3500);
    }
    const [code] = await exited;
    process.exitCode = typeof code === 'number' ? code : 0;
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    clearInterval(heartbeat);
    process.off('SIGTERM', forward);
    process.off('SIGINT', interrupt);
    if (id) await admin('release', id).catch(() => {});
  }
}

export async function main(args: string[]) {
  const [command, ...rest] = args;
  if (command === 'serve' && !rest.length) return serve();
  if (command === 'claude' || command === 'codex') return launch(command, rest);
  if (command === 'settings' && !rest.length) {
    const config = runtime();
    const browser = spawn('open', [`http://127.0.0.1:${config.port}/settings`], { stdio: 'ignore' });
    await once(browser, 'exit');
    return;
  }
  console.log('Usage: even-orca serve | settings | claude [--resume <id>] | codex [resume <id>]');
  if (command && !['-h', '--help'].includes(command)) process.exitCode = 1;
}
