/**
 * Eval TARGET models named the documented way, `mcpjam/<vendor>/<model>`.
 *
 * The SDK's local planner (`planModel`) reads the prefix as "the model MCPJam
 * hosts" and runs the case on the hosted rail, so a run in the cloud has to
 * store the same pick: the runner only recognizes a hosted target by its
 * catalog id, and a provider named `mcpjam` runs on no rail at all.
 *
 * A translated entry is stored the way the UI stores a hosted pick:
 * `{ model: "<vendor>/<model>", provider: "<vendor>" }`. It is rewritten ONLY
 * when
 * - what follows the prefix is exactly a hosted catalog id
 *   ({@link hostedIdBehindPrefix}, the rule the judge uses too);
 * - the provider is absent, `mcpjam`, or the vendor the id names, which is
 *   what `planModel` accepts beside the prefix;
 * - a saved selection, if any, is a hosted one.
 * Anything else is left exactly as sent, so a BYOK id is never touched. A
 * prefixed id that is not a hosted catalog id is refused by the route
 * ({@link isUnmappedHostedTarget}) rather than stored to fail at run time.
 */
import { hostedProviderFromCanonicalId } from "@/shared/types";
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";

const HOSTED_PREFIX = "mcpjam/";

/**
 * The hosted catalog id behind `mcpjam/`, or `undefined` when the id has no
 * prefix or what follows it is not, exactly, a hosted catalog id: a dashed
 * legacy alias, a double prefix, padding inside the id, a missing segment or
 * a different case. `isHostedCatalogModel` trims its input, hence the explicit
 * `rest === rest.trim()`: a padded id must not be rewritten into another one.
 */
export function hostedIdBehindPrefix(model: string): string | undefined {
  const trimmed = model.trim();
  if (!trimmed.startsWith(HOSTED_PREFIX)) return undefined;
  const rest = trimmed.slice(HOSTED_PREFIX.length);
  return rest === rest.trim() && isHostedCatalogModel(rest) ? rest : undefined;
}

/**
 * A target that claims the hosted rail (`mcpjam/…`) but names no hosted
 * catalog id: a typo, a dashed legacy alias, or a model the cached catalog
 * does not know yet. Stored, it would run as provider `mcpjam` and fail.
 */
export function isUnmappedHostedTarget(model: string): boolean {
  return model.trim().startsWith(HOSTED_PREFIX) && !hostedIdBehindPrefix(model);
}

/** A bare target model id (a suite's default model), translated or as sent. */
export function canonicalTargetModelId(model: string): string {
  return hostedIdBehindPrefix(model) ?? model;
}

/** A case's target `{ model, provider, selection }`, translated or as sent. */
export function canonicalTargetModelEntry<
  E extends {
    model: string;
    provider?: string;
    selection?: { source?: unknown } | null;
  },
>(entry: E): E {
  const hosted = hostedIdBehindPrefix(entry.model);
  if (!hosted) return entry;
  if (entry.selection && entry.selection.source !== "hosted") return entry;
  const slash = hosted.indexOf("/");
  const vendorSegment = (
    slash > 0 ? hosted.slice(0, slash) : hosted
  ).toLowerCase();
  const provider = hostedProviderFromCanonicalId(hosted);
  const hint = entry.provider?.trim().toLowerCase();
  if (
    hint &&
    hint !== "mcpjam" &&
    hint !== vendorSegment &&
    hint !== provider
  ) {
    return entry;
  }
  return { ...entry, model: hosted, provider };
}
