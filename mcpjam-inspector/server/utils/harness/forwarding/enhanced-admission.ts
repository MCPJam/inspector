import type { MCPClientManager } from "@mcpjam/sdk";
import { nativeForwardingGaps } from "./native-admission.js";
import {
  isEnhancedModelPolicy,
  isEnhancedMcpProfile,
} from "../harness-connection-profile.js";

type Candidate = Omit<Parameters<typeof nativeForwardingGaps>[0], "manager"> & {
  manager: MCPClientManager;
  modernInputAvailable?: boolean;
  ownedTasksAvailable?: boolean;
};
const BRIDGED_GAPS = new Set([
  "tool-visibility",
  "model-result-policy",
  "client-capabilities",
  "capability-overrides",
  "client-identity",
  "protocol-pins",
  "unqualified-protocol",
  "request-timeout",
  "client-behavior",
  "tasks",
]);

/** Choose the MCP delivery before the CLI starts; errors never switch the agent loop. */
export function forwardingAdmission(candidate: Candidate): {
  delivery?: "native" | "bridge";
  gaps: string[];
} {
  const gaps = nativeForwardingGaps(candidate);
  if (gaps.length === 0) return { delivery: "native", gaps };
  const bridged =
    !candidate.hasClientTools &&
    (!candidate.hasTasks || candidate.ownedTasksAvailable === true) &&
    isEnhancedModelPolicy(candidate.modelVisibleMcpToolResults) &&
    gaps.every((gap) => BRIDGED_GAPS.has(gap)) &&
    candidate.serverIds.every((id) =>
      isEnhancedMcpProfile(
        candidate.manager,
        id,
        candidate.modernInputAvailable === true,
        candidate.ownedTasksAvailable === true,
      ),
    );
  return { delivery: bridged ? "bridge" : undefined, gaps };
}
