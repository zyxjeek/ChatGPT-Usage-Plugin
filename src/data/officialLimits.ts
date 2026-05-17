import type { OfficialUsageLimit } from "../types";

export const GPT_55_HELP_CENTER_URL = "https://help.openai.com/zh-hans-cn/articles/11909943-gpt-55-in-chatgpt";

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

export const OFFICIAL_USAGE_LIMITS: OfficialUsageLimit[] = [
  {
    id: "gpt-5.5-thinking-plus-business",
    planMatcher: ["plus", "business"],
    modelMatcher: ["gpt-5.5 thinking", "gpt-5-5-thinking", "thinking"],
    displayPlan: "Plus / Business",
    displayModel: "GPT-5.5 Thinking 手动选择",
    limit: 3000,
    windowMs: WEEK_MS,
    windowLabel: "每周",
    note: "仅统计手动选择 Thinking；Instant 自动切换到 Thinking 不计入该每周限制。",
    sourceUrl: GPT_55_HELP_CENTER_URL
  },
  {
    id: "gpt-5.5-thinking-go",
    planMatcher: ["go"],
    modelMatcher: ["gpt-5.5 thinking", "gpt-5-5-thinking", "thinking"],
    displayPlan: "Go",
    displayModel: "GPT-5.5 Thinking",
    limit: 10,
    windowMs: 5 * HOUR_MS,
    windowLabel: "5 小时",
    note: "Go 用户启用 Thinking 后适用。",
    sourceUrl: GPT_55_HELP_CENTER_URL
  },
  {
    id: "gpt-5.5-free",
    planMatcher: ["free", "免费"],
    modelMatcher: ["gpt-5.5", "gpt-5-5", "gpt 5.5", "instant"],
    displayPlan: "Free",
    displayModel: "GPT-5.5",
    limit: 10,
    windowMs: 5 * HOUR_MS,
    windowLabel: "5 小时",
    note: "达到限制后会自动改用 mini 版本。",
    sourceUrl: GPT_55_HELP_CENTER_URL
  },
  {
    id: "gpt-5.5-plus-go",
    planMatcher: ["plus", "go"],
    modelMatcher: ["gpt-5.5", "gpt-5-5", "gpt 5.5", "instant"],
    displayPlan: "Plus / Go",
    displayModel: "GPT-5.5",
    limit: 160,
    windowMs: 3 * HOUR_MS,
    windowLabel: "3 小时",
    note: "达到限制后会切换为 mini 版本。",
    sourceUrl: GPT_55_HELP_CENTER_URL
  },
  {
    id: "gpt-5-business-pro",
    planMatcher: ["business", "pro"],
    modelMatcher: ["gpt-5", "gpt-5.5", "gpt-5-5", "instant", "thinking"],
    displayPlan: "Business / Pro",
    displayModel: "GPT-5 系列",
    limit: null,
    windowMs: null,
    windowLabel: "无限制",
    note: "受防滥用护栏约束，异常使用仍可能被临时限制。",
    sourceUrl: GPT_55_HELP_CENTER_URL
  }
];

export function findOfficialLimit(model: string, planName?: string | null): OfficialUsageLimit | null {
  const normalizedModel = normalize(model);
  const normalizedPlan = normalize(planName ?? "");

  return OFFICIAL_USAGE_LIMITS.find((limit) => {
    const planMatches = !normalizedPlan || limit.planMatcher.some((plan) => normalizedPlan.includes(normalize(plan)));
    const modelMatches = limit.modelMatcher.some((candidate) => normalizedModel.includes(normalize(candidate)));
    return planMatches && modelMatches;
  }) ?? null;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_.\s]+/g, "-");
}
