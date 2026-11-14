// /api/generate — 상담일지 생성 API
//
// 보안 설계 요약 (자세한 설명은 README.md 의 "보안 설정" 참고)
//  1) Origin/Referer 검증 — 허용된 오리진(같은 오리진·localhost·APP_ALLOWED_ORIGINS) 외 호출 차단
//  2) 접근 코드 게이트 — APP_ACCESS_CODE 가 설정되면 x-app-code 헤더가 일치해야 통과
//  3) 요청 속도 제한 — IP당 분당/일일, 전체 일일 상한 (메모리 카운터)
//  4) 입력 검증 — 요청 크기 / 프롬프트 길이 / max_tokens 상한, 모델은 서버가 고정
//  5) 업스트림 오류 상세(키 상태·모델명 등)는 클라이언트로 노출하지 않고 서버 로그에만 남김
//
// 주의: 상담 메모(프롬프트)에는 민감한 개인정보가 들어 있으므로 로그에 절대 남기지 않는다.

const DEFAULT_MODEL = 'claude-sonnet-5-5'; // claude-sonnet-4-20250514 는 2026-06-15 서비스 종료됨
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const UPSTREAM_TIMEOUT_MS = 25000;

const MIN_MAX_TOKENS = 256;
const HARD_MAX_TOKENS = 4000;
const DEFAULT_MAX_TOKENS = 2000; // SOAP 표준형 일지 한 편이 1,200토큰에서 잘리던 문제 보정

// ── 설정 ──────────────────────────────────────────────
function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.floor(n);
}

function getConfig() {
  return {
    // 접근 코드: 설정하면 모든 호출에 x-app-code 헤더가 필요하다.
    accessCode: String(process.env.APP_ACCESS_CODE || '').trim(),
    // 추가 허용 오리진(쉼표 구분). 같은 오리진과 로컬 개발 주소는 자동 허용된다.
    allowedOrigins: String(process.env.APP_ALLOWED_ORIGINS || '')
      .split(',')
      .map(normalizeOrigin)
      .filter(Boolean),
    model: String(process.env.APP_MODEL || DEFAULT_MODEL).trim(),
    maxTokens: toInt(process.env.APP_MAX_TOKENS, DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS, HARD_MAX_TOKENS),
    maxPromptChars: toInt(process.env.MAX_PROMPT_CHARS, 8000, 500, 40000),
    maxBodyBytes: toInt(process.env.MAX_BODY_BYTES, 32 * 1024, 4 * 1024, 256 * 1024),
    perMinute: toInt(process.env.RATE_LIMIT_PER_MIN, 12, 1, 1000),
    perDay: toInt(process.env.RATE_LIMIT_PER_DAY, 200, 1, 100000),
    globalPerDay: toInt(process.env.RATE_LIMIT_GLOBAL_PER_DAY, 500, 1, 1000000)
  };
}

// "https://Example.com/path/" → "https://example.com"
function normalizeOrigin(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return '';
  }
}

function headerValue(req, name) {
  const headers = (req && req.headers) || {};
  const raw = headers[name] !== undefined ? headers[name] : headers[String(name).toLowerCase()];
  if (Array.isArray(raw)) return String(raw[0] || '').trim();
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

// 요청이 실제로 도달한 호스트(프록시 뒤에서도 배포 도메인)
function requestHost(req) {
  const forwarded = headerValue(req, 'x-forwarded-host').split(',')[0].trim();
  const host = forwarded || headerValue(req, 'host').split(',')[0].trim();
  return host.toLowerCase();
}

function originHost(origin) {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return '';
  }
}

function isLocalOrigin(origin) {
  const host = originHost(origin);
  const name = host.split(':')[0];
  return name === 'localhost' || name === '127.0.0.1' || name === '0.0.0.0' || name === '[::1]' || name === '::1';
}

// 브라우저 문맥 판단
//  'allowed'  : 허용된 오리진(같은 오리진/로컬/허용 목록)
//  'blocked'  : 명시된 오리진·리퍼러가 허용 목록에 없음
//  'none'     : Origin·Referer 가 모두 없음 (브라우저 밖에서 온 직접 호출)
function browserContext(req, cfg) {
  const originHeader = headerValue(req, 'origin');
  const refererHeader = headerValue(req, 'referer');
  const host = requestHost(req);

  const allowed = (value) => {
    const origin = normalizeOrigin(value);
    if (!origin) return false;
    if (cfg.allowedOrigins.includes(origin)) return true;
    if (isLocalOrigin(origin)) return true;
    return originHost(origin) === host;
  };

  if (originHeader) return allowed(originHeader) ? 'allowed' : 'blocked';
  if (refererHeader) return allowed(refererHeader) ? 'allowed' : 'blocked';
  return 'none';
}

function corsOrigin(req, cfg) {
  const origin = normalizeOrigin(headerValue(req, 'origin'));
  if (!origin) return '';
  const host = requestHost(req);
  if (cfg.allowedOrigins.includes(origin) || isLocalOrigin(origin) || originHost(origin) === host) return origin;
  return '';
}

function applyCors(req, res, cfg, allowOrigin) {
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-app-code');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ── 접근 코드 ─────────────────────────────────────────
function safeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (!left || !right) return false;
  let diff = left.length ^ right.length;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ── 속도 제한 ─────────────────────────────────────────
// 서버리스 환경에서는 인스턴스마다 카운터가 따로 잴 수 있다(최선 노력형).
// 전역 일일 상한을 함께 두어 최악의 경우에도 과금 피해가 커지지 않게 한다.
const RATE_STATE = new Map();
const RATE_STATE_MAX_KEYS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

function pruneRateState(now) {
  if (RATE_STATE.size <= RATE_STATE_MAX_KEYS) return;
  for (const [key, entry] of RATE_STATE) {
    if (now - entry.dayStart >= DAY_MS) RATE_STATE.delete(key);
  }
}

function bump(key, windowMs, limit, now) {
  let entry = RATE_STATE.get(key);
  if (!entry || now - entry.start >= windowMs) {
    entry = { start: now, count: 0 };
    RATE_STATE.set(key, entry);
  }
  entry.count += 1;
  return { count: entry.count, limited: entry.count > limit, retryAfter: Math.max(1, Math.ceil((entry.start + windowMs - now) / 1000)) };
}

function checkRateLimit(ip, cfg, now = Date.now()) {
  pruneRateState(now);
  const minute = bump(`m:${ip}`, 60 * 1000, cfg.perMinute, now);
  if (minute.limited) return { ok: false, message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', retryAfter: minute.retryAfter };

  const day = bump(`d:${ip}`, DAY_MS, cfg.perDay, now);
  if (day.limited) return { ok: false, message: '오늘 사용할 수 있는 생성 횟수를 모두 사용했습니다. 내일 다시 시도해 주세요.', retryAfter: day.retryAfter };

  const global = bump('g:all', DAY_MS, cfg.globalPerDay, now);
  if (global.limited) return { ok: false, message: '오늘 서비스 전체 생성 한도에 도달했습니다. 내일 다시 시도해 주세요.', retryAfter: global.retryAfter };

  return { ok: true };
}

function clientIp(req) {
  const forwarded = headerValue(req, 'x-forwarded-for').split(',')[0].trim();
  const ip = forwarded || headerValue(req, 'x-real-ip') || headerValue(req, 'x-vercel-forwarded-for').split(',')[0].trim();
  if (ip) return ip.slice(0, 64);
  const socket = req && req.socket;
  return (socket && socket.remoteAddress) || 'unknown';
}

// ── 입력 검증 ─────────────────────────────────────────
function readBody(req, cfg) {
  const declared = Number(headerValue(req, 'content-length'));
  if (Number.isFinite(declared) && declared > cfg.maxBodyBytes) {
    return { error: { status: 413, message: '요청 내용이 너무 큽니다.' } };
  }
  const raw = req && req.body;
  if (raw === undefined || raw === null || raw === '') return { error: { status: 400, message: '내용을 입력해주세요.' } };
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) {
    if (Buffer.byteLength(JSON.stringify(raw)) > cfg.maxBodyBytes) {
      return { error: { status: 413, message: '요청 내용이 너무 큽니다.' } };
    }
    return { body: raw };
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (Buffer.byteLength(text) > cfg.maxBodyBytes) {
    return { error: { status: 413, message: '요청 내용이 너무 큽니다.' } };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return { error: { status: 400, message: '요청 형식이 올바르지 않습니다.' } };
    return { body: parsed };
  } catch {
    return { error: { status: 400, message: '요청 형식이 올바르지 않습니다.' } };
  }
}

function validatePrompt(body, cfg) {
  const prompt = body && body.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { error: { status: 400, message: '내용을 입력해주세요.' } };
  }
  const trimmed = prompt.trim();
  if (trimmed.length > cfg.maxPromptChars) {
    return { error: { status: 413, message: `입력이 너무 깁니다. ${cfg.maxPromptChars}자 이내로 입력해 주세요.` } };
  }
  return { prompt: trimmed };
}

// 클라이언트가 보낸 max_tokens 는 상한 안에서만 인정하고, 모델은 서버 설정만 사용한다.
function resolveMaxTokens(body, cfg) {
  const requested = Number(body && body.maxTokens !== undefined ? body.maxTokens : body && body.max_tokens);
  if (!Number.isFinite(requested) || requested <= 0) return cfg.maxTokens;
  const ceiling = Math.min(HARD_MAX_TOKENS, Math.max(cfg.maxTokens, MIN_MAX_TOKENS));
  return Math.max(MIN_MAX_TOKENS, Math.min(Math.floor(requested), ceiling));
}

// ── 업스트림 호출 ─────────────────────────────────────
function upstreamPayload(model, maxTokens, prompt) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  };
  // Claude Sonnet 5.5 계열은 '사고(thinking)'가 기본으로 켜져 있어 지연·토큰이 늘어난다.
  // 상담일지는 즉답형 작업이므로 up-front thinking 을 끈다(문서상 이 모델은 'disabled' 대신 'between_tools').
  if (/^claude-sonnet-5-5/i.test(model)) {
    body.thinking = { type: 'between_tools' };
  }
  return body;
}

function mapUpstreamError(status) {
  if (status === 429) return { status: 429, message: 'AI 요청이 몰리고 있습니다. 잠시 후 다시 시도해 주세요.' };
  if (status === 401 || status === 403) return { status: 500, message: 'AI 서비스 인증에 실패했습니다. 관리자에게 문의해 주세요.' };
  if (status === 404) return { status: 500, message: 'AI 모델 설정을 확인해 주세요. 관리자에게 문의해 주세요.' };
  if (status === 400) return { status: 400, message: '요청을 처리할 수 없습니다. 입력 내용을 확인해 주세요.' };
  if (status === 503 || status === 529) return { status: 503, message: 'AI 서비스가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요.' };
  if (status === 413) return { status: 413, message: '요청 내용이 너무 큽니다.' };
  return { status: 502, message: '생성에 실패했습니다. 잠시 후 다시 시도해 주세요.' };
}

// ── 핸들러 ────────────────────────────────────────────
export default async function handler(req, res) {
  const cfg = getConfig();
  const method = String((req && req.method) || 'GET').toUpperCase();
  const allowOrigin = corsOrigin(req, cfg);

  applyCors(req, res, cfg, allowOrigin);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (method === 'OPTIONS') {
    if (headerValue(req, 'origin') && !allowOrigin) return res.status(403).end();
    return res.status(204).end();
  }
  if (method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1) Origin / Referer 검증
  const context = browserContext(req, cfg);
  if (context === 'blocked') {
    console.warn('[api/generate] blocked:origin', clientIp(req));
    return res.status(403).json({ error: '허용되지 않은 경로에서의 요청입니다.' });
  }

  // 2) 접근 코드 게이트
  if (cfg.accessCode) {
    const provided = headerValue(req, 'x-app-code') || headerValue(req, 'authorization').replace(/^Bearer\s+/i, '');
    if (!safeEqual(provided, cfg.accessCode)) {
      console.warn('[api/generate] blocked:access-code', clientIp(req));
      return res.status(401).json({ error: '접근 코드가 필요합니다.', code: 'access_code_required' });
    }
  } else if (context === 'none') {
    // 브라우저 밖(스크립트·curl)에서의 직접 호출은 접근 코드가 설정된 경우에만 허용한다.
    console.warn('[api/generate] blocked:no-origin', clientIp(req));
    return res.status(403).json({ error: '허용되지 않은 경로에서의 요청입니다.' });
  }

  // 3) 속도 제한
  const limit = checkRateLimit(clientIp(req), cfg);
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    console.warn('[api/generate] blocked:rate-limit', clientIp(req));
    return res.status(429).json({ error: limit.message });
  }

  // 4) API 키 · 입력 검증
  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    console.error('[api/generate] ANTHROPIC_API_KEY is not set');
    return res.status(503).json({ error: 'AI 서비스가 준비되지 않았습니다. 관리자에게 문의해 주세요.' });
  }

  const parsedBody = readBody(req, cfg);
  if (parsedBody.error) return res.status(parsedBody.error.status).json({ error: parsedBody.error.message });

  const checked = validatePrompt(parsedBody.body, cfg);
  if (checked.error) return res.status(checked.error.status).json({ error: checked.error.message });

  const maxTokens = resolveMaxTokens(parsedBody.body, cfg);

  // 5) 업스트림 호출
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let response;
  let data;
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify(upstreamPayload(cfg.model, maxTokens, checked.prompt)),
      signal: controller.signal
    });
    data = await response.json().catch(() => ({}));
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || controller.signal.aborted);
    console.error('[api/generate] upstream request failed:', aborted ? 'timeout' : (error && error.message));
    return res.status(aborted ? 504 : 502).json({
      error: aborted ? 'AI 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.' : 'AI 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // 상세 내용(모델명, 키 상태 등)은 서버 로그에만 남긴다.
    console.error('[api/generate] upstream error', response.status, String((data && data.error && data.error.message) || '').slice(0, 200));
    const mapped = mapUpstreamError(response.status);
    return res.status(mapped.status).json({ error: mapped.message });
  }

  const blocks = Array.isArray(data && data.content) ? data.content : [];
  const text = blocks
    .filter((block) => block && (block.type === 'text' || (block.type === undefined && typeof block.text === 'string')))
    .map((block) => block.text || '')
    .join('')
    .trim();

  if (!text) {
    console.error('[api/generate] empty completion', (data && data.stop_reason) || 'unknown');
    return res.status(502).json({ error: '생성 결과가 비어 있습니다. 다시 시도해 주세요.' });
  }

  // 응답이 토큰 상한에 걸려 잘렸는지 알려 준다(사용자가 다시 생성할지 판단할 수 있게).
  return res.status(200).json({ text, truncated: (data && data.stop_reason) === 'max_tokens' });
}
