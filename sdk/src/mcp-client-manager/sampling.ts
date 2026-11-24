import type { ManagedMcpClient } from "./managed-mcp-client.js";
import type { SamplingCallback } from "./types.js";

/**
 * A connection declares `sampling` only when something answers it, as it
 * declares `elicitation` only when a handler is registered: advertise = answer.
 */
export function withSamplingCapability(
  capabilities: Record<string, unknown>,
  callback: SamplingCallback | undefined
): Record<string, unknown> {
  return callback
    ? { ...capabilities, sampling: capabilities.sampling ?? {} }
    : capabilities;
}

/**
 * On revisions before 2026-07-28 the server asks the client directly, so the
 * client needs a handler for it once `sampling` was declared. On 2026-07-28 the
 * request rides in an `input_required` result and the MRTR collector answers.
 */
export function applySamplingHandler(
  client: ManagedMcpClient,
  serverId: string,
  declared: Record<string, unknown>,
  callback: SamplingCallback | undefined
): void {
  if (declared.sampling == null || !callback) return;
  client.setRequestHandler("sampling/createMessage", (request) =>
    callback({ serverId, params: request.params ?? {} })
  );
}
