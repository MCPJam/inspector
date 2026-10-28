import { extractHostExecutionPolicy } from "@mcpjam/sdk/host-config/internal";
import { createHash } from "node:crypto";
import { asSchema, type ToolSet } from "ai";
import { HOSTED_MODE } from "../../config.js";
import type { ResolvedEnvironmentRuntime } from "../environments/runtime.js";
import type { EffectiveCapabilitySet } from "../environments/effective-capabilities.js";

export type SetupIncompleteReason =
  | "runtime_provenance_unavailable"
  | "skill_provenance_unavailable"
  | "server_provenance_unavailable"
  | "tool_provenance_unavailable"
  | "credential_provenance_unavailable"
  | "setup_changed_during_turn";

/** Object keys are unordered; arrays retain tool/skill/plugin precedence. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return entry;
    return Object.fromEntries(
      Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Called after preparation. Missing evidence is explicit, never an empty catalog. */
export async function buildSetupManifest(args: {
  environment?: ResolvedEnvironmentRuntime;
  capabilities?: EffectiveCapabilitySet;
  model: { id: string; provider?: string };
  routingRef?: string;
  engine: string;
  venue: string;
  systemPrompt: string;
  temperature?: number;
  reasoningEffort?: string;
  requireToolApproval: boolean;
  serverIds: string[];
  tools: ToolSet;
  builtInIds: string[];
  connectionIds?: string[];
  maxSteps?: number;
  maxToolCalls?: number;
  toolMode?: string;
  allowedServerIds?: string[];
  allowedTools?: string[];
  policy?: Record<string, unknown>;
  executionPolicy?: Record<string, unknown>;
  incomplete?: SetupIncompleteReason[];
}) {
  const reasons = new Set<SetupIncompleteReason>(args.incomplete);
  const env = args.environment;
  if (!args.routingRef) reasons.add("credential_provenance_unavailable");
  const configHash = env?.host.runtimeConfig.configHash;
  if (
    typeof configHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(configHash) ||
    args.engine !== "emulated"
  )
    reasons.add("runtime_provenance_unavailable");
  const skills = args.capabilities && [
    ...args.capabilities.standaloneSkills,
    ...args.capabilities.pluginSkills,
    ...args.capabilities.serverSkills,
    ...args.capabilities.localSkills,
  ];
  if (
    !skills ||
    skills.some((s) => typeof s.content !== "string" || !s.aggregateHash)
  )
    reasons.add("skill_provenance_unavailable");
  if (args.serverIds.some((id) => !env?.serverConfigHashes?.[id]))
    reasons.add("server_provenance_unavailable");
  if (!env?.selectedSecretIds) reasons.add("credential_provenance_unavailable");
  if (env?.pluginVersions?.some((p) => !p.bundleHash))
    reasons.add("runtime_provenance_unavailable");
  let toolEvidence: unknown;
  try {
    toolEvidence = await Promise.all(
      Object.entries(args.tools).map(async ([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: await asSchema(tool.inputSchema).jsonSchema,
        ...(tool.outputSchema
          ? { outputSchema: await asSchema(tool.outputSchema).jsonSchema }
          : {}),
      })),
    );
  } catch {
    // A schema conversion failure invalidates provenance, not the prepared execution.
    reasons.add("tool_provenance_unavailable");
  }
  if (reasons.size)
    return {
      version: 1 as const,
      status: "incomplete" as const,
      reasons: [...reasons],
    };
  const policy = extractHostExecutionPolicy(args.policy ?? null);
  return {
    version: 1 as const,
    status: "complete" as const,
    setup: {
      runtime: { engine: args.engine, venue: args.venue, configHash },
      model: {
        id: args.model.id,
        provider: args.model.provider ?? "unknown",
        ...(args.routingRef ? { routingRef: args.routingRef } : {}),
      },
      settings: {
        systemPromptHash: digest(args.systemPrompt),
        policyHash: digest({
          progressiveDiscoveryEnabled: policy.progressiveDiscoveryEnabled,
          modelVisibleMcpToolResults: policy.modelVisibleMcpToolResults,
          mcpToolResultImageRendering: policy.mcpToolResultImageRendering,
          executionPolicy: args.executionPolicy ?? {},
          respectToolVisibility: policy.respectToolVisibility !== false,
        }),
        requireToolApproval: args.requireToolApproval,
        ...(args.temperature !== undefined
          ? { temperature: args.temperature }
          : {}),
        ...(args.reasoningEffort !== undefined
          ? { reasoningEffort: args.reasoningEffort }
          : {}),
        ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
        ...(args.maxToolCalls !== undefined
          ? { maxToolCalls: args.maxToolCalls }
          : {}),
        ...(args.toolMode !== undefined ? { toolMode: args.toolMode } : {}),
      },
      servers: args.serverIds.map((id) => ({
        id,
        configHash: env?.serverConfigHashes?.[id],
      })),
      tools: {
        schemaHash: digest(toolEvidence),
        builtInIds: args.builtInIds,
        ...(args.allowedServerIds !== undefined
          ? { allowedServerIds: args.allowedServerIds }
          : {}),
        ...(args.allowedTools !== undefined
          ? { allowedTools: args.allowedTools }
          : {}),
      },
      plugins: (env?.pluginVersions ?? []).map((p) => ({
        versionId: p.pluginVersionId,
        bundleHash: p.bundleHash,
      })),
      skills: (skills ?? []).map((s) => ({
        ref: s.ref,
        hash: s.aggregateHash,
      })),
      credentials: {
        secretIds: env?.selectedSecretIds ?? [],
        connectionIds: args.connectionIds ?? [],
      },
    },
  };
}

export type SetupAtTurn = Awaited<ReturnType<typeof buildSetupManifest>>;

/** Capture the web runner after preparation and runtime limits are resolved. */
export function capturePreparedWebSetup(args: {
  prepare: import("../../utils/web-chat-turn.js").WebChatTurnPrepareInputs;
  persist: import("../../utils/web-chat-turn.js").WebChatTurnPersistContext;
  prepared: Pick<
    import("../../utils/chat-v2-orchestration.js").PrepareChatV2Result,
    "resolvedTemperature"
  > &
    Partial<
      Pick<
        import("../../utils/chat-v2-orchestration.js").PrepareChatV2Result,
        "connectionsAtTurn" | "progressivePlan" | "liveServerSkills"
      >
    >;
  tools: ToolSet;
  maxSteps: number;
  serverIds: string[];
  systemPrompt: string;
  secretsUnavailable: boolean;
  modelVenue?: "local" | "remote";
}) {
  const {
    prepare,
    persist,
    prepared,
    tools,
    maxSteps,
    serverIds,
    systemPrompt,
    secretsUnavailable,
  } = args;
  return buildSetupManifest({
    environment: persist.setupEnvironment,
    capabilities: prepare.effectiveCapabilities,
    model: {
      id: String(prepare.modelDefinition.id),
      provider: prepare.modelDefinition.provider,
    },
    routingRef: prepare.routingSelection
      ? JSON.stringify(prepare.routingSelection)
      : prepare.modelDefinition.hosted === true
        ? "mcpjam-hosted"
        : undefined,
    engine: persist.harness ?? "emulated",
    // Venue describes the engine, not the provider. A local tool loop can
    // still call a remote model, and a local app can run a cloud harness.
    venue: persist.harness
      ? persist.harnessExecutionTarget
        ? "local"
        : "computer"
      : HOSTED_MODE
        ? "hosted"
        : "local",
    executionPolicy: { modelVenue: args.modelVenue ?? "remote" },
    systemPrompt,
    temperature: prepared.resolvedTemperature,
    reasoningEffort: prepare.reasoningEffort,
    requireToolApproval: prepare.requireToolApproval ?? false,
    serverIds,
    tools,
    maxSteps,
    toolMode: "auto",
    builtInIds: Object.keys(prepare.builtInTools ?? {}),
    connectionIds: prepared.connectionsAtTurn?.map((c) => c.connectionId),
    policy: {
      respectToolVisibility: prepare.respectToolVisibility,
      progressiveToolDiscovery: prepared.progressivePlan?.enabled,
      modelVisibleMcpToolResults: prepare.modelVisibleMcpToolResults,
      mcpToolResultImageRendering: persist.mcpToolResultImageRendering,
    },
    incomplete: [
      ...(persist.setupConnectionPolicyIncomplete
        ? ["runtime_provenance_unavailable" as const]
        : []),
      ...(prepared.liveServerSkills || persist.setupSkillProvenanceIncomplete
        ? ["skill_provenance_unavailable" as const]
        : []),
      ...(prepare.refreshTools ? ["setup_changed_during_turn" as const] : []),
      ...(secretsUnavailable
        ? ["credential_provenance_unavailable" as const]
        : []),
    ],
  });
}
