import { describe, expect, it, vi } from "vitest";
import { extractRequestMeta, parseChatGPTResponse } from "../src/parsers/chatgpt";

vi.stubGlobal("location", new URL("https://chatgpt.com/"));

describe("chatgpt parser", () => {
  it("extracts model metadata from request bodies without preserving content", () => {
    const meta = extractRequestMeta(JSON.stringify({
      model: "gpt-4o",
      messages: [{ content: "private prompt" }]
    }));

    expect(meta).toEqual({ bodyKind: "json", model: "gpt-4o" });
  });

  it("parses official plan, models, and limits defensively", () => {
    const parsed = parseChatGPTResponse({
      url: "https://chatgpt.com/backend-api/models",
      method: "GET",
      status: 200,
      ok: true,
      contentType: "application/json",
      responseJson: {
        account_plan: "Plus",
        account_status: "active",
        models: [
          { slug: "gpt-4o", message_cap: 80, remaining_messages: 42, resets_at: "2030-01-01T00:00:00Z" },
          { slug: "o3-mini" }
        ]
      }
    });

    expect(parsed?.plan?.planName).toBe("Plus");
    expect(parsed?.models).toEqual(["gpt-4o", "o3-mini"]);
    expect(parsed?.limits?.[0]).toMatchObject({ model: "gpt-4o", limit: 80, remaining: 42 });
  });

  it("ignores unrelated same-origin responses", () => {
    const parsed = parseChatGPTResponse({
      url: "https://chatgpt.com/public-api/feature-flags",
      method: "GET",
      status: 200,
      ok: true,
      contentType: "application/json",
      responseJson: { enabled: true }
    });

    expect(parsed).toBeNull();
  });

  it("classifies loaded history conversations without counting them as new messages", () => {
    const parsed = parseChatGPTResponse({
      url: "https://chatgpt.com/backend-api/conversation/abc123",
      method: "GET",
      status: 200,
      ok: true,
      contentType: "application/json",
      responseJson: {
        mapping: {
          node: {
            message: {
              metadata: { model_slug: "gpt-5.5" }
            }
          }
        }
      }
    });

    expect(parsed?.request?.type).toBe("conversation");
    expect(parsed?.request?.model).toBe("gpt-5.5");
  });
});
