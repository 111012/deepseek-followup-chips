/**
 * DeepSeekHashV1 工作量证明（PoW）。
 *
 * 官方网页在调用 /api/v0/chat/completion 前会先申请 challenge，
 * 用官方 sha3_wasm_bg.wasm 在本地求出 answer，再放进 x-ds-pow-response。
 * 这里复用同一份官方 WASM（vendor/sha3_wasm_bg.wasm），不联网、不上传任何内容。
 */

const encoder = new TextEncoder();

/** 加载并实例化 PoW WASM，返回 exports。 */
export async function loadPowSolver(wasmUrl) {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`PoW wasm: HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports;
  if (
    !exports ||
    typeof exports.wasm_solve !== 'function' ||
    typeof exports.__wbindgen_export_0 !== 'function' ||
    typeof exports.__wbindgen_add_to_stack_pointer !== 'function'
  ) {
    throw new Error('PoW wasm: 导出函数不完整');
  }
  return exports;
}

/** 把字符串写入 WASM 线性内存，返回 [指针, 字节长度]。 */
function passString(exports, value) {
  const bytes = encoder.encode(value);
  const pointer = exports.__wbindgen_export_0(bytes.length, 1);
  if (!pointer) throw new Error('PoW wasm: 内存分配失败');
  new Uint8Array(exports.memory.buffer).set(bytes, pointer);
  return [pointer, bytes.length];
}

/**
 * 求出 challenge 对应的 answer。
 * @param {WebAssembly.Exports} exports
 * @param {{algorithm:string, challenge:string, salt:string, expire_at:number|string, difficulty:number, signature:string, target_path:string}} challenge
 */
export function solvePowChallenge(exports, challenge) {
  if (!challenge || challenge.algorithm !== 'DeepSeekHashV1') {
    throw new Error(`PoW: 不支持的算法 ${challenge?.algorithm ?? '(missing)'}`);
  }

  const hex = String(challenge.challenge ?? '');
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error('PoW: challenge 不是合法的十六进制字符串');
  }

  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const [challengePtr, challengeLen] = passString(exports, hex);
  const [prefixPtr, prefixLen] = passString(exports, prefix);

  // 官方的返回值布局：retptr+0 = i32 是否找到，retptr+8 = f64 answer
  const retptr = exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    exports.wasm_solve(
      retptr,
      challengePtr,
      challengeLen,
      prefixPtr,
      prefixLen,
      Number(challenge.difficulty) || 144000,
    );
    const view = new DataView(exports.memory.buffer);
    const found = view.getInt32(retptr, true);
    const answer = view.getFloat64(retptr + 8, true);
    if (!found) throw new Error('PoW: 指定难度内没有找到解');
    return answer;
  } finally {
    exports.__wbindgen_add_to_stack_pointer(16);
  }
}

/** 组装 x-ds-pow-response 请求头（Base64 的 JSON）。 */
export function buildPowHeader(challenge, answer) {
  const payload = JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  });
  return bytesToBase64(encoder.encode(payload));
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
