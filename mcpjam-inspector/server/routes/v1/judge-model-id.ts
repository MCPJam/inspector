/**
 * The judge model id as the backend stores it, from the spelling a caller
 * sent.
 *
 * The SDK and CLI document `mcpjam/<vendor>/<model>` as the way to name a
 * model MCPJam hosts (`mcpjam/anthropic/claude-haiku-4.5`), and a suite file
 * is written in that vocabulary. The backend catalog knows the model as
 * `<vendor>/<model>`, so a judge named the documented way was refused on save
 * with "is not in MCPJam's hosted model catalog" (CONVEX-33X).
 *
 * Stripping the prefix loses nothing for a HOSTED judge: `mcpjam/` states the
 * hosted rail, and a bare catalog id already means that rail. Judges are no
 * longer hosted-only — an organization selection (BYOK judge) is a valid
 * judge, and when the organization requires its own provider keys it is the
 * only one (there is no default judge then: one must be chosen) — but an org
 * judge is named by its selection, whose id carries no `mcpjam/` prefix, so
 * this rewrite never touches one ({@link canonicalJudgeModelIdForSelection}).
 * Which judge selections are admitted (org yes; local and stored-legacy no; a
 * picked hosted judge not under the org-key policy) is the backend's
 * decision, not this helper's. This is NOT a general model-id rewrite and
 * must not become one: an eval TARGET's prefix chooses between hosted and
 * BYOK, and how a hosted run routes a `mcpjam/` target is a separate question
 * from what a judge stores.
 *
 * Rewritten ONLY when what follows the prefix is, exactly, a hosted catalog
 * id. Anything else is returned trimmed but otherwise as sent, so the backend
 * refuses it under the id the caller typed rather than one we derived:
 *   - a dashed legacy alias (`mcpjam/anthropic/claude-sonnet-4-6`): the save
 *     check would accept it through its alias table, but grading looks the
 *     model up by exact id and would fail every trial;
 *   - a double prefix (`mcpjam/mcpjam/…`), padding inside the id, a missing
 *     vendor or model segment;
 *   - a different case (`MCPJam/…`, `…/Anthropic/…`): every other parser of
 *     this prefix, and the catalog itself, is case-sensitive.
 * Catalog membership alone rules out every one of these; the explicit
 * `rest === rest.trim()` check is there because `isHostedCatalogModel` trims
 * its input, and a padded id must not be rewritten into a different one.
 *
 * The catalog consulted is the Inspector's cached copy (the seed snapshot plus
 * a periodic fetch), not the backend's. A model the backend has just started
 * serving is forwarded as typed until the next refresh, and refused with the
 * CONVEX-33X message: no worse than before this rewrite existed, and gone once
 * the rewrite moves into the backend's judge-write path.
 */
import { z } from "zod";
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";

const HOSTED_PREFIX = "mcpjam/";

export function canonicalJudgeModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed.startsWith(HOSTED_PREFIX)) return trimmed;
  const rest = trimmed.slice(HOSTED_PREFIX.length);
  return rest === rest.trim() && isHostedCatalogModel(rest) ? rest : trimmed;
}

/**
 * The judge model id to store beside the selection it was sent with.
 *
 * Only a HOSTED judge (or a bare id with no selection) is normalized: an org
 * selection's id is the org connection's model id and is forwarded exactly as
 * sent, so it is never rewritten into a hosted catalog id or refused here. A
 * `mcpjam/` id beside an org selection contradicts it, and the mismatch check
 * that compares the two then says so in the caller's own words.
 */
export function canonicalJudgeModelIdForSelection(
  model: string,
  selection?: { source?: unknown } | null,
): string {
  if (selection && selection.source !== "hosted") return model.trim();
  return canonicalJudgeModelId(model);
}

/**
 * A judge model field that is checked (non-blank, trimmed) but NOT yet
 * normalized: for a route that also takes the judge's selection, which decides
 * whether the hosted rewrite applies ({@link canonicalJudgeModelIdForSelection}).
 */
export const judgeModelIdInputSchema = z.string().trim().min(1);

/**
 * The one schema for a judge model field on `/api/v1`. Every route that writes
 * a judge model parses it through here, so a new one cannot forget the
 * rewrite, and a blank or padded id is handled the same way everywhere.
 */
export const judgeModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .overwrite(canonicalJudgeModelId);
