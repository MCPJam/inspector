import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import { canonicalJson } from "../../tool-approval-token.js";

export function forwardingToolPolicy(
  policy?: ToolPolicySnapshot,
): ToolPolicySnapshot {
  return (
    policy ?? { mode: "default", denied: {}, known: [], unknownTool: "allow" }
  );
}

/** Cached native tool closures may survive a configuration refresh. */
export function nativePolicyDigest(
  policies: Record<string, ToolPolicySnapshot> = {},
  delivery?: unknown,
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
  return createHash("sha256")
    .update(
      delivery === undefined
        ? JSON.stringify(normalized)
        : canonicalJson([normalized, delivery]),
    )
    .digest("hex");
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

/** Check the host-owned snapshot before the adapter can attach to a paused agent. */
export function assertPendingPolicy(state: unknown, digest: string): void {
  const stamp = z.object({ data: z.object({ mcpjamForwardingPolicy: z.literal(digest) }) });
  if (!stamp.safeParse(state).success)
    throw new Error("The pending turn's tool policy has changed. Start a new turn.");
}
