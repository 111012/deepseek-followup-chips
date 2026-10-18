/**
 * 纯函数与 SSE 解析：不依赖 chrome / DOM，可直接在 Node 中测试。
 */

/** 截断过长文本，保留开头和结尾，避免把整篇长回答塞进提示词。 */
export function clampText(value, maxChars) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (text.length <= maxChars) return text;
  const tail = Math.floor(maxChars * 0.25);
  const head = maxChars - tail;
  return `${text.slice(0, head)}\n…\n${text.slice(-tail)}`;
}

/**
 * 生成“追问建议”的提示词。
 * 只要求模型输出 JSON 数组，语言跟随助手回答。
 */
export function buildPrompt(question, answer) {
  const q = clampText(question, 800) || '（未捕获到用户问题，请只根据助手回答推断）';
  const a = clampText(answer, 6000);

  return [
    '你是对话助手的“追问建议”生成器。阅读下面这一轮对话，写出用户最可能接着问的 3 个问题。',
    '',
    '规则：',
    '1. 只输出一个 JSON 字符串数组，例如 ["问题一","问题二","问题三"]',
    '2. 恰好 3 条，每条不超过 30 个字符',
    '3. 使用与【助手回答】相同的语言',
    '4. 每条都是用户视角、可独立理解的完整问句，具体且彼此不重复',
    '5. 不要编号、不要解释、不要输出 Markdown 代码块',
    '',
    '【用户问题】',
    q,
    '',
    '【助手回答】',
    a,
  ].join('\n');
}

/**
 * 从模型输出中解析建议列表。
 * 兼容 Markdown 代码块、前后解释文字、对象数组、失败时的逐行/引号兜底。
 */
export function parseSuggestions(raw, { max = 3, maxChars = 30 } = {}) {
  const text = String(raw ?? '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  if (!text) return [];

  let list = null;

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      // 继续尝试兜底解析
    }
  }

  if (!list) {
    const quoted = [...text.matchAll(/["“]([^"“”\n]{2,60})["”]/g)].map((m) => m[1]);
    if (quoted.length >= 2) list = quoted;
  }

  if (!list) {
    // 只接受明显的列表行，避免把“好的，以下是三个建议：”这类说明当成追问
    const lines = text
      .split(/\r?\n/)
      .filter((line) => /^\s*(?:[-*•]|\d+\s*[.)、:：])\s*/.test(line))
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+\s*[.)、:：])\s*/, '').trim())
      .filter((line) => line.length >= 2 && line.length <= 80);
    if (lines.length >= 2) list = lines;
  }

  if (!Array.isArray(list)) return [];

  const seen = new Set();
  const result = [];
  for (const item of list) {
    const value =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? item.text ?? item.suggestion ?? item.question ?? ''
          : '';
    let suggestion = String(value)
      .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!suggestion) continue;

    const chars = Array.from(suggestion);
    if (chars.length > maxChars) suggestion = chars.slice(0, maxChars).join('');
    if (suggestion.length < 2) continue;

    const key = suggestion.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(suggestion);
    if (result.length >= max) break;
  }
  return result;
}

/**
 * 增量解析 DeepSeek 的 SSE patch 流，只保留 RESPONSE 片段。
 *
 * 支持：
 *   data: {"v":{"response":{"fragments":[...]}}}
 *   data: {"p":"response/fragments/-1/content","o":"APPEND","v":"..."}
 *   data: {"p":"response","o":"BATCH","v":[...]}
 *   event: close / finish
 */
export class SseResponseCollector {
  constructor() {
    this.buffer = '';
    this.fragments = [];
    this.status = '';
    this.closed = false;
  }

  feed(chunk) {
    if (!chunk) return;
    this.buffer += String(chunk);
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.#consumeLine(line.replace(/\r$/, ''));
  }

  #consumeLine(line) {
    if (!line || line.startsWith(':')) return;

    if (line.startsWith('event:')) {
      const eventName = line.slice(6).trim();
      if (eventName === 'close' || eventName === 'finish') this.closed = true;
      return;
    }

    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return;

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    // 初始快照：{"v":{"response":{...}}}
    if (!payload.p && payload.v && typeof payload.v === 'object' && !Array.isArray(payload.v)) {
      const response = payload.v.response;
      if (response && typeof response === 'object') {
        if (Array.isArray(response.fragments)) this.fragments = response.fragments;
        if (response.status) this.status = response.status;
      }
      return;
    }

    // 纯文本增量：{"v":"闭"}，追加到当前最后一个 fragment
    if (!payload.p && typeof payload.v === 'string') {
      const fragment = this.fragments[this.fragments.length - 1];
      if (fragment && typeof fragment === 'object') {
        fragment.content = String(fragment.content ?? '') + payload.v;
      }
      return;
    }

    if (typeof payload.p === 'string') {
      this.#applyPatch(payload.p, payload.o || 'SET', payload.v);
    }
  }

  #applyPatch(path, op, value) {
    if (op === 'BATCH' && Array.isArray(value)) {
      const base = path === 'response' ? '' : path;
      for (const sub of value) {
        if (!sub || typeof sub.p !== 'string') continue;
        const subPath = base ? `${base}/${sub.p}` : `response/${sub.p}`;
        this.#applyPatch(subPath, sub.o || 'SET', sub.v);
      }
      return;
    }

    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'response') parts.shift();
    if (!parts.length) {
      if (value && typeof value === 'object') {
        if (Array.isArray(value.fragments)) this.fragments = value.fragments;
        if (value.status) this.status = value.status;
      }
      return;
    }

    if (parts[0] === 'fragments') {
      if (parts.length === 1) {
        if (op === 'APPEND') this.fragments.push(...(Array.isArray(value) ? value : [value]));
        else if (op === 'SET' && Array.isArray(value)) this.fragments = value;
        return;
      }

      const index = this.#resolveIndex(parts[1]);
      if (index === -1) return;
      const fragment = this.fragments[index];
      if (!fragment || typeof fragment !== 'object') return;

      if (parts.length === 2) {
        if (value && typeof value === 'object') Object.assign(fragment, value);
        return;
      }

      if (parts[2] === 'content') {
        if (op === 'APPEND') fragment.content = String(fragment.content ?? '') + String(value ?? '');
        else if (op === 'SET') fragment.content = String(value ?? '');
        return;
      }
      if (parts[2] === 'status') fragment.status = value;
      return;
    }

    if (parts[0] === 'status') this.status = value;
  }

  #resolveIndex(part) {
    if (part === '-1') return this.fragments.length - 1;
    if (part === '-2') return this.fragments.length - 2;
    const index = Number(part);
    return Number.isInteger(index) ? index : -1;
  }

  get finished() {
    return this.closed || this.status === 'FINISHED';
  }

  get text() {
    return this.fragments
      .filter((f) => f && typeof f === 'object' && String(f.type).toUpperCase() === 'RESPONSE')
      .map((f) => String(f.content ?? ''))
      .join('')
      .trim();
  }
}
