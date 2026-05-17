import { describe, expect, it, vi } from "vitest";
import { extractRequestMeta, parseChatGPTResponse } from "../src/parsers/chatgpt";

vi.stubGlobal("location", new URL("https://chatgpt.com/"));

describe("chatgpt parser", () => {
  it("extracts model metadata from request bodies without preserving content", () => {
    const meta = extractRequestMeta(JSON.stringify({
      model: "gpt-5.5",
      action: "next",
      messages: [{ id: "msg-1", author: { role: "user" }, content: "private prompt" }]
    }));

    expect(meta).toEqual({ bodyKind: "json", model: "gpt-5.5", isUserMessage: true, eventKey: "msg-1" });
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
          { slug: "gpt-5.5", message_cap: 160, remaining_messages: 42, resets_at: "2030-01-01T00:00:00Z" },
          { slug: "gpt-5-5-thinking" },
          { slug: "gpt-4o" },
          { slug: "o3-mini" }
        ]
      }
    });

    expect(parsed?.plan?.planName).toBe("Plus");
    expect(parsed?.models).toEqual(["gpt-5.5", "gpt-5.5 thinking"]);
    expect(parsed?.limits?.[0]).toMatchObject({ model: "gpt-5.5", limit: 160, remaining: 42 });
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

  it("does not classify POST history loads as messages without user-message intent", () => {
    const parsed = parseChatGPTResponse({
      url: "https://chatgpt.com/backend-api/conversation/abc123",
      method: "POST",
      status: 200,
      ok: true,
      contentType: "application/json",
      requestMeta: { bodyKind: "json", model: "gpt-5.5", isUserMessage: false },
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

  it("classifies POST conversations as messages only with user-message intent", () => {
    const parsed = parseChatGPTResponse({
      url: "https://chatgpt.com/backend-api/conversation",
      method: "POST",
      status: 200,
      ok: true,
      contentType: "text/event-stream",
      requestMeta: { bodyKind: "json", model: "gpt-5.5", isUserMessage: true }
    });

    expect(parsed?.request?.type).toBe("message");
    expect(parsed?.request?.model).toBe("gpt-5.5");
  });
});
