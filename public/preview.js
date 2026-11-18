// Rebuilds an approximation of the Even Terminal glasses view from the exact
// messages the bridge sends to the phone. Layout details are guesses to be
// corrected against the real glasses: one status line, then the latest
// conversation lines anchored to the bottom, agent lines prefixed with "> ".
const get = id => document.getElementById(id);
const statusNames = { thinking: '생각 중', busy: '실행 중', idle: '대기 중', awaiting: '응답 대기', disconnected: '연결 끊김' };
const marker = '• ';

let sessionId;
let after = 0;
let messages = [];
let state = 'idle';

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
      lines.push({ kind: 'note', text: `권한 요청: ${message.toolName ?? ''}` });
      paragraph = undefined;
    } else if (message.type === 'tool_start' || message.type === 'tool_end') {
      // Only present when "G2에 도구 실행 표시" is on.
      if (message.type === 'tool_end') lines.push({ kind: 'agent', text: `tool end: ${message.name ?? ''}` });
      paragraph = undefined;
    }
  }
  return { lines: lines.slice(-30), phase };
}

function render() {
  const { lines, phase } = screenModel(messages);
  const shown = state === 'idle' || state === 'disconnected' || state === 'awaiting' ? state : phase === 'thinking' ? 'thinking' : 'busy';
  get('status').textContent = statusNames[shown] ?? shown;
  const container = get('lines');
  container.replaceChildren(...lines.map(line => {
    const element = document.createElement('div');
    element.className = `line ${line.kind}`;
    element.textContent = line.kind === 'agent' ? `> ${line.text}` : line.text;
    return element;
  }));
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
      get('note').textContent = '연결된 세션이 없습니다. 설정에서 Orca 터미널을 G2에 연결하세요.';
      return;
    }
    if (feed.sessionId !== sessionId) {
      sessionId = feed.sessionId;
      messages = [];
      after = 0;
    }
    select.value = sessionId;
    messages = messages.concat(feed.messages).slice(-400);
    after = messages.at(-1)?.id ?? after;
    state = feed.state;
    get('note').textContent = `마지막 갱신 ${new Date().toLocaleTimeString('ko-KR')} · 받은 메시지 ${messages.length}개`;
    render();
  } catch (error) { get('note').textContent = error.message; }
}

get('session').addEventListener('change', event => {
  sessionId = event.target.value;
  messages = [];
  after = 0;
  void poll();
});
get('zoom').addEventListener('change', event => document.documentElement.style.setProperty('--zoom', event.target.value));
void poll();
setInterval(() => { if (!document.hidden) void poll(); }, 1000);
