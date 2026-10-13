import type { EvalSuiteFileToolPolicy } from "./suite-file.js";

export type ToolSafetyClassification = "readOnly" | "destructive" | "unknown";

/**
 * The reason vocabulary as VALUES, so an out-of-process consumer can validate a
 * reason it read back off the wire instead of trusting the string.
 */
export const TOOL_POLICY_DECISION_REASONS = [
  "denyList",
  "allowList",
  "destructiveDefaultDeny",
  "readOnlyModeClassified",
  "readOnlyModeUnclassified",
  "modeDefault",
  /**
   * A tool that did not exist when the policy decision snapshot was built
   * (`tools/list_changed` after launch). Out-of-process enforcement can see
   * such a call; the in-process gate cannot, because the tool was never in the
   * wrapped map. Denied whenever a policy is in force — allowing it would be a
   * fail-open the in-process path does not have.
   */
  "unknownAtLaunch",
] as const;

export type ToolPolicyDecisionReason =
  (typeof TOOL_POLICY_DECISION_REASONS)[number];

export function isToolPolicyDecisionReason(
  value: unknown
): value is ToolPolicyDecisionReason {
  return (
    typeof value === "string" &&
    (TOOL_POLICY_DECISION_REASONS as readonly string[]).includes(value)
  );
}

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

/**
 * A fully-resolved policy decision for every tool known at launch, so an
 * out-of-process enforcement point (the harness MCP proxy) performs a MAP
 * LOOKUP and never a classification. Annotations never travel with it.
 */
export type ToolPolicySnapshot = {
  mode: "default" | "readOnly";
  /**
   * Tool name → the denying decision. Allowed tools are absent.
   *
   * The classification travels with the reason because a block has to be
   * reported as the same `PolicyBlockRecord` the in-process gate produces, and
   * that record carries the classification; re-deriving it from the reason
   * would fabricate it (`denyList` says nothing about the annotations).
   */
  denied: Record<
    string,
    {
      reason: ToolPolicyDecisionReason;
      classification: ToolSafetyClassification;
    }
  >;
  /**
   * Every tool name the snapshot decided, denied or not.
   *
   * Required to enforce `unknownTool`: with `denied` alone, a tool that
   * appeared AFTER launch is indistinguishable from one that was decided and
   * allowed, so the enforcement point could not tell the two apart and
   * `unknownTool` would be unenforceable.
   */
  known: string[];
  /** What to do with a tool that was not known at launch. */
  unknownTool: "deny" | "allow";
};

/**
 * Resolve `policy` against every tool known at launch, using `decideToolPolicy`
 * itself — one pure function, no forked precedence at the enforcement point.
 *
 * `unknownTool` is `deny` whenever a policy is present: a tool that appears
 * after launch has no decision, and permitting it would let a `tools/list`
 * change defeat the policy.
 */
export function buildToolPolicySnapshot(args: {
  policy: EvalSuiteFileToolPolicy;
  tools: ReadonlyArray<{
    name: string;
    annotations?: Record<string, unknown> | undefined;
  }>;
}): ToolPolicySnapshot {
  const denied: ToolPolicySnapshot["denied"] = {};
  const known: string[] = [];
  for (const tool of args.tools) {
    if (!known.includes(tool.name)) known.push(tool.name);
    const decision = decideToolPolicy({
      toolName: tool.name,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      policy: args.policy,
    });
    if (!decision.allowed) {
      denied[tool.name] = {
        reason: decision.reason,
        classification: decision.classification,
      };
    }
  }
  return {
    mode: args.policy.mode === "readOnly" ? "readOnly" : "default",
    denied,
    known,
    unknownTool: "deny",
  };
}

/**
 * Decide one call against an already-resolved snapshot — a MAP LOOKUP, so an
 * out-of-process enforcement point never classifies anything.
 *
 * A tool absent from `snapshot.known` did not exist at launch, so no decision
 * was ever made for it: denied with `unknownAtLaunch` unless the snapshot says
 * unknown tools are allowed.
 */
export function decideToolPolicyFromSnapshot(args: {
  snapshot: ToolPolicySnapshot;
  toolName: string;
}):
  | { allowed: true }
  | {
      allowed: false;
      reason: ToolPolicyDecisionReason;
      classification: ToolSafetyClassification;
    } {
  const denied = args.snapshot.denied[args.toolName];
  if (denied) {
    return {
      allowed: false,
      reason: denied.reason,
      classification: denied.classification,
    };
  }
  if (
    !args.snapshot.known.includes(args.toolName) &&
    args.snapshot.unknownTool === "deny"
  ) {
    // Never seen, never classified: "unknown" is the honest classification.
    return {
      allowed: false,
      reason: "unknownAtLaunch",
      classification: "unknown",
    };
  }
  return { allowed: true };
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

// ── name validation and the block marker ─────────────────────────────────────
//
// Pure policy helpers shared by every enforcement point: the hosted runner's
// in-process gate (`server/services/evals/tool-policy-gate.ts`, which
// re-exports them) and the SDK's local suite-file runner. Side-effect
// manifests and artifact ledgers stay in the server — they bound WHAT a call
// may write, which only a benchmark with a pinned manifest has.

/**
 * The key a policy-blocked tool result carries, set to `true`.
 *
 * A blocked call never reached an MCP server, so it is not a tool span, not a
 * tool error and not a call the case can be graded on. Trace wrappers and
 * tool-call projections recognize the marker (see
 * {@link isToolPolicyBlockResult}) and leave the call out.
 */
export const TOOL_POLICY_BLOCK_MARKER = "mcpjamPolicyBlock";

/** True for a tool result a policy gate produced instead of executing. */
export function isToolPolicyBlockResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[TOOL_POLICY_BLOCK_MARKER] === true
  );
}

/**
 * A `deny` name that matches no tool the run can see.
 *
 * INVALID INPUT, not a warning: a deny list that names nothing enforces
 * nothing, and an author who typed `delete_notes` for `delete_note` believes a
 * destructive tool is fenced off while it runs freely.
 */
export class UnmatchedToolPolicyNameError extends Error {
  readonly code = "TOOL_POLICY_INVALID";
  /** The unmatched deny names, in authored order. */
  readonly names: readonly string[];

  constructor(names: string[]) {
    super(
      `TOOL_POLICY_INVALID: Tool policy deny name(s) did not match any available tool: ${names.join(
        ", "
      )}`
    );
    this.name = "UnmatchedToolPolicyNameError";
    this.names = [...names];
  }
}

/**
 * Check a policy's names against the tool surface it will be enforced on.
 *
 * An unmatched `deny` throws {@link UnmatchedToolPolicyNameError}, unless the
 * name is in `deferredToolNames` — a tool that exists but cannot be listed
 * until run start — which is a warning instead. An unmatched `allow` is always
 * a warning: allowing a tool that is not there changes nothing. Returns the
 * warnings.
 */
export function validateToolPolicyNames(args: {
  policy: EvalSuiteFileToolPolicy;
  availableToolNames: Iterable<string>;
  deferredToolNames?: Iterable<string>;
}): string[] {
  const availableNames = new Set(args.availableToolNames);
  const deferredNames = new Set(args.deferredToolNames ?? []);
  const unmatchedDeny = (args.policy.deny ?? []).filter(
    (name) => !availableNames.has(name)
  );
  const invalidDeny = unmatchedDeny.filter((name) => !deferredNames.has(name));
  if (invalidDeny.length > 0) {
    throw new UnmatchedToolPolicyNameError(invalidDeny);
  }
  const warnings =
    unmatchedDeny.length > invalidDeny.length
      ? [
          `Tool policy deny name(s) could not be resolved at run start: ${unmatchedDeny
            .filter((name) => deferredNames.has(name))
            .join(", ")}`,
        ]
      : [];
  const unmatchedAllow = (args.policy.allow ?? []).filter(
    (name) => !availableNames.has(name)
  );
  if (unmatchedAllow.length > 0) {
    warnings.push(
      `Tool policy allow name(s) did not match any available tool: ${unmatchedAllow.join(
        ", "
      )}`
    );
  }
  return warnings;
}
