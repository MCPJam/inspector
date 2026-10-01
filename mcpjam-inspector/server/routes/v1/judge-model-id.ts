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
 * Stripping the prefix loses nothing for a judge: judges only ever run on
 * MCPJam's hosted catalog, so `mcpjam/` states the one rail they already use.
 * This is NOT a general model-id rewrite — eval targets keep the id their
 * author picked, because there the prefix chooses between hosted and BYOK.
 *
 * Only a well-formed `mcpjam/<vendor>/<model>` is rewritten. Anything else
 * passes through verbatim, so the backend's refusal names exactly what the
 * caller typed.
 */
const HOSTED_PREFIX = "mcpjam/";

export function canonicalJudgeModelId(model: string): string {
  const trimmed = model.trim();
  if (!trimmed.toLowerCase().startsWith(HOSTED_PREFIX)) return model;
  const rest = trimmed.slice(HOSTED_PREFIX.length);
  const segments = rest.split("/");
  if (segments.length < 2 || segments.some((segment) => segment === "")) {
    return model;
  }
  return rest;
}
