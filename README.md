# ChatGPT Usage Monitor

一个 Tampermonkey/Violentmonkey 用户脚本，用于在 ChatGPT 页面中显示订阅和模型使用情况元数据。

## 功能

- 在 `chatgpt.com` 和 `chat.openai.com` 注入右下角使用情况面板。
- 拦截同源 `fetch` / `XMLHttpRequest` 响应，尝试读取官方暴露的订阅、模型和限额字段。
- 只对带模型字段的发送消息请求做本地观察统计；加载历史会话不会增加使用次数。
- 仅统计和展示主模型：`GPT-5.5` 与 `GPT-5.5 Thinking`。
- 内置 OpenAI Help Center 中 GPT-5.5 的官方限制数据，按当前订阅等级在主模型进度条中展示本周期用量。
- 支持固定面板、紧凑模式、刷新、导出元数据、清空统计。
- 默认只保存模型、时间、状态码、成功失败和计数等元数据，不保存提示词、回复内容、完整请求体或完整响应体。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run build
```

构建结果位于：

```text
dist/chatgpt-usage-monitor.user.js
```

将该文件内容安装到 Tampermonkey/Violentmonkey 即可使用。

如果项目发布在 `zyxjeek/ChatGPT-Usage-Plugin` 的 `main` 分支，脚本会通过下面的 GitHub raw 地址自动更新：

```text
https://raw.githubusercontent.com/zyxjeek/ChatGPT-Usage-Plugin/main/dist/chatgpt-usage-monitor.user.js
```

以后每次修改脚本时，递增 `vite.config.ts` 里的 `@version` 并提交新的 `dist/chatgpt-usage-monitor.user.js`，脚本管理器就能检测到更新。

## 调试

在 ChatGPT 页面控制台运行：

```js
localStorage.setItem("chatgpt-usage-monitor-debug", "1")
```

刷新页面后会输出解析调试日志。关闭调试：

```js
localStorage.removeItem("chatgpt-usage-monitor-debug")
```

## 注意

ChatGPT 前端内部接口可能变化。本脚本会尽量防御式解析；读取不到官方字段时，面板会显示未知或退回本地观察统计。

GPT-5.5 限制参考来源：

```text
https://help.openai.com/zh-hans-cn/articles/11909943-gpt-55-in-chatgpt
```
