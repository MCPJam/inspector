/**
 * serverId → user-assigned name, for namespacing SEP-2640 server-skill refs.
 *
 * Keyed by id rather than positional like `narrowTarget`'s `names`, so a
 * half-populated name array cannot misalign anything: an entry with no name is
 * simply absent, and `prepareChatV2` falls back to the server id for it. That
 * fallback is safe but ugly — the id is host-assigned, which is the property
 * that matters (a server must never get to choose the namespace its own skills
 * are addressed under, so `serverInfo.name` is never a candidate) — it just
 * reads as `p176vpy…/run-evals` instead of `mcpjam-staging-skills/run-evals`
 * in the `listSkills` catalog and in the origin banner on loaded skill content,
 * both of which the model and the user see.
 *
 * Returns `undefined` when nothing is labelled, so the call site can keep to
 * the spread-only-when-present convention the rest of the options use.
 */
export function serverLabelsFor(
  selected: ReadonlyArray<{ id: string; name?: string }>,
): Record<string, string> | undefined {
  const labels: Record<string, string> = {};
  for (const entry of selected) {
    if (typeof entry.name === "string" && entry.name.length > 0) {
      labels[entry.id] = entry.name;
    }
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

/** The two equivalent ways a caller says "run this turn with no tools". */
export function wantsNoTools(body: {
  maxToolCalls?: number;
  allowedTools?: string[];
}): boolean {
  return body.maxToolCalls === 0 || body.allowedTools?.length === 0;
}

/**
 * Should a claimed lease be handed back when this turn ends?
 *
 * The three-way distinction IS the idempotency guarantee, so it is stated
 * once, here, rather than inlined in a `finally` where the reasoning would be
 * invisible:
 *
 *   - SETTLED — the ingest completed the lease inside its own mutation. There
 *     is nothing to release.
 *   - SPENT (`modelCallStarted`) — the engine was entered, so money may be
 *     gone and tools may have run against the caller's servers. Releasing here
 *     would free the required-and-stable idempotencyKey to claim a fresh lease
 *     and re-run all of it, which is precisely what the lease exists to
 *     prevent. These keep the lease and let the TTL expire it, so a retry
 *     inside the window is refused rather than re-charged.
 *   - NEITHER — the turn died before any model call (bad target, dead server,
 *     unresolvable model). Release: the caller's retry should run, and holding
 *     the session locked for the full TTL would be a self-inflicted outage on
 *     the failure path that most needs to stay usable.
 */
export function shouldReleaseLease(state: {
  leaseTurnId: string | undefined;
  leaseSettled: boolean;
  modelCallStarted: boolean;
}): boolean {
  return Boolean(
    state.leaseTurnId && !state.leaseSettled && !state.modelCallStarted,
  );
}
