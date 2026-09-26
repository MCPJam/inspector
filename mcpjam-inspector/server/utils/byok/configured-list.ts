import { normalizeIds } from "./list-request.js";
import type {
  ByokAdapterDeps,
  ByokConnection,
  ByokListResult,
} from "./types.js";

/**
 * `listModels` for providers addressed by ids the connection was configured
 * with (Azure deployment names, Bedrock model / inference-profile ids, custom
 * provider model ids). No network: the configured list IS the answer, and an
 * empty one is reported as such rather than guessed.
 */
export function listConfiguredModels(
  connection: ByokConnection,
  deps: ByokAdapterDeps = {},
): ByokListResult {
  return {
    ok: true,
    source: "configured",
    models: normalizeIds(connection.configuredModelIds).map((nativeId) => ({
      nativeId,
    })),
    complete: true,
    observedAt: (deps.now ?? Date.now)(),
  };
}
