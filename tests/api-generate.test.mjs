// api/generate.js 핸들러 단위 테스트 (의존성 없음)
//
//   실행:  node --test tests/
//
// 저장소에는 package.json 이 없어 api/generate.js 가 ESM(.js)로 취급되지 않으므로,
// 테스트에서는 파일을 임시 .mjs 로 복사해 동적 import 한다(코드는 그대로 실행됨).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, '..', 'api', 'generate.js');

// 핸들러를 매번 새 모듈 인스턴스로 불러온다(속도 제한 카운터가 모듈 상태라 테스트 간 간섭을 막는다).
async function loadHandler(label) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cj-test-'));
  const target = path.join(dir, `generate-${label}.mjs`);
  await writeFile(target, await readFile(sourcePath, 'utf8'));
  const mod = await import(pathToFileURL(target).href);
  assert.equal(typeof mod.default, 'function', 'default export must be a function');
  return mod.default;
}

let handler;

test.before(async () => {
  handler = await loadHandler('main');
});

// ── 도우미 ────────────────────────────────────────────
function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; }
  };
  return res;
}

function makeReq({ method = 'POST', body = { prompt: '상담 메모' }, headers = {}, ip = freshIp() } = {}) {
  return {
    method,
    body,
    socket: { remoteAddress: ip },
    headers: {
      host: 'counseling-journal-app.vercel.app',
      'x-forwarded-host': 'counseling-journal-app.vercel.app',
      'x-forwarded-for': ip,
      origin: 'https://counseling-journal-app.vercel.app',
      ...headers
    }
  };
}

const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'APP_ACCESS_CODE', 'APP_ALLOWED_ORIGINS', 'APP_MODEL',
  'APP_MAX_TOKENS', 'MAX_PROMPT_CHARS', 'MAX_BODY_BYTES',
  'RATE_LIMIT_PER_MIN', 'RATE_LIMIT_PER_DAY', 'RATE_LIMIT_GLOBAL_PER_DAY'
];

function setEnv(values = {}) {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  Object.assign(process.env, values);
}

let upstreamCalls = [];
function stubFetch({ status = 200, payload = { content: [{ type: 'text', text: '생성된 일지' }] } } = {}) {
  upstreamCalls = [];
  globalThis.fetch = async (url, init) => {
    upstreamCalls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload
    };
  };
}

let ipSeed = 1;
function freshIp() {
  ipSeed += 1;
  return `10.0.0.${ipSeed}`;
}

// ── 테스트 ────────────────────────────────────────────
test('같은 오리진 브라우저 요청은 통과하고 모델은 서버가 고정한다', async () => {
  setEnv();
  stubFetch();
  const res = makeRes();
  await handler(makeReq({ body: { prompt: '상담 메모', model: 'gpt-4o', max_tokens: 999999 } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.text, '생성된 일지');
  assert.equal(res.body.truncated, false);
  assert.equal(upstreamCalls.length, 1);
  const sent = upstreamCalls[0].body;
  assert.equal(sent.model, 'claude-sonnet-5-5');
  assert.ok(sent.max_tokens <= 4000, `max_tokens 상한 초과: ${sent.max_tokens}`);
  assert.ok(sent.max_tokens >= 256);
  assert.equal(upstreamCalls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(upstreamCalls[0].init.headers['x-api-key'], 'sk-ant-test');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('허용되지 않은 Origin 은 403 으로 막고 CORS 헤더를 주지 않는다', async () => {
  setEnv();
  stubFetch();
  const res = makeRes();
  await handler(makeReq({ headers: { origin: 'https://evil.example.com' } }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(upstreamCalls.length, 0);
});

test('Referer 만 있는 경우에도 허용 목록을 검사한다', async () => {
  setEnv();
  stubFetch();
  const blocked = makeRes();
  await handler(makeReq({ headers: { origin: '', referer: 'https://evil.example.com/page' } }), blocked);
  assert.equal(blocked.statusCode, 403);

  const allowed = makeRes();
  await handler(makeReq({ headers: { origin: '', referer: 'https://counseling-journal-app.vercel.app/' } }), allowed);
  assert.equal(allowed.statusCode, 200);
});

test('Origin·Referer 가 없는 직접 호출은 접근 코드가 없으면 거절한다', async () => {
  setEnv();
  stubFetch();
  const res = makeRes();
  await handler(makeReq({ headers: { origin: '', referer: '' } }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(upstreamCalls.length, 0);
});

test('APP_ALLOWED_ORIGINS 로 다른 도메인을 허용할 수 있다', async () => {
  setEnv({ APP_ALLOWED_ORIGINS: 'https://journal.example.org, https://www.example.org/' });
  stubFetch();
  const res = makeRes();
  await handler(makeReq({ headers: { origin: 'https://journal.example.org' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['access-control-allow-origin'], 'https://journal.example.org');
});

test('로컬 개발(localhost)은 코드 없이도 같은 흐름으로 동작한다', async () => {
  setEnv();
  stubFetch();
  const res = makeRes();
  await handler(makeReq({ headers: { host: 'localhost:3000', 'x-forwarded-host': 'localhost:3000', origin: 'http://localhost:3000' } }), res);

  assert.equal(res.statusCode, 200);
});

test('APP_ACCESS_CODE 설정 시 코드 없는 요청은 401, 맞는 코드는 200', async () => {
  setEnv({ APP_ACCESS_CODE: 'counsel-2026' });
  stubFetch();

  const denied = makeRes();
  await handler(makeReq(), denied);
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.body.code, 'access_code_required');
  assert.equal(upstreamCalls.length, 0);

  const wrong = makeRes();
  await handler(makeReq({ headers: { 'x-app-code': 'nope' } }), wrong);
  assert.equal(wrong.statusCode, 401);

  const ok = makeRes();
  await handler(makeReq({ headers: { 'x-app-code': 'counsel-2026' } }), ok);
  assert.equal(ok.statusCode, 200);
});

test('접근 코드가 설정되면 브라우저 밖 직접 호출도 코드만 맞으면 허용된다', async () => {
  setEnv({ APP_ACCESS_CODE: 'counsel-2026' });
  stubFetch();
  const res = makeRes();
  await handler(makeReq({ headers: { origin: '', referer: '', 'x-app-code': 'counsel-2026' } }), res);
  assert.equal(res.statusCode, 200);
});

test('분당 호출 상한을 넘으면 429 와 Retry-After 를 돌려준다', async () => {
  setEnv({ RATE_LIMIT_PER_MIN: '2' });
  stubFetch();
  const ip = freshIp();

  const results = [];
  for (let i = 0; i < 3; i++) {
    const res = makeRes();
    await handler(makeReq({ ip }), res);
    results.push(res);
  }

  assert.equal(results[0].statusCode, 200);
  assert.equal(results[1].statusCode, 200);
  assert.equal(results[2].statusCode, 429);
  assert.ok(Number(results[2].headers['retry-after']) >= 1);
  assert.equal(upstreamCalls.length, 2, '상한을 넘은 요청은 업스트림으로 가지 않아야 한다');
});

test('IP당 일일 상한이 동작한다', async () => {
  setEnv({ RATE_LIMIT_PER_MIN: '100', RATE_LIMIT_PER_DAY: '2' });
  stubFetch();
  const ip = freshIp();

  const codes = [];
  for (let i = 0; i < 3; i++) {
    const res = makeRes();
    await handler(makeReq({ ip }), res);
    codes.push(res.statusCode);
  }
  assert.deepEqual(codes, [200, 200, 429]);
});

test('프롬프트 길이 상한을 넘으면 413', async () => {
  setEnv({ MAX_PROMPT_CHARS: '500' });
  stubFetch();
  const res = makeRes();
  await handler(makeReq({ body: { prompt: '가'.repeat(501) } }), res);
  assert.equal(res.statusCode, 413);
  assert.equal(upstreamCalls.length, 0);
});

test('본문 크기 상한을 넘으면 413', async () => {
  setEnv({ MAX_BODY_BYTES: '4096' });
  stubFetch();
  const res = makeRes();
  await handler(makeReq({ headers: { 'content-length': '9000' }, body: { prompt: '메모' } }), res);
  assert.equal(res.statusCode, 413);
});

test('prompt 가 없거나 비어 있으면 400', async () => {
  setEnv();
  stubFetch();
  for (const body of [{}, { prompt: '' }, { prompt: '   ' }, { prompt: 123 }]) {
    const res = makeRes();
    await handler(makeReq({ body }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(upstreamCalls.length, 0);
});

test('본문이 문자열로 온 경우에도 처리한다', async () => {
  setEnv();
  stubFetch();
  const res = makeRes();
  await handler(makeReq({ body: JSON.stringify({ prompt: '문자열 본문' }) }), res);
  assert.equal(res.statusCode, 200);

  const bad = makeRes();
  await handler(makeReq({ body: '{깨진 json' }), bad);
  assert.equal(bad.statusCode, 400);
});

test('GET 은 405', async () => {
  setEnv();
  stubFetch();
  const res = makeRes();
  await handler(makeReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'POST, OPTIONS');
});

test('OPTIONS 프리플라이트는 허용 오리진만 되돌려 준다', async () => {
  setEnv();
  const ok = makeRes();
  await handler(makeReq({ method: 'OPTIONS' }), ok);
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.headers['access-control-allow-origin'], 'https://counseling-journal-app.vercel.app');
  assert.match(ok.headers['access-control-allow-headers'], /x-app-code/);

  const denied = makeRes();
  await handler(makeReq({ method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } }), denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
});

test('업스트림 오류 상세는 노출하지 않고 상태 코드만 매핑한다', async () => {
  setEnv();
  stubFetch({ status: 404, payload: { error: { message: 'model: claude-sonnet-4-20250514' } } });
  const res = makeRes();
  await handler(makeReq({ ip: freshIp() }), res);

  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(res.body), /claude-sonnet-4-20250514|model:/);
  assert.match(res.body.error, /관리자에게 문의/);

  stubFetch({ status: 401, payload: { error: { message: 'invalid x-api-key' } } });
  const auth = makeRes();
  await handler(makeReq({ ip: freshIp() }), auth);
  assert.equal(auth.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(auth.body), /api-key/i);

  stubFetch({ status: 429, payload: { error: { message: 'rate limited' } } });
  const busy = makeRes();
  await handler(makeReq({ ip: freshIp() }), busy);
  assert.equal(busy.statusCode, 429);
});

test('토큰 상한으로 잘리면 truncated 표시를 돌려준다', async () => {
  setEnv();
  stubFetch({ status: 200, payload: { content: [{ type: 'text', text: '잘린 일지' }], stop_reason: 'max_tokens' } });
  const res = makeRes();
  await handler(makeReq({ ip: freshIp() }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.truncated, true);
});

test('업스트림 응답이 비어 있으면 502', async () => {
  setEnv();
  stubFetch({ status: 200, payload: { content: [{ type: 'thinking', text: '' }], stop_reason: 'max_tokens' } });
  const res = makeRes();
  await handler(makeReq({ ip: freshIp() }), res);
  assert.equal(res.statusCode, 502);
});

test('ANTHROPIC_API_KEY 가 없으면 503', async () => {
  setEnv();
  delete process.env.ANTHROPIC_API_KEY;
  stubFetch();
  const res = makeRes();
  await handler(makeReq({ ip: freshIp() }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(upstreamCalls.length, 0);
});

test('APP_MODEL 로 모델을 바꿀 수 있고, 5.5 계열이 아니면 thinking 필드를 보내지 않는다', async () => {
  setEnv({ APP_MODEL: 'claude-haiku-4-5-20251001' });
  stubFetch();
  const res = makeRes();
  await handler(makeReq({ ip: freshIp() }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(upstreamCalls[0].body.model, 'claude-haiku-4-5-20251001');
  assert.equal(upstreamCalls[0].body.thinking, undefined);
});

// 전체(전역) 카운터는 모듈 상태를 공유하므로 새 핸들러 인스턴스로 따로 검증한다.
test('전체 일일 상한이 동작한다', async () => {
  setEnv({ RATE_LIMIT_PER_MIN: '100', RATE_LIMIT_PER_DAY: '100', RATE_LIMIT_GLOBAL_PER_DAY: '2' });
  stubFetch();
  const isolated = await loadHandler('global');

  const codes = [];
  for (let i = 0; i < 3; i++) {
    const res = makeRes();
    await isolated(makeReq({ ip: freshIp() }), res);
    codes.push(res.statusCode);
  }
  assert.deepEqual(codes, [200, 200, 429]);
});
