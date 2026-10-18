/**
 * DeepSeek 追问建议 — 后台 Service Worker
 *
 * 职责：
 * 1. 从 chat.deepseek.com 的 API 请求头里捕获 Bearer Token（用户零配置）。
 * 2. 监听 completion 请求的开始/结束，通知 content.js 何时算“回答完成”。
 * 3. 用同一账号的 Web API 发起一次轻量请求，生成 3 条追问建议。
 *
 * 隐私：Token 只保存在 chrome.storage.local；问题和回答只发送到
 * https://chat.deepseek.com 官方接口，不经过任何第三方。
 */

import { buildPrompt, parseSuggestions, SseResponseCollector } from './lib/core.js';
import { buildPowHeader, loadPowSolver, solvePowChallenge } from './lib/pow.js';

const API_ORIGIN = 'https://chat.deepseek.com';
const COMPLETION_PATH = '/api/v0/chat/completion';
const TOKEN_KEY = 'dsfs_token';
const TOKEN_AT_KEY = 'dsfs_token_at';
const REQUEST_TIMEOUT_MS = 25000;

const CLIENT_HEADERS = {
  'x-client-platform': 'web',
  'x-client-version': '2.5.0',
  'x-client-locale': getLocale(),
  'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
};

/** 每个 tab 最近一次 completion 请求，用于把“完成事件”配对到具体问题。 */
const tabRequests = new Map();
/** 每个 tab 正在进行的建议生成请求，新一轮提问时取消旧请求。 */
const inflight = new Map();

let cachedToken = null;
let tokenLoaded = false;
let tokenLoading = null;
let wasmPromise = null;
let cachedHif = null;

/* ------------------------------------------------------------------ */
/* Token                                                               */
/* ------------------------------------------------------------------ */

function getLocale() {
  const raw = (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN';
  return raw.replace(/-/g, '_');
}

function extractBearer(headers) {
  for (const header of headers || []) {
    const name = String(header?.name || '').toLowerCase();
    const value = String(header?.value || '');
    if (name === 'authorization' && /^Bearer\s+/i.test(value)) {
      return value.replace(/^Bearer\s+/i, '').trim() || null;
    }
  }
  return null;
}

function rememberHif(headers) {
  const next = { ...(cachedHif || {}) };
  let changed = false;
  for (const header of headers || []) {
    const name = String(header?.name || '').toLowerCase();
    if (name === 'x-hif-leim' && header.value) {
      next.leim = String(header.value);
      changed = true;
    } else if (name === 'x-hif-dliq' && header.value) {
      next.dliq = String(header.value);
      changed = true;
    }
  }
  if (changed) cachedHif = next;
}

async function getToken() {
  if (cachedToken) return cachedToken;
  if (tokenLoaded) return cachedToken;
  if (!tokenLoading) {
    tokenLoading = (async () => {
      try {
        const stored = await chrome.storage.local.get([TOKEN_KEY]);
        const value = stored?.[TOKEN_KEY];
        if (!cachedToken && typeof value === 'string' && value) cachedToken = value;
      } catch {
        // 读不到就当作没有 Token
      } finally {
        tokenLoaded = true;
        tokenLoading = null;
      }
      return cachedToken;
    })();
  }
  return tokenLoading;
}

async function saveToken(token) {
  if (!token || token === cachedToken) return;
  cachedToken = token;
  tokenLoaded = true;
  try {
    await chrome.storage.local.set({ [TOKEN_KEY]: token, [TOKEN_AT_KEY]: Date.now() });
  } catch {
    // 存储失败不阻塞主流程，下一次请求会再次捕获
  }
}

async function clearToken() {
  cachedToken = null;
  tokenLoaded = true;
  try {
    await chrome.storage.local.remove([TOKEN_KEY, TOKEN_AT_KEY]);
  } catch {
    // ignore
  }
}

/* ------------------------------------------------------------------ */
/* webRequest：捕获 Token / HIF，跟踪 completion 生命周期                */
/* ------------------------------------------------------------------ */

function registerHeaderListener(withExtraHeaders) {
  const extraInfoSpec = withExtraHeaders
    ? ['requestHeaders', 'extraHeaders']
    : ['requestHeaders'];
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      // 只从页面请求里学 Token；扩展自己发出的临时会话请求（tabId = -1）
      // 可能在 Token 已失效后把它重新写回存储。
      if (details.tabId < 0) return;
      const token = extractBearer(details.requestHeaders);
      if (token) void saveToken(token);
      rememberHif(details.requestHeaders);
    },
    { urls: [`${API_ORIGIN}/api/*`] },
    extraInfoSpec,
  );
}

try {
  registerHeaderListener(true);
} catch {
  registerHeaderListener(false);
}

function isCompletionRequest(details) {
  if (!details || details.method !== 'POST') return false;
  try {
    const url = new URL(details.url);
    return url.origin === API_ORIGIN && url.pathname.replace(/\/+$/, '') === COMPLETION_PATH;
  } catch {
    return false;
  }
}

function parseRequestBody(requestBody) {
  if (!requestBody || !Array.isArray(requestBody.raw) || !requestBody.raw.length) return null;
  try {
    const decoder = new TextDecoder();
    const text = requestBody.raw
      .map((part) => (part?.bytes ? decoder.decode(part.bytes) : ''))
      .join('');
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function notifyTab(tabId, message) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      // 页面还没有 content script 时会报错，忽略即可
      void chrome.runtime.lastError;
    });
  } catch {
    // ignore
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isCompletionRequest(details) || details.tabId < 0) return;

    const body = parseRequestBody(details.requestBody);
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    const sessionId = body?.chat_session_id ?? null;

    // 新一轮提问：取消上一轮还没跑完的建议请求
    const previous = inflight.get(details.tabId);
    if (previous) previous.abort('new-generation');

    tabRequests.set(details.tabId, {
      requestId: details.requestId,
      prompt,
      sessionId,
      startedAt: Date.now(),
    });
    if (tabRequests.size > 50) {
      const oldest = tabRequests.keys().next().value;
      tabRequests.delete(oldest);
    }

    notifyTab(details.tabId, {
      type: 'DSFS_GENERATION_START',
      prompt,
      sessionId,
    });
  },
  { urls: [`${API_ORIGIN}${COMPLETION_PATH}*`] },
  ['requestBody'],
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!isCompletionRequest(details) || details.tabId < 0) return;
    const tracked = tabRequests.get(details.tabId);
    if (!tracked || tracked.requestId !== details.requestId) return;

    if (details.statusCode >= 200 && details.statusCode < 300) {
      notifyTab(details.tabId, {
        type: 'DSFS_GENERATION_DONE',
        prompt: tracked.prompt,
        sessionId: tracked.sessionId,
      });
    } else {
      notifyTab(details.tabId, { type: 'DSFS_GENERATION_ABORTED' });
    }
    tabRequests.delete(details.tabId);
  },
  { urls: [`${API_ORIGIN}${COMPLETION_PATH}*`] },
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!isCompletionRequest(details) || details.tabId < 0) return;
    notifyTab(details.tabId, { type: 'DSFS_GENERATION_ABORTED' });
    tabRequests.delete(details.tabId);
  },
  { urls: [`${API_ORIGIN}${COMPLETION_PATH}*`] },
);

/* ------------------------------------------------------------------ */
/* 消息入口                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  const senderUrl = sender?.tab?.url || sender?.url || '';
  if (!senderUrl.startsWith(`${API_ORIGIN}/`)) {
    sendResponse({ ok: false, reason: 'unexpected-sender' });
    return undefined;
  }

  if (message.type === 'DSFS_INJECT') {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, reason: 'no-tab' });
      return undefined;
    }
    chrome.scripting
      .executeScript({ target: { tabId }, world: 'MAIN', files: ['injected.js'] })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
    return true;
  }

  if (message.type === 'DSFS_TOKEN') {
    // content script 的兜底：同源请求 /api/v0/users/current 拿到 Token
    const token = typeof message.token === 'string' ? message.token.trim() : '';
    if (token.length < 20 || token.length > 4096) {
      sendResponse({ ok: false, reason: 'invalid-token' });
      return undefined;
    }
    saveToken(token)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'DSFS_GENERATE') {
    const tabId = sender?.tab?.id ?? -1;
    generateSuggestions(message, tabId)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.warn('[DeepSeek Follow-ups] generate failed:', error?.message || error);
        sendResponse({ ok: false, reason: String(error?.message || error) });
      });
    return true;
  }

  return undefined;
});

/* ------------------------------------------------------------------ */
/* 生成建议                                                            */
/* ------------------------------------------------------------------ */

async function generateSuggestions(message, tabId) {
  const question = typeof message.question === 'string' ? message.question.slice(0, 2000) : '';
  const answer = typeof message.answer === 'string' ? message.answer.slice(0, 20000) : '';
  if (answer.trim().length < 10) return { ok: false, reason: 'empty-answer' };

  const token = await getToken();
  if (!token) {
    console.info('[DeepSeek Follow-ups] 尚未捕获到登录 Token，先刷新页面或发一条消息。');
    return { ok: false, reason: 'no-token' };
  }

  const previous = inflight.get(tabId);
  if (previous) previous.abort('superseded');

  const controller = new AbortController();
  inflight.set(tabId, controller);
  const timer = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);

  let sessionId = null;
  try {
    sessionId = await createSession(token, controller.signal);
    const prompt = buildPrompt(question, answer);
    const raw = await runCompletion(token, sessionId, prompt, controller.signal);
    const suggestions = parseSuggestions(raw, { max: 3, maxChars: 30 });
    if (!suggestions.length) {
      console.warn('[DeepSeek Follow-ups] 模型没有返回可用的 JSON 建议。');
      return { ok: false, reason: 'no-suggestions' };
    }
    return { ok: true, suggestions };
  } catch (error) {
    let reason = controller.signal.aborted
      ? String(controller.signal.reason || 'aborted')
      : String(error?.message || error);
    // DeepSeek 对无效 Token 常常返回 HTTP 200 + code 40003；转成 no-token，
    // 让 content script 走一次同源 /users/current 兜底。
    if (/code 4000[23]|invalid token|authorization failed/i.test(reason)) {
      await clearToken();
      reason = 'no-token';
    }
    // 不打印问题/回答，避免把对话内容写进日志
    console.warn('[DeepSeek Follow-ups] suggestion request failed:', reason);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
    if (inflight.get(tabId) === controller) inflight.delete(tabId);
    if (sessionId) void deleteSession(token, sessionId);
  }
}

function buildApiHeaders(token, extra = {}, includeHif = false) {
  const headers = {
    ...CLIENT_HEADERS,
    authorization: `Bearer ${token}`,
    ...extra,
  };
  if (includeHif) {
    if (cachedHif?.leim) headers['x-hif-leim'] = cachedHif.leim;
    if (cachedHif?.dliq) headers['x-hif-dliq'] = cachedHif.dliq;
  }
  return headers;
}

function unwrapBizData(json) {
  if (!json || json.code !== 0) throw new Error(`api code ${json?.code ?? 'unknown'}`);
  const biz = json.data;
  if (!biz) throw new Error('api data missing');
  if (biz.biz_code !== undefined && biz.biz_code !== 0) {
    throw new Error(`biz code ${biz.biz_code}`);
  }
  return biz.biz_data;
}

async function apiJson(path, token, body, signal) {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    method: 'POST',
    headers: buildApiHeaders(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    credentials: 'include',
    signal,
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) await clearToken();
    const text = await response.text().catch(() => '');
    let code = null;
    try {
      code = JSON.parse(text)?.code ?? null;
    } catch {
      // 非 JSON 错误页，不记录正文
    }
    throw new Error(`HTTP ${response.status}${code !== null ? ` code ${code}` : ''}`);
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error('response is not JSON');
  }
  if (json?.code === 40002 || json?.code === 40003) await clearToken();
  return json;
}

async function createSession(token, signal) {
  const json = await apiJson('/api/v0/chat_session/create', token, {}, signal);
  const data = unwrapBizData(json);
  const id = data?.chat_session?.id;
  if (id === undefined || id === null || id === '') throw new Error('create session: no id');
  return String(id);
}

async function deleteSession(token, sessionId) {
  try {
    await fetch(`${API_ORIGIN}/api/v0/chat_session/delete`, {
      method: 'POST',
      headers: buildApiHeaders(token, { 'content-type': 'application/json' }),
      body: JSON.stringify({ chat_session_id: sessionId }),
      credentials: 'include',
    });
  } catch {
    // 删除失败时会在账号里留下一个空会话，README 已说明
  }
}

function getPowSolver() {
  if (!wasmPromise) {
    wasmPromise = loadPowSolver(chrome.runtime.getURL('vendor/sha3_wasm_bg.wasm')).catch((error) => {
      wasmPromise = null;
      throw error;
    });
  }
  return wasmPromise;
}

async function buildPowHeaderFor(token, targetPath, signal) {
  const [solver, challengeJson] = await Promise.all([
    getPowSolver(),
    apiJson('/api/v0/chat/create_pow_challenge', token, { target_path: targetPath }, signal),
  ]);
  const challenge = unwrapBizData(challengeJson)?.challenge;
  if (!challenge?.challenge) throw new Error('pow challenge missing');
  const answer = solvePowChallenge(solver, challenge);
  return buildPowHeader(challenge, answer);
}

async function runCompletion(token, sessionId, prompt, signal) {
  const powHeader = await buildPowHeaderFor(token, COMPLETION_PATH, signal);

  const response = await fetch(`${API_ORIGIN}${COMPLETION_PATH}`, {
    method: 'POST',
    headers: buildApiHeaders(token, {
      'content-type': 'application/json',
      'x-ds-pow-response': powHeader,
    }, true),
    body: JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: null,
      model_type: null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false,
      preempt: false,
    }),
    credentials: 'include',
    signal,
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) await clearToken();
    const text = await response.text().catch(() => '');
    let code = null;
    try {
      code = JSON.parse(text)?.code ?? null;
    } catch {
      // ignore
    }
    throw new Error(`completion HTTP ${response.status}${code !== null ? ` code ${code}` : ''}`);
  }
  if (!response.body) throw new Error('completion: empty body');

  const contentType = response.headers.get('content-type') || '';
  if (contentType && !contentType.includes('text/event-stream') && !contentType.includes('text/plain')) {
    const text = await response.text().catch(() => '');
    let code = null;
    try {
      code = JSON.parse(text)?.code ?? null;
    } catch {
      // ignore
    }
    if (code === 40002 || code === 40003) await clearToken();
    throw new Error(`completion unexpected content-type: ${contentType}${code !== null ? ` code ${code}` : ''}`);
  }

  const collector = new SseResponseCollector();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      collector.feed(decoder.decode(value, { stream: true }));
      if (collector.finished) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    collector.feed(decoder.decode());
    collector.feed('\n');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  const text = collector.text;
  if (!text) throw new Error('completion: no response text');
  return text;
}

/* ------------------------------------------------------------------ */
/* 生命周期日志（便于排查）                                              */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(() => {
  console.info('[DeepSeek Follow-ups] installed. 打开 chat.deepseek.com 并提问即可。');
});
