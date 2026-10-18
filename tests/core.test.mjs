import assert from 'node:assert/strict';
import { buildPrompt, clampText, parseSuggestions, SseResponseCollector } from '../lib/core.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test('clampText keeps head and tail', () => {
  const text = 'a'.repeat(100) + 'b'.repeat(100);
  const clamped = clampText(text, 50);
  assert.equal(clamped.length, 53); // 50 chars + "\n…\n"
  assert.ok(clamped.startsWith('a'));
  assert.ok(clamped.endsWith('b'));
});

test('buildPrompt includes question, answer and JSON rule', () => {
  const prompt = buildPrompt('什么是闭包？', '闭包是函数和其词法环境的组合。');
  assert.ok(prompt.includes('什么是闭包？'));
  assert.ok(prompt.includes('闭包是函数和其词法环境的组合。'));
  assert.ok(prompt.includes('JSON'));
  assert.ok(prompt.includes('30 个字符'));
});

test('parseSuggestions accepts fenced JSON', () => {
  const raw = '```json\n["闭包和普通函数有什么区别？","闭包会导致内存泄漏吗？","能举个闭包的实际例子吗？"]\n```';
  assert.deepEqual(parseSuggestions(raw), [
    '闭包和普通函数有什么区别？',
    '闭包会导致内存泄漏吗？',
    '能举个闭包的实际例子吗？',
  ]);
});

test('parseSuggestions accepts object array and drops duplicates', () => {
  const raw = JSON.stringify([
    { text: '这适用于什么场景？' },
    { suggestion: '这适用于什么场景？' },
    { text: '有没有性能问题？' },
    { text: '如何测试？' },
  ]);
  assert.deepEqual(parseSuggestions(raw), ['这适用于什么场景？', '有没有性能问题？', '如何测试？']);
});

test('parseSuggestions ignores surrounding prose and truncates to 30 chars', () => {
  const raw = `好的，建议如下：
["${'长'.repeat(40)}","第二条建议","第三条建议"]
以上。`;
  const result = parseSuggestions(raw);
  assert.equal(result.length, 3);
  assert.equal(Array.from(result[0]).length, 30);
});

test('parseSuggestions falls back to quoted strings', () => {
  const raw = '1. "为什么需要这样做？"\n2. "还有其他方案吗？"\n3. "什么时候会失效？"';
  assert.deepEqual(parseSuggestions(raw), ['为什么需要这样做？', '还有其他方案吗？', '什么时候会失效？']);
});

test('parseSuggestions returns [] for unusable output', () => {
  assert.deepEqual(parseSuggestions('抱歉，我无法完成。'), []);
  assert.deepEqual(parseSuggestions(''), []);
});

test('SSE collector handles split chunks and append patches', () => {
  const collector = new SseResponseCollector();
  const stream = [
    'event: ready\n',
    'data: {"request_message_id":1,"response_message_id":2}\n\n',
    'data: {"v":{"response":{"fragments":[{"type":"THINKING","content":"思考中"},{"type":"RESPONSE","content":""}]}}}\n\n',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"第一段"}\n\n',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"，第二段"}\n\n',
    'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
  ].join('');

  // 模拟网络分片，可能从任意位置切断
  for (const chunk of [stream.slice(0, 37), stream.slice(37, 120), stream.slice(120)]) {
    collector.feed(chunk);
  }

  assert.equal(collector.text, '第一段，第二段');
  assert.equal(collector.finished, true);
});

test('SSE collector handles BATCH and ignores thinking content', () => {
  const collector = new SseResponseCollector();
  collector.feed(
    'data: {"p":"response","o":"BATCH","v":[' +
      '{"p":"fragments","o":"APPEND","v":[{"type":"THINKING","content":"内部思考"},{"type":"RESPONSE","content":"答案"}]},' +
      '{"p":"status","o":"SET","v":"FINISHED"}' +
      ']}\n',
  );
  assert.equal(collector.text, '答案');
  assert.equal(collector.finished, true);
});

test('SSE collector handles bare v-string deltas (real DeepSeek format)', () => {
  const collector = new SseResponseCollector();
  const payloads = [
    { v: { response: { message_id: 2, status: 'WIP', fragments: [{ id: 2, type: 'RESPONSE', content: '["' }] } } },
    { p: 'response/fragments/-1/content', o: 'APPEND', v: '闭' },
    { v: '包' },
    { v: '和' },
    { v: '普通' },
    { v: '函数' },
    { v: '有什么' },
    { v: '区别' },
    { v: '？' },
    { v: '"' },
    { v: ']' },
    { p: 'response/status', o: 'SET', v: 'FINISHED' },
  ];
  const stream = payloads.map((payload) => `data: ${JSON.stringify(payload)}`).join('\n');
  collector.feed(`${stream}\n`);
  assert.equal(collector.text, '["闭包和普通函数有什么区别？"]');
  assert.equal(collector.finished, true);
});

test('SSE collector handles event close', () => {
  const collector = new SseResponseCollector();
  collector.feed('data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"hi"}]}\n');
  collector.feed('event: close\ndata: {"auto_resume":false}\n');
  assert.equal(collector.text, 'hi');
  assert.equal(collector.finished, true);
});

console.log(`\n${passed} tests passed`);
