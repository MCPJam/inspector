/**
 * Skill-metadata context budget (INS-3).
 *
 * OpenAI's plugin guidance caps the skill DISCOVERY listing — the names and
 * descriptions every turn pays for, before the model has chosen anything — at
 * 2% of the model's context. MCPJam adopts that number directly rather than
 * inventing one: a plugin authored against OpenAI's budget must behave the same
 * here, or an eval run in MCPJam stops predicting the plugin's real behavior.
 *
 * The budget is stated in TOKENS and enforced here in CHARACTERS, because the
 * listing is assembled as a string long before any tokenizer sees it. We use
 * the conventional ~4 chars/token English approximation. It is an
 * approximation on purpose: exact tokenization would need the model's own
 * tokenizer at list time, and the failure it would prevent (a listing a few
 * percent over budget) is not worth a per-model tokenizer dependency.
 *
 * Ordering of the two remedies is the load-bearing part, and comes from the
 * plan: TRUNCATE descriptions before OMITTING skills. A truncated description
 * still lets the model find the skill and call `loadSkill`, which delivers the
 * full body; an omitted skill is invisible and unreachable. Omission is the
 * last resort and is always reported.
 */

/** OpenAI's cap on discovery metadata, as a fraction of model context. */
export const SKILL_METADATA_CONTEXT_FRACTION = 0.02;
/** The plan's fallback when the model's context size is unknown. */
export const SKILL_METADATA_FALLBACK_BUDGET_CHARS = 8_000;
/** Conventional English approximation used to spend a token budget on chars. */
const CHARS_PER_TOKEN = 4;
/**
 * Below this, a description is not worth truncating further — the remaining
 * text would not describe anything. Entries that cannot fit even this are
 * omitted instead.
 */
const MIN_DESCRIPTION_CHARS = 40;

export interface SkillMetadataEntry {
  /** The model-facing identity (bare name or `<plugin>/<skill>`). */
  ref: string;
  description: string;
  /**
   * Provenance rendered in the same line (`plugin alpha@aaaa1111`, `project`).
   *
   * Charged as part of the entry's fixed cost. It is NOT decoration: a plugin
   * origin runs 20-30 characters, so leaving it uncharged overshoots the cap by
   * an amount that GROWS with the number of plugin skills — the exact case the
   * budget exists for.
   */
  origin?: string;
}

export interface SkillMetadataBudgetResult<T extends SkillMetadataEntry> {
  /** Entries to advertise, in input order, descriptions possibly truncated. */
  entries: T[];
  /** Refs whose description was shortened to fit. */
  truncatedRefs: string[];
  /** Refs dropped entirely — the model cannot see or load these. */
  omittedRefs: string[];
  budgetChars: number;
}

/**
 * The character budget for a model's discovery listing.
 *
 * A non-finite or non-positive context length is treated as UNKNOWN, not as
 * zero: a model definition missing `contextLength` must fall back to the
 * documented 8,000 characters, never silently advertise nothing.
 */
export function skillMetadataBudgetChars(modelContextTokens?: number): number {
  if (
    typeof modelContextTokens !== "number" ||
    !Number.isFinite(modelContextTokens) ||
    modelContextTokens <= 0
  ) {
    return SKILL_METADATA_FALLBACK_BUDGET_CHARS;
  }
  return Math.floor(
    modelContextTokens * SKILL_METADATA_CONTEXT_FRACTION * CHARS_PER_TOKEN,
  );
}

/**
 * Fit a discovery listing into `budgetChars`.
 *
 * Cost is charged per entry as `ref + origin + description` plus the line's own
 * punctuation, matching the emitted `- **<ref>** (<origin>): <description>\n`
 * exactly — the accounting must track what is actually emitted, or the budget
 * silently permits more than it claims.
 *
 * Two passes, in the plan's order:
 *   1. Admit entries at full description while they fit.
 *   2. On the first entry that does not fit, truncate its description to the
 *      remaining budget; if what remains cannot carry a useful description,
 *      omit that entry and keep trying the rest (a later short entry may still
 *      fit, and dropping it too would hide a skill for no gain).
 */
export function applySkillMetadataBudget<T extends SkillMetadataEntry>(
  entries: T[],
  budgetChars: number,
): SkillMetadataBudgetResult<T> {
  /**
   * The punctuation of `- **<ref>** (<origin>): <description>\n`:
   * `- **` + `** (` + `): ` + the newline = 12 characters.
   */
  const LINE_PUNCTUATION_CHARS = 12;

  const admitted: T[] = [];
  const truncatedRefs: string[] = [];
  const omittedRefs: string[] = [];
  let spent = 0;

  for (const entry of entries) {
    const fixed =
      entry.ref.length + (entry.origin?.length ?? 0) + LINE_PUNCTUATION_CHARS;
    const full = fixed + entry.description.length;
    if (spent + full <= budgetChars) {
      admitted.push(entry);
      spent += full;
      continue;
    }
    const room = budgetChars - spent - fixed;
    if (room < MIN_DESCRIPTION_CHARS) {
      omittedRefs.push(entry.ref);
      continue;
    }
    // `…` signals the truncation to the model, which can still call
    // `loadSkill` for the whole thing.
    admitted.push({
      ...entry,
      description: `${entry.description.slice(0, room - 1)}…`,
    });
    truncatedRefs.push(entry.ref);
    spent += fixed + room;
  }

  return { entries: admitted, truncatedRefs, omittedRefs, budgetChars };
}

/**
 * Overflow sentence appended OUTSIDE the budget when skills were dropped.
 * Shared by every inlined catalog (live cloud, pinned, effective) so the
 * notice stays byte-identical across surfaces.
 */
export function skillCatalogOverflowNotice(omittedCount: number): string {
  return `(${omittedCount} more skill${
    omittedCount === 1 ? "" : "s"
  } could not be listed within this model's skill-metadata budget.)`;
}

/**
 * Render a budgeted catalog as prompt-ready bullet lines.
 *
 * Entries with an `origin` keep the effective-path
 * `- **<ref>** (<origin>): <description>` shape; cloud/pinned entries omit
 * origin and render `- **<name>**: <description>`. Budget accounting is
 * unchanged (origin is optional and uncharged when absent).
 */
export function renderBudgetedSkillCatalog<T extends SkillMetadataEntry>(
  entries: T[],
  budgetChars: number,
): {
  lines: string[];
  omittedRefs: string[];
  truncatedRefs: string[];
} {
  const result = applySkillMetadataBudget(entries, budgetChars);
  const lines = result.entries.map((entry) =>
    entry.origin
      ? `- **${entry.ref}** (${entry.origin}): ${entry.description}`
      : `- **${entry.ref}**: ${entry.description}`,
  );
  return {
    lines,
    omittedRefs: result.omittedRefs,
    truncatedRefs: result.truncatedRefs,
  };
}

/** Join catalog lines and (when needed) the overflow notice. */
export function formatSkillCatalogBody(
  lines: string[],
  omittedRefs: string[],
): string {
  const notice =
    omittedRefs.length > 0
      ? `\n\n${skillCatalogOverflowNotice(omittedRefs.length)}`
      : "";
  return `${lines.join("\n")}${notice}`;
}
