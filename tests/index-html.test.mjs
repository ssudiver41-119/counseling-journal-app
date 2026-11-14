// index.html 화면 코드 회귀 테스트 (의존성 없음)
//
//   실행:  node --test   (tests/ 의 test 파일을 자동으로 찾는다)
//
// 화면 코드는 브라우저에서 도는데, 여기서는 index.html 에서 두 가지만 떼어 검사한다.
//  1) 상담 날짜 기본값이 기기 시간대와 무관하게 KST(Asia/Seoul) 기준 YYYY-MM-DD 인지
//  2) 일지 생성 프롬프트에 마크다운 서식 금지 지침이 들어 있는지

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(here, '..', 'index.html');
const html = await readFile(htmlPath, 'utf8');

// index.html 의 todayKST 함수 본문을 그대로 떼어 온다(코드가 바뀌면 여기서 실패해 알 수 있다).
function loadTodayKST() {
  const start = html.indexOf('function todayKST()');
  assert.ok(start >= 0, 'index.html 에 todayKST 함수가 있어야 한다');
  const end = html.indexOf('\n}', start);
  assert.ok(end > start, 'todayKST 함수 본문을 찾지 못했다');
  const source = html.slice(start, end + 2);
  assert.match(source, /todayKST/, 'todayKST 본문 확인');
  return source;
}

// 고정 시각을 돌려주는 Date 대역 — 인자 없는 new Date() 는 주어진 ISO 시각이 된다.
function dateAt(iso) {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
  }
  FakeDate.now = () => fixed;
  return FakeDate;
}

function todayKSTAt(iso) {
  const source = loadTodayKST();
  const factory = new Function('Date', `${source}\nreturn todayKST;`);
  return factory(dateAt(iso))();
}

test('상담 날짜 기본값은 KST 기준 YYYY-MM-DD 다 (UTC 는 아직 전날)', () => {
  // 한국 11-15 00:00 = UTC 11-14 15:00 → 예전 UTC 방식이면 11-14 가 떴다.
  assert.equal(todayKSTAt('2026-11-14T15:00:00Z'), '2026-11-15');
  // 한국 11-15 08:30 (새벽~오전 사이) = UTC 11-14 23:30
  assert.equal(todayKSTAt('2026-11-14T23:30:00Z'), '2026-11-15');
  // 한국 11-14 23:59 = UTC 11-14 14:59 — 아직 14일이어야 한다.
  assert.equal(todayKSTAt('2026-11-14T14:59:59Z'), '2026-11-14');
  // 월·연도 경계
  assert.equal(todayKSTAt('2026-12-31T15:00:00Z'), '2027-01-01');
  assert.equal(todayKSTAt('2027-01-31T15:00:00Z'), '2027-02-01');
});

test('상담 날짜 기본값에 UTC 기준 toISOString 계산이 남아 있지 않다', () => {
  assert.doesNotMatch(html, /new Date\(\)\.toISOString\(\)\.(split|slice)/);
  assert.match(html, /document\.getElementById\('date'\)\.value=todayKST\(\)/);
  assert.match(html, /timeZone:\s*'Asia\/Seoul'/);
});

test('일지 생성 프롬프트가 마크다운 서식 기호를 금지한다', () => {
  const start = html.indexOf('const prompt=`');
  assert.ok(start >= 0, 'index.html 에 생성 프롬프트가 있어야 한다');
  const end = html.indexOf('`;', start);
  assert.ok(end > start, '프롬프트 끝을 찾지 못했다');
  const prompt = html.slice(start, end);

  assert.match(prompt, /마크다운 서식 기호/);
  assert.match(prompt, /절대 쓰지 마세요/);
  // 실제로 문제가 되던 기호들을 이름으로 막고 있는지
  for (const token of ['**', '##', '#', '*', '_', '백틱', '~~', '>', '|']) {
    assert.ok(prompt.includes(token), `프롬프트 지침에 "${token}" 언급이 없다`);
  }
  // 기존 지침(전문 용어·강점/자원·인권 감수성·한국어)이 훼손되지 않았는지
  assert.match(prompt, /전문적이고 객관적인 사회복지 용어/);
  assert.match(prompt, /내담자의 강점과 자원/);
  assert.match(prompt, /인권 감수성/);
  assert.match(prompt, /한국어로 작성/);
  // 프롬프트가 서버 상한(8,000자) 안에 있는지 — 보강으로 넘치면 413 이 난다.
  assert.ok(prompt.length < 8000, `프롬프트가 너무 길다: ${prompt.length}자`);
});
