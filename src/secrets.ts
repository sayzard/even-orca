import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

// The OpenAI API key for prompt correction lives in the project's .env file.
// Mac settings can write a new key there (write-only: the page only learns
// whether a key is configured, never the key itself).

export type KeyCheck = 'valid' | 'invalid' | 'unknown';

const keyPattern = /^sk-[A-Za-z0-9_-]{20,300}$/u;
const variable = 'EVEN_ORCA_OPENAI_API_KEY';
const assignment = new RegExp(`^\\s*(?:export\\s+)?${variable}\\s*=`, 'u');

/** Sets EVEN_ORCA_OPENAI_API_KEY in a dotenv file, keeping every other line. */
export function writeEnvKey(path: string, key: string) {
  let lines: string[] = [];
  try { lines = readFileSync(path, 'utf8').split('\n'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (lines.at(-1) === '') lines.pop();
  const kept = lines.filter(line => !assignment.test(line));
  const first = lines.findIndex(line => assignment.test(line));
  kept.splice(first < 0 ? kept.length : first, 0, `${variable}=${key}`);
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, `${kept.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/** Asks OpenAI whether the key is accepted, without using any model tokens. */
export async function verifyOpenAIKey(key: string, baseURL = 'https://api.openai.com/v1'): Promise<KeyCheck> {
  try {
    const response = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(6000) });
    if (response.ok) return 'valid';
    return response.status === 401 ? 'invalid' : 'unknown';
  } catch { return 'unknown'; }
}

export function openApiKey(options: { env?: string; envFile: string; verify?: (key: string) => Promise<KeyCheck> }) {
  const { envFile, verify = verifyOpenAIKey } = options;
  let key = options.env?.trim() || undefined;
  return {
    current: () => key,
    status: () => ({ configured: Boolean(key) }),
    async set(value: unknown) {
      const next = typeof value === 'string' ? value.trim() : '';
      if (!keyPattern.test(next)) throw new Error('OpenAI API 키 형식이 아닙니다. sk-로 시작하는 키를 붙여 넣으세요.');
      const check = await verify(next);
      if (check === 'invalid') throw new Error('OpenAI가 이 키를 거부했습니다. 키를 다시 확인하세요.');
      writeEnvKey(envFile, next);
      key = next;
      return check;
    },
  };
}

export type ApiKey = ReturnType<typeof openApiKey>;
