# DeepSeek 追问建议（浏览器扩展）

<img src="icons/preview-512.png" width="96" alt="扩展图标">

给 [chat.deepseek.com](https://chat.deepseek.com) 增加类似 ChatGPT 的「回答后追问建议」：

- 正常提问，回答完成后，回答下方出现 **3 个可点击的追问 chips**；
- 点击 chip 只会把文字**填入输入框**，不会自动发送；
- 你可以继续编辑，或直接按 Enter 发送；
- 只显示最新一轮，新提问开始时旧 chips 自动消失；
- 生成失败、找不到 DOM、未登录时**静默不显示**，不打扰主回答流式输出。

> 这是一个非官方个人项目，与 DeepSeek 官方无关。使用前请阅读文末的「已知风险」。

---

## 目录结构

```
deepseek-followup-chips/
├── manifest.json          # MV3 清单
├── background.js          # Token 捕获、completion 生命周期、生成建议
├── content.js             # 观察回答、渲染 chips、点击处理
├── injected.js            # 页面 MAIN world：安全写入 textarea / contenteditable
├── content.css            # chips 样式（自适应深浅色）
├── lib/
│   ├── core.js            # 提示词、JSON 解析、SSE patch 解析（纯函数，可测试）
│   └── pow.js             # DeepSeekHashV1 PoW（调用官方 Wasm）
├── vendor/
│   └── sha3_wasm_bg.wasm  # DeepSeek 官方 PoW Wasm（本地使用，不联网）
├── icons/                 # 16/32/48/128 图标
├── tests/
│   └── core.test.mjs      # Node 单元测试（解析器 / SSE）
├── package.json           # 仅用于 npm test（Chrome 忽略）
└── README.md
```

---

## 安装（开发者模式）

### Chrome / Edge

1. 把 `deepseek-followup-chips` 整个文件夹放到本地任意位置。
   - `manifest.json` 必须直接位于该文件夹根目录，**不要**多套一层。
2. 打开扩展管理页：
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
3. 打开右上角 **开发者模式 / Developer mode**。
4. 点击 **加载已解压的扩展程序 / Load unpacked**。
5. 选择 `deepseek-followup-chips` 文件夹。
6. 打开或刷新 <https://chat.deepseek.com>，登录账号。
7. 固定扩展图标（可选）。扩展没有弹窗，加载后自动运行。

### 第一次检查

在扩展管理页找到「DeepSeek 追问建议」，点击 **Service Worker / 检查视图**，确认控制台没有红色报错。
正常加载时会看到一条：

```
[DeepSeek Follow-ups] installed. 打开 chat.deepseek.com 并提问即可。
```

---

## 使用

1. 在 DeepSeek 网页版正常提问。
2. 等回答生成完（停止按钮消失、正文不再变化）。
3. 回答下方出现 3 个圆角半透明 chips。
4. 点击任意 chip：
   - 文本填入底部输入框；
   - 光标停在末尾；
   - **不会自动发送**。
5. 编辑后按 Enter，或直接发送。
6. 再问下一个问题时，上一轮 chips 会自动移除。

---

## 测试步骤（手工）

按顺序做一遍，基本能覆盖主要路径：

### 1. 加载与基础检查

- [ ] 开发者模式加载扩展，扩展卡片无「错误」按钮。
- [ ] 打开 `chrome://extensions` → 该扩展 → Service Worker → 控制台无异常。
- [ ] 打开 <https://chat.deepseek.com>，已登录。

### 2. 捕获 Token

- [ ] 在页面里随便发一条消息（或刷新已登录页面）。
- [ ] 打开 Service Worker 控制台，执行：
  ```js
  chrome.storage.local.get(['dsfs_token'], console.log)
  ```
- [ ] 应该能看到 `dsfs_token`，值是一长串字符。
  - 看不到：见「故障排查 → 没有生成建议」。

> Token 只存在扩展本地存储；content script 不访问 `chrome.storage`、不打印 Token，只在兜底认证时把同源接口返回的 Token 通过内部消息交给 background。

### 3. 生成 chips

- [ ] 提一个需要几秒钟回答的问题，例如「用三句话解释什么是闭包」。
- [ ] 回答完成后 1～8 秒内，回答下方出现 3 个 chips。
- [ ] chips 是圆角、半透明、小号字，深浅色主题都正常。
- [ ] 回答还在流式输出时，不应该出现 chips。

### 4. 点击填入

- [ ] 点击第一个 chip。
- [ ] 文本出现在底部输入框，光标在末尾。
- [ ] 消息**没有**被自动发送。
- [ ] 可以直接按 Enter 发送；也可以先编辑。

### 5. 只保留最新一轮

- [ ] 不点击 chip，直接问第二个问题。
- [ ] 新回答开始生成时，上一轮 chips 消失。
- [ ] 新回答完成后，只出现一组新的 3 个 chips。

### 6. 失败路径

- [ ] 退出登录后提问：不应出现 chips，页面无报错弹窗。
- [ ] 断网后提问：不应出现 chips，主回答正常。
- [ ] 在非 `chat.deepseek.com` 页面：扩展不注入、不显示任何东西。
- [ ] 手机端：不适用（移动浏览器不支持桌面扩展）。

### 7. 可选：单元测试

```bash
cd deepseek-followup-chips
npm test
```

应输出 `15 tests passed`。测试覆盖提示词、JSON 解析、SSE 解析，以及用官方 Wasm 反推挑战来验证 PoW 求解器，不依赖浏览器。

后台生成流水线（登录后的 createSession → PoW → completion → 删除临时会话）可以用 mock API 跑：

```bash
npm run test:e2e   # 需要 Node 18+（内置 fetch / Response）
```

应输出 `4 tests passed`。

---

## 工作原理

### 1. 认证：从请求头捕获 Token（零配置）

`background.js` 用 `chrome.webRequest.onBeforeSendHeaders` 监听：

```
https://chat.deepseek.com/api/*
```

从 `Authorization: Bearer <token>` 中提取 Token，写入 `chrome.storage.local` 的 `dsfs_token`。
用户不需要填写任何配置。

兜底：如果某些浏览器策略让 webRequest 看不到 Authorization，`content.js` 会在首次生成返回 `no-token` 时，用页面同源请求 `/api/v0/users/current` 取一次 Token，再通过内部消息交给 background 保存。

### 2. 判断“回答完成”

主信号来自 `chrome.webRequest.onCompleted`：

- 页面发出 `POST /api/v0/chat/completion` 时，`onBeforeRequest` 同时解析请求体里的 `prompt`，通知 content「开始生成」；
- 流式响应结束、`onCompleted` 返回 2xx 时，通知 content「生成完成」。

content 收到完成事件后，等 500ms 再读 DOM，并做一次 250ms 的正文稳定性检查；React 还没渲染完时会重试最多 6 次。

DOM 兜底：如果 webRequest 不可用（例如权限被策略禁用），content 会观察正文是否持续变长，稳定 2.6 秒且找不到“停止生成”按钮时，认为完成。

### 3. 生成建议

`background.js` 使用**当前登录账号的 Web API**，不会调用第三方模型：

1. `POST /api/v0/chat_session/create` 创建一个临时会话；
2. `POST /api/v0/chat/create_pow_challenge` 申请 PoW；
3. 用本地 `vendor/sha3_wasm_bg.wasm` 计算 `DeepSeekHashV1` answer；
4. `POST /api/v0/chat/completion`，带上 `x-ds-pow-response`；
5. 关闭 `thinking` 和 `search`，只让模型输出一个 JSON 数组；
6. 用 SSE patch 解析器收集回答；
7. `POST /api/v0/chat_session/delete` 删除临时会话；
8. 把 3 条建议返回给 content。

提示词要求：

- 只输出 JSON 数组；
- 恰好 3 条；
- 每条不超过 30 字符；
- 语言与助手回答一致；
- 不编号、不解释、不加代码块。

解析器兼容代码块、前后解释文字、对象数组；失败时静默。

### 4. 点击填入

```
chip click
  → content.js 找到输入框并 focus
  → window.postMessage({type:'FILL_INPUT'})
  → injected.js（MAIN world）找到 textarea / contenteditable
  → 原生 value setter + InputEvent / execCommand('insertText')
  → 回执 FILL_RESULT
  → 超时则 content.js 用隔离世界再兜底写一次
```

之所以要在 MAIN world 执行，是为了绕过 React 对输入框 value 的劫持。`injected.js` 由 background 通过 `chrome.scripting.executeScript({ world: 'MAIN' })` 注入，重复注入有幂等保护。

---

## 选择器维护

页面改版时，**优先只改 `content.js` 顶部的 `CONFIG.selectors`**：

| 键 | 默认值 | 用途 |
| --- | --- | --- |
| `answer` | `.ds-markdown` | 回答正文容器 |
| `excludeAnswer` | `.ds-think-content, [class*="think-content"], [class*="search-result"], [class*="search_result"]` | 排除思考块/搜索结果里的 Markdown |
| `bubble` | `[class*="d7dc56a8"]` | AI 消息气泡，chips 挂在其后 |
| `actionBar` | `[class*="_0a3d93b"]` | 回答底部操作栏，气泡找不到时的锚点 |
| `userText` | `.fbb737a4, [class*="_9663006"]` | 用户消息正文，问题兜底 |
| `stopButton` | 多个 `aria-label` 匹配「停止 / Stop」 | 生成中按钮，DOM 兜底判断 |
| `messageList` | `.ds-virtual-list-visible-items` | 消息虚拟列表（保留给排查用） |
| `inputTextarea` | `textarea` | 输入框候选 |
| `inputEditable` | `[contenteditable="true"]` | contenteditable 候选 |

`injected.js` 里的输入框查找是通用逻辑（`textarea` / `[contenteditable="true"]` + 可见性 + placeholder 优先），通常不需要改。

调试选择器：在 DeepSeek 页面控制台执行，例如：

```js
document.querySelectorAll('.ds-markdown').length
document.querySelectorAll('[class*="d7dc56a8"]').length
```

如果 DeepSeek 改了 class 哈希，用 Elements 面板找到新的稳定特征，改 `CONFIG.selectors` 对应项即可。

---

## 权限说明

| 权限 | 为什么需要 |
| --- | --- |
| `webRequest` | 读取 `chat.deepseek.com/api/*` 的 Authorization 请求头；监听 completion 请求开始/结束 |
| `storage` | 保存 Token（`chrome.storage.local`） |
| `scripting` | 把 `injected.js` 注入页面 MAIN world，写入 React 输入框 |
| `host_permissions: https://chat.deepseek.com/*` | 只在这个站点运行，也只访问这个站点的接口 |

安装时浏览器会提示「读取和更改您在 chat.deepseek.com 上的数据」等权限。扩展不会读取其他网站。

`content_security_policy` 里的 `'wasm-unsafe-eval'` 仅用于本地实例化 DeepSeek 官方 PoW Wasm。

---

## 已知风险与限制

1. **DOM 可能变动**
   DeepSeek 的 class 名是哈希的，按钮也没有稳定的 `aria-label`。扩展已经用「网络生命周期」做主判断、DOM 只做兜底，但仍可能需要跟随页面更新 `CONFIG.selectors`。

2. **Web API 不是公开 API**
   生成建议依赖 `chat.deepseek.com/api/v0/*` 和 PoW。官方随时可能改接口、改 PoW、加风控或限制频率；失败时扩展会静默不显示 chips。

3. **会创建一个临时会话**
   生成建议时会在账号里短暂创建一个会话，完成后立即删除。如果删除请求失败（网络中断、接口变更），可能留下一个空会话，可在侧边栏手动删除。

4. **消耗账号额度 / 可能触发频率限制**
   每轮回答会额外发一次轻量 completion 请求。短时间连续提问可能遇到 429 或服务端限流，此时不显示 chips。

5. **自动化可能违反服务条款**
   这是非官方扩展，使用账号 Web 接口做自动化请求。请自行评估账号风险，建议仅个人学习/研究使用。

6. **权限提示**
   `webRequest` + host permission 会让安装时出现较醒目的权限提示，这是捕获 Token 和判断完成所必需的。

7. **移动端不支持**
   Chrome/Edge 移动版不支持桌面扩展；首期只面向桌面端。

8. **MV3 Service Worker 可能被挂起**
   浏览器会在空闲时暂停 Service Worker。监听器都在顶层注册，事件会重新唤醒它；但极长的请求仍可能被中断，表现为静默失败。

9. **`document.execCommand` 已废弃**
   contenteditable 路径仍在使用它（目前浏览器都还支持）。若某天失效，会退回直接设置文本 + 派发 `InputEvent`，React 编辑器可能不认，此时需要改成对应编辑器（ProseMirror/Lexical）的 API。

10. **只保证“填入”，不保证“发送”**
    扩展刻意不点击发送按钮，避免误发。发送仍由用户按 Enter 或点发送按钮完成。

---

## 隐私

- Token 只保存在 `chrome.storage.local`；content script 不访问存储、不打印 Token。
- 问题和回答只发送到 `https://chat.deepseek.com` 官方接口。
- 没有统计、没有远程配置、没有第三方域名请求。
- 生成的建议不落盘；页面刷新即丢失。
- 卸载扩展会删除其本地存储（包括 Token）。

如果你在共享电脑上使用，使用完可以在扩展管理页移除扩展，或在 Service Worker 控制台执行：

```js
chrome.storage.local.clear()
```

---

## 故障排查

### 没有出现 chips

按顺序检查：

1. **是否登录**：未登录时不会捕获 Token，也不会生成。
2. **Token 是否存在**：Service Worker 控制台执行
   ```js
   chrome.storage.local.get(['dsfs_token'], console.log)
   ```
   没有值：刷新页面、发一条消息，再看。
3. **Service Worker 是否在运行**：扩展管理页点「Service Worker」；如果显示「无效」，点一下重新启动。
4. **看后台日志**：搜索 `[DeepSeek Follow-ups]`。
   - `尚未捕获到登录 Token` → 认证问题。
   - `suggestion request failed: HTTP 401/403` → Token 过期或风控，刷新页面重试。
   - `suggestion request failed: 429` → 频率限制，等一会儿。
   - `pow: ...` → PoW/Wasm 失败，检查 `vendor/sha3_wasm_bg.wasm` 是否完整。
   - `模型没有返回可用的 JSON 建议` → 模型没有按格式输出，可重试。
5. **检查选择器**：页面控制台执行
   ```js
   document.querySelectorAll('.ds-markdown').length
   ```
   如果是 0，说明回答容器改名了，改 `CONFIG.selectors.answer`。
6. **是否在最新一轮**：只对最后一条回答显示；滚动到旧回答不会生成。
7. **回答是否太短**：少于 10 个字符的回答（例如“收到，测试正常”）不会生成，避免硬凑追问。
8. **窗口是否在前台**：DeepSeek 的虚拟列表在窗口失焦/后台时有时会暂时不渲染回答；切到前台或刷新页面即可。

### chips 出现但点击没反应

1. 页面控制台执行 `window.__DSFS_INJECTED__`，应为 `true`。
   - 不是：在扩展管理页点「重新加载」，刷新页面。
2. 看页面控制台是否有 `no-input` 相关日志（默认不打印，可临时把 `content.js` 的 `DEBUG` 改为 `true`）。
3. 确认输入框是可见的；如果页面在编辑历史消息，会优先填入当前聚焦的编辑框。

### chips 位置不对

DeepSeek 改版可能让 AI 气泡的 class 变化。改 `CONFIG.selectors.bubble` 或 `actionBar`。
如果都不匹配，会退化为插在 `.ds-markdown` 后面，通常仍然可见。

### 扩展加载报错

- 确认选择的是 `deepseek-followup-chips` 文件夹本身，而不是它的父目录。
- 确认 `manifest.json` 在根目录。
- 看扩展卡片的「错误」按钮，通常是文件缺失或 JSON 语法错误。
- `vendor/sha3_wasm_bg.wasm` 不能被删；缺了它认证流程会在 PoW 阶段失败。

---

## 卸载

- `chrome://extensions` → 找到扩展 → **移除**。
- 卸载会清除 `chrome.storage.local` 中的 Token。
- 如果临时会话删除失败，去 DeepSeek 侧边栏手动删除残留会话。

---

## 验证状态

- 已在 Edge 155（Chromium 155）加载验证：manifest / Service Worker / MAIN world 注入 / textarea 与 contenteditable 写入 / chips 渲染 / 点击填入 / 生成完成事件链路。
- SSE 解析器、提示词、JSON 解析、PoW 求解器有 15 个 Node 单元测试；其中 PoW 测试用官方 Wasm 反推一个必然有解的 challenge，再让 `solvePowChallenge` 求解，结果正确。
- 后台生成流水线另有 4 个 mock API 测试（`npm run test:e2e`），覆盖 createSession → PoW → completion SSE → 解析 → 删除临时会话。
- **已在真实登录账号上实测通过**（2026-10-18）：提问「用一句话解释什么是 HTTP 缓存」→ 回答下方出现 3 个 chips：「HTTP缓存有哪些类型？」「缓存什么时候会失效？」「如何控制缓存策略？」；点击后只填入输入框，未自动发送。
- 真实 Web API 是逆向用法，DeepSeek 改版后仍可能失效；失败时 Service Worker 控制台会给出不含对话内容的错误原因。

---

## License / 免责声明

MIT（仅限本项目代码）。`vendor/sha3_wasm_bg.wasm` 来自 DeepSeek 官方网页资源，仅用于本地 PoW 计算。

本项目与 DeepSeek 官方无关联。使用本扩展可能违反 DeepSeek 的服务条款，或带来账号风控风险；请自行判断并承担后果。建议仅用于个人学习与研究。
