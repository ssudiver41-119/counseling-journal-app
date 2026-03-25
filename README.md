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
├── icons/
│   ├── icon-192.png  # 앱 아이콘 (192x192)
│   └── icon-512.png  # 앱 아이콘 (512x512)
└── README.md
```
