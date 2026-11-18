import { locale, mountSwitcher, onLanguageChange, t, translate } from './i18n.js';

const get = id => document.getElementById(id);
const terms = get('terms');
const entries = get('activity');
const descriptions = {
  correcting: '보정 중', accepted: 'Orca 연결에 전달', submitted: '제출 확인', held: '제출 보류', unknown: '제출 여부 미확인',
};
const linkStates = { idle: '대기 중', busy: '작업 중', awaiting: 'Orca에서 응답 대기', disconnected: '연결 끊김' };
const headers = { 'Content-Type': 'application/json', 'X-Even-Orca-Settings': '1' };

function show(element, text, error = false) {
  element.textContent = text;
  element.classList.toggle('error', error);
}
const message = (text, error = false) => show(get('feedback'), text, error);

function addTerm(heard = '', preferred = '', focus = false) {
  const row = get('term-row').content.firstElementChild.cloneNode(true);
  translate(row);
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
  if (!response.ok) throw new Error(t('Mac 브리지에 연결할 수 없습니다.'));
  return response.json();
}

async function failure(response) {
  try { return t((await response.json()).error ?? '요청을 처리하지 못했습니다.'); }
  catch { return t('요청을 처리하지 못했습니다.'); }
}

async function loadSettings() {
  const configuration = await read('/local/settings');
  get('model').value = configuration.model;
  get('effort').value = configuration.effort;
  get('show-tools').checked = configuration.showTools;
  terms.replaceChildren();
  for (const term of configuration.terms) addTerm(term.heard, term.preferred);
}

// OpenAI key: write-only. The bridge reports only whether a key is set.
// Key, model and effort share one block that starts folded once a key is set.
let keyConfigured;
let openaiFolded = false;
function renderKey() {
  if (keyConfigured === undefined) return;
  show(get('key-status'), keyConfigured === null ? t('브리지를 다시 시작하면 키를 설정할 수 있습니다.')
    : keyConfigured ? t('키가 설정되어 있습니다. 바꾸려면 새 키를 입력하세요.') : t('키가 없습니다. 키를 저장해야 음성 문장을 보정해 제출합니다.'), keyConfigured === false);
  get('key-input').placeholder = keyConfigured ? t('비워 두면 지금 키를 유지합니다') : 'sk-...';
  const model = get('model').value;
  get('openai-summary').textContent = [model, model && get('effort').value, keyConfigured === null ? '' : t(keyConfigured ? '키 설정됨' : '키 없음')].filter(Boolean).join(' · ');
  if (!openaiFolded) {
    openaiFolded = true;
    get('openai').open = !keyConfigured;
  }
}
async function loadKey() {
  const response = await fetch('/local/openai-key').catch(() => undefined);
  keyConfigured = response?.ok ? (await response.json()).configured : null;
  renderKey();
}
async function saveKey() {
  const input = get('key-input');
  if (!input.value.trim()) return '';
  const response = await fetch('/local/openai-key', { method: 'PUT', headers, body: JSON.stringify({ key: input.value }) });
  if (!response.ok) throw new Error(await failure(response));
  const result = await response.json();
  input.value = '';
  keyConfigured = result.configured;
  return result.verified ? t('키를 확인하고 저장했습니다.') : t('키를 저장했습니다. OpenAI 확인은 하지 못했습니다.');
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
    // A rejected key stops here, before the other settings change.
    const keyResult = await saveKey();
    const response = await fetch('/local/settings', { method: 'PUT', headers, body: JSON.stringify(configuration) });
    if (!response.ok) throw new Error(await failure(response));
    message([keyResult, t('설정을 저장했습니다.')].filter(Boolean).join(' '));
    renderKey();
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
    get('connection').textContent = targets.length ? t('Orca 세션 {count}개 연결됨', { count: targets.length }) : t('연결된 Orca 세션이 없습니다.');
    const signature = JSON.stringify(activity);
    if (signature === activitySignature) return;
    activitySignature = signature;
    get('empty').hidden = activity.length > 0;
    entries.replaceChildren();
    for (const item of activity) {
      const row = append(entries, 'li', '');
      const meta = append(row, 'div', '', 'meta');
      append(meta, 'strong', t(descriptions[item.status]), item.status);
      append(meta, 'span', `${item.provider === 'claude' ? 'Claude Code' : 'Codex'} · ${item.sessionId.slice(-8)} · ${new Date(item.startedAt).toLocaleTimeString(locale())}`, 'muted');
      if (item.elapsed !== undefined) append(meta, 'span', t('{seconds}초', { seconds: (item.elapsed / 1000).toFixed(2) }), 'muted');
      append(row, 'p', item.raw, 'transcript');
      if (item.corrected && item.corrected !== item.raw) append(row, 'p', t('보정 · {text}', { text: item.corrected }), 'transcript');
      if (item.detail) append(row, 'p', t(item.detail), 'muted');
      const button = append(row, 'button', t('사전에 추가'), 'secondary record-button');
      button.type = 'button';
      button.addEventListener('click', () => {
        const selected = window.getSelection()?.toString().trim() ?? '';
        addTerm(selected.length <= 120 && item.raw.includes(selected) ? selected : '', '', true);
      });
    }
  } catch (error) { get('connection').textContent = error.message; }
}

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
    empty.textContent = error ? t('Orca: {error}', { error: t(error) }) : t('열려 있는 Claude Code 터미널이 없습니다.');
    for (const item of terminals) {
      const row = append(list, 'li', '');
      const info = append(row, 'div', '', 'orca-info');
      append(info, 'strong', item.title);
      append(info, 'span', `${item.cwd} · ${item.sessionId.slice(-8)} · ${t(linkStates[item.status] ?? item.status)}`, 'muted');
      if (item.wrapped) {
        append(row, 'span', t('Even 래퍼로 연결됨'), 'badge');
        continue;
      }
      const button = append(row, 'button', item.attached ? t('연결 해제') : t('G2에 연결'), item.attached ? 'secondary' : '');
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const response = await fetch(`/local/orca/${item.attached ? 'detach' : 'attach'}`, {
            method: 'POST', headers, body: JSON.stringify({ sessionId: item.sessionId }),
          });
          if (!response.ok) throw new Error(await failure(response));
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

mountSwitcher(get('lang'));
translate();
onLanguageChange(() => {
  renderKey();
  message('');
  activitySignature = '';
  void refresh();
  void refreshOrca();
});
get('refresh').addEventListener('click', refresh);
get('orca-refresh').addEventListener('click', refreshOrca);
get('orca-empty').textContent = t('Orca 터미널을 찾는 중입니다.');
// The folded summary shows the model and effort, so load settings first.
loadSettings().catch(error => message(error.message, true)).finally(() => void loadKey());
void refresh();
void refreshOrca();
setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
setInterval(() => { if (!document.hidden) void refreshOrca(); }, 6000);
