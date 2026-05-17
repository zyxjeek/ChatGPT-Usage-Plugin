export type SourceKind = "official" | "observed";

export interface PlanInfo {
  planName: string | null;
  accountStatus: string | null;
  visibleModels: string[];
  source: SourceKind;
  updatedAt: number;
}

export interface ModelUsage {
  model: string;
  used: number;
  remaining: number | null;
  limit: number | null;
  limitLabel: string | null;
  windowStart: number;
  windowEnd: number | null;
  lastUsedAt: number;
  source: SourceKind;
}

export interface OfficialUsageLimit {
  id: string;
  planMatcher: string[];
  modelMatcher: string[];
  displayPlan: string;
  displayModel: string;
  limit: number | null;
  windowMs: number | null;
  windowLabel: string;
  note: string;
  sourceUrl: string;
}

export interface RequestRecord {
  id: string;
  timestamp: number;
  endpoint: string;
  method: string;
  status: number | null;
  ok: boolean;
  model: string | null;
  type: "subscription" | "models" | "limits" | "message" | "conversation" | "unknown";
  source: SourceKind;
}

export interface UISettings {
  expanded: boolean;
  pinned: boolean;
  compact: boolean;
}

export interface UsageState {
  version: 1;
  plan: PlanInfo | null;
  usages: Record<string, ModelUsage>;
  recent: RequestRecord[];
  settings: UISettings;
  lastUpdatedAt: number;
}

export interface ParsedChatGPTResponse {
  plan?: Partial<PlanInfo>;
  models?: string[];
  limits?: Array<{
    model: string;
    remaining?: number | null;
    limit?: number | null;
    windowEnd?: number | null;
  }>;
  request?: Omit<RequestRecord, "id" | "timestamp" | "source"> & {
    timestamp?: number;
    source?: SourceKind;
  };
}

export interface ObservedResponse {
  url: string;
  method: string;
  status: number | null;
  ok: boolean;
  contentType: string | null;
  responseJson?: unknown;
  requestMeta?: {
    model?: string | null;
    bodyKind?: "json" | "form" | "unknown" | "none";
    isUserMessage?: boolean;
  };
}
