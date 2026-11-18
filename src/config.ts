import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof efforts[number];
export type Provider = 'claude' | 'codex';
export interface Term { preferred: string; heard: string }
// showTools: tool_start/tool_end events crowd out the agent's narration on the
// G2 display, so the phone stream omits them unless this is turned on.
export interface Settings { model: string; effort: Effort; terms: Term[]; showTools: boolean }
export const defaultSettings: Settings = { model: 'gpt-6.2-sol', effort: 'low', terms: [], showTools: false };
export const stateDir = process.env.EVEN_ORCA_STATE_DIR || join(homedir(), '.config', 'even-orca');

export interface Runtime {
  port: number;
  codexPort: number;
  adminToken: string;
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

export function portFrom(value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid local port: ${value}`);
  return port;
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export const terminalControls = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u;

export function parseSettings(value: unknown): Settings {
  if (!value || typeof value !== 'object') throw new Error('설정 형식이 잘못되었습니다.');
  const { model, effort, terms, showTools = false } = value as Partial<Settings>;
  if (typeof showTools !== 'boolean') throw new Error('도구 실행 표시 설정이 잘못되었습니다.');
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(model)) {
    throw new Error('올바른 OpenAI 모델 ID를 입력하세요.');
  }
  if (!effort || !efforts.includes(effort)) throw new Error('지원하는 reasoning effort를 선택하세요.');
  if ((effort === 'none' || effort === 'minimal') && /^gpt-6\.2-(sol|astra)(?:-|$)/u.test(model)) {
    throw new Error('GPT-6.2 Sol과 Astra는 effort low 이상을 지원합니다.');
  }
  if (!Array.isArray(terms) || terms.length > 250) throw new Error('사전 항목은 250개까지 저장할 수 있습니다.');
  const aliases = new Set<string>();
  const parsedTerms = terms.map((item): Term => {
    if (typeof item?.preferred !== 'string' || typeof item.heard !== 'string') {
      throw new Error('사전 항목 형식이 잘못되었습니다.');
    }
    const preferred = item.preferred.trim().normalize();
    const heard = item.heard.trim().normalize();
    if (!preferred || [preferred, heard].some(text => text.length > 120 || terminalControls.test(text) || /[\n\t]/u.test(text))) {
      throw new Error('사전 입력은 줄바꿈 없이 120자까지 허용됩니다.');
    }
    const alias = heard.toLowerCase();
    if (alias && aliases.has(alias)) throw new Error('같은 오인식 표기가 두 번 등록되어 있습니다.');
    if (alias) aliases.add(alias);
    return { preferred, heard };
  });
  return { model, effort, terms: parsedTerms, showTools };
}

export function openSettings(directory: string) {
  const path = join(directory, 'settings.json');
  let current = parseSettings(readJson(path) ?? defaultSettings);
  return {
    current: () => current,
    update(value: unknown) {
      const next = parseSettings(value);
      writeJson(path, next);
      current = next;
      return next;
    },
  };
}
