import { legacyPluginFormWire } from "../../services/plugin-host/owned-legacy.js";

/**
 * Which OpenAI plugin path a Playground chat turn installs on its manager.
 *
 * - `admitted`: the turn admits the plugin workspace at all (App context,
 *   App messages, owned model Apps, forms). An emulated turn does; so does a
 *   Codex harness turn, whose MCP tools run here in process (host-executed
 *   delivery) and so pass through the same per-call executor. A harness whose
 *   runtime calls MCP itself does not.
 * - `modernServerIds`: servers pinned to 2026-07-28, answered by the plugin
 *   MRTR adapter. Never on a harness turn: it has no suspend/resume leg.
 * - `legacyServerIds`: servers the `openai/elicitation/create` handler
 *   answers (see `legacyPluginFormWire`). The manager's capabilities are
 *   shared, so this is all of the turn's servers or none: a mixed batch keeps
 *   its existing collector rather than over-advertising a partial handler.
 *   With the client's Forms extension off it is none, and nothing is claimed.
 */
export function chatPluginFormPlan(input: {
  harness: string | undefined;
  serverIds: readonly string[];
  pinFor: (serverId: string) => string | undefined;
  mrtrEnabled: boolean;
  forms: boolean | undefined;
}): {
  admitted: boolean;
  modernServerIds: string[];
  legacyServerIds: string[];
} {
  const admitted = !input.harness || input.harness === "codex";
  if (!admitted)
    return { admitted, modernServerIds: [], legacyServerIds: [] };
  const modernServerIds =
    input.mrtrEnabled && !input.harness
      ? input.serverIds.filter((id) => input.pinFor(id) === "2026-07-28")
      : [];
  const eligible = input.serverIds.filter((id) =>
    legacyPluginFormWire(input.pinFor(id)),
  );
  const legacyServerIds =
    eligible.length &&
    eligible.length === input.serverIds.length &&
    input.forms !== false
      ? eligible
      : [];
  return { admitted, modernServerIds, legacyServerIds };
}
