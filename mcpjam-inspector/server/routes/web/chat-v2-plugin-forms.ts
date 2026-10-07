import { legacyPluginFormWire } from "../../services/plugin-host/owned-legacy.js";
import type { ModelToolExecutor } from "../../utils/model-tool-executor.js";

const MODERN = "2026-07-28";

/**
 * Which OpenAI plugin path a Playground chat turn installs on its manager.
 *
 * - `admitted`: the turn admits the plugin workspace at all (App context,
 *   App messages, owned model Apps, forms). An emulated turn does; so does a
 *   Codex harness turn, whose MCP tools run here in process (host-executed
 *   delivery) and so pass through the same per-call executor. A harness whose
 *   runtime calls MCP itself does not.
 * - `modernServerIds`: servers the plugin MRTR adapter may answer: pinned to
 *   2026-07-28, or unpinned (Auto), which can negotiate it. An unpinned
 *   server is also legacy-eligible; `chatPluginToolExecutor` picks per call
 *   from the era its connection negotiated. Never on a harness turn (it has
 *   no suspend/resume leg), and never with the client's Forms extension off:
 *   the adapter only exists to answer forms, so an ordinary tool call then
 *   runs on the normal path.
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
    input.mrtrEnabled && !input.harness && input.forms !== false
      ? input.serverIds.filter((id) => {
          const pin = input.pinFor(id);
          return pin === MODERN || pin === undefined;
        })
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

/**
 * The turn's plugin executor. A server in the modern plan whose connection
 * is on the 2026-07-28 era (by pin, or negotiated by an Auto client) goes to
 * the MRTR adapter; every other call goes to the legacy form executor when
 * one is installed, or runs as is.
 */
export function chatPluginToolExecutor(input: {
  modern?: { serverIds: readonly string[]; execute: ModelToolExecutor };
  legacy?: ModelToolExecutor;
  pinFor: (serverId: string) => string | undefined;
  negotiatedVersion: (serverId: string) => string | undefined;
}): ModelToolExecutor | undefined {
  const { modern, legacy } = input;
  if (!modern) return legacy;
  return (execution, run) => {
    const id = execution.serverKey;
    if (
      modern.serverIds.includes(id) &&
      (input.pinFor(id) === MODERN || input.negotiatedVersion(id) === MODERN)
    )
      return modern.execute(execution, run);
    return legacy ? legacy(execution, run) : run();
  };
}
