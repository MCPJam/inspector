/**
 * Harness runtime registry — the ONLY place that knows a harness adapter is
 * "Claude Code" specifically. `runHarnessTurn` and the session-state machinery
 * stay harness-agnostic and look the adapter up by id.
 *
 * V1 ships a single adapter (`claude-code`). Adding a future harness (Codex,
 * etc.) should be a new entry here + hostConfig validation/UI + tests — NOT a
 * copy of the claim/lease/commit/stream machinery. We intentionally do NOT add
 * speculative adapters, a capability matrix, or new Convex harness ids until a
 * second adapter is actually installed and tested.
 */
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { fetchHarnessModelCredential } from "./harness-model-credential.js";

export type HarnessId = "claude-code";

/** Gateway-shaped credential the inspector maps to the adapter's `auth.gateway`. */
export type HarnessGatewayAuth = {
  gateway: { apiKey: string; baseUrl?: string };
};

export type HarnessRuntimeAdapter = {
  id: HarnessId;
  /** Fetch the model credential for this harness from Convex (member-gated). */
  resolveAuth(args: {
    projectId: string;
    modelId: string;
    bearer: string;
    signal?: AbortSignal;
  }): Promise<HarnessGatewayAuth>;
  /** Construct the harness adapter (already cast to the server's HarnessAgent
   *  boundary type) for the given host model + resolved auth. */
  createHarness(args: {
    modelId: string;
    auth: HarnessGatewayAuth;
  }): HarnessAgentAdapter;
  /** Map a host model id to the harness's native model id/alias, if it needs
   *  one. Undefined ⇒ let the harness use its default. */
  toNativeModel?(modelId: string): string | undefined;
};

/** Map a host model id (gateway `creator/model`, e.g. `anthropic/claude-haiku-4.5`)
 *  to a Claude Code CLI-native alias. The CLI accepts `sonnet|opus|haiku` and
 *  resolves them to its current model; it does NOT understand the gateway
 *  `creator/model` form (passing it makes the CLI do zero inference). Unknown ⇒
 *  undefined (let the CLI use its default). */
function toClaudeCodeModel(
  modelId: string,
): "haiku" | "sonnet" | "opus" | undefined {
  const m = modelId.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  return undefined;
}

const claudeCodeAdapter: HarnessRuntimeAdapter = {
  id: "claude-code",
  async resolveAuth(args) {
    const result = await fetchHarnessModelCredential({
      projectId: args.projectId,
      modelId: args.modelId,
      bearer: args.bearer,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    return {
      gateway: {
        apiKey: result.credential.apiKey,
        ...(result.credential.baseUrl
          ? { baseUrl: result.credential.baseUrl }
          : {}),
      },
    };
  },
  toNativeModel: toClaudeCodeModel,
  createHarness({ modelId, auth }) {
    const nativeModel = toClaudeCodeModel(modelId);
    // Dual-`ai` boundary cast: createClaudeCode returns a HarnessV1 from its own
    // (nested) @ai-sdk/harness copy, nominally distinct from this server's copy
    // that HarnessAgent uses. Structurally identical; the drive reads loosely.
    return createClaudeCode({
      ...(nativeModel ? { model: nativeModel } : {}),
      auth,
    }) as unknown as HarnessAgentAdapter;
  },
};

const HARNESS_ADAPTERS: Record<HarnessId, HarnessRuntimeAdapter> = {
  "claude-code": claudeCodeAdapter,
};

export function getHarnessAdapter(id: string): HarnessRuntimeAdapter {
  const adapter = (HARNESS_ADAPTERS as Record<string, HarnessRuntimeAdapter>)[
    id
  ];
  if (!adapter) {
    throw new Error(`Unsupported harness: ${id}`);
  }
  return adapter;
}
