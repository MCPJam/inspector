import { isTransientSpendRefusal } from "./swarm-attempt-error.js";

/** The fields a refusal states itself in; see the `holds_committed` check. */
const OWN_MESSAGE_KEYS = ["message", "error", "errorMessage"] as const;

/** Account credit exhaustion, shared by notifications and run schedulers.
 * Provider 429s and admin spend caps must never be treated as a top-up signal.
 */
export function isCreditExhaustion(value: unknown): boolean {
  // A bare string is the refusal's own message (a stored attempt row's text).
  if (typeof value === "string" && isTransientSpendRefusal(null, null, value))
    return false;
  const seen = new WeakSet<object>();
  const strings = new Set<string>();
  let exhausted = false;
  let excluded = false;
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      if (strings.has(item)) return;
      strings.add(item);
      if (
        // `platform_capacity`, `agent_turn_limit` and `agent_billing_rejected`
        // are Ask MCPJam's refusals: MCPJam's own budget, a per-user COUNT,
        // and a billing claim that did not hold. Like the others here, none is
        // a wallet anyone can top up — and they arrive on a surface the
        // product calls free, so selling credits against one would be wrong
        // twice over. The `starter`/`budget_truncated` codes are the same
        // thing for a free starter swarm conversation.
        /\b(?:platform_free_budget_exhausted|account_suspended|spend_budget_reached|ORGANIZATION_SPEND_BUDGET_REACHED|wallet_locked|platform_capacity|agent_turn_limit|agent_billing_rejected|starter_session_budget_reached|swarm_starter_rejected|starter_step_rejected|budget_truncated)\b/i.test(
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
        /\bThis request needs about \d+ MCPJam credits\b/i.test(item) ||
        /\b(?:out of (?:MCPJam )?credits|insufficient credits|credits? (?:balance )?(?:exhausted|depleted)|credit limit (?:was )?(?:reached|exceeded))\b/i.test(
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
    // Other in-flight requests hold the last credits; the backend says retry
    // in seconds. Treating it as exhaustion stopped runs and locked models.
    // The reason alone decides: a nested refusal can carry it without a code.
    // A stored attempt row keeps only the backend's sentence, so this object's
    // OWN message counts too — but not a string quoted anywhere else inside
    // it, which would let unrelated `details` text veto a real exhaustion.
    const record = item as Record<string, unknown>;
    if (
      record.refusalReason === "holds_committed" ||
      OWN_MESSAGE_KEYS.some((key) => {
        const own = record[key];
        return (
          typeof own === "string" && isTransientSpendRefusal(null, null, own)
        );
      })
    )
      excluded = true;
    if (item instanceof Error) visit(item.message);
    for (const nested of Object.values(item)) visit(nested);
  };
  visit(value);
  return exhausted && !excluded;
}
