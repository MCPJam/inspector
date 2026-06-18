import type { GenerationOptions } from "@/lib/apis/evals-api";

/**
 * Client-side, per-suite generation config for the "Generate" config popover.
 *
 * Progressive disclosure: the one-click Generate uses the suite's persisted
 * config (defaults reproduce the backend's default 8-case mix). The popover
 * edits this; nothing here is sent to the backend except via
 * {@link toGenerationOptions}. Persisted in localStorage keyed by suite id so
 * there is no backend schema for a UI preference.
 */
export type GenerateCasesConfig = {
  simple: number;
  multiTool: number;
  multiTurn: number;
  complex: number;
  negative: number;
  varyUserStyles: boolean;
};

export const GENERATE_BUCKET_KEYS = [
  "simple",
  "multiTool",
  "multiTurn",
  "complex",
  "negative",
] as const;

export type GenerateBucketKey = (typeof GENERATE_BUCKET_KEYS)[number];

/** Mirrors the backend's DEFAULT_NORMAL_MIX (2/2/1/1/2). */
export const DEFAULT_GENERATE_CONFIG: GenerateCasesConfig = {
  simple: 2,
  multiTool: 2,
  multiTurn: 1,
  complex: 1,
  negative: 2,
  varyUserStyles: false,
};

export const GENERATE_BUCKET_META: Record<
  GenerateBucketKey,
  { label: string; hint: string }
> = {
  simple: { label: "Simple", hint: "Easy, single tool" },
  multiTool: { label: "Multi-tool", hint: "Medium, 2+ tools" },
  multiTurn: { label: "Multi-turn", hint: "Follow-up workflow" },
  complex: { label: "Complex", hint: "Hard / cross-server" },
  negative: { label: "Negative", hint: "Should not call tools" },
};

export const MIN_BUCKET = 0;
export const MAX_BUCKET = 10;
export const MAX_TOTAL = 20;

const STORAGE_PREFIX = "mcpjam.evals.generateConfig.";

function clampBucket(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(MIN_BUCKET, Math.min(MAX_BUCKET, Math.floor(value)));
}

export function totalCases(config: GenerateCasesConfig): number {
  return GENERATE_BUCKET_KEYS.reduce((sum, key) => sum + config[key], 0);
}

function storageKey(suiteId: string): string {
  return `${STORAGE_PREFIX}${suiteId}`;
}

export function loadGenerateConfig(suiteId: string): GenerateCasesConfig {
  if (typeof window === "undefined") return { ...DEFAULT_GENERATE_CONFIG };
  try {
    const raw = window.localStorage.getItem(storageKey(suiteId));
    if (!raw) return { ...DEFAULT_GENERATE_CONFIG };
    const parsed = JSON.parse(raw) as Partial<GenerateCasesConfig>;
    const next: GenerateCasesConfig = { ...DEFAULT_GENERATE_CONFIG };
    for (const key of GENERATE_BUCKET_KEYS) {
      const clamped = clampBucket(parsed?.[key]);
      if (clamped !== null) next[key] = clamped;
    }
    if (typeof parsed?.varyUserStyles === "boolean") {
      next.varyUserStyles = parsed.varyUserStyles;
    }
    // Per-bucket clamping above doesn't bound the aggregate; a stale/tampered
    // entry could exceed MAX_TOTAL. Fall back to defaults rather than forward an
    // out-of-range mix the backend would reject.
    if (totalCases(next) > MAX_TOTAL) return { ...DEFAULT_GENERATE_CONFIG };
    return next;
  } catch {
    return { ...DEFAULT_GENERATE_CONFIG };
  }
}

export function saveGenerateConfig(
  suiteId: string,
  config: GenerateCasesConfig
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(suiteId), JSON.stringify(config));
  } catch {
    // Non-fatal: persistence is a convenience, not a requirement.
  }
}

/**
 * Convert UI config to the API `generationOptions`. Always sends the full
 * caseMix (the popover is authoritative once touched) plus the toggle.
 */
export function toGenerationOptions(
  config: GenerateCasesConfig
): GenerationOptions {
  return {
    caseMix: {
      simple: config.simple,
      multiTool: config.multiTool,
      multiTurn: config.multiTurn,
      complex: config.complex,
      negative: config.negative,
    },
    varyUserStyles: config.varyUserStyles,
  };
}
