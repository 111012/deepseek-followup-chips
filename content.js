/**
 * DeepSeek 追问建议 — 内容脚本
 *
 * 只做三件事：
 * 1. 在“回答完成”时读取当前这一轮的「问题 + 回答」。
 * 2. 向 background 请求 3 条追问建议，渲染成 chips。
 * 3. 点击 chip 时，让 injected.js（页面 MAIN world）把文字写入输入框。
 *
 * 选择器全部集中在 CONFIG.selectors，页面改版时只改这里。
 */

(() => {
  'use strict';

  const CONFIG = {
    selectors: {
      /** 回答正文（DeepSeek 的 Markdown 渲染容器，语义类名，通常较稳定） */
      answer: '.ds-markdown',
      /** 排除思考过程、搜索结果卡片里的 Markdown */
      excludeAnswer:
        '.ds-think-content, [class*="think-content"], [class*="search-result"], [class*="search_result"]',
      /** 消息虚拟列表（仅用于定位，找不到也不影响主流程） */
      messageList: '.ds-virtual-list-visible-items',
      /** 回答底部操作栏（复制/点赞/重新生成），用作 chips 的锚点 */
      actionBar: '[class*="_0a3d93b"]',
      /** AI 消息气泡（把 chips 挂在整条消息之后） */
      bubble: '[class*="d7dc56a8"]',
      /** 用户消息正文，网络层没拿到 prompt 时的兜底 */
      userText: '.fbb737a4, [class*="_9663006"]',
      /** 生成中的“停止”按钮（仅作 DOM 兜底判断） */
      stopButton:
        'button[aria-label*="停止"], button[aria-label*="Stop"], [role="button"][aria-label*="停止"], [role="button"][aria-label*="Stop"], [data-testid*="stop"]',
      /** 输入框 */
      inputTextarea: 'textarea',
      inputEditable: '[contenteditable="true"]',
    },
    maxSuggestions: 3,
    maxSuggestionChars: 30,
    minAnswerChars: 10,
    /** 网络层 onCompleted 后，等 React 把最终内容渲染出来的时间 */
    finalizeDelayMs: 500,
    /** 没有网络事件时，正文稳定多久才认为生成结束 */
    fallbackStableMs: 2600,
    /** 等待 injected.js 回执的时间，超时则用隔离世界兜底写入 */
    fillAckTimeoutMs: 1200,
    urlCheckMs: 1000,
  };

  const DEBUG = false;
  const log = (...args) => {
    if (DEBUG) console.debug('[DeepSeek Follow-ups]', ...args);
  };

  const state = {
    round: 0,
    networkSeen: false,
    generating: false,
    pendingPrompt: '',
    suggestions: [],
    chips: null,
    answerSignature: '',
    lastFinalizedSignature: '',
    lastFallbackText: '',
    lastFallbackElement: null,
    fallbackTimer: 0,
    lastUrl: location.href,
    injectAttempts: 0,
    tokenRetry: false,
  };

  /* ------------------------------------------------------------------ */
  /* DOM 工具                                                            */
  /* ------------------------------------------------------------------ */

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getAnswers() {
    return [...document.querySelectorAll(CONFIG.selectors.answer)].filter(
      (element) => isVisible(element) && !element.closest(CONFIG.selectors.excludeAnswer),
    );
  }

  function getLatestAnswer() {
    const answers = getAnswers();
    return answers.length ? answers[answers.length - 1] : null;
  }

  function getAnswerText(element) {
    return (element?.innerText || '').trim();
  }

  function signatureOf(text) {
    const value = String(text || '');
    return `${value.length}:${value.slice(0, 64)}:${value.slice(-64)}`;
  }

  function getStopButtons() {
    return [...document.querySelectorAll(CONFIG.selectors.stopButton)].filter(isVisible);
  }

  function findInput() {
    const candidates = [...document.querySelectorAll(
      `${CONFIG.selectors.inputTextarea}, ${CONFIG.selectors.inputEditable}`,
    )].filter((element) => {
      if (!isVisible(element)) return false;
      if (element.disabled || element.readOnly) return false;
      return element.tagName === 'TEXTAREA' || element.isContentEditable;
    });

    const preferred = candidates.find(
      (element) =>
        element.tagName === 'TEXTAREA' &&
        /deepseek|发送|message|ask/i.test(element.getAttribute('placeholder') || ''),
    );
    if (preferred) return preferred;

    const textarea = candidates.find((element) => element.tagName === 'TEXTAREA');
    if (textarea) return textarea;

    return candidates.find((element) => element.isContentEditable) || null;
  }

  function guessQuestion() {
    const nodes = [...document.querySelectorAll(CONFIG.selectors.userText)].filter(isVisible);
    const last = nodes[nodes.length - 1];
    return (last?.innerText || '').trim().slice(0, 1000);
  }

  function findAnchor(answer) {
    // 挂在 AI 消息气泡内部、底部操作栏之后：消息项高度会随之增长，虚拟列表不易裁切
    const bubble = answer.closest(CONFIG.selectors.bubble);
    if (bubble) {
      const bar = bubble.querySelector(CONFIG.selectors.actionBar);
      return bar || bubble;
    }

    // 气泡类名变了时，退到回答底部的操作栏之后
    const actionBar = answer.parentElement?.querySelector(`:scope > ${CONFIG.selectors.actionBar}`);
    return actionBar || answer;
  }

  /* ------------------------------------------------------------------ */
  /* 渲染 chips                                                          */
  /* ------------------------------------------------------------------ */

  function removeChips() {
    document.querySelectorAll('.dsfs-chips').forEach((element) => element.remove());
    state.chips = null;
  }

  function renderChips(answer, suggestions, answerSignature) {
    const cleaned = suggestions
      .filter((item) => typeof item === 'string')
      .map((item) => Array.from(item.trim()).slice(0, CONFIG.maxSuggestionChars).join(''))
      .filter(Boolean)
      .slice(0, CONFIG.maxSuggestions);
    if (!cleaned.length) return;
    if (!answer || !answer.isConnected) return;

    removeChips();

    const container = document.createElement('div');
    container.className = 'dsfs-chips';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', '追问建议');

    for (const suggestion of cleaned) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dsfs-chip';
      button.textContent = suggestion;
      button.title = suggestion;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void handleChipClick(suggestion, button);
      });
      container.appendChild(button);
    }

    findAnchor(answer).insertAdjacentElement('afterend', container);
    state.chips = container;
    state.suggestions = cleaned;
    state.answerSignature = answerSignature;
    log('chips rendered', cleaned.length);
  }

  /* ------------------------------------------------------------------ */
  /* 点击 → 填入输入框（不发送）                                          */
  /* ------------------------------------------------------------------ */

  function makeId() {
    try {
      return crypto.randomUUID();
    } catch {
      return `dsfs_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
  }

  function requestFill(text) {
    const requestId = makeId();
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(false);
      }, CONFIG.fillAckTimeoutMs);

      const listener = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (
          !data ||
          data.source !== 'dsfs' ||
          data.type !== 'FILL_RESULT' ||
          data.requestId !== requestId
        ) {
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        resolve(Boolean(data.ok));
      };

      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener('message', listener);
      }

      window.addEventListener('message', listener);
      window.postMessage({ source: 'dsfs', type: 'FILL_INPUT', text, requestId }, '*');
    });
  }

  /** injected.js 不可用时的兜底；通常也能触发 React 的 onChange。 */
  function fallbackFill(text) {
    const input = findInput();
    if (!input) {
      log('no input found');
      return false;
    }
    input.focus();

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const prototype =
        input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(input, text);
      else input.value = text;

      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
      );
      input.dispatchEvent(new Event('change', { bubbles: true }));
      try {
        input.setSelectionRange(text.length, text.length);
      } catch {
        // ignore
      }
      return true;
    }

    if (input.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection.removeAllRanges();
      selection.addRange(range);

      let inserted = false;
      try {
        inserted = document.execCommand('insertText', false, text);
      } catch {
        inserted = false;
      }
      if (!inserted) input.textContent = text;

      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
      );
      return true;
    }
    return false;
  }

  async function handleChipClick(text, button) {
    button.classList.add('dsfs-chip--picked');
    const input = findInput();
    if (input) input.focus();

    const filled = await requestFill(text);
    if (!filled) fallbackFill(text);

    setTimeout(() => button.classList.remove('dsfs-chip--picked'), 450);
  }

  /* ------------------------------------------------------------------ */
  /* 生成建议                                                            */
  /* ------------------------------------------------------------------ */

  function clearFallbackTimer() {
    if (state.fallbackTimer) {
      clearTimeout(state.fallbackTimer);
      state.fallbackTimer = 0;
    }
  }

  /**
   * 兜底认证：如果 webRequest 没抓到 Authorization（少见的浏览器策略），
   * 用页面同源请求 /api/v0/users/current 取 Token。仍然只发给 background 本地保存。
   */
  async function discoverToken() {
    try {
      const response = await fetch('/api/v0/users/current', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return false;
      const json = await response.json();
      const token = json?.data?.biz_data?.token;
      if (typeof token !== 'string' || token.length < 20) return false;
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'DSFS_TOKEN', token }, (result) => {
          resolve(!chrome.runtime.lastError && Boolean(result?.ok));
        });
      });
    } catch {
      return false;
    }
  }

  function finalize(question) {
    const answerElement = getLatestAnswer();
    if (!answerElement) return;

    const answerText = getAnswerText(answerElement);
    if (answerText.length < CONFIG.minAnswerChars) return;

    const signature = signatureOf(answerText);
    if (signature === state.lastFinalizedSignature) return;
    state.lastFinalizedSignature = signature;

    const round = state.round;
    const effectiveQuestion = (question || state.pendingPrompt || guessQuestion()).trim();

    log('request suggestions', { questionLength: effectiveQuestion.length, answerLength: answerText.length });

    chrome.runtime.sendMessage(
      { type: 'DSFS_GENERATE', question: effectiveQuestion, answer: answerText },
      (response) => {
        if (chrome.runtime.lastError) return;
        if (round !== state.round) return;

        if (response?.reason === 'no-token' && !state.tokenRetry) {
          state.tokenRetry = true;
          void discoverToken().then((ok) => {
            if (!ok || round !== state.round) return;
            state.lastFinalizedSignature = '';
            finalize(effectiveQuestion);
          });
          return;
        }

        if (!response?.ok || !Array.isArray(response.suggestions) || !response.suggestions.length) {
          return;
        }

        const latest = getLatestAnswer();
        if (!latest) return;
        // 回答已经变化（新一轮/重新生成）则丢弃
        if (signatureOf(getAnswerText(latest)) !== signature) return;

        renderChips(latest, response.suggestions, signature);
      },
    );
  }

  function scheduleFinalize(question, round, attempt = 0) {
    const delay = attempt === 0 ? CONFIG.finalizeDelayMs : 350;
    setTimeout(() => {
      if (round !== state.round) return;
      const answer = getLatestAnswer();
      if (!answer || getAnswerText(answer).length < CONFIG.minAnswerChars) {
        if (attempt < 6) scheduleFinalize(question, round, attempt + 1);
        return;
      }
      // 等正文稳定下来，避免 React 还没渲染完最后一段
      const before = getAnswerText(answer);
      setTimeout(() => {
        if (round !== state.round) return;
        const latest = getLatestAnswer();
        if (!latest) return;
        if (getAnswerText(latest) !== before && attempt < 6) {
          scheduleFinalize(question, round, attempt + 1);
          return;
        }
        finalize(question);
      }, 250);
    }, delay);
  }

  function onGenerationDone(message) {
    state.networkSeen = true;
    state.generating = false;
    clearFallbackTimer();
    if (message?.prompt) state.pendingPrompt = message.prompt;
    scheduleFinalize(state.pendingPrompt, state.round);
  }

  function onGenerationStart(message) {
    state.round += 1;
    state.networkSeen = true;
    state.generating = true;
    state.pendingPrompt = typeof message?.prompt === 'string' ? message.prompt : '';
    state.lastFinalizedSignature = '';
    state.answerSignature = '';
    state.suggestions = [];
    state.lastFallbackText = '';
    state.lastFallbackElement = null;
    state.tokenRetry = false;
    clearFallbackTimer();
    removeChips();
    log('generation start');
  }

  function onGenerationAborted() {
    state.generating = false;
  }

  /* ------------------------------------------------------------------ */
  /* 没有网络事件时的 DOM 兜底                                            */
  /* ------------------------------------------------------------------ */

  /** 记录当前最后一条回答作为基线，避免把打开页面/切换会话时的历史回答当成新生成。 */
  function snapshotFallbackBaseline() {
    if (state.networkSeen) return;
    const answer = getLatestAnswer();
    state.lastFallbackElement = answer;
    state.lastFallbackText = getAnswerText(answer);
    clearFallbackTimer();
  }

  function scheduleFallbackCheck() {
    if (state.networkSeen) return;
    const answer = getLatestAnswer();
    if (!answer) return;

    // 出现了一条新的回答节点：视为新一轮，清掉旧 chips 并重新计时
    if (answer !== state.lastFallbackElement) {
      state.lastFallbackElement = answer;
      state.lastFallbackText = '';
      if (state.chips) {
        removeChips();
        state.suggestions = [];
        state.answerSignature = '';
      }
    }

    const text = getAnswerText(answer);
    if (text.length < CONFIG.minAnswerChars) {
      state.lastFallbackText = text;
      return;
    }
    // 同一个气泡被复用重新生成：正文突然变短，视为新一轮
    if (text.length < state.lastFallbackText.length) {
      state.lastFallbackText = text;
      if (state.chips) {
        removeChips();
        state.suggestions = [];
        state.answerSignature = '';
      }
      return;
    }
    // 只有“变长”才说明在流式生成；避免打开历史会话时对旧回答生成建议
    if (text.length <= state.lastFallbackText.length + 2) return;

    state.lastFallbackText = text;
    clearFallbackTimer();
    state.fallbackTimer = setTimeout(() => {
      if (state.networkSeen || state.generating) return;
      if (getStopButtons().length) return;
      const latest = getLatestAnswer();
      if (!latest) return;
      if (getAnswerText(latest) !== text) return;
      finalize(guessQuestion());
    }, CONFIG.fallbackStableMs);
  }

  /* ------------------------------------------------------------------ */
  /* 观察页面                                                            */
  /* ------------------------------------------------------------------ */

  let mutationQueued = false;

  function handleMutations() {
    // chips 被 React 重渲染移除了：如果仍是最新一轮，补回来
    if (state.suggestions.length && (!state.chips || !state.chips.isConnected)) {
      const latest = getLatestAnswer();
      if (latest && signatureOf(getAnswerText(latest)) === state.answerSignature) {
        renderChips(latest, state.suggestions, state.answerSignature);
      }
    }
    scheduleFallbackCheck();
  }

  const observer = new MutationObserver(() => {
    if (mutationQueued) return;
    mutationQueued = true;
    setTimeout(() => {
      mutationQueued = false;
      handleMutations();
    }, 120);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  /* ------------------------------------------------------------------ */
  /* 消息                                                                */
  /* ------------------------------------------------------------------ */

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'DSFS_GENERATION_START':
        onGenerationStart(message);
        break;
      case 'DSFS_GENERATION_DONE':
        onGenerationDone(message);
        break;
      case 'DSFS_GENERATION_ABORTED':
        onGenerationAborted();
        break;
      default:
        break;
    }
  });

  /* ------------------------------------------------------------------ */
  /* 初始化                                                              */
  /* ------------------------------------------------------------------ */

  function ensureInjected() {
    chrome.runtime.sendMessage({ type: 'DSFS_INJECT' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.ok) {
        log('injected.js ready');
        return;
      }
      if (state.injectAttempts < 2) {
        state.injectAttempts += 1;
        setTimeout(ensureInjected, 800);
      } else {
        log('injected.js unavailable, using isolated-world fallback');
      }
    });
  }

  // SPA 切换会话：清理上一轮 chips，避免串台
  setInterval(() => {
    if (location.href === state.lastUrl) return;
    state.lastUrl = location.href;
    state.round += 1;
    state.networkSeen = false;
    state.generating = false;
    state.pendingPrompt = '';
    state.lastFinalizedSignature = '';
    state.answerSignature = '';
    state.suggestions = [];
    state.lastFallbackText = '';
    state.lastFallbackElement = null;
    state.tokenRetry = false;
    clearFallbackTimer();
    removeChips();
    setTimeout(snapshotFallbackBaseline, 1200);
  }, CONFIG.urlCheckMs);

  ensureInjected();
  // 记录打开页面时已有的最后一条回答，防止把历史回答误判为“刚开始生成”
  setTimeout(snapshotFallbackBaseline, 1200);
  log('content script ready');
})();
