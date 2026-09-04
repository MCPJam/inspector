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
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
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

/**
 * A stable string for the host-tool catalog alone.
 *
 * Separate from the turn fingerprint because the two force different things. A
 * changed tool set cannot be absorbed by a restarted THREAD: Codex reads its
 * MCP server's tool list once, when the PROCESS starts, and this adapter wires
 * no `tools/list_changed`. So the catalog is what decides whether the runtime
 * itself has to be rebuilt, while instructions (a `thread/start` parameter) only
 * need a new thread.
 */
export function toolCatalogFingerprint(
  tools: readonly TurnFingerprintTool[],
): string {
  return stableStringify(
    [...tools]
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? null,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  );
}

/**
 * A stable string for everything baked into a Codex PROCESS when it spawns.
 *
 * The coarser of the two: a change here rebuilds the RUNTIME, not just the
 * thread. Both members earn that. `webSearch` is rendered into the
 * `config.toml` the process reads at startup, and the tool catalog is read from
 * the MCP server once at the same moment — so a new thread against a reused
 * process would keep the tools it booted with, leaving a newly-selected server
 * uncallable and a removed one still callable.
 *
 * Lives beside the turn fingerprint rather than in the bridge because the two
 * decide overlapping things, and the next field added has to be put in the
 * right one of them. Reading them apart is how that goes wrong.
 */
export function runtimeConfigFingerprint(input: {
  webSearch?: boolean | undefined;
  tools?: readonly TurnFingerprintTool[] | undefined;
}): string {
  return stableStringify({
    webSearch: input.webSearch ?? false,
    tools: toolCatalogFingerprint(input.tools ?? []),
  });
}

/** A stable string for the turn configuration a live Codex thread is pinned to. */
export function turnConfigurationFingerprintInput(input: {
  instructions: string | undefined;
  tools: readonly TurnFingerprintTool[];
}): string {
  return stableStringify({
    instructions: input.instructions ?? "",
    tools: toolCatalogFingerprint(input.tools),
  });
}
