// Rebuilds an approximation of the Even Terminal glasses view from the exact
// messages the bridge sends to the phone. Glyph advances, kerning and line
// breaking follow the G2 firmware font (via @evenrealities/pretext); the
// layout constants below were calibrated against the real glasses.
import { getAdvW, getTextWidth } from './vendor/pretext.js';
import { locale, mountSwitcher, onLanguageChange, t, translate } from './i18n.js';

const get = id => document.getElementById(id);
// Only the idle text is confirmed on the real glasses; the others are guesses.
const statusNames = { thinking: '생각 중', busy: '실행 중', idle: '입력 대기 중', awaiting: '응답 대기', disconnected: '연결 끊김' };
const marker = '• ';
// Text column width: every observed line on the real glasses fits 513–538px
// with word wrapping.
const contentWidth = 525;
// Prefix column: the firmware width of "> " (15px). The status bar sits a
// little left of the content column on the real glasses.
const prefixWidth = 15;
const statusWidth = 13;
const visibleRows = 40;

let sessionId;
let after = 0;
let messages = [];
let state = 'idle';

// The Terminal app wraps by words even in Hangul (the firmware default would
// break between any CJK glyphs); a word longer than a line still hard-breaks.
const breakable = cp => cp === 32 || cp === 45;

/** Per-glyph firmware advances in px, with kerning against the next glyph. */
function cells(text) {
  const chars = Array.from(text);
  return chars.map((ch, index) => {
    const cp = ch.codePointAt(0);
    if (cp === 10) return { ch, cp, px: 0 };
    // Glyphs missing from the firmware font draw as a 4px placeholder.
    if (getAdvW(cp) === 0 && cp >= 32) return { ch: '', cp, px: 4 };
    const next = chars[index + 1];
    const paired = next && next !== '\n';
    return { ch, cp, px: paired ? getTextWidth(ch + next) - getTextWidth(next) : getTextWidth(ch) };
  });
}

/** Port of pretext's measureTextWrap (LVGL lv_text_get_next_line) with the app's word breaks, returning lines. */
function wrap(text, width) {
  const list = cells(text);
  const lines = [];
  let start = 0, used = 0, last = -1, index = 0;
  while (index < list.length) {
    const { cp, px } = list[index];
    if (cp === 10) { lines.push(list.slice(start, index)); index++; start = index; used = 0; last = -1; continue; }
    if (used === 0 && cp === 32) { index++; start = index; continue; }
    if (used + px > width) {
      if (cp === 32) { lines.push(list.slice(start, index)); index++; start = index; used = 0; last = -1; }
      else if (last !== -1) { lines.push(list.slice(start, last + 1)); index = last + 1; start = index; used = 0; last = -1; }
      else { lines.push(list.slice(start, index)); start = index; used = px; last = -1; index++; }
    } else {
      used += px;
      if (breakable(cp)) last = index;
      index++;
    }
  }
  lines.push(list.slice(start));
  return lines;
}

function screenModel(list) {
  const lines = [];
  let phase = 'idle';
  let paragraph;
  for (const message of list) {
    if (message.type === 'user_prompt' && message.text) {
      lines.push({ kind: 'user', text: message.text });
      paragraph = undefined;
    } else if (message.type === 'status') {
      if (message.state === 'think_start') phase = 'thinking';
      else if (message.state === 'think_end' || message.state === 'busy') phase = 'busy';
      else if (message.state === 'idle') phase = 'idle';
    } else if (message.type === 'text_delta' && typeof message.text === 'string') {
      // A marked chunk starts a paragraph; unmarked chunks continue it.
      if (!paragraph || message.text.startsWith(marker)) {
        paragraph = { kind: 'agent', text: message.text };
        lines.push(paragraph);
      } else paragraph.text += message.text;
    } else if (message.type === 'notification') {
      lines.push({ kind: 'note', text: [message.title, message.message].filter(Boolean).join(': ') });
      paragraph = undefined;
    } else if (message.type === 'permission_request') {
      lines.push({ kind: 'note', text: t('권한 요청: {tool}', { tool: message.toolName ?? '' }) });
      paragraph = undefined;
    } else if (message.type === 'tool_end') {
      // Only present when "G2에 도구 실행 표시" is on.
      lines.push({ kind: 'agent', text: `tool end: ${message.name ?? ''}` });
      paragraph = undefined;
    }
  }
  return { lines: lines.slice(-60), phase };
}

function glyphRun(parent, line) {
  for (const cell of line) {
    const glyph = document.createElement('span');
    glyph.className = 'ch';
    glyph.style.width = `${cell.px}px`;
    glyph.textContent = cell.ch;
    parent.append(glyph);
  }
}

function row(kind, prefix, line) {
  const element = document.createElement('div');
  element.className = `row ${kind}`;
  const cell = document.createElement('span');
  cell.className = 'prefix';
  cell.textContent = prefix;
  element.append(cell);
  glyphRun(element, line);
  return element;
}

function render() {
  const { lines, phase } = screenModel(messages);
  const shown = state === 'idle' || state === 'disconnected' || state === 'awaiting' ? state : phase === 'thinking' ? 'thinking' : 'busy';
  get('status').replaceChildren();
  glyphRun(get('status'), cells(t(statusNames[shown] ?? shown)));
  get('hint').replaceChildren();
  glyphRun(get('hint'), cells(t('[길게 눌러 입력]')));
  // The app prefixes the user's prompts with "/" and agent output with ">",
  // shows no blank lines, drops markdown bold markers (no bold weight), and
  // indents wrapped lines to the text column.
  const rows = lines.flatMap(line => {
    // Emphasis is stripped within a line, bold first, then italic: this also
    // reproduces the glasses showing "**를 … **를" as "*를 … *를".
    const text = line.text
      .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/gu, '$1')
      .replace(/\*(?=\S)(.+?)(?<=\S)\*/gu, '$1')
      .replace(/\n(?:[ \t]*\n)+/gu, '\n').trim();
    // ">" marks only the first row of an answer; "/" marks every row of a prompt.
    const prefix = line.kind === 'agent' ? '>' : line.kind === 'user' ? '/' : '';
    return wrap(text, contentWidth).map((visual, index) => row(line.kind, index && line.kind !== 'user' ? '' : prefix, visual));
  }).slice(-visibleRows);
  get('lines').replaceChildren(...rows);
  // Stay on the latest line, and place the thumb by scroll position.
  const body = get('body');
  body.scrollTop = body.scrollHeight;
  const thumb = get('thumb');
  const overflow = body.scrollHeight - body.clientHeight;
  thumb.hidden = overflow <= 0;
  if (overflow > 0) thumb.style.top = `${(body.scrollTop / overflow) * (body.clientHeight - thumb.offsetHeight)}px`;
}

async function poll() {
  try {
    const query = new URLSearchParams({ after: String(after) });
    if (sessionId) query.set('sessionId', sessionId);
    const response = await fetch(`/local/preview-feed?${query}`);
    if (!response.ok) throw new Error('Mac 브리지에 연결할 수 없습니다.');
    const feed = await response.json();
    const select = get('session');
    const options = feed.sessions.map(item => `${item.id}|${item.label}`).join('\n');
    if (select.dataset.options !== options) {
      select.dataset.options = options;
      select.replaceChildren(...feed.sessions.map(item => new Option(`${item.label} · ${item.id.slice(-8)}`, item.id)));
    }
    if (!feed.sessionId) {
      get('note').textContent = t('연결된 세션이 없습니다. 설정에서 Orca 터미널을 G2에 연결하세요.');
      return;
    }
    if (feed.sessionId !== sessionId) {
      sessionId = feed.sessionId;
      messages = [];
      after = 0;
    }
    select.value = sessionId;
    const fresh = feed.messages.length > 0 || feed.state !== state;
    messages = messages.concat(feed.messages).slice(-400);
    after = messages.at(-1)?.id ?? after;
    state = feed.state;
    get('note').textContent = t('마지막 갱신 {time} · 받은 메시지 {count}개', { time: new Date().toLocaleTimeString(locale()), count: messages.length });
    if (fresh) render();
  } catch (error) { get('note').textContent = t(error.message); }
}

get('session').addEventListener('change', event => {
  sessionId = event.target.value;
  messages = [];
  after = 0;
  void poll();
});
get('zoom').addEventListener('change', event => document.documentElement.style.setProperty('--zoom', event.target.value));
const lens = get('lens');
lens.style.setProperty('--prefix', `${prefixWidth}px`);
lens.style.setProperty('--status-col', `${statusWidth}px`);
lens.style.setProperty('--content', `${contentWidth}px`);
mountSwitcher(get('lang'));
translate();
onLanguageChange(render);
render();
void poll();
setInterval(() => { if (!document.hidden) void poll(); }, 1000);
