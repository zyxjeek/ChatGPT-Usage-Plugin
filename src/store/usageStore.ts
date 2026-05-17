import type { ModelUsage, ParsedChatGPTResponse, RequestRecord, UISettings, UsageState } from "../types";
import { findOfficialLimit } from "../data/officialLimits";

const STORE_KEY = "chatgpt-usage-monitor-state";
const MAX_RECENT = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

const defaultSettings: UISettings = {
  expanded: false,
  pinned: false,
  compact: false
};

export function createEmptyState(): UsageState {
  return {
    version: 1,
    plan: null,
    usages: {},
    recent: [],
    settings: { ...defaultSettings },
    lastUpdatedAt: Date.now()
  };
}

export interface KeyValueStorage {
  get<T>(key: string, fallback: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export class BrowserStorage implements KeyValueStorage {
  async get<T>(key: string, fallback: T): Promise<T> {
    try {
      if (typeof GM_getValue === "function") {
        return await GM_getValue(key, fallback);
      }
    } catch {
      // Fall through to localStorage.
    }

    const raw = localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      if (typeof GM_setValue === "function") {
        await GM_setValue(key, value);
        return;
      }
    } catch {
      // Fall through to localStorage.
    }

    localStorage.setItem(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    try {
      if (typeof GM_deleteValue === "function") {
        await GM_deleteValue(key);
        return;
      }
    } catch {
      // Fall through to localStorage.
    }

    localStorage.removeItem(key);
  }
}

export class UsageStore extends EventTarget {
  private state: UsageState | null = null;

  constructor(private readonly storage: KeyValueStorage = new BrowserStorage()) {
    super();
  }

  async load(): Promise<UsageState> {
    if (this.state) {
      return this.state;
    }

    const loaded = await this.storage.get<UsageState>(STORE_KEY, createEmptyState());
    this.state = normalizeState(loaded);
    return this.state;
  }

  async getState(): Promise<UsageState> {
    return this.load();
  }

  async updateSettings(settings: Partial<UISettings>): Promise<UsageState> {
    const state = await this.load();
    state.settings = { ...state.settings, ...settings };
    state.lastUpdatedAt = Date.now();
    await this.persist(state);
    return state;
  }

  async applyParsed(parsed: ParsedChatGPTResponse): Promise<UsageState> {
    const state = await this.load();
    const now = Date.now();

    if (parsed.plan || parsed.models?.length) {
      state.plan = {
        planName: parsed.plan?.planName ?? state.plan?.planName ?? null,
        accountStatus: parsed.plan?.accountStatus ?? state.plan?.accountStatus ?? null,
        visibleModels: dedupe([
          ...(parsed.models ?? []),
          ...(parsed.plan?.visibleModels ?? []),
          ...(state.plan?.visibleModels ?? [])
        ]),
        source: "official",
        updatedAt: now
      };
    }

    for (const limit of parsed.limits ?? []) {
      const key = normalizeModelName(limit.model);
      const existing = state.usages[key] ?? createUsage(key, now, state.plan?.planName);
      state.usages[key] = {
        ...existing,
        remaining: limit.remaining ?? existing.remaining,
        limit: limit.limit ?? existing.limit,
        limitLabel: existing.limitLabel,
        windowEnd: limit.windowEnd ?? existing.windowEnd,
        source: "official"
      };
    }

    if (parsed.request) {
      const request: RequestRecord = {
        id: `${now}-${Math.random().toString(36).slice(2)}`,
        timestamp: parsed.request.timestamp ?? now,
        endpoint: parsed.request.endpoint,
        method: parsed.request.method,
        status: parsed.request.status,
        ok: parsed.request.ok,
        model: parsed.request.model ? normalizeModelName(parsed.request.model) : null,
        type: parsed.request.type,
        source: parsed.request.source ?? "observed"
      };

      state.recent = [request, ...state.recent].slice(0, MAX_RECENT);

      if (request.type === "message" && request.ok && request.model) {
        const usage = rolloverIfNeeded(
          state.usages[request.model] ?? createUsage(request.model, request.timestamp, state.plan?.planName),
          request.timestamp,
          state.plan?.planName
        );
        usage.used += 1;
        usage.lastUsedAt = request.timestamp;
        usage.source = usage.source === "official" ? "official" : "observed";

        if (usage.remaining !== null && usage.remaining > 0) {
          usage.remaining -= 1;
        }

        state.usages[request.model] = usage;
      }
    }

    state.lastUpdatedAt = now;
    await this.persist(state);
    return state;
  }

  async clear(): Promise<UsageState> {
    await this.storage.delete(STORE_KEY);
    this.state = createEmptyState();
    await this.persist(this.state);
    return this.state;
  }

  async exportJson(): Promise<string> {
    const state = await this.load();
    return JSON.stringify(state, null, 2);
  }

  private async persist(state: UsageState): Promise<void> {
    this.state = normalizeState(state);
    await this.storage.set(STORE_KEY, this.state);
    this.dispatchEvent(new CustomEvent<UsageState>("change", { detail: this.state }));
  }
}

function normalizeState(input: UsageState): UsageState {
  const usages = Object.fromEntries(
    Object.entries(input.usages ?? {}).map(([key, usage]) => [
      key,
      {
        ...usage,
        limitLabel: usage.limitLabel ?? "本地日"
      }
    ])
  );

  return {
    version: 1,
    plan: input.plan ?? null,
    usages,
    recent: Array.isArray(input.recent) ? input.recent.slice(0, MAX_RECENT) : [],
    settings: { ...defaultSettings, ...(input.settings ?? {}) },
    lastUpdatedAt: input.lastUpdatedAt || Date.now()
  };
}

function createUsage(model: string, now: number, planName?: string | null): ModelUsage {
  const officialLimit = findOfficialLimit(model, planName);
  const windowMs = officialLimit?.windowMs ?? DAY_MS;
  const windowStart = officialLimit?.windowMs ? alignRollingWindow(now, officialLimit.windowMs) : startOfLocalDay(now);

  return {
    model,
    used: 0,
    remaining: officialLimit?.limit ?? null,
    limit: officialLimit?.limit ?? null,
    limitLabel: officialLimit?.windowLabel ?? "本地日",
    windowStart,
    windowEnd: officialLimit?.windowMs ? windowStart + windowMs : windowStart + DAY_MS,
    lastUsedAt: now,
    source: "observed"
  };
}

function rolloverIfNeeded(usage: ModelUsage, now: number, planName?: string | null): ModelUsage {
  if (usage.windowEnd && now < usage.windowEnd) {
    return usage;
  }

  const fresh = createUsage(usage.model, now, planName);
  return {
    ...fresh,
    limit: fresh.limit ?? usage.limit,
    remaining: fresh.limit ?? usage.limit,
    limitLabel: fresh.limitLabel ?? usage.limitLabel,
    source: usage.source
  };
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function alignRollingWindow(timestamp: number, windowMs: number): number {
  return Math.floor(timestamp / windowMs) * windowMs;
}

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}
