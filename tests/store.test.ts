import { describe, expect, it } from "vitest";
import { UsageStore, type KeyValueStorage } from "../src/store/usageStore";

class MemoryStorage implements KeyValueStorage {
  private data = new Map<string, unknown>();

  async get<T>(key: string, fallback: T): Promise<T> {
    return (this.data.get(key) as T | undefined) ?? fallback;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

describe("usage store", () => {
  it("increments successful observed message requests for tracked models", async () => {
    const store = new UsageStore(new MemoryStorage());

    await store.applyParsed({
      request: {
        endpoint: "/backend-api/conversation",
        method: "POST",
        status: 200,
        ok: true,
        model: "GPT-5.5",
        type: "message",
        source: "observed"
      }
    });

    const state = await store.getState();
    expect(state.usages["gpt-5.5"].used).toBe(1);
    expect(state.recent).toHaveLength(1);
  });

  it("ignores non-main models", async () => {
    const store = new UsageStore(new MemoryStorage());

    await store.applyParsed({
      request: {
        endpoint: "/backend-api/conversation",
        method: "POST",
        status: 200,
        ok: true,
        model: "gpt-4o",
        type: "message",
        source: "observed"
      }
    });

    const state = await store.getState();
    expect(state.usages["gpt-4o"]).toBeUndefined();
    expect(Object.keys(state.usages)).toHaveLength(0);
  });

  it("does not increment failed message requests", async () => {
    const store = new UsageStore(new MemoryStorage());

    await store.applyParsed({
      request: {
        endpoint: "/backend-api/conversation",
        method: "POST",
        status: 429,
        ok: false,
        model: "gpt-4o",
        type: "message",
        source: "observed"
      }
    });

    const state = await store.getState();
    expect(state.usages["gpt-4o"]).toBeUndefined();
    expect(state.recent).toHaveLength(1);
  });

  it("does not increment loaded history conversations", async () => {
    const store = new UsageStore(new MemoryStorage());

    await store.applyParsed({
      request: {
        endpoint: "/backend-api/conversation/abc123",
        method: "GET",
        status: 200,
        ok: true,
        model: "gpt-5.5",
        type: "conversation",
        source: "official"
      }
    });

    const state = await store.getState();
    expect(state.usages["gpt-5.5"]).toBeUndefined();
    expect(state.recent).toHaveLength(1);
  });

  it("applies official GPT-5.5 Plus cycle metadata when available", async () => {
    const store = new UsageStore(new MemoryStorage());

    await store.applyParsed({
      plan: { planName: "Plus", accountStatus: "active" },
      models: ["gpt-5.5"]
    });
    await store.applyParsed({
      request: {
        endpoint: "/backend-api/conversation",
        method: "POST",
        status: 200,
        ok: true,
        model: "gpt-5.5",
        type: "message",
        source: "observed"
      }
    });

    const state = await store.getState();
    expect(state.usages["gpt-5.5"]).toMatchObject({
      used: 1,
      limit: 160,
      remaining: 159,
      limitLabel: "3 小时"
    });
  });

  it("creates zero-progress official quota rows from plan visible models", async () => {
    const store = new UsageStore(new MemoryStorage());

    await store.applyParsed({
      plan: { planName: "Free", accountStatus: "active" },
      models: ["gpt-5.5"]
    });

    const state = await store.getState();
    expect(state.usages["gpt-5.5"]).toMatchObject({
      used: 0,
      limit: 10,
      remaining: 10,
      limitLabel: "5 小时"
    });
  });

  it("clears persisted state", async () => {
    const store = new UsageStore(new MemoryStorage());

    await store.applyParsed({
      models: ["gpt-4o"]
    });
    await store.clear();

    const state = await store.getState();
    expect(state.plan).toBeNull();
    expect(state.recent).toHaveLength(0);
  });
});
