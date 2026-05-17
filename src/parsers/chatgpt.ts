import type { ObservedResponse, ParsedChatGPTResponse, RequestRecord } from "../types";
import { canonicalTrackedModel, isTrackedModel } from "../models/trackedModels";

const CHATGPT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

const MODEL_KEYS = new Set([
  "model",
  "model_slug",
  "slug",
  "default_model_slug",
  "selected_model_slug",
  "current_model_slug",
  "effective_model",
  "effective_model_slug"
]);
const PLAN_KEYS = new Set(["plan_type", "plan_name", "account_plan", "subscription_plan", "product_name"]);
const STATUS_KEYS = new Set(["account_status", "status", "subscription_status"]);
const LIMIT_KEYS = new Set(["message_cap", "message_limit", "cap", "limit", "max_messages"]);
const REMAINING_KEYS = new Set(["remaining", "remaining_messages", "messages_remaining"]);
const RESET_KEYS = new Set(["reset_after", "reset_at", "resets_at", "window_end"]);

export function isChatGPTSameOrigin(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin && CHATGPT_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export function parseChatGPTResponse(observed: ObservedResponse): ParsedChatGPTResponse | null {
  if (!isInterestingEndpoint(observed.url) && observed.requestMeta?.model == null) {
    return null;
  }

  const endpointType = classifyEndpoint(observed.url, observed.method, Boolean(observed.requestMeta?.isUserMessage));
  const parsed: ParsedChatGPTResponse = {};
  const models = new Set<string>();

  const requestModel = canonicalTrackedModel(observed.requestMeta?.model);
  if (requestModel) {
    models.add(requestModel);
  }

  if (isJsonLike(observed.contentType) && observed.responseJson != null) {
    const findings = collectFindings(observed.responseJson);

    for (const model of findings.models) {
      const trackedModel = canonicalTrackedModel(model);
      if (trackedModel) {
        models.add(trackedModel);
      }
    }

    if (findings.planName || findings.accountStatus) {
      parsed.plan = {
        planName: findings.planName ?? null,
        accountStatus: findings.accountStatus ?? null,
        source: "official"
      };
    }

    if (findings.limits.length > 0) {
      parsed.limits = findings.limits.flatMap((limit) => {
        const model = canonicalTrackedModel(limit.model);
        return model ? [{ ...limit, model }] : [];
      });
    }
  }

  if (models.size > 0) {
    parsed.models = Array.from(models).sort();
  }

  parsed.request = {
    endpoint: safePath(observed.url),
    method: observed.method,
    status: observed.status,
    ok: observed.ok,
    model: requestModel ?? firstModelForRequest(models),
    type: endpointType,
    source: endpointType === "message" ? "observed" : "official",
    eventKey: observed.requestMeta?.eventKey ?? null
  };

  return hasUsefulData(parsed) ? parsed : null;
}

export function extractRequestMeta(body: unknown): ObservedResponse["requestMeta"] {
  if (body == null) {
    return { bodyKind: "none", model: null };
  }

  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) {
      return { bodyKind: "none", model: null };
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const json = JSON.parse(trimmed) as unknown;
        return {
          bodyKind: "json",
          model: findModelValue(json),
          isUserMessage: hasUserMessageIntent(json),
          eventKey: findEventKey(json)
        };
      } catch {
        return { bodyKind: "unknown", model: null };
      }
    }

    return { bodyKind: "form", model: extractModelFromText(trimmed) };
  }

  if (body instanceof URLSearchParams) {
    return { bodyKind: "form", model: body.get("model") ?? body.get("model_slug") };
  }

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const model = body.get("model") ?? body.get("model_slug");
    return { bodyKind: "form", model: typeof model === "string" ? model : null };
  }

  return { bodyKind: "unknown", model: null };
}

function collectFindings(root: unknown): {
  models: string[];
  planName: string | null;
  accountStatus: string | null;
  limits: NonNullable<ParsedChatGPTResponse["limits"]>;
} {
  const models = new Set<string>();
  const limits: NonNullable<ParsedChatGPTResponse["limits"]> = [];
  let planName: string | null = null;
  let accountStatus: string | null = null;
  const seen = new WeakSet<object>();

  function visit(value: unknown): void {
    if (value == null || typeof value !== "object") {
      return;
    }

    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    const model = pickString(record, MODEL_KEYS);
    if (model && isTrackedModel(model)) {
      models.add(model);
    }

    planName ??= pickString(record, PLAN_KEYS);
    accountStatus ??= pickString(record, STATUS_KEYS);

    const limit = pickNumber(record, LIMIT_KEYS);
    const remaining = pickNumber(record, REMAINING_KEYS);
    const windowEnd = pickTime(record, RESET_KEYS);
    if (model && (limit !== null || remaining !== null || windowEnd !== null)) {
      limits.push({ model, limit, remaining, windowEnd });
    }

    for (const child of Object.values(record)) {
      visit(child);
    }
  }

  visit(root);
  return {
    models: Array.from(models),
    planName,
    accountStatus,
    limits
  };
}

function classifyEndpoint(url: string, method: string, isUserMessage: boolean): RequestRecord["type"] {
  const path = safePath(url).toLowerCase();
  const normalizedMethod = method.toUpperCase();

  if ((path.includes("conversation") || path.includes("completion")) && normalizedMethod === "POST" && isUserMessage) {
    return "message";
  }
  if (path.includes("conversation") || path.includes("completion")) {
    return "conversation";
  }
  if (path.includes("models")) {
    return "models";
  }
  if (path.includes("limit") || path.includes("cap")) {
    return "limits";
  }
  if (path.includes("account") || path.includes("subscription") || path.includes("billing")) {
    return "subscription";
  }
  return "unknown";
}

function isInterestingEndpoint(url: string): boolean {
  const path = safePath(url).toLowerCase();
  return [
    "backend-api",
    "conversation",
    "completion",
    "models",
    "account",
    "subscription",
    "billing",
    "limit",
    "cap"
  ].some((part) => path.includes(part));
}

function hasUsefulData(parsed: ParsedChatGPTResponse): boolean {
  return Boolean(parsed.plan || parsed.models?.length || parsed.limits?.length || parsed.request?.type !== "unknown");
}

function isJsonLike(contentType: string | null): boolean {
  return Boolean(contentType?.includes("application/json") || contentType?.includes("+json"));
}

function safePath(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function firstModelForRequest(models: Set<string>): string | null {
  const first = models.values().next();
  return first.done ? null : first.value;
}

function pickString(record: Record<string, unknown>, keys: Set<string>): string | null {
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key.toLowerCase()) && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, keys: Set<string>): number | null {
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(key.toLowerCase())) {
      continue;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function pickTime(record: Record<string, unknown>, keys: Set<string>): number | null {
  for (const [key, value] of Object.entries(record)) {
    if (!keys.has(key.toLowerCase())) {
      continue;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 10_000_000_000 ? value : Date.now() + value * 1000;
    }

    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function findModelValue(root: unknown): string | null {
  let found: string | null = null;
  const seen = new WeakSet<object>();

  function visit(value: unknown): void {
    if (found || value == null || typeof value !== "object") {
      return;
    }

    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    found = pickString(record, MODEL_KEYS);
    if (found) {
      return;
    }

    for (const child of Object.values(record)) {
      visit(child);
    }
  }

  visit(root);
  return found;
}

function hasUserMessageIntent(root: unknown): boolean {
  if (root == null || typeof root !== "object") {
    return false;
  }

  const record = root as Record<string, unknown>;
  const action = typeof record.action === "string" ? record.action.toLowerCase() : null;
  if (action === "next" || action === "variant") {
    return true;
  }

  return containsUserMessage(root);
}

function containsUserMessage(root: unknown): boolean {
  const seen = new WeakSet<object>();

  function visit(value: unknown): boolean {
    if (value == null || typeof value !== "object") {
      return false;
    }

    if (seen.has(value)) {
      return false;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.some((item) => visit(item));
    }

    const record = value as Record<string, unknown>;
    if (record.role === "user" || (record.author && typeof record.author === "object" && (record.author as Record<string, unknown>).role === "user")) {
      return true;
    }

    return Object.values(record).some((child) => visit(child));
  }

  return visit(root);
}

function findEventKey(root: unknown): string | null {
  if (root == null || typeof root !== "object") {
    return null;
  }

  const record = root as Record<string, unknown>;
  const candidates = [
    record.message_id,
    record.parent_message_id,
    record.conversation_id,
    record.client_message_id,
    record.request_id
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const messages = record.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (message && typeof message === "object") {
        const messageRecord = message as Record<string, unknown>;
        const id = messageRecord.id ?? messageRecord.message_id;
        if (typeof id === "string" && id.trim()) {
          return id.trim();
        }
      }
    }
  }

  return null;
}

function extractModelFromText(text: string): string | null {
  const match = /(?:model|model_slug)=([^&]+)/i.exec(text);
  return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : null;
}

function looksLikeModel(value: string): boolean {
  return isTrackedModel(value);
}
