import { installInterceptors } from "./network/interceptor";
import { UsageStore } from "./store/usageStore";
import { UsagePanel } from "./ui/panel";
import { onReady } from "./utils/dom";

const DEBUG = localStorage.getItem("chatgpt-usage-monitor-debug") === "1";

const store = new UsageStore();

installInterceptors({
  debug: DEBUG,
  onParsed: async (parsed) => {
    await store.applyParsed(parsed);
  }
});

window.__CHATGPT_USAGE_MONITOR__ = {
  refresh: async () => {
    await store.getState();
  },
  exportData: async () => {
    const json = await store.exportJson();
    console.info("[ChatGPT Usage Monitor] Metadata export", JSON.parse(json) as unknown);
  }
};

onReady(() => {
  const panel = new UsagePanel(store);
  void panel.init();
});
