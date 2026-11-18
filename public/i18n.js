// Minimal UI localization for the Mac pages. Korean source strings are the
// keys and English entries translate them; strings without an entry (and
// everything in Korean mode) pass through. Server messages arrive in Korean
// and are translated through the same table.
const storageKey = 'even-orca:lang';

const en = {
  // Settings page
  'Even Orca 설정': 'Even Orca Settings',
  'Orca 연결 확인 중': 'Checking Orca connection',
  'G2 미리보기': 'G2 preview',
  'G2 연결 QR': 'G2 pairing QR',
  'Even Realities 앱의 Terminal에서 스캔하세요.': 'Scan it from Terminal in the Even Realities app.',
  'Even Terminal 연결 QR 코드': 'Even Terminal pairing QR code',
  'OpenAI API 키': 'OpenAI API key',
  '키는 이 Mac의 .env 파일에 저장되고, 음성 문장 보정에만 쓰입니다. 저장한 키는 이 화면에서 다시 볼 수 없습니다.': 'The key is stored in the .env file on this Mac and used only to correct dictated prompts. A saved key cannot be viewed here again.',
  '키가 설정되어 있습니다. 바꾸려면 새 키를 입력하세요.': 'A key is set. Enter a new key to replace it.',
  '키가 없습니다. 키를 저장해야 음성 문장을 보정해 제출합니다.': 'No key yet. Save a key to correct and submit dictated prompts.',
  '키를 확인하고 저장했습니다.': 'Key verified and saved.',
  '키를 저장했습니다. OpenAI 확인은 하지 못했습니다.': 'Key saved. OpenAI could not be reached to verify it.',
  '브리지를 다시 시작하면 키를 설정할 수 있습니다.': 'Restart the bridge to set the key here.',
  'OpenAI 설정': 'OpenAI settings',
  '키 설정됨': 'key set',
  '키 없음': 'no key',
  '비워 두면 지금 키를 유지합니다': 'Leave empty to keep the current key',
  'Orca 터미널': 'Orca terminals',
  '다시 찾기': 'Refresh',
  'G2에서 쓸 Claude Code 터미널을 고르세요. Claude Code가 실행 중인 터미널만 표시됩니다.': 'Choose the Claude Code terminals the G2 can use. Only terminals running Claude Code are listed.',
  'Orca 터미널을 찾는 중입니다.': 'Looking for Orca terminals…',
  '열려 있는 Claude Code 터미널이 없습니다.': 'No open Claude Code terminals.',
  'Even 래퍼로 연결됨': 'Linked via Even wrapper',
  '연결 해제': 'Unlink',
  'G2에 연결': 'Link to G2',
  '대기 중': 'Idle',
  '작업 중': 'Working',
  'Orca에서 응답 대기': 'Waiting for input in Orca',
  '연결 끊김': 'Disconnected',
  '문장 보정': 'Prompt correction',
  '설정 저장': 'Save settings',
  'OpenAI 모델': 'OpenAI model',
  'G2에 도구 실행(Bash, Read 등) 표시': 'Show tool runs (Bash, Read, …) on the G2',
  '끄면 G2에는 에이전트의 진행 메시지와 답변만 표시됩니다.': 'When off, the G2 shows only the agent’s progress messages and answers.',
  '내 사전': 'My dictionary',
  '단어 추가': 'Add term',
  '정확한 표기를 등록하세요. 자주 생기는 오인식은 함께 적어 두면 우선 교정됩니다.': 'Add the correct spelling. Add a frequent misrecognition too and it is corrected first.',
  '오인식 표기': 'Misheard as',
  '선택': 'optional',
  '표준 표기': 'Correct spelling',
  '워크 트리': 'work tree',
  '삭제': 'Remove',
  '사전 항목 삭제': 'Remove dictionary entry',
  '최근 음성 입력': 'Recent voice input',
  '새로고침': 'Refresh',
  '아직 받은 프롬프트가 없습니다.': 'No prompts received yet.',
  '보정 중': 'Correcting',
  'Orca 연결에 전달': 'Sent to Orca',
  '제출 확인': 'Submitted',
  '제출 보류': 'Held',
  '제출 여부 미확인': 'Delivery unknown',
  '보정 · {text}': 'Corrected · {text}',
  '{seconds}초': '{seconds}s',
  '사전에 추가': 'Add to dictionary',
  '설정을 저장했습니다.': 'Settings saved.',
  'Mac 브리지에 연결할 수 없습니다.': 'Cannot reach the Mac bridge.',
  'Orca 세션 {count}개 연결됨': '{count} Orca session(s) linked',
  '연결된 Orca 세션이 없습니다.': 'No Orca sessions linked.',
  'Orca: {error}': 'Orca: {error}',
  // Preview page
  'G2 미리보기 · Even Orca': 'G2 Preview · Even Orca',
  '브리지가 G2로 보내는 내용을 안경 화면 크기(576×288)로 흉내 낸 화면입니다. 실제 화면과 다른 점을 알려 주세요.': 'Approximates the glasses display (576×288) from what the bridge sends to the G2. Glyph shapes come from this Mac’s fonts.',
  '세션': 'Session',
  '확대': 'Zoom',
  '설정': 'Settings',
  '연결된 세션을 기다리는 중입니다.': 'Waiting for a linked session.',
  '연결된 세션이 없습니다. 설정에서 Orca 터미널을 G2에 연결하세요.': 'No linked session. Link an Orca terminal to the G2 in Settings.',
  '마지막 갱신 {time} · 받은 메시지 {count}개': 'Updated {time} · {count} messages',
  // Glasses UI in the preview (English wording on the glasses is a guess).
  '생각 중': 'Thinking',
  '실행 중': 'Working',
  '입력 대기 중': 'Waiting for input',
  '응답 대기': 'Waiting',
  '[길게 눌러 입력]': '[Hold to speak]',
  '권한 요청: {tool}': 'Permission request: {tool}',
  // Server messages shown on these pages
  '설정 형식이 잘못되었습니다.': 'Invalid settings.',
  '도구 실행 표시 설정이 잘못되었습니다.': 'Invalid tool display setting.',
  '올바른 OpenAI 모델 ID를 입력하세요.': 'Enter a valid OpenAI model ID.',
  '지원하는 reasoning effort를 선택하세요.': 'Choose a supported reasoning effort.',
  'GPT-6.2 Sol과 Astra는 effort low 이상을 지원합니다.': 'GPT-6.2 Sol and Astra support effort low or higher.',
  '사전 항목은 250개까지 저장할 수 있습니다.': 'The dictionary holds up to 250 entries.',
  '사전 항목 형식이 잘못되었습니다.': 'Invalid dictionary entry.',
  '사전 입력은 줄바꿈 없이 120자까지 허용됩니다.': 'Dictionary entries allow up to 120 characters without line breaks.',
  '같은 오인식 표기가 두 번 등록되어 있습니다.': 'The same misheard form is listed twice.',
  '잘못된 설정입니다.': 'Invalid settings.',
  '요청을 처리하지 못했습니다.': 'The request failed.',
  'OpenAI API 키 형식이 아닙니다. sk-로 시작하는 키를 붙여 넣으세요.': 'That is not an OpenAI API key. Paste a key that starts with sk-.',
  'OpenAI가 이 키를 거부했습니다. 키를 다시 확인하세요.': 'OpenAI rejected this key. Check the key and try again.',
  '키를 저장하지 못했습니다.': 'Could not save the key.',
  '세션 ID가 필요합니다.': 'A session ID is required.',
  'Orca 세션을 연결하지 못했습니다.': 'Could not link the Orca session.',
  'Orca에 연결하지 못했습니다.': 'Could not reach Orca.',
  '잘못된 세션 ID입니다.': 'Invalid session ID.',
  '이미 Even 래퍼로 연결된 세션입니다.': 'This session is already linked through the Even wrapper.',
  'Orca에서 이 Claude Code 세션을 찾지 못했습니다.': 'This Claude Code session was not found in Orca.',
  'Orca CLI를 찾을 수 없습니다.': 'The Orca CLI was not found.',
  'Orca CLI 실행에 실패했습니다.': 'The Orca CLI failed to run.',
  'Orca CLI 응답을 해석하지 못했습니다.': 'Could not read the Orca CLI response.',
  'Orca 세션이 연결되어 있지 않습니다.': 'The Orca session is not linked.',
  '이전 입력 전달을 확인할 수 없습니다. Orca에서 확인하고 연동 세션을 다시 여세요.': 'The previous prompt could not be confirmed. Check Orca, then reopen the linked session.',
  'Orca가 작업 중이거나 권한 입력을 기다리고 있습니다.': 'Orca is busy or waiting for a permission answer.',
  '같은 Orca 세션의 입력 기록을 읽지 못했습니다.': 'Could not read this Orca session’s prompt history.',
  'OpenAI API 키가 없습니다. Mac 설정 화면에서 키를 입력하세요.': 'No OpenAI API key. Enter one in Mac settings.',
  'OpenAI 보정에 실패했습니다. API 키, 모델, effort 또는 연결을 확인하세요.': 'OpenAI correction failed. Check the API key, model, effort, or connection.',
  'Orca에 입력이 전달됐는지 확인할 수 없습니다. Orca에서 확인하세요.': 'Could not confirm the prompt reached Orca. Check Orca.',
  'Orca 입력을 보류했습니다.': 'The prompt was held.',
  '입력 전달 여부 미확인. Orca에서 확인하세요.': 'Delivery unconfirmed. Check Orca.',
  'Orca 세션이 사용 중입니다.': 'The Orca session is busy.',
  'Orca 터미널을 확인하지 못했습니다.': 'Could not check the Orca terminal.',
  'Orca 터미널이 바뀌었거나 닫혔습니다. 다시 연결하세요.': 'The Orca terminal changed or closed. Link it again.',
  'Orca 세션이 작업 중이거나 응답을 기다립니다.': 'The Orca session is busy or waiting for input.',
  'Claude Code가 Orca에서 응답을 기다리고 있어 입력을 보류했습니다.': 'Held: Claude Code is waiting for an answer in Orca.',
  'Orca가 입력 형식을 거부했습니다.': 'Orca rejected the prompt format.',
};

let lang = (() => {
  const requested = new URLSearchParams(location.search).get('lang');
  if (requested === 'ko' || requested === 'en') return requested;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'ko' || saved === 'en') return saved;
  } catch { /* storage unavailable */ }
  return navigator.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
})();
const listeners = [];

export const language = () => lang;
export const locale = () => (lang === 'ko' ? 'ko-KR' : 'en-US');

export function t(text, values = {}) {
  const template = lang === 'en' ? en[text] ?? text : text;
  return template.replace(/\{(\w+)\}/gu, (_, name) => String(values[name] ?? ''));
}

/** Translates [data-i18n] text and [data-i18n-<attr>] attributes under root. */
export function translate(root = document) {
  if (root === document) document.documentElement.lang = lang;
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.dataset.i18n ||= element.textContent.trim();
    element.textContent = t(element.dataset.i18n);
  }
  for (const attribute of ['placeholder', 'aria-label', 'alt', 'title']) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}

export function onLanguageChange(listener) { listeners.push(listener); }

/** Flag buttons for Korean and English in the page header. */
export function mountSwitcher(container) {
  const buttons = [['ko', '🇰🇷', '한국어'], ['en', '🇺🇸', 'English']].map(([code, flag, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'flag';
    button.textContent = flag;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', () => {
      if (code === lang) return;
      lang = code;
      try { localStorage.setItem(storageKey, code); } catch { /* storage unavailable */ }
      for (const [other, element] of buttons) element.setAttribute('aria-pressed', String(other === lang));
      translate();
      for (const listener of listeners) listener();
    });
    return [code, button];
  });
  for (const [code, button] of buttons) {
    button.setAttribute('aria-pressed', String(code === lang));
    container.append(button);
  }
}
