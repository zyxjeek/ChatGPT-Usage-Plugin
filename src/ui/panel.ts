import styles from "../styles.css?inline";
import type { ModelUsage, UsageState } from "../types";
import { escapeHtml, formatTime } from "../utils/dom";
import type { UsageStore } from "../store/usageStore";

export class UsagePanel {
  private readonly host = document.createElement("div");
  private readonly shadow = this.host.attachShadow({ mode: "open" });

  constructor(private readonly store: UsageStore) {
    this.host.id = "chatgpt-usage-monitor";
    this.shadow.innerHTML = `<style>${styles}</style><div class="cgum-root"></div>`;
    document.body.append(this.host);

    this.shadow.addEventListener("click", (event) => {
      void this.handleClick(event);
    });

    this.store.addEventListener("change", (event) => {
      const state = (event as CustomEvent<UsageState>).detail;
      this.render(state);
    });
  }

  async init(): Promise<void> {
    this.render(await this.store.getState());
  }

  render(state: UsageState): void {
    const root = this.shadow.querySelector(".cgum-root");
    if (!root) {
      return;
    }

    root.className = `cgum-root${state.settings.compact ? " cgum-compact" : ""}`;
    root.innerHTML = state.settings.expanded || state.settings.pinned
      ? this.renderPanel(state)
      : `<button class="cgum-button" data-action="expand" title="ChatGPT 使用情况" aria-label="ChatGPT 使用情况">▦</button>`;
  }

  private renderPanel(state: UsageState): string {
    const plan = state.plan;
    const usages = Object.values(state.usages).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    const recent = state.recent.slice(0, state.settings.compact ? 3 : 6);

    return `
      <section class="cgum-panel" aria-label="ChatGPT 使用情况">
        <header class="cgum-header">
          <div>
            <h2 class="cgum-title">ChatGPT 使用情况</h2>
            <p class="cgum-subtitle">${escapeHtml(plan?.source === "official" ? "官方状态 + 本地观察" : "本地观察统计")}</p>
          </div>
          <div class="cgum-tools">
            <button class="cgum-icon-button" data-action="refresh" title="刷新" aria-label="刷新">↻</button>
            <button class="cgum-icon-button" data-action="compact" title="紧凑模式" aria-label="紧凑模式" aria-pressed="${state.settings.compact}">◱</button>
            <button class="cgum-icon-button" data-action="pin" title="固定面板" aria-label="固定面板" aria-pressed="${state.settings.pinned}">⌖</button>
            <button class="cgum-icon-button" data-action="collapse" title="收起" aria-label="收起">×</button>
          </div>
        </header>
        <div class="cgum-body">
          <section class="cgum-section">
            <div class="cgum-section-title">订阅</div>
            <div class="cgum-plan">
              <div>
                <strong>${escapeHtml(plan?.planName ?? "未知订阅")}</strong>
                <span>${escapeHtml(plan?.accountStatus ?? "状态未知")}</span>
              </div>
              <span class="cgum-pill">${escapeHtml(plan?.source ?? "unknown")}</span>
            </div>
          </section>
          <section class="cgum-section">
            <div class="cgum-section-title">
              <span>模型用量</span>
              <span>${usages.length} 个模型</span>
            </div>
            ${usages.length ? usages.map((usage) => this.renderUsage(usage)).join("") : this.renderEmpty()}
          </section>
          <section class="cgum-section">
            <div class="cgum-section-title">最近请求</div>
            ${recent.length ? `<div class="cgum-recent">${recent.map((record) => `
              <div class="cgum-record">
                <strong>${escapeHtml(record.model ?? record.type)}</strong>
                <b class="${record.ok ? "cgum-record-ok" : "cgum-record-fail"}">${record.status ?? "?"}</b>
                <span>${escapeHtml(record.method)} ${escapeHtml(record.endpoint)}</span>
                <span>${formatTime(record.timestamp)}</span>
              </div>
            `).join("")}</div>` : this.renderEmpty()}
          </section>
          <section class="cgum-section cgum-actions">
            <button class="cgum-action" data-action="export">导出元数据</button>
            <button class="cgum-action" data-action="clear">清空统计</button>
          </section>
          <p class="cgum-section cgum-privacy">仅保存模型、时间、状态码、成功失败和计数等元数据；不保存提示词、回复内容、完整请求体或完整响应体。</p>
        </div>
      </section>
    `;
  }

  private renderUsage(usage: ModelUsage): string {
    const hasLimit = usage.limit !== null && usage.limit > 0;
    const percentage = hasLimit ? Math.min(100, Math.round((usage.used / usage.limit!) * 100)) : 0;
    const quota = usage.limit === null ? "无限制" : `${usage.used} / ${usage.limit}`;
    const remaining = usage.remaining === null ? "无限制或未知" : `剩余 ${usage.remaining}`;
    const windowLabel = usage.limitLabel ?? "当前周期";

    return `
      <div class="cgum-model">
        <div class="cgum-model-row">
          <div class="cgum-model-name" title="${escapeHtml(usage.model)}">${escapeHtml(usage.model)}</div>
          <div class="cgum-model-count">${escapeHtml(quota)}</div>
        </div>
        <div class="cgum-bar" aria-hidden="true"><div class="cgum-bar-fill" style="--value: ${percentage}%"></div></div>
        <div class="cgum-meta">
          <span>${escapeHtml(remaining)}</span>
          <span>${escapeHtml(windowLabel)}${usage.windowEnd ? ` · 重置 ${formatTime(usage.windowEnd)}` : ""}</span>
        </div>
      </div>
    `;
  }

  private renderEmpty(): string {
    return `<div class="cgum-empty">暂无可显示数据。发送一次消息或刷新页面后，脚本会尝试从 ChatGPT 请求中读取元数据。</div>`;
  }

  private async handleClick(event: Event): Promise<void> {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
    if (!target) {
      return;
    }

    const state = await this.store.getState();
    const action = target.dataset.action;

    if (action === "expand") {
      await this.store.updateSettings({ expanded: true });
    } else if (action === "collapse") {
      await this.store.updateSettings({ expanded: false, pinned: false });
    } else if (action === "pin") {
      await this.store.updateSettings({ pinned: !state.settings.pinned, expanded: true });
    } else if (action === "compact") {
      await this.store.updateSettings({ compact: !state.settings.compact });
    } else if (action === "refresh") {
      this.render(await this.store.getState());
    } else if (action === "clear") {
      if (confirm("清空本地 ChatGPT 使用统计？")) {
        await this.store.clear();
      }
    } else if (action === "export") {
      await exportState(await this.store.exportJson());
    }
  }
}

async function exportState(json: string): Promise<void> {
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const name = `chatgpt-usage-${new Date().toISOString().slice(0, 10)}.json`;

  try {
    if (typeof GM_download === "function") {
      GM_download({ url, name, saveAs: true });
      return;
    }

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
