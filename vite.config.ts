import { defineConfig } from "vitest/config";

const userscriptHeader = `// ==UserScript==
// @name         ChatGPT Usage Monitor
// @namespace    https://github.com/local/chatgpt-usage-userscript
// @version      0.1.3
// @description  Show local and officially observed ChatGPT subscription/model usage metadata without storing conversation content.
// @author       local
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_download
// @grant        unsafeWindow
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/zyxjeek/ChatGPT-Usage-Plugin/main/dist/chatgpt-usage-monitor.user.js
// @downloadURL  https://raw.githubusercontent.com/zyxjeek/ChatGPT-Usage-Plugin/main/dist/chatgpt-usage-monitor.user.js
// ==/UserScript==
`;

export default defineConfig({
  plugins: [
    {
      name: "prepend-userscript-header",
      generateBundle(_, bundle) {
        for (const item of Object.values(bundle)) {
          if (item.type === "chunk" && item.fileName.endsWith(".user.js")) {
            item.code = `${userscriptHeader}\n${item.code}`;
          }
        }
      }
    }
  ],
  build: {
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    lib: {
      entry: "src/main.ts",
      name: "ChatGPTUsageMonitor",
      formats: ["iife"],
      fileName: () => "chatgpt-usage-monitor.user.js"
    }
  },
  test: {
    environment: "happy-dom"
  }
});
