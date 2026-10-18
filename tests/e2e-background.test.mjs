/**
 * 端到端测试“生成建议”的后台流水线（Node 24+）：
 *   DSFS_GENERATE 消息
 *     → createSession
 *     → create_pow_challenge
 *     → 本地 Wasm 解 PoW
 *     → completion（模拟 SSE）
 *     → 解析 JSON 建议
 *     → deleteSession
 *
 * 不访问真实 DeepSeek，只验证代码路径与请求形状。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';

const wasmPath = new URL('../vendor/sha3_wasm_bg.wasm', import.meta.url);
const wasmBytes = fs.readFileSync(wasmPath);

// 来自 tests/pow.test.mjs 的确定性 fixture：prefix = testsalt_1792283000_，answer = 123
const CHALLENGE = {
  algorithm: 'DeepSeekHashV1',
  challenge: '5714b0729aa1b4c3c947f4b4f7cfd6ebfb7e8f48728fb59264cee85b8416d6a2',
  salt: 'testsalt',
  expire_at: 1792283000,
  difficulty: 124,
  signature: 'test-signature',
  target_path: '/api/v0/chat/completion',
};

const calls = [];
let messageListener = null;

globalThis.chrome = {
  webRequest: {
    onBeforeSendHeaders: { addListener() {} },
    onBeforeRequest: { addListener() {} },
    onCompleted: { addListener() {} },
    onErrorOccurred: { addListener() {} },
  },
  storage: {
    local: {
      async get() {
        return { dsfs_token: 'test-token' };
      },
      async set() {},
      async remove() {},
    },
  },
  runtime: {
    onMessage: {
      addListener(listener) {
        messageListener = listener;
      },
    },
    onInstalled: { addListener() {} },
    getURL(path) {
      return `chrome-extension://test/${path}`;
    },
  },
  tabs: { sendMessage() {} },
  scripting: { async executeScript() {} },
};

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  calls.push({ url: href, options });

  if (href.startsWith('chrome-extension://')) {
    return new Response(wasmBytes, { status: 200 });
  }
  if (href.endsWith('/api/v0/chat_session/create')) {
    return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { chat_session: { id: 'session-1' } } } });
  }
  if (href.endsWith('/api/v0/chat/create_pow_challenge')) {
    return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: { challenge: CHALLENGE } } });
  }
  if (href.endsWith('/api/v0/chat/completion')) {
    const raw = JSON.stringify(['追问一', '追问二', '追问三']);
    const sse = [
      `data: ${JSON.stringify({ v: { response: { fragments: [{ type: 'RESPONSE', content: raw }] } } })}`,
      '',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
      '',
    ].join('\n');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  if (href.endsWith('/api/v0/chat_session/delete')) {
    return jsonResponse({ code: 0, data: { biz_code: 0, biz_data: {} } });
  }
  throw new Error(`unexpected fetch: ${href}`);
};

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

await import('../background.js');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

await test('background message pipeline returns 3 suggestions', async () => {
  assert.equal(typeof messageListener, 'function');

  const response = await new Promise((resolve) => {
    const keepChannelOpen = messageListener(
      { type: 'DSFS_GENERATE', question: '什么是闭包？', answer: '闭包是函数与其词法环境的组合。'.repeat(5) },
      { tab: { id: 7, url: 'https://chat.deepseek.com/a/chat/s/test' } },
      resolve,
    );
    assert.equal(keepChannelOpen, true);
  });

  assert.deepEqual(response, { ok: true, suggestions: ['追问一', '追问二', '追问三'] });
});

await test('completion request carries PoW header, session id and prompt', () => {
  const completion = calls.find((call) => call.url.endsWith('/api/v0/chat/completion'));
  assert.ok(completion, 'completion request missing');
  assert.ok(completion.options.headers['x-ds-pow-response'], 'missing PoW header');
  assert.equal(completion.options.headers.authorization, 'Bearer test-token');

  const body = JSON.parse(completion.options.body);
  assert.equal(body.chat_session_id, 'session-1');
  assert.equal(body.thinking_enabled, false);
  assert.equal(body.search_enabled, false);
  assert.ok(body.prompt.includes('什么是闭包？'));
  assert.ok(body.prompt.includes('JSON'));
});

await test('temporary session is deleted', async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(calls.some((call) => call.url.endsWith('/api/v0/chat_session/delete')));
});

await test('unexpected sender is rejected', async () => {
  const response = await new Promise((resolve) => {
    messageListener(
      { type: 'DSFS_GENERATE', question: 'x', answer: 'y'.repeat(30) },
      { tab: { id: 8, url: 'https://example.com/' } },
      resolve,
    );
  });
  assert.equal(response.ok, false);
  assert.equal(response.reason, 'unexpected-sender');
});

console.log(`\n${passed} tests passed`);
