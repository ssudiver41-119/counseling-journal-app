# 상담일지 자동생성 앱

사회복지 현장을 위한 AI 상담일지 자동생성 PWA

## 배포 방법 (GitHub + Vercel)

### 1단계 — GitHub 저장소 만들기

1. [github.com](https://github.com) 접속 → 로그인
2. 오른쪽 상단 **+** → **New repository**
3. Repository name: `counseling-journal-app`
4. **Public** 선택 → **Create repository**

### 2단계 — 파일 올리기

1. 생성된 저장소 페이지에서 **uploading an existing file** 클릭
2. 아래 파일들을 드래그하여 업로드:
   - `index.html`
   - `manifest.json`
   - `sw.js`
   - `vercel.json`
   - `icons/` 폴더 (icon-192.png, icon-512.png)
3. **Commit changes** 클릭

### 3단계 — Vercel 배포

1. [vercel.com](https://vercel.com) 접속 → **Sign up with GitHub**
2. 대시보드에서 **Add New Project**
3. GitHub 저장소 `counseling-journal-app` 선택 → **Import**
4. 설정 변경 없이 **Deploy** 클릭
5. 배포 완료 후 `https://counseling-journal-app.vercel.app` 주소 생성

### 4단계 — 스마트폰 홈화면 추가

**iPhone (Safari)**
1. Safari에서 앱 주소 접속
2. 하단 공유 버튼(□↑) → **홈 화면에 추가**

**Android (Chrome)**
1. Chrome에서 앱 주소 접속
2. 주소창 오른쪽 메뉴(⋮) → **홈 화면에 추가**
   또는 앱 내 배너에서 **설치** 버튼 클릭

## 기능

- ✨ AI 상담일지 자동 생성 (Claude AI)
- 📄 DOCX 파일 내보내기
- 💾 로컬 저장 (기기에 저장)
- 🔒 PIN 잠금
- ⚙ 기관명·상담사명 설정
- 📲 PWA (홈화면 설치, 오프라인 지원)

## 파일 구조

```
counseling-journal-app/
├── index.html        # 메인 앱
├── manifest.json     # PWA 설정
├── sw.js             # Service Worker
├── vercel.json       # Vercel 배포 설정
├── api/
│   └── generate.js   # AI 생성 API (보안 게이트 포함)
├── tests/
│   └── api-generate.test.mjs  # API 단위 테스트
├── icons/
│   ├── icon-192.png  # 앱 아이콘 (192x192)
│   └── icon-512.png  # 앱 아이콘 (512x512)
└── README.md
```

## 보안 설정 (API 보호)

`/api/generate` 는 Anthropic API 키로 동작하므로, 키가 있는 서버가 아무나 호출할 수 있으면
요금이 새어 나갈 수 있습니다. 아래 장치가 기본으로 동작합니다.

| 장치 | 동작 |
| --- | --- |
| 오리진(Origin/Referer) 검증 | 같은 사이트·로컬 개발(localhost)에서 온 요청만 허용. 외부 도메인 페이지·스크립트에서의 호출은 403 |
| 직접 호출 차단 | 브라우저 문맥(Origin·Referer)이 없는 호출(curl, 스크립트)은 접근 코드가 없으면 403 |
| 접근 코드 게이트 | `APP_ACCESS_CODE` 를 설정하면 `x-app-code` 헤더가 일치해야 통과(불일치 401) |
| 속도 제한 | IP당 분당·일일, 서비스 전체 일일 상한(초과 시 429 + `Retry-After`) |
| 입력 검증 | 본문 크기(기본 32KB), 프롬프트 길이(기본 8000자), `max_tokens` 상한(기본 2000, 최대 4000) |
| 모델 고정 | 모델은 서버 설정값만 사용(클라이언트가 보낸 모델은 무시) |
| 오류 최소화 | 업스트림 오류 상세(모델명·키 상태)는 응답에 싣지 않고 서버 로그에만 기록 |

상담 메모에는 민감한 개인정보가 들어가므로 **프롬프트 내용은 로그에 남기지 않습니다.**

### 환경변수 (Vercel → Settings → Environment Variables)

| 이름 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | ✅ | — | Anthropic API 키 |
| `APP_ACCESS_CODE` | 권장 | (없음) | 설정 시 앱의 ⚙ 설정 → **API 접근 코드** 에 같은 값을 입력해야 생성됨 |
| `APP_ALLOWED_ORIGINS` | 선택 | (없음) | 추가로 허용할 오리진, 쉼표 구분 (예: `https://내도메인.com`) |
| `APP_MODEL` | 선택 | `claude-sonnet-5-5` | 사용할 Claude 모델 ID |
| `APP_MAX_TOKENS` | 선택 | `2000` | 응답 최대 토큰(256~4000). 표준형 SOAP 일지가 잘리면 이 값을 올리세요 |
| `MAX_PROMPT_CHARS` | 선택 | `8000` | 프롬프트 최대 글자수 |
| `RATE_LIMIT_PER_MIN` | 선택 | `12` | IP당 1분 호출 상한 |
| `RATE_LIMIT_PER_DAY` | 선택 | `200` | IP당 1일 호출 상한 |
| `RATE_LIMIT_GLOBAL_PER_DAY` | 선택 | `500` | 서비스 전체 1일 호출 상한 |

> 접근 코드를 켜는 순서: 코드를 정해 Vercel 환경변수 `APP_ACCESS_CODE` 에 넣고 재배포 →
> 각 기기에서 앱 ⚙ 설정 → **API 접근 코드** 에 같은 값을 저장. 코드를 비우면 위의 오리진·속도 제한만 적용됩니다.

> 모델: `claude-sonnet-4-20250514` 는 2026-06-15 서비스 종료되어 더 이상 동작하지 않습니다.
> 현재 기본값은 `claude-sonnet-5-5` 입니다.

### 테스트

```bash
node --test
```

- `tests/api-generate.test.mjs` — 서버 함수(보안·입력 검증·업스트림 요청 형태)
- `tests/index-html.test.mjs` — 화면 코드(상담 날짜 KST 기본값, 마크다운 금지 지침)

### 알아둘 점

- 속도 제한 카운터는 서버 함수 메모리에 있습니다. 서버리스에서는 인스턴스마다 따로 세어질 수 있어
  정밀한 차단보다는 **과금 폭주 방지용 안전판**으로 보는 것이 맞습니다.
- Vercel Hobby 플랜의 함수 실행 시간 제한(기본 10초)에 걸리면 `vercel.json` 의 `functions` 설정으로
  `maxDuration` 을 늘릴 수 있습니다.
