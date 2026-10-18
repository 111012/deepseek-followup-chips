/**
 * DeepSeek 追问建议 — 页面上下文注入脚本（MAIN world）
 *
 * 由 background.js 通过 chrome.scripting.executeScript({ world: 'MAIN' }) 注入。
 * 只有它能可靠地绕过 React 的 value tracker，把文本写进输入框。
 */

(() => {
  'use strict';

  if (window.__DSFS_INJECTED__) return;
  window.__DSFS_INJECTED__ = true;

  const MAX_TEXT_LENGTH = 2000;

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findEditor() {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' || active.isContentEditable) && isVisible(active)) {
      return active;
    }

    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"]')].filter(
      (element) => {
        if (!isVisible(element)) return false;
        if (element.disabled || element.readOnly) return false;
        return element.tagName === 'TEXTAREA' || element.isContentEditable;
      },
    );

    const byPlaceholder = candidates.find((element) => {
      const placeholder = element.getAttribute('placeholder') || element.getAttribute('aria-label') || '';
      return /deepseek|发送|message|ask/i.test(placeholder);
    });
    if (byPlaceholder) return byPlaceholder;

    // 输入框通常在页面最下方，取 bottom 最大的可见候选
    return (
      candidates.sort(
        (a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom,
      )[0] || null
    );
  }

  function dispatchInput(element, text) {
    element.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: false,
        inputType: 'insertText',
        data: text,
      }),
    );
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillTextarea(element, text) {
    element.focus({ preventScroll: false });

    // 使用页面原生 setter，绕过 React 对 value 的劫持
    const prototype =
      element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, text);
    else element.value = text;

    dispatchInput(element, text);

    try {
      element.setSelectionRange(text.length, text.length);
    } catch {
      // ignore
    }
    return true;
  }

  function fillContentEditable(element, text) {
    element.focus({ preventScroll: false });

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }

    if (!inserted) {
      // 兜底：execCommand 被禁用时直接替换文本节点
      element.textContent = text;
      dispatchInput(element, text);
    } else {
      // 有些 React 编辑器只监听 input 事件，再补一次（内容不变，不会重复插入）
      dispatchInput(element, text);
    }

    // 光标移到末尾
    const endRange = document.createRange();
    endRange.selectNodeContents(element);
    endRange.collapse(false);
    selection.removeAllRanges();
    selection.addRange(endRange);
    return true;
  }

  function fill(text) {
    const editor = findEditor();
    if (!editor) return { ok: false, reason: 'no-input' };

    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      return { ok: fillTextarea(editor, text) };
    }
    if (editor.isContentEditable) {
      return { ok: fillContentEditable(editor, text) };
    }
    return { ok: false, reason: 'unsupported-input' };
  }

  function ack(requestId, ok, reason) {
    window.postMessage(
      {
        source: 'dsfs',
        type: 'FILL_RESULT',
        requestId,
        ok,
        reason: reason || '',
      },
      '*',
    );
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'dsfs' || data.type !== 'FILL_INPUT') return;

    const text = typeof data.text === 'string' ? data.text.slice(0, MAX_TEXT_LENGTH) : '';
    if (!text.trim()) {
      ack(data.requestId, false, 'empty-text');
      return;
    }

    try {
      const result = fill(text);
      ack(data.requestId, result.ok, result.reason);
    } catch (error) {
      ack(data.requestId, false, String(error?.message || error));
    }
  });
})();
