import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPowHeader, solvePowChallenge } from '../lib/pow.js';

// Node 16 没有全局 btoa；扩展环境（Service Worker）原生支持
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (binary) => Buffer.from(binary, 'binary').toString('base64');
}

const wasmBytes = fs.readFileSync(new URL('../vendor/sha3_wasm_bg.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const exports = instance.exports;

const encoder = new TextEncoder();
function writeString(value) {
  const bytes = encoder.encode(value);
  const pointer = exports.__wbindgen_export_0(bytes.length, 1);
  new Uint8Array(exports.memory.buffer).set(bytes, pointer);
  return [pointer, bytes.length];
}

/**
 * 官方挑战的生成方式：challenge = hex(wasm_deepseek_hash_v1(prefix + answer))。
 * 这里用同一个 Wasm 反推一个“必然有解”的挑战，从而在本地验证 solver。
 */
function makeChallenge({ salt, expireAt, answer }) {
  const prefix = `${salt}_${expireAt}_`;
  const [inputPtr, inputLen] = writeString(`${prefix}${answer}`);
  const resultPtr = exports.__wbindgen_export_0(16, 1);
  exports.wasm_deepseek_hash_v1(resultPtr, inputPtr, inputLen);

  const view = new DataView(exports.memory.buffer);
  const hashPtr = view.getUint32(resultPtr, true);
  const hashLen = view.getUint32(resultPtr + 4, true);
  const hashText = String.fromCharCode(
    ...new Uint8Array(exports.memory.buffer, hashPtr, hashLen),
  );

  return {
    algorithm: 'DeepSeekHashV1',
    challenge: hashText,
    salt,
    expire_at: expireAt,
    difficulty: answer + 1,
    signature: 'test-signature',
    target_path: '/api/v0/chat/completion',
  };
}

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

await test('PoW solver finds the answer for a valid challenge', () => {
  const answer = 123;
  const challenge = makeChallenge({ salt: 'testsalt', expireAt: 1792283000, answer });
  assert.equal(challenge.challenge.length, 64);
  assert.equal(solvePowChallenge(exports, challenge), answer);
});

await test('PoW solver handles a larger answer / difficulty', () => {
  const answer = 4096;
  const challenge = makeChallenge({ salt: 'another-salt', expireAt: 1792289999, answer });
  assert.equal(solvePowChallenge(exports, challenge), answer);
});

await test('buildPowHeader produces a decodable payload', () => {
  const answer = 7;
  const challenge = makeChallenge({ salt: 'header-salt', expireAt: 1792283001, answer });
  const header = buildPowHeader(challenge, answer);
  const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  assert.equal(payload.algorithm, 'DeepSeekHashV1');
  assert.equal(payload.answer, answer);
  assert.equal(payload.challenge, challenge.challenge);
  assert.equal(payload.target_path, '/api/v0/chat/completion');
});

await test('PoW solver rejects unsupported algorithms', () => {
  assert.throws(
    () => solvePowChallenge(exports, { algorithm: 'SHA256', challenge: '00' }),
    /不支持的算法/,
  );
});

console.log(`\n${passed} tests passed`);
