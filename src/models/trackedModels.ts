export const TRACKED_MODELS = ["gpt-5.5", "gpt-5.5 thinking"] as const;

export type TrackedModel = typeof TRACKED_MODELS[number];

export function canonicalTrackedModel(model: string | null | undefined): TrackedModel | null {
  if (!model) {
    return null;
  }

  const normalized = normalizeModel(model);
  const hasGpt55 = normalized.includes("gpt-5-5") || normalized.includes("gpt5-5") || normalized.includes("gpt-55");
  const hasThinking = normalized.includes("thinking") || normalized.includes("reasoning");

  if (hasGpt55 && hasThinking) {
    return "gpt-5.5 thinking";
  }

  if (hasGpt55 || normalized === "instant") {
    return "gpt-5.5";
  }

  return null;
}

export function isTrackedModel(model: string | null | undefined): boolean {
  return canonicalTrackedModel(model) !== null;
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase().replace(/[_.\s]+/g, "-");
}
