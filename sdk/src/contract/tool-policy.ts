import type { EvalSuiteFileToolPolicy } from "./suite-file.js";

export type ToolSafetyClassification = "readOnly" | "destructive" | "unknown";

export type ToolPolicyDecisionReason =
  | "denyList"
  | "allowList"
  | "destructiveDefaultDeny"
  | "readOnlyModeClassified"
  | "readOnlyModeUnclassified"
  | "modeDefault";

export type ToolPolicyDecision = {
  allowed: boolean;
  reason: ToolPolicyDecisionReason;
  classification: ToolSafetyClassification;
};

/**
 * Server-provided annotations are advisory and UNTRUSTED. Missing, malformed,
 * or contradictory values must never be treated as evidence that a tool is
 * safe to run.
 */
export function classifyToolSafety(
  annotations: Record<string, unknown> | undefined
): ToolSafetyClassification {
  const readOnlyHint = annotations?.readOnlyHint;
  const destructiveHint = annotations?.destructiveHint;
  if (readOnlyHint === true && destructiveHint === true) return "unknown";
  if (destructiveHint === true) return "destructive";
  if (readOnlyHint === true) return "readOnly";
  return "unknown";
}

export function decideToolPolicy(args: {
  toolName: string;
  annotations?: Record<string, unknown>;
  policy: EvalSuiteFileToolPolicy;
}): ToolPolicyDecision {
  const { toolName, annotations, policy } = args;
  const classification = classifyToolSafety(annotations);
  if (policy.deny?.includes(toolName)) {
    return { allowed: false, reason: "denyList", classification };
  }
  if (policy.allow?.includes(toolName)) {
    return { allowed: true, reason: "allowList", classification };
  }
  // A contradictory pair is classified as unknown for reporting, but its
  // destructive hint still triggers the rule-3 deny-by-default safeguard.
  if (annotations?.destructiveHint === true) {
    return {
      allowed: false,
      reason: "destructiveDefaultDeny",
      classification,
    };
  }
  if (policy.mode === "readOnly") {
    return {
      allowed: classification === "readOnly",
      reason:
        classification === "readOnly"
          ? "readOnlyModeClassified"
          : "readOnlyModeUnclassified",
      classification,
    };
  }
  return { allowed: true, reason: "modeDefault", classification };
}
