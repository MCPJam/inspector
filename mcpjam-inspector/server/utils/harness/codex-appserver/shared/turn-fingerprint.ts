/**
 * The turn-configuration fingerprint, shared by the host adapter and the
 * in-sandbox bridge.
 *
 * ONE implementation on purpose. Both sides compute this independently — the
 * host to decide whether to ask for a restart, the bridge to decide whether to
 * honour one — and two hand-mirrored copies would drift on the next field
 * added, with the failure mode being a thread that silently keeps a stale tool
 * catalog. `shared/` is imported by both, so they cannot disagree.
 *
 * WHY THE WHOLE DESCRIPTOR, not just the name: Codex reads its MCP server's
 * tool list exactly once, at startup, and this adapter wires no
 * `tools/list_changed`. A tool that keeps its name while its description or
 * input schema changes is therefore invisible to a running thread — the model
 * goes on calling it with the old contract. Names alone missed exactly that.
 */

/** JSON with sorted keys, so an object built in a different order hashes the
 *  same. Without it a harmless key reorder upstream would look like a changed
 *  tool and restart the thread on every turn, which is worse than the bug this
 *  file fixes: it would break multi-turn resume outright. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/** The subset of a host tool that a running thread cannot absorb a change to. */
export type TurnFingerprintTool = {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
};

/** A stable string for the turn configuration a live Codex thread is pinned to. */
export function turnConfigurationFingerprintInput(input: {
  instructions: string | undefined;
  tools: readonly TurnFingerprintTool[];
}): string {
  return stableStringify({
    instructions: input.instructions ?? "",
    tools: [...input.tools]
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? null,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  });
}
