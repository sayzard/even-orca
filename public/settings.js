const get = id => document.getElementById(id);
const terms = get('terms');
const feedback = get('feedback');
const entries = get('activity');
const descriptions = {
  correcting: '보정 중', accepted: 'Orca 연결에 전달', submitted: '제출 확인', held: '제출 보류', unknown: '제출 여부 미확인',
};

function message(text, error = false) {
  feedback.textContent = text;
  feedback.classList.toggle('error', error);
}

function addTerm(heard = '', preferred = '', focus = false) {
  const row = get('term-row').content.firstElementChild.cloneNode(true);
  const alias = row.querySelector('[name="heard"]');
  const spelling = row.querySelector('[name="preferred"]');
  alias.value = heard;
  spelling.value = preferred;
  row.querySelector('.remove').addEventListener('click', () => row.remove());
  terms.append(row);
  if (focus) alias.focus();
}

async function read(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('Mac 브리지에 연결할 수 없습니다.');
  return response.json();
}

async function loadSettings() {
  const configuration = await read('/local/settings');
  get('model').value = configuration.model;
  get('effort').value = configuration.effort;
  get('show-tools').checked = configuration.showTools;
  terms.replaceChildren();
  for (const term of configuration.terms) addTerm(term.heard, term.preferred);
}

get('model').addEventListener('change', () => {
  if (get('model').value === 'gpt-6-luna') get('effort').value = 'none';
  if (get('model').value === 'gpt-6.2-sol') get('effort').value = 'low';
});
get('add').addEventListener('click', () => addTerm('', '', true));
get('settings').addEventListener('submit', async event => {
  event.preventDefault();
  const configuration = {
    model: get('model').value.trim(), effort: get('effort').value,
    showTools: get('show-tools').checked,
    terms: Array.from(terms.children, row => ({
      heard: row.querySelector('[name="heard"]').value,
      preferred: row.querySelector('[name="preferred"]').value,
    })),
  };
  try {
    const response = await fetch('/local/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Even-Orca-Settings': '1' },
      body: JSON.stringify(configuration),
    });
    if (!response.ok) throw new Error((await response.json()).error);
    message('설정을 저장했습니다.');
  } catch (error) { message(error.message, true); }
});

function append(parent, tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

let activitySignature = '';
const pairing = get('pairing');
// First-time users need the QR, so it starts open for the first few visits.
const visits = (() => {
  try {
    const count = Number(localStorage.getItem('even-orca:visits')) || 0;
    localStorage.setItem('even-orca:visits', String(count + 1));
    return count;
  } catch { return 0; }
})();
let pairingShown = false;
pairing.addEventListener('toggle', () => {
  const qr = pairing.querySelector('img');
  if (pairing.open && !qr.hasAttribute('src')) qr.src = '/local/pairing.svg';
});
async function refresh() {
  try {
    const { activity, targets, pairingAvailable } = await read('/local/activity');
    pairing.hidden = !pairingAvailable;
    if (pairingAvailable && !pairingShown) {
      pairingShown = true;
      if (visits < 5) pairing.open = true;
    }
    get('connection').textContent = targets.length ? `Orca 세션 ${targets.length}개 연결됨` : '연결된 Orca 세션이 없습니다.';
    const signature = JSON.stringify(activity);
    if (signature === activitySignature) return;
    activitySignature = signature;
    get('empty').hidden = activity.length > 0;
    entries.replaceChildren();
    for (const item of activity) {
      const row = append(entries, 'li', '');
      const meta = append(row, 'div', '', 'meta');
      append(meta, 'strong', descriptions[item.status], item.status);
      append(meta, 'span', `${item.provider === 'claude' ? 'Claude Code' : 'Codex'} · ${item.sessionId.slice(-8)} · ${new Date(item.startedAt).toLocaleTimeString('ko-KR')}`, 'muted');
      if (item.elapsed !== undefined) append(meta, 'span', `${(item.elapsed / 1000).toFixed(2)}초`, 'muted');
      append(row, 'p', item.raw, 'transcript');
      if (item.corrected && item.corrected !== item.raw) append(row, 'p', `보정 · ${item.corrected}`, 'transcript');
      if (item.detail) append(row, 'p', item.detail, 'muted');
      const button = append(row, 'button', '사전에 추가', 'secondary record-button');
      button.type = 'button';
      button.addEventListener('click', () => {
        const selected = window.getSelection()?.toString().trim() ?? '';
        addTerm(selected.length <= 120 && item.raw.includes(selected) ? selected : '', '', true);
      });
    }
  } catch (error) { get('connection').textContent = error.message; }
}

const linkStates = { idle: '대기 중', busy: '작업 중', awaiting: 'Orca에서 응답 대기', disconnected: '연결 끊김' };
let orcaBusy = false;
async function refreshOrca() {
  if (orcaBusy) return;
  orcaBusy = true;
  const list = get('orca-list');
  const empty = get('orca-empty');
  try {
    const { terminals, error } = await read('/local/orca');
    list.replaceChildren();
    empty.hidden = terminals.length > 0;
    empty.textContent = error ? `Orca: ${error}` : '열려 있는 Claude Code 터미널이 없습니다.';
    for (const item of terminals) {
      const row = append(list, 'li', '');
      const info = append(row, 'div', '', 'orca-info');
      append(info, 'strong', item.title);
      append(info, 'span', `${item.cwd} · ${item.sessionId.slice(-8)} · ${linkStates[item.status] ?? item.status}`, 'muted');
      if (item.wrapped) {
        append(row, 'span', 'Even 래퍼로 연결됨', 'badge');
        continue;
      }
      const button = append(row, 'button', item.attached ? '연결 해제' : 'G2에 연결', item.attached ? 'secondary' : '');
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const response = await fetch(`/local/orca/${item.attached ? 'detach' : 'attach'}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Even-Orca-Settings': '1' },
            body: JSON.stringify({ sessionId: item.sessionId }),
          });
          if (!response.ok) throw new Error((await response.json()).error);
        } catch (error) { message(error.message, true); }
        orcaBusy = false;
        await refreshOrca();
        void refresh();
      });
    }
  } catch (error) {
    empty.hidden = false;
    empty.textContent = error.message;
  } finally { orcaBusy = false; }
}

get('refresh').addEventListener('click', refresh);
get('orca-refresh').addEventListener('click', refreshOrca);
loadSettings().catch(error => message(error.message, true));
void refresh();
void refreshOrca();
setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
setInterval(() => { if (!document.hidden) void refreshOrca(); }, 6000);
