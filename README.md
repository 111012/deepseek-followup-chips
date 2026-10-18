DeepSeek 追问建议



在 DeepSeek 网页版回答下方自动生成 3 个可点击的追问 chips。  

点击只填入输入框，不自动发送。

3 步安装：下载 zip → 解压 → 加载已解压的扩展程序。

安装

1. 去 Releases 下载 deepseek-followup-chips-v0.1.0.zip，解压。
2. 打开 chrome://extensions 或 edge://extensions。
3. 打开右上角「开发者模式」。
4. 点「加载已解压的扩展程序」，选择解压后的 deepseek-followup-chips 文件夹。
5. 打开并登录 chat.deepseek.com，刷新页面。

不要直接选 zip，要先解压；选到能看到 manifest.json 的那一层。

使用

1. 正常提问，等回答结束。
2. 回答下方出现 3 个 chips。
3. 点一个 chip：文字填入输入框，不会自动发送。
4. 编辑后按 Enter，或直接发送。

说明

- 桌面端 Chrome / Edge，Manifest V3；手机不支持。
- 不需要 API Key；登录 Token 只保存在浏览器本地。
- 非官方项目，与 DeepSeek 无关联；DeepSeek 改版后可能失效。
- 回答少于 10 个字时不会生成。

开发

    npm test
    npm run test:e2e   # 需要 Node 18+




    
不能商用!!!
不能商用!!!
侵权联系我邮箱删除

详细原理、选择器维护、已知风险：docs/DETAILS.md

License

MIT
