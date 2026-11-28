import type { ModelRates } from "@mcpjam/sdk/browser";

/**
 * Validation for a model rate someone types in: a local override for a
 * personal key, or an organization rate. The rules and messages match the
 * backend's check on organization rates, so the form refuses a value before
 * it is sent and the server refuses the same value with the same words.
 */

const MAX_ID_LENGTH = 200;
const MAX_NOTE_LENGTH = 500;
/** Above this per million tokens is almost always a per-token price. */
const MAX_RATE_USD = 100_000;
/** Backdating covers usage priced later; a year either way rejects a typo. */
export const EFFECTIVE_AT_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

/** The rates the forms edit, in USD per million tokens. */
export const MODEL_RATE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
] as const;

export type ModelRateField = (typeof MODEL_RATE_FIELDS)[number];

export const MODEL_RATE_LABELS: Record<ModelRateField, string> = {
  input: "Input price",
  output: "Output price",
  cacheRead: "Cache read price",
  cacheWrite: "Cache write price",
};

export type ModelRateInput = {
  modelId: string;
  providerKey?: string;
  rates: Partial<Record<ModelRateField, number>>;
  effectiveAt?: number;
  note?: string;
};

export type ModelRateInputResult =
  | {
      ok: true;
      value: Omit<ModelRateInput, "rates"> & {
        rates: ModelRates;
        effectiveAt: number;
      };
    }
  | { ok: false; message: string };

/** A typed-in rate, or the message that says what to fix. */
function readRate(
  field: ModelRateField,
  value: number | undefined,
): number | string {
  const label = MODEL_RATE_LABELS[field];
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return `${label} must be zero or more. Enter a dollar amount.`;
  }
  if (value > MAX_RATE_USD) {
    return `${label} is above $${MAX_RATE_USD.toLocaleString("en-US")}. Enter the price per million tokens.`;
  }
  return value;
}

/**
 * Trim, bound and check one rate. `requireProvider` is set for local
 * overrides, which price one provider's calls; an organization rate may leave
 * it blank to apply on any provider.
 */
export function normalizeModelRateInput(
  input: ModelRateInput,
  options: { now: number; requireProvider: boolean },
): ModelRateInputResult {
  const refuse = (message: string) => ({ ok: false as const, message });
  const modelId = input.modelId.trim();
  if (!modelId) {
    return refuse("Enter a model ID, such as anthropic/claude-sonnet-4.5.");
  }
  if (modelId.length > MAX_ID_LENGTH) {
    return refuse(
      `Model IDs can be at most ${MAX_ID_LENGTH} characters. Enter the ID your provider uses for the model.`,
    );
  }
  const providerKey = input.providerKey?.trim() || undefined;
  if (!providerKey && options.requireProvider) {
    return refuse("Pick the provider these prices apply to.");
  }
  const read = (field: ModelRateField) => readRate(field, input.rates[field]);
  const inputRate = read("input");
  if (typeof inputRate === "string") return refuse(inputRate);
  const outputRate = read("output");
  if (typeof outputRate === "string") return refuse(outputRate);
  const rates: ModelRates = {
    currency: "USD",
    input: inputRate,
    output: outputRate,
  };
  for (const field of ["cacheRead", "cacheWrite"] as const) {
    if (input.rates[field] === undefined) continue;
    const rate = read(field);
    if (typeof rate === "string") return refuse(rate);
    rates[field] = rate;
  }
  const effectiveAt = input.effectiveAt ?? options.now;
  if (
    !Number.isFinite(effectiveAt) ||
    Math.abs(effectiveAt - options.now) > EFFECTIVE_AT_WINDOW_MS
  ) {
    return refuse("Pick an effective date within one year of today.");
  }
  const note = input.note?.trim() || undefined;
  if (note && note.length > MAX_NOTE_LENGTH) {
    return refuse(
      `Notes can be at most ${MAX_NOTE_LENGTH} characters. Shorten the note and save again.`,
    );
  }
  return {
    ok: true,
    value: {
      modelId,
      ...(providerKey ? { providerKey } : {}),
      rates,
      effectiveAt: Math.floor(effectiveAt),
      ...(note ? { note } : {}),
    },
  };
}
