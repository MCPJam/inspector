/** Account credit exhaustion, shared by notifications and run schedulers.
 * Provider 429s and admin spend caps must never be treated as a top-up signal.
 */
export function isCreditExhaustion(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const strings = new Set<string>();
  let exhausted = false;
  let excluded = false;
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (strings.has(item)) return;
      strings.add(item);
      if (
        /\b(?:platform_free_budget_exhausted|account_suspended|spend_budget_reached|ORGANIZATION_SPEND_BUDGET_REACHED|wallet_locked)\b/i.test(
          item,
        )
      ) {
        excluded = true;
      }
      if (
        /\b(?:mcpjam_rate_limit|user_rate_limit|org_rate_limit|billing_limit_reached)\b/i.test(
          item,
        ) ||
        /mcpjam[\w\s-]{0,40}model limit/i.test(item) ||
        /\b(?:daily|monthly) (?:MCPJam )?credit limit reached\b/i.test(item) ||
        /\b(?:out of credits|insufficient credits|credits? (?:balance )?(?:exhausted|depleted)|credit limit (?:was )?(?:reached|exceeded))\b/i.test(
          item,
        )
      )
        exhausted = true;
      // Error envelopes often prefix a JSON response with a URL and status.
      const start = item.indexOf("{");
      if (start >= 0) {
        try {
          visit(JSON.parse(item.slice(start)));
        } catch {
          /* Plain text. */
        }
      }
      return;
    }
    if (!item || typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    // Billing also uses this code for plan quotas (e.g. Eval iteration count).
    // Those have their own upgrade dialog and cannot be lifted by credit.
    for (const key of ["gateKey", "limit"]) {
      const gate = (item as Record<string, unknown>)[key];
      if (
        typeof gate === "string" &&
        /^max[A-Z]/.test(gate) &&
        !/credit/i.test(gate)
      )
        excluded = true;
    }
    if ("limitKind" in item && item.limitKind === "concurrency")
      excluded = true;
    if (item instanceof Error) visit(item.message);
    for (const nested of Object.values(item)) visit(nested);
  };
  visit(value);
  return exhausted && !excluded;
}
