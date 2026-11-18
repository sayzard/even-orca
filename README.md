# Even Orca

Even G2의 기존 Terminal 음성 인식 결과를 보정해서 Orca 안에서 연 Claude Code 또는 Codex 세션에 제출합니다. 녹음과 안경 표시는 Even 앱이 담당합니다. Mac 브리지는 인식된 문장에 사용자 사전과 같은 세션의 최근 입력을 적용한 뒤 자동 제출합니다. 실제로 제출된 문장과 에이전트 답변은 Even Terminal의 이벤트 스트림으로 돌아갑니다.

## 시작하기

Node.js 22.18 이상, Orca, 기존에 설정한 `claude` 또는 `codex` CLI, OpenAI API 키가 필요합니다. Mac과 휴대폰은 같은 사설 네트워크에 연결합니다.

아래 예시는 저장소를 `~/even-orca`에 받는다고 가정합니다. 다른 위치라면 경로를 바꿔 실행하세요.

```sh
git clone https://github.com/sayzard/even-orca.git ~/even-orca
cd ~/even-orca
npm ci
test -f .env || cp .env.example .env
chmod 600 .env
```

`.env`의 `OPENAI_API_KEY` 또는 `EVEN_ORCA_OPENAI_API_KEY`에 OpenAI API 키를 넣은 뒤 `npm start`를 실행합니다. 터미널이나 [Mac 설정 화면](http://127.0.0.1:3466/settings)의 **G2 연결 QR**을 Even Realities 앱의 **Terminal**에서 스캔합니다. Codex를 기본 제공자로 쓰려면 `.env`에 `EVEN_ORCA_PROVIDER=codex`를 지정합니다.

Orca에서는 작업하려는 워크스페이스의 터미널에서 아래 중 하나를 실행합니다.

```sh
~/even-orca/bin/even-orca.mjs claude
~/even-orca/bin/even-orca.mjs codex
```

기존 대화는 같은 워크스페이스에서 에이전트의 세션 UUID를 지정해 엽니다. 기존 CLI 인스턴스에서 같은 세션을 열어 둔 경우 먼저 그 인스턴스를 종료합니다.

```sh
~/even-orca/bin/even-orca.mjs claude --resume <session-id>
~/even-orca/bin/even-orca.mjs codex resume <session-id>
```

Even 앱에서 연결된 세션을 선택합니다. 새 Claude 세션이 목록에 바로 나오지 않으면 Orca에서 한 번 입력해 세션을 등록합니다. Codex에서 다른 대화로 바꿀 때는 연동 명령으로 해당 세션을 다시 엽니다. 음성 입력 중에는 Orca 입력창에 작성 중인 문장을 먼저 제출하거나 지워 두세요.

브리지 기본 포트는 `3466`, 로컬 Codex 앱 서버의 포트는 `8766`입니다. 충돌하거나 다른 네트워크 인터페이스를 사용해야 하면 [.env.example](.env.example)의 설정으로 바꿀 수 있습니다. 기존 Even Terminal 전역 설치와 페어링 설정은 별도로 유지됩니다.

### 이미 열려 있는 Orca 터미널에 연결

연동 명령 없이 Orca에서 실행 중인 Claude Code 세션을 그대로 쓸 수도 있습니다. `npm start`를 실행하면 Orca에 열린 Claude Code 터미널을 찾아 터미널에 보여 줍니다. [Mac 설정 화면](http://127.0.0.1:3466/settings)의 **Orca 터미널**에서 G2에 쓸 터미널을 **G2에 연결**하면 Even 앱 세션 목록에 나타납니다. 고른 세션은 `~/.config/even-orca/orca.json`에 저장되어, 브리지를 다시 시작해도 그 세션이 Orca에 열려 있으면 다시 연결됩니다.

- Claude Code가 실행 중인 터미널만 목록에 나옵니다. 일반 쉘 터미널에는 음성 문장이 명령어로 실행될 수 있어 제외합니다.
- 프롬프트는 `orca terminal send`로 제출하고, 답변은 세션의 대화 기록에서 읽어 G2로 보냅니다. Orca에서 직접 입력한 턴도 G2에 표시됩니다.
- 권한 요청, 선택 질문, 중단은 G2에서 처리하지 않습니다. G2에 알림이 오면 Orca 터미널에서 응답합니다. 이 기능이 필요하면 연동 명령으로 세션을 여세요.
- 터미널이 닫히거나 그 안의 프로세스가 바뀌면 연결이 풀리고 입력을 보내지 않습니다.
- Orca CLI는 `/Applications/Orca.app/Contents/Resources/bin/orca`를 사용합니다. 다른 위치라면 `EVEN_ORCA_ORCA_BIN`으로 지정합니다.

### G2 미리보기

실제 안경 화면은 캡처할 수 없어서, Mac에서 [G2 미리보기](http://127.0.0.1:3466/preview)를 열면 브리지가 G2로 보내는 내용을 안경 화면(576×288)에 가깝게 그려 줍니다. 글자 폭과 자간은 Even의 G2 펌웨어 글꼴 측정값([@evenrealities/pretext](https://www.npmjs.com/package/@evenrealities/pretext), MIT)을 쓰고, 단어 단위 줄바꿈과 `>`·`/` 표시, 빈 줄과 마크다운 강조 제거는 실제 안경과 비교해 맞췄습니다. 글자 모양은 Mac 글꼴이라 실제와 다르고, 일부 줄바꿈이 한 단어 정도 다를 수 있습니다.

## 사전 및 모델

Mac에서 [Even Orca 설정](http://127.0.0.1:3466/settings)을 엽니다. 기본 보정 모델은 `gpt-6.2-sol`, effort는 `low`입니다. 짧은 발화에서 지연을 우선할 때는 `gpt-6-luna` / `none`을 선택할 수 있습니다. 모델과 effort를 저장하면 다음 입력부터 적용됩니다. 에이전트 자체의 모델은 Orca에서 사용 중인 CLI 설정을 따릅니다.

- **표준 표기**에 `worktree`, `useAuth`, `Even Hub`처럼 자주 쓰는 이름을 추가합니다. 같은 방식으로 잘못 인식되는 단어는 **오인식 표기**도 등록합니다.
- G2에는 기본적으로 에이전트의 진행 메시지와 답변만 보냅니다. Bash, Read 같은 도구 실행 줄까지 보려면 **G2에 도구 실행 표시**를 켭니다.
- **최근 음성 입력**에서 원문, 보정문, Mac 처리 시간, 제출 여부를 확인합니다. 선택한 오인식 구절을 **사전에 추가**로 가져올 수 있습니다.
- OpenAI에는 현재 인식 문장, 관련 사전 항목, 같은 세션에서 최근에 제출한 사용자 입력 최대 5건을 보냅니다. 에이전트 답변과 오디오는 이 보정 요청에 포함되지 않습니다. Even 앱에서 직접 입력한 텍스트가 음성과 동일한 프롬프트 API로 들어오면 같은 보정을 적용합니다.
- 보정 실패, 작업 중인 세션, 권한 대기 상태에서는 제출을 보류합니다. 제출 여부가 미확인으로 표시되면 먼저 Orca에서 입력 기록을 확인합니다.

사전과 모델 설정은 Mac의 `~/.config/even-orca/settings.json`에 저장됩니다. 최근 입력 목록은 브리지가 실행되는 동안 Mac에서만 볼 수 있습니다.

## 확인 방법

```sh
npm run check
npm test
```

자동 테스트는 OpenAI 모의 응답과 Even Terminal의 Claude 전송 프로토콜을 이용해 사전 교정, 최근 입력 분리, 숫자·명령어·부정 표현 보존, 권한 대기, 중복 방지, SSE 답변 반환을 확인합니다.

실기기에서는 Orca에 먼저 `src/auth.ts의 로그인 테스트를 확인해`처럼 문맥을 넣고, `워크 트리` 같은 오인식 패턴을 등록합니다. G2에서 같은 대상에 대해 발화한 뒤 녹음을 종료해 다음을 확인합니다.

1. 보정된 문장이 Orca 세션에 한 번 제출된다.
2. G2에서 제출된 문장과 에이전트 답변을 확인할 수 있다.
3. 다른 Orca 세션에서는 앞 세션의 용어와 입력 기록이 보정에 섞이지 않는다.
4. API 키나 모델 설정 오류가 발생하면 Orca로 입력이 전달되지 않는다.
