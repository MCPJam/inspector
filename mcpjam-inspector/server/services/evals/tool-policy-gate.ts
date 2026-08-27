import type { ToolSet } from "ai";
import {
  buildToolPolicySnapshot,
  decideToolPolicy,
  type EvalSuiteFileToolPolicy,
  type ToolPolicyDecision,
  type ToolPolicySnapshot,
  type ToolSafetyClassification,
} from "@mcpjam/sdk/contract";
import type { BenchmarkArtifactLedger } from "./artifact-ledger.js";
import {
  BENCHMARK_ARTIFACT_PREFIX,
  composeArtifactPrefix,
  createRuleForTool,
  readManifestIds,
  readManifestPath,
  type ResolvedCaseSideEffects,
} from "./side-effect-manifest.js";

export const TOOL_POLICY_BLOCK_MARKER = "mcpjamPolicyBlock";

/**
 * Why a call was blocked by the pinned side-effect manifest.
 *
 * A SEPARATE vocabulary from `ToolPolicyDecisionReason`, and deliberately not
 * folded into it: the SDK's reasons are the ones a `ToolPolicySnapshot` carries
 * to the out-of-process harness proxy, and that path decides by tool NAME
 * alone. Manifest enforcement reads ARGUMENTS, which the snapshot does not
 * carry and must not start carrying — so a manifest reason could never be
 * produced there, and putting it in that union would advertise an enforcement
 * point that does not exist.
 */
export const SIDE_EFFECT_BLOCK_REASONS = [
  /** The case declares writes and no verified manifest reached the gate. */
  "sideEffectManifestMissing",
  /** The manifest does not list this tool at all. */
  "sideEffectToolNotAllowed",
  /** The artifact's name is missing, unreadable, or not run-scoped. */
  "sideEffectArtifactPrefix",
  /** The call names a thing this run did not create. */
  "sideEffectMutationTargetUnknown",
] as const;

export type SideEffectBlockReason = (typeof SIDE_EFFECT_BLOCK_REASONS)[number];

export function isSideEffectBlockReason(
  value: unknown,
): value is SideEffectBlockReason {
  return (
    typeof value === "string" &&
    (SIDE_EFFECT_BLOCK_REASONS as readonly string[]).includes(value)
  );
}

export type ToolPolicyBlock = {
  toolName: string;
  reason: ToolPolicyDecision["reason"] | SideEffectBlockReason;
  classification: ToolSafetyClassification;
  at: number;
  toolCallId?: string;
  /** What the manifest objected to. Present only on a side-effect block. */
  detail?: string;
};

/**
 * The write manifest in force for ONE iteration of one case.
 *
 * Per-iteration because the artifact prefix is: a list-style case must not be
 * able to observe its own sibling iterations' artifacts and grade a leak that
 * is ours. The ledger is per-RUN, because cleanup is.
 */
export type SideEffectGate = {
  /** Resolved by `suiteHash + caseId`, verified against the pins before launch. */
  sideEffects: ResolvedCaseSideEffects | undefined;
  benchmarkRunId: string;
  iteration: number;
  ledger: BenchmarkArtifactLedger;
  /**
   * The case declares writes, so a missing manifest is fail-closed rather than
   * "no rules apply". A write case whose rules could not be verified must not
   * touch a third party's server at all.
   */
  requireManifest: boolean;
};

export type ToolAnnotationsLookup = Map<
  string,
  Record<string, unknown> | undefined
>;

export type ToolPolicyGate = {
  policy: EvalSuiteFileToolPolicy;
  annotations: ToolAnnotationsLookup;
  blocks: ToolPolicyBlock[];
  warnings: string[];
  recordBlock: (block: Omit<ToolPolicyBlock, "at">) => void;
  blockedToolCallIds: () => ReadonlySet<string>;
  wrap: (tools: ToolSet) => ToolSet;
};

export class UnmatchedToolPolicyNameError extends Error {
  readonly code = "TOOL_POLICY_INVALID";

  constructor(names: string[]) {
    super(
      `TOOL_POLICY_INVALID: Tool policy deny name(s) did not match any available tool: ${names.join(
        ", "
      )}`
    );
    this.name = "UnmatchedToolPolicyNameError";
  }
}

export function toolAnnotationsKey(serverId: string, toolName: string): string {
  return `${serverId}:${toolName}`;
}

/**
 * Resolve the policy for every launch-known tool of every selected server, so
 * the decision can travel to the MCP proxy sealed and be applied there by
 * lookup. Uses the SAME `decideToolPolicy` the in-process gate uses — the proxy
 * never classifies anything, and annotations never leave this process.
 *
 * Requires the annotation lookup D4 already populates before launch
 * (`TOOL_POLICY_ANNOTATIONS_UNAVAILABLE` otherwise), so "known at launch" here
 * is exactly the set the in-process gate would have wrapped.
 */
export function buildHarnessToolPolicySnapshots(args: {
  policy: EvalSuiteFileToolPolicy;
  serverIds: ReadonlyArray<string>;
  annotations: ToolAnnotationsLookup;
}): Record<string, ToolPolicySnapshot> {
  const snapshots: Record<string, ToolPolicySnapshot> = {};
  for (const serverId of args.serverIds) {
    const prefix = toolAnnotationsKey(serverId, "");
    const tools: Array<{
      name: string;
      annotations?: Record<string, unknown>;
    }> = [];
    for (const [key, annotations] of args.annotations) {
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (!name) continue;
      tools.push({ name, ...(annotations ? { annotations } : {}) });
    }
    snapshots[serverId] = buildToolPolicySnapshot({
      policy: args.policy,
      tools,
    });
  }
  return snapshots;
}

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

/** A refusal from the per-call manifest inspector. */
type SideEffectRefusal = { reason: SideEffectBlockReason; detail: string };

/**
 * Inspect ONE call's arguments against the pinned manifest.
 *
 * Pure and exported, because every arm is a decision about whether something
 * gets written to a server somebody else operates. It runs BEFORE the MCP
 * call: a refusal returned here means the call never happened, which is the
 * only version of this that is worth anything — a check after the fact would
 * be a report about damage rather than a bound on it.
 */
export function inspectSideEffects(args: {
  gate: SideEffectGate;
  toolName: string;
  input: unknown;
}): SideEffectRefusal | null {
  const { gate, toolName, input } = args;
  const manifest = gate.sideEffects;

  if (!manifest) {
    // A case in a write exam that arrives with no enforceable manifest is
    // refused outright. "No rules reached us" is not "no rules apply".
    return gate.requireManifest
      ? {
          reason: "sideEffectManifestMissing",
          detail:
            "This exam declares side effects and no verified side-effect manifest reached the gate for this case.",
        }
      : null;
  }

  // A `read_only` manifest IS a manifest — it declares that this case makes no
  // writes, which is a statement rather than an absence. Only the classification
  // gate applies to it.
  if (manifest.mode !== "test_write") return null;

  if (!manifest.allowedTools.includes(toolName)) {
    // Reads are on the list too — see `allowedTools`. A manifest that silently
    // permitted whatever it forgot to mention would not be a bound.
    return {
      reason: "sideEffectToolNotAllowed",
      detail: `The pinned side-effect manifest does not list "${toolName}".`,
    };
  }

  const createRule = createRuleForTool(manifest, toolName);
  if (createRule) {
    const prefix = composeArtifactPrefix({
      requiredPrefix: createRule.requiredPrefix,
      benchmarkRunId: gate.benchmarkRunId,
      iteration: gate.iteration,
    });
    // The convention is what makes an artifact identifiable as OURS to an
    // operator looking at their own server. A manifest that pins some other
    // base has not described a benchmark artifact, whatever else it got right.
    if (!prefix.startsWith(BENCHMARK_ARTIFACT_PREFIX)) {
      return {
        reason: "sideEffectArtifactPrefix",
        detail: `"${toolName}" pins the prefix "${createRule.requiredPrefix}", which does not begin with "${BENCHMARK_ARTIFACT_PREFIX}".`,
      };
    }
    const named = readManifestPath(input, createRule.artifactNamePath);
    const name = named.length === 1 ? named[0] : undefined;
    if (typeof name !== "string" || !name.startsWith(prefix)) {
      // An artifact whose name is not run-scoped cannot be told apart from the
      // operator's own data afterwards, so it cannot be cleaned up either.
      return {
        reason: "sideEffectArtifactPrefix",
        detail: `"${toolName}" must name its artifact at ${createRule.artifactNamePath} with the prefix "${prefix}".`,
      };
    }
  }

  for (const path of manifest.mutationTargetPaths) {
    for (const id of readManifestIds(input, path)) {
      if (!gate.ledger.has(id)) {
        return {
          reason: "sideEffectMutationTargetUnknown",
          detail: `"${toolName}" targets ${id} at ${path}, which this run did not create.`,
        };
      }
    }
  }

  return null;
}

/**
 * Harvest the ids a create call produced into the run's artifact ledger.
 *
 * Exported for the same reason as the inspector: the ledger is what makes a
 * later mutation legal and a later cleanup possible, so a create whose id was
 * not harvested is an artifact this run can never remove.
 */
export function harvestCreatedArtifacts(args: {
  gate: SideEffectGate;
  toolName: string;
  input: unknown;
  result: unknown;
}): void {
  const manifest = args.gate.sideEffects;
  if (manifest?.mode !== "test_write") return;
  const createRule = createRuleForTool(manifest, args.toolName);
  if (!createRule) return;

  const named = readManifestPath(args.input, createRule.artifactNamePath);
  const artifactName = typeof named[0] === "string" ? named[0] : "";

  for (const path of createRule.createdIdResultPaths) {
    for (const createdId of readManifestIds(args.result, path)) {
      args.gate.ledger.record({
        tool: args.toolName,
        artifactName,
        createdId,
        cleanupSteps: manifest.cleanupSteps,
      });
    }
  }
}

/**
 * Build the execution-layer policy gate for one iteration.
 *
 * Mode-derived rules apply only to MCP server tools (`_serverId`). MCPJam
 * internal tools (skills, progressive-discovery meta-tools, computer/widget
 * tools, and sandbox `bash`) are not classified by server annotations and are
 * not subject to mode-derived denial. An explicit deny still blocks any tool
 * by name because an operator naming a tool means it.
 *
 * Each driver applies this gate exactly once to its final merged tool map,
 * before applying the eval trace wrapper. A blocked result carries a
 * machine-readable marker, and trace wrappers must recognize that marker and
 * emit no tool span: a policy block is not an MCP call or tool error.
 *
 * `sideEffectGate` is the benchmark's write-manifest enforcement. With it,
 * ALLOWED tools are wrapped too — the classification decides whether a tool may
 * be called, and only the manifest can decide what it may be called WITH.
 * "May call `create_page`" bounds nothing on its own: the same permission
 * covers creating a page named for this run and overwriting the operator's
 * homepage.
 */
export function createToolPolicyGate(args: {
  policy: EvalSuiteFileToolPolicy;
  annotations: ToolAnnotationsLookup;
  warnings?: ReadonlyArray<string>;
  sideEffectGate?: SideEffectGate;
}): ToolPolicyGate {
  const blocks: ToolPolicyBlock[] = [];
  const blockedCallIds = new Set<string>();
  const warnings: string[] = [...(args.warnings ?? [])];
  const recordBlock = (block: Omit<ToolPolicyBlock, "at">): void => {
    blocks.push({ ...block, at: Date.now() });
    if (block.toolCallId) {
      blockedCallIds.add(block.toolCallId);
    }
  };
  return {
    policy: args.policy,
    annotations: args.annotations,
    blocks,
    warnings,
    recordBlock,
    blockedToolCallIds: () => new Set(blockedCallIds),
    wrap(tools) {
      const wrapped: ToolSet = { ...tools };
      const sideEffectGate = args.sideEffectGate;
      for (const [toolName, tool] of Object.entries(tools)) {
        const serverId =
          typeof (tool as { _serverId?: unknown })._serverId === "string"
            ? (tool as unknown as { _serverId: string })._serverId
            : undefined;
        const isExplicitlyDenied =
          args.policy.deny?.includes(toolName) === true;
        if (!serverId && !isExplicitlyDenied) continue;
        const decision = decideToolPolicy({
          toolName,
          annotations: serverId
            ? args.annotations.get(toolAnnotationsKey(serverId, toolName))
            : undefined,
          policy: args.policy,
        });

        /** One marked, span-free refusal, however the call came to be refused. */
        const refuse = (
          reason: ToolPolicyBlock["reason"],
          classification: ToolSafetyClassification,
          toolCallId: string | undefined,
          detail?: string,
        ) => {
          recordBlock({
            toolName,
            reason,
            classification,
            ...(toolCallId ? { toolCallId } : {}),
            ...(detail ? { detail } : {}),
          });
          return {
            content: [
              {
                type: "text",
                text: detail
                  ? `Call blocked by tool policy: ${reason} — ${detail}`
                  : `Call blocked by tool policy: ${reason}`,
              },
            ],
            [TOOL_POLICY_BLOCK_MARKER]: true,
          };
        };

        if (!decision.allowed) {
          wrapped[toolName] = {
            ...tool,
            execute: async (
              _input: unknown,
              options?: { toolCallId?: string },
            ) =>
              refuse(
                decision.reason,
                decision.classification,
                options?.toolCallId,
              ),
          };
          continue;
        }

        // ALLOWED, and still wrapped when a manifest is in force. Only MCP
        // server tools reach a third party; an internal tool has no side
        // effects on the target to bound.
        //
        // A tool with no local `execute` is CLIENT-FULFILLED — the AI SDK hands
        // the call back to the caller to answer — so it never reaches the
        // target through us, and injecting an `execute` here would turn it into
        // a silent no-op. (The deny path above deliberately does inject one:
        // a denied client tool still has to be refused.)
        const inner = (tool as { execute?: unknown }).execute;
        if (!sideEffectGate || !serverId || typeof inner !== "function") {
          continue;
        }
        wrapped[toolName] = {
          ...tool,
          execute: async (
            input: unknown,
            options?: { toolCallId?: string },
          ) => {
            const refusal = inspectSideEffects({
              gate: sideEffectGate,
              toolName,
              input,
            });
            if (refusal) {
              return refuse(
                refusal.reason,
                decision.classification,
                options?.toolCallId,
                refusal.detail,
              );
            }
            const result = await (
              inner as (
                input: unknown,
                options?: { toolCallId?: string },
              ) => Promise<unknown>
            )(input, options);
            // Harvest AFTER the call: the id only exists once the server has
            // answered, and an unharvested id is an artifact this run can
            // never clean up.
            harvestCreatedArtifacts({
              gate: sideEffectGate,
              toolName,
              input,
              result,
            });
            return result;
          },
        };
      }
      return wrapped;
    },
  };
}

export function isToolPolicyBlockResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[TOOL_POLICY_BLOCK_MARKER] === true
  );
}
