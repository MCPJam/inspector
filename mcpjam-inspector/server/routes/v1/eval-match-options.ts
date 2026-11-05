/**
 * Tool-call match options on the v1 eval API: the two vocabularies a body may
 * spell them in, and the translation between those and storage.
 *
 * PUBLIC is what every response returns and what the CLI help, the SDK types
 * and the reference docs use: a `toolCallOrder` of `any`, `in-order` or
 * `exact`, `extraToolCalls`, `arguments`. INTERNAL is what storage and the
 * matcher read: a `toolCallOrder` of `ignore`, `superset` or `strict`,
 * `maxExtraToolCalls` (legacy `allowExtraToolCalls`), `argumentMatching`.
 *
 * Every body that carries match options — a run override, an inline test on a
 * run or a new suite, a case create or update, the suite defaults — accepts
 * either vocabulary through {@link matchOptionsInputSchema}, so a value that
 * works on one of them works on all of them. Both schemas are `.strict()` and
 * the vocabularies are disjoint, so a body can satisfy only one: mixing them in
 * one object is a 400, never a silent pick.
 */
import { z } from "zod";
import {
  matchOptionsSchema,
  type MatchOptionsDTO,
} from "@/shared/eval-matching";

const PUBLIC_TOOL_CALL_ORDER = ["any", "in-order", "exact"] as const;
const PUBLIC_ARGUMENTS = ["ignore", "partial", "exact"] as const;
// Public → internal tool-call-order vocabulary (and the inverse for DTOs).
const ORDER_TO_INTERNAL = {
  any: "ignore",
  "in-order": "superset",
  exact: "strict",
} as const;
const ORDER_TO_PUBLIC: Record<string, (typeof PUBLIC_TOOL_CALL_ORDER)[number]> =
  { ignore: "any", superset: "in-order", strict: "exact" };

export const publicMatchOptionsSchema = z
  .object({
    toolCallOrder: z.enum(PUBLIC_TOOL_CALL_ORDER).optional(),
    extraToolCalls: z
      .union([z.literal("unlimited"), z.number().int().min(0)])
      .optional(),
    arguments: z.enum(PUBLIC_ARGUMENTS).optional(),
  })
  .strict();
export type PublicMatchOptions = z.infer<typeof publicMatchOptionsSchema>;

/** Match options in either vocabulary; fold with {@link toInternalMatchOptions}. */
export const matchOptionsInputSchema = z.union([
  publicMatchOptionsSchema,
  matchOptionsSchema,
]);
export type MatchOptionsInput = z.infer<typeof matchOptionsInputSchema>;

/**
 * A re-parse is a reliable discriminant because the vocabularies are disjoint.
 * An EMPTY object parses as public and folds to an empty object, which is the
 * same no-op either way.
 */
function isPublicMatchOptions(
  value: MatchOptionsInput,
): value is PublicMatchOptions {
  return publicMatchOptionsSchema.safeParse(value).success;
}

/** Fold match options sent in either vocabulary down to the internal shape. */
export function toInternalMatchOptions(
  value: MatchOptionsInput,
): MatchOptionsDTO {
  if (!isPublicMatchOptions(value)) return value;
  const out: MatchOptionsDTO = {};
  if (value.toolCallOrder !== undefined)
    out.toolCallOrder = ORDER_TO_INTERNAL[value.toolCallOrder];
  if (value.extraToolCalls !== undefined)
    out.maxExtraToolCalls =
      value.extraToolCalls === "unlimited" ? null : value.extraToolCalls;
  if (value.arguments !== undefined) out.argumentMatching = value.arguments;
  return out;
}

/**
 * Merge a partial patch, in either vocabulary, onto the stored (internal)
 * object. `updateTestSuite`/`updateTestCase` replace the field wholesale, so a
 * partial patch must layer onto current values or every field it does not
 * mention is reset.
 *
 * The extra-call bound the patch names replaces whichever spelling was stored.
 * `maxExtraToolCalls` wins over the legacy `allowExtraToolCalls` on read, so a
 * patch setting the modern field drops the legacy one, and a patch setting the
 * legacy flag drops a stored `maxExtraToolCalls` that would otherwise shadow it.
 */
export function mergeMatchOptions(
  current: unknown,
  patch: MatchOptionsInput,
): Record<string, unknown> {
  const partial = toInternalMatchOptions(patch);
  const merged: Record<string, unknown> = {
    ...(current && typeof current === "object" ? current : {}),
    ...partial,
  };
  if ("maxExtraToolCalls" in partial) delete merged.allowExtraToolCalls;
  else if ("allowExtraToolCalls" in partial) delete merged.maxExtraToolCalls;
  return merged;
}

/** Stored match options in the public vocabulary every response returns. */
export function toPublicMatchOptions(
  stored: unknown,
): PublicMatchOptions | null {
  if (!stored || typeof stored !== "object") return null;
  const internal: {
    toolCallOrder?: unknown;
    maxExtraToolCalls?: unknown;
    allowExtraToolCalls?: unknown;
    argumentMatching?: unknown;
  } = stored;
  // `maxExtraToolCalls` is the current field and is authoritative whenever the
  // key is PRESENT — including an explicit `null`, which means unlimited. Only
  // fall back to the legacy boolean `allowExtraToolCalls` when the modern field
  // is entirely absent (the SDK matcher shims true→null, false→0).
  let extraToolCalls: "unlimited" | number;
  if (internal.maxExtraToolCalls !== undefined) {
    extraToolCalls =
      internal.maxExtraToolCalls === null
        ? "unlimited"
        : Number(internal.maxExtraToolCalls);
  } else if (typeof internal.allowExtraToolCalls === "boolean") {
    extraToolCalls = internal.allowExtraToolCalls ? "unlimited" : 0;
  } else {
    extraToolCalls = "unlimited";
  }
  return {
    toolCallOrder: ORDER_TO_PUBLIC[String(internal.toolCallOrder)] ?? "any",
    extraToolCalls,
    arguments:
      PUBLIC_ARGUMENTS.find((value) => value === internal.argumentMatching) ??
      "partial",
  };
}
