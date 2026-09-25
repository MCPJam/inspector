/**
 * One regex, in a module with no imports.
 *
 * `classifyTurnFailure` lived in `resolve-turn-runtime.ts`, which reaches the
 * model factories, the org stream handler and the usage writeback. Anything
 * that wanted this one predicate had to load all of it — and
 * `run-supervisor/retry.ts`, which composes it into `classifyRetry`, is meant
 * to be importable from the control-plane client, whose module graph was nine
 * files before and would have become a hundred and eighty-seven WITH A CYCLE.
 *
 * So the predicate moved down here and `resolve-turn-runtime.ts` re-exports it.
 * Every existing importer is untouched; the definition is still single.
 */

/**
 * The single source of truth for folding spend-cap / rate-limit errors into
 * the amber `rate_limited` outcome vs a hard `failed`. Both `runOneSession`'s
 * catch AND the per-runtime `classifyFailure` delegate here so the regex can't
 * drift between the two call sites.
 *
 * Matches provider rate-limits (`rate limit`, a literal `429` or "too many
 * requests" — the local-BYOK path attaches no code or status, so prose is all
 * that survives) AND org spend-cap wording (`spend`, `cap`, `quota`,
 * `budget`) — an org cap surfaced as "quota exceeded" / "budget exhausted"
 * must land in `rate_limited` so the swarm fan-out's whole-run stop can fire
 * on it (it re-inspects the message via `classifyRateLimit`).
 * `cap`/`quota`/`budget` are word-anchored so genuine spend-cap wording
 * matches but "capacity", "recap", "escape" do NOT (a provider capacity error
 * is a hard `failed`, not a spend cap). A bare `429` is anchored harder still —
 * never preceded by `:` or `.` — so a port (`127.0.0.1:429`) or a decimal stays
 * the hard failure it is.
 */
export function classifyTurnFailure(
  message: string,
): "rate_limited" | "failed" {
  // A step that came back empty was answered in full, so nothing throttled
  // it. Its explanation talks about the output-token "budget", and the prose
  // match below read that as an org spend cap: a Gemini model that spent its
  // tokens reasoning was reported to the user as "Google AI rate-limited this
  // key". The code is structural, so it decides before any wording does.
  if (/\bprovider_empty_response\b/.test(message)) return "failed";
  return /rate.?limit|too many requests|(?:^|[^\w.:])429\b|\bspend\b|spend_budget_reached|\bquota\b|\bbudget\b|\bcap\b/i.test(
    message,
  )
    ? "rate_limited"
    : "failed";
}
