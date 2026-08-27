/**
 * `intent` — the optional, author-supplied label a case is grouped under when
 * stage analytics are compared across models and hosts.
 *
 * This module is browser-safe and intentionally has no node-only deps. It is
 * data + pure helpers only: no network, no clock, no storage.
 *
 * ── What intent is, and what it is NOT ───────────────────────────────────────
 *
 * Intent is ANALYTICS METADATA. It is a grouping key and nothing else: no
 * derivation reads it, no verdict depends on it, and no stage state is inferred
 * from it. A case tagged `"search"` and a case tagged nothing at all are graded
 * identically; the only difference is which funnel row they land in.
 *
 * That framing is load-bearing in two places:
 *
 *   1. **Import exactness.** Retagging a case's intent must never downgrade a
 *      converter's claim that it mapped a foreign suite exactly — see
 *      {@link INTENT_EXCLUDED_FROM_SEMANTIC_EXACTNESS}. Intent is not part of
 *      what a case MEANS, so a comparison that folds it in reports a semantic
 *      difference where only a label moved.
 *   2. **Absence.** A case that was never labelled is UNLABELLED, permanently.
 *      Nothing in this module manufactures a default bucket — see
 *      {@link UNLABELED_INTENT_LABEL}. Old rows carry no intent and must render
 *      as unlabelled rather than being folded into a synthetic `general` that
 *      nobody authored and that would silently absorb every historical case.
 *
 * ── Two shapes, deliberately ─────────────────────────────────────────────────
 *
 * {@link caseIntentSchema} is the AUTHORED/STORED form: `string`, already
 * trimmed, 1..{@link MAX_INTENT_CHARS} characters. Absence is expressed by the
 * field being absent, never by `null` and never by `""`.
 *
 * {@link caseIntentUpdateSchema} is the WIRE form at an authoritative mutation
 * or file-reconciliation boundary, and it is the ONLY place `null` is legal.
 * The three-way distinction it encodes cannot be expressed with two states:
 *
 *   - **omitted** — the caller did not speak to intent. PRESERVE what is
 *     stored. This is what an older client sends, and reading it as "clear"
 *     would let every pre-B5c CLI silently strip labels off cases it round-trips.
 *   - **`null`** — the caller is authoritative and says there is no intent.
 *     CLEAR it.
 *   - **a string** — set it, after {@link normalizeIntent}.
 *
 * {@link resolveIntentUpdate} is the one sanctioned way to apply that
 * three-way rule, so no call site has to re-derive it (and get `?? undefined`
 * wrong, which collapses `null` and omitted into the same branch).
 *
 * ── Wiring status ────────────────────────────────────────────────────────────
 *
 * B5a freezes this contract ONLY. No production suite-file validator, `EvalTest`
 * author, serializer, reporter or Platform mapping accepts or sends `intent`
 * yet; that is B5c's job, and it lands only once the backend that persists the
 * field is deployed. The rule this staging exists to honour is that no released
 * CLI or SDK may accept a nonempty intent and silently discard it — a field that
 * validates but is dropped on write is worse than a field that does not exist,
 * because the author believes it was saved.
 */

import { z } from "zod";

/**
 * Max length of a stored intent label.
 *
 * Small on purpose. Intent is a GROUPING key, and a grouping key long enough to
 * hold a sentence produces a funnel with one row per case — which is not a
 * comparison, it is the raw table with extra steps. 64 characters is room for a
 * phrase and not room for a description.
 */
export const MAX_INTENT_CHARS = 64;

/**
 * What an absent intent is CALLED in a rendered funnel.
 *
 * Exported so every surface says the same word, and stated here rather than in
 * a UI file so it cannot drift into "General" / "Other" / "Uncategorized" per
 * component. This is a DISPLAY string: it is never stored, never sent, and
 * never matched against — an unlabelled slice carries `value: null`, and a case
 * whose author literally typed "Unlabeled" is a different, labelled slice.
 */
export const UNLABELED_INTENT_LABEL = "Unlabeled";

/**
 * Intent is excluded from import semantic-exactness comparison.
 *
 * A named constant rather than a bare comment because the exclusion is a
 * CONTRACT that a future comparator has to honour, and the reason is not
 * self-evident from the field: converters claim `exact` when the case they
 * produced means the same thing as the case they read. Intent means nothing to
 * grading, so tagging an imported case — or retagging it later — must leave
 * that claim untouched. Folding it in would downgrade a correct converter to
 * `approximate` the first time somebody labelled a funnel.
 */
export const INTENT_EXCLUDED_FROM_SEMANTIC_EXACTNESS = true as const;

/**
 * The authored / stored intent.
 *
 * Validates an ALREADY-TRIMMED value rather than trimming as a transform: this
 * schema projects into the generated JSON Schema and is hand-mirrored by the
 * backend validator, and a transform does neither. Normalization is
 * {@link normalizeIntent}'s job at the boundary, and this is the invariant that
 * holds afterwards.
 */
export const caseIntentSchema = z
  .string()
  .min(1)
  .max(MAX_INTENT_CHARS)
  .refine((value) => value.trim() === value, {
    message:
      "intent must be trimmed (no leading or trailing whitespace); " +
      "normalize with normalizeIntent before validating",
  });

export type CaseIntent = z.infer<typeof caseIntentSchema>;

/**
 * The intent as it appears on an authoritative mutation or file-reconciliation
 * wire.
 *
 * `null` is legal HERE and nowhere else. See the module docblock for the
 * three-way omitted / `null` / string rule, and {@link resolveIntentUpdate} for
 * the only sanctioned way to apply it.
 */
export const caseIntentUpdateSchema = caseIntentSchema.nullable();

export type CaseIntentUpdate = z.infer<typeof caseIntentUpdateSchema>;

/**
 * Trim a candidate intent into its stored form, or `undefined` if there is none.
 *
 * Returns `undefined` — not `""` and not `null` — for every shape of "nothing":
 * absent, empty, and whitespace-only. A stored empty string is a third way to
 * say absent, and three ways to say absent is how one of them ends up rendering
 * as a real, empty-named funnel row.
 *
 * Over-long input is NOT silently truncated. Truncation invents a label the
 * author did not write and, worse, merges two distinct intents that share a
 * prefix into one bucket. The value is returned as-is for
 * {@link caseIntentSchema} to reject, so the author is told.
 */
export function normalizeIntent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** The outcome of applying one wire-level intent update to a stored value. */
export type IntentUpdateResolution = {
  /**
   * Whether the caller spoke to intent at all.
   *
   * `false` means OMITTED, and a writer must leave the stored field exactly as
   * it found it — not write `undefined` over it, which is the same bug spelled
   * differently.
   */
  changed: boolean;
  /** The value to store when `changed`. `undefined` means "clear the field". */
  value: string | undefined;
};

/**
 * Apply the omitted / `null` / string rule to one incoming intent.
 *
 * The whole point is that `undefined` and `null` mean OPPOSITE things here, so
 * the caller never writes `incoming ?? current` (which preserves on clear) or
 * `incoming ?? undefined` (which clears on omit). Both are one keystroke from
 * correct and neither fails a type check.
 *
 * A string that normalizes to nothing — `""`, `"   "` — is treated as an
 * explicit CLEAR, not as an omission: the caller did speak, and what they said
 * was "no label".
 */
export function resolveIntentUpdate(
  incoming: string | null | undefined
): IntentUpdateResolution {
  if (incoming === undefined) return { changed: false, value: undefined };
  if (incoming === null) return { changed: true, value: undefined };
  return { changed: true, value: normalizeIntent(incoming) };
}

/**
 * The slice key an intent groups under, for aggregation.
 *
 * `null` for unlabelled, mirroring the nullable `value` on an intent slice —
 * NOT {@link UNLABELED_INTENT_LABEL}, which is a display word. Keying on the
 * display word would make a case literally labelled "Unlabeled" collide with
 * every case that was never labelled at all, and no reader of the resulting
 * funnel could tell the merge had happened.
 */
export function intentSliceKey(intent: string | undefined): string | null {
  return normalizeIntent(intent) ?? null;
}

/**
 * Compare two intents for FINGERPRINTING — authored-config revision and run
 * identity.
 *
 * Intent participates in the authored config revision: a run tagged `"search"`
 * and the same run tagged `"browse"` are not the same authored configuration,
 * and a fingerprint that ignored the label would let a retag reuse a frozen
 * snapshot whose analytics then attribute trials to the wrong funnel.
 *
 * That is the exact opposite of the import-exactness rule above, and the two
 * are not in tension: exactness asks "does this case MEAN the same thing"
 * (intent does not participate), and fingerprinting asks "is this the same
 * authored configuration" (it does).
 */
export function intentFingerprintValue(intent: string | undefined): string {
  return normalizeIntent(intent) ?? "";
}
