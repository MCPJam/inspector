import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";

/** Cached native tool closures may survive a configuration refresh. */
export function nativePolicyDigest(
  policies: Record<string, ToolPolicySnapshot> = {},
): string {
  const normalized = Object.entries(policies)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, policy]) => [
      server,
      policy.mode,
      policy.unknownTool,
      [...policy.known].sort(),
      Object.entries(policy.denied)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, decision]) => [
          name,
          decision.reason,
          decision.classification,
        ]),
    ]);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function stampNativeForwardingPolicy(
  state: { data: unknown },
  policyDigest: string,
) {
  return {
    ...state,
    data: {
      ...z.record(z.string(), z.unknown()).parse(state.data),
      mcpjamForwardingPolicy: policyDigest,
    },
  };
}
