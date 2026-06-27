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
import { asSchema } from "ai";
import { fetchHarnessModelCredential } from "./harness-model-credential.js";

export type HarnessId = "claude-code";

/** Gateway-shaped credential the inspector maps to the adapter's `auth.gateway`. */
export type HarnessGatewayAuth = {
  gateway: { apiKey: string; baseUrl?: string };
};

/**
 * A harness's native built-in tool, normalized for DISPLAY (the Playground
 * lists these so a harness host doesn't look tool-less). These run INSIDE the
 * sandbox via the harness's own agent loop — they are NOT callable through
 * MCPJam, so consumers must render them read-only (no "Run").
 */
export type HarnessBuiltinToolInfo = {
  /** The key in the adapter's `builtinTools` record. */
  key: string;
  /** Display label — the runtime's native name (`nativeName`) or the key. */
  name: string;
  /** Cross-harness common alias, when the key maps to one. For badges/filtering. */
  commonName?: string;
  /** `readonly` | `edit` | `bash` — package-provided. For badges/filtering. */
  toolUseKind?: string;
  description?: string;
  /** JSON Schema for the tool's input. Omitted when absent/unconvertible. */
  inputSchema?: Record<string, unknown>;
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
  /** The harness's native built-in tools as a normalized, display-only catalog.
   *  No auth/sandbox needed — read straight from the constructed adapter's
   *  static `builtinTools` ToolSet. */
  listBuiltinTools(): HarnessBuiltinToolInfo[];
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

/** Normalize Claude Code's static `builtinTools` ToolSet for display. Memoized:
 *  the set is constant per process, and constructing the adapter (no auth, no
 *  sandbox) just to read it once is enough. */
let claudeCodeBuiltinToolsCache: HarnessBuiltinToolInfo[] | undefined;

/** Convert a built-in tool's input schema to JSON Schema, or omit on failure.
 *  The adapter's schemas are **Zod v3** (from its bundled `zod`), which the
 *  inspector's own `zod@4` `z.toJSONSchema` can't read — so use `ai`'s
 *  `asSchema`, which handles both Zod versions and yields a JSON Schema. */
function builtinInputJsonSchema(
  schema: unknown,
): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  try {
    const js = asSchema(schema as Parameters<typeof asSchema>[0]).jsonSchema;
    return js && typeof js === "object"
      ? (js as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function listClaudeCodeBuiltinTools(): HarnessBuiltinToolInfo[] {
  if (claudeCodeBuiltinToolsCache) return claudeCodeBuiltinToolsCache;
  // `createClaudeCode()` builds the adapter (and its static `builtinTools`)
  // synchronously with no credential — auth is only needed at session time.
  const builtinTools = createClaudeCode().builtinTools as Record<
    string,
    {
      description?: unknown;
      inputSchema?: unknown;
      nativeName?: unknown;
      commonName?: unknown;
      toolUseKind?: unknown;
    }
  >;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const list = Object.entries(builtinTools).map(([key, tool]) => {
    const inputSchema = builtinInputJsonSchema(tool?.inputSchema);
    return {
      key,
      name: str(tool?.nativeName) ?? key,
      ...(str(tool?.commonName) ? { commonName: str(tool.commonName) } : {}),
      ...(str(tool?.toolUseKind) ? { toolUseKind: str(tool.toolUseKind) } : {}),
      ...(str(tool?.description) ? { description: str(tool.description) } : {}),
      ...(inputSchema ? { inputSchema } : {}),
    } as HarnessBuiltinToolInfo;
  });
  list.sort((a, b) => a.name.localeCompare(b.name));
  claudeCodeBuiltinToolsCache = list;
  return list;
}

const claudeCodeAdapter: HarnessRuntimeAdapter = {
  id: "claude-code",
  listBuiltinTools: listClaudeCodeBuiltinTools,
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
