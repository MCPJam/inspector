/**
 * Harness runtime registry — the ONLY place that knows an adapter is "Claude
 * Code" or "Codex" specifically. `runHarnessTurn` and the session-state
 * machinery stay harness-agnostic and look the adapter up by id, then read its
 * declared CAPABILITIES (MCP delivery, tool-name attribution, file-change
 * naming, approval, skills) rather than hardcoding per-harness behavior.
 *
 * Adding a future harness (pi, …) is a new entry here + the SDK `HARNESS_IDS`
 * widening + hostConfig/UI + tests — NOT a copy of the claim/lease/commit/stream
 * machinery. `HARNESS_ADAPTERS` is typed `Record<HarnessId, …>` where
 * `HarnessId` is the SDK's `Harness` union, so a persistence-layer id without an
 * adapter is a COMPILE error.
 */
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodex } from "@ai-sdk/harness-codex";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type { HarnessV1PermissionMode } from "@ai-sdk/harness";
import { asSchema } from "ai";
import { type Harness } from "@mcpjam/sdk/host-config/internal";
import { fetchHarnessModelCredential } from "./harness-model-credential.js";
import {
  parseHarnessToolName,
  serializeHarnessMcpJson,
  type HarnessMcpJson,
} from "./mcp-config.js";

/** A harness id this inspector has a runtime adapter for. Derived from the SDK's
 *  portable `Harness` union (the persistence-contract source of truth), so the
 *  registry can't accept an id the storage layer would reject. `HARNESS_ADAPTERS`
 *  is typed `Record<HarnessId, …>`, so a new SDK id without an adapter here is a
 *  COMPILE error — parity is enforced by the type, and a test asserts the keys
 *  match `HARNESS_IDS` at runtime too. */
export type HarnessId = Harness;

/** Auth the inspector hands an adapter. CLIENT path uses `gateway` (real key
 *  from Convex). BROKER path uses dummy `anthropic`/`openaiCompatible` creds
 *  pointed at the model proxy — the REAL lease is injected by E2B OUTSIDE the VM,
 *  so these placeholders only satisfy the CLI's auth env. All-optional so a single
 *  value type is accepted by both `createClaudeCode` and `createCodex`. */
export type HarnessAuth = {
  gateway?: { apiKey: string; baseUrl?: string };
  anthropic?: { apiKey: string; authToken: string; baseUrl: string };
  openaiCompatible?: { apiKey: string; baseUrl: string };
};
/** @deprecated use HarnessAuth — kept for existing references. */
export type HarnessGatewayAuth = HarnessAuth;

/** Placeholder credential value handed to the in-sandbox CLI on the broker path.
 *  It is never used for auth (the proxy ignores VM-supplied Authorization/
 *  x-api-key and trusts only E2B's injected `x-mcpjam-harness-lease`); it just
 *  has to be present so the CLI makes the request. */
const BROKER_DUMMY_CREDENTIAL = "mcpjam-broker-dummy";

/** Build the dummy broker auth pointed at the proxy base URL. Claude Code reads
 *  `ANTHROPIC_AUTH_TOKEN` (Bearer) + `ANTHROPIC_BASE_URL`; Codex reads
 *  `CODEX_API_KEY` + `OPENAI_BASE_URL`. */
export function buildBrokerDummyAuth(
  harnessId: HarnessId,
  proxyBaseUrl: string
): HarnessAuth {
  if (harnessId === "codex") {
    return {
      openaiCompatible: {
        apiKey: BROKER_DUMMY_CREDENTIAL,
        baseUrl: proxyBaseUrl,
      },
    };
  }
  return {
    anthropic: {
      apiKey: "",
      authToken: BROKER_DUMMY_CREDENTIAL,
      baseUrl: proxyBaseUrl,
    },
  };
}

/** `{ serverId?, toolName }` — the MCPJam tool identity a harness tool name maps
 *  to. MCP server tools carry a `serverId`; native harness tools (Bash, Read,
 *  file-change, …) don't (serverId undefined). */
export type HarnessToolAttribution = { serverId?: string; toolName: string };

/** Args for an adapter's MCP-server delivery into a fresh sandbox session. The
 *  caller binds `writeTextFile` to the live session (which lives behind the
 *  dual-`ai` boundary), so the registry needn't import the harness session
 *  type. */
export type HarnessMcpDeliveryArgs = {
  /** Write a UTF-8 text file into the fresh sandbox session. */
  writeTextFile(args: { path: string; content: string }): Promise<void>;
  sessionWorkDir: string;
  mcpJson: HarnessMcpJson;
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
  /** Human-facing runtime name for preflight/availability messages + UI. */
  displayName: string;
  /** Whether this harness must run inside an attached personal computer. Drives
   *  the availability preflight (data-plane requirement). */
  requiresComputer: boolean;
  /** Permission mode handed to `HarnessAgent` — the runtime's only honored mode
   *  today is "allow-all"; modeled per-adapter so it isn't a hardcoded constant. */
  defaultPermissionMode: HarnessV1PermissionMode;
  /** Can the runtime PAUSE for interactive approval of its NATIVE built-in tools
   *  (Bash/Read/…)? Both current adapters: false (the CLI runs them itself). */
  supportsNativeToolApproval: boolean;
  /** Can the runtime pause for approval of MCP-server tools it calls in-sandbox?
   *  Both current adapters: false. */
  supportsMcpToolApproval: boolean;
  /** Can host-executed AI SDK tools (run on MCPJam's server) be approval-gated?
   *  Modeled separately; false for v1 (not wired/tested in MCPJam yet). */
  supportsHostExecutedToolApproval: boolean;
  /** Does the adapter deliver the host's selected MCP servers into the sandbox?
   *  Claude Code: yes (`.mcp.json`). Codex v1: no (bridge MCP limits) — a Codex
   *  host with selected servers fails the preflight. */
  supportsSelectedMcpServers: boolean;
  /** Does the adapter deliver runtime (Cloud) skills into the sandbox? Claude
   *  Code: yes. Codex v1: no. */
  supportsSkills: boolean;
  /** Native-tool name used to surface this runtime's `file-change` stream parts
   *  as a synthetic tool call. Undefined ⇒ the runtime doesn't emit file-change. */
  fileChangeToolName?: string;
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
  /** Can this runtime actually run the given host model? Claude Code runs any
   *  Anthropic model the CLI accepts (true); Codex only the gpt-5 family it maps.
   *  The preflight rejects unsupported models rather than letting the runtime
   *  silently fall back to its own default. */
  supportsModel(modelId: string): boolean;
  /** Map a runtime tool name back to MCPJam tool identity. Claude Code namespaces
   *  MCP tools `mcp__<server>__<tool>`; other harnesses differ, so this is
   *  per-adapter rather than pinned to Claude's scheme. */
  parseToolName(
    rawToolName: string,
    keyToServerId: Record<string, string>
  ): HarnessToolAttribution;
  /** Write the host's MCP servers into a fresh sandbox session. Present only when
   *  `supportsSelectedMcpServers`. */
  deliverMcpServers?(args: HarnessMcpDeliveryArgs): Promise<void>;
};

const CLAUDE_CODE_BRIDGE_USER_MESSAGE_NEEDLE = 'type: "user",\n    message: {';
const CLAUDE_CODE_BRIDGE_USER_MESSAGE_PATCH =
  'type: "user",\n    parent_tool_use_id: null,\n    message: {';
const CLAUDE_CODE_BRIDGE_TEXT_STATE_NEEDLE =
  "let streamStarted = false;\n  const partialBlocks";
const CLAUDE_CODE_BRIDGE_TEXT_STATE_PATCH = `let streamStarted = false;
  let streamedAssistantText = false;
  let lastEmittedFallbackText;
  const emitAssistantTextFallback = (text) => {
    const normalized = typeof text === "string" ? text : "";
    if (!normalized || streamedAssistantText || normalized === lastEmittedFallbackText) return;
    const id = randomUUID();
    emit({ type: "text-start", id });
    emit({ type: "text-delta", id, delta: normalized });
    emit({ type: "text-end", id });
    lastEmittedFallbackText = normalized;
  };
  const partialBlocks`;
const CLAUDE_CODE_BRIDGE_STREAM_EVENT_NEEDLE = `if (type === "stream_event") {
        handleStreamEvent(msg.event, partialBlocks, emit);
        continue;
      }`;
const CLAUDE_CODE_BRIDGE_STREAM_EVENT_PATCH = `if (type === "stream_event") {
        if (msg.event?.type === "content_block_delta" && msg.event?.delta?.type === "text_delta" && typeof msg.event?.delta?.text === "string" && msg.event.delta.text.length > 0) {
          streamedAssistantText = true;
        }
        handleStreamEvent(msg.event, partialBlocks, emit);
        continue;
      }`;
const CLAUDE_CODE_BRIDGE_ASSISTANT_TEXT_NEEDLE = `for (const block of msg.message.content) {
          if (block.type === "tool_use"`;
const CLAUDE_CODE_BRIDGE_ASSISTANT_TEXT_PATCH = `for (const block of msg.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            emitAssistantTextFallback(block.text);
            continue;
          }
          if (block.type === "tool_use"`;
const CLAUDE_CODE_BRIDGE_RESULT_TEXT_NEEDLE = `const emptyResult = !msg.result?.trim?.();
          if (emptyResult && observedTerminalError) {`;
const CLAUDE_CODE_BRIDGE_RESULT_TEXT_PATCH = `const emptyResult = !msg.result?.trim?.();
          if (!emptyResult) {
            emitAssistantTextFallback(msg.result);
          }
          if (emptyResult && observedTerminalError) {`;
const CLAUDE_CODE_BRIDGE_MODEL_OVERRIDES_NEEDLE = `const permissionOptions = createPermissionOptions({
    start,
    turn,
    emit,
    nativeToolCallNames,
    approvalRequestedToolUseIds
  });`;
const CLAUDE_CODE_BRIDGE_MODEL_OVERRIDES_PATCH = `const permissionOptions = createPermissionOptions({
    start,
    turn,
    emit,
    nativeToolCallNames,
    approvalRequestedToolUseIds
  });
  const gatewayModelOverridesForClaudeModel = (model) => {
    if (typeof model !== "string") return undefined;
    if (model === "haiku") {
      return {
        haiku: "anthropic/claude-haiku-4.5",
        "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
        "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4.5"
      };
    }
    if (!model.startsWith("claude-")) return undefined;
    const match = model.match(/^claude-(haiku|sonnet|opus)-(\\d+)(?:-(\\d+))?$/);
    if (!match) return undefined;
    const [, family, major, minor] = match;
    return {
      [model]: \`anthropic/claude-\${family}-\${major}\${minor ? \`.\${minor}\` : ""}\`
    };
  };
  const gatewayModelOverrides = gatewayModelOverridesForClaudeModel(start.model);
  const gatewayModelOverrideSettings = gatewayModelOverrides
    ? { modelOverrides: gatewayModelOverrides }
    : undefined;
  // AI Gateway's Anthropic-compat schema rejects the newer output_config.effort
  // request field ("400 output_config.effort: Extra inputs are not permitted").
  // "unset" makes the CLI omit the field entirely (verified in CLI 0.2.x-2.1.x:
  // CLAUDE_CODE_EFFORT_LEVEL of "unset"/"auto" short-circuits effort resolution).
  // The CLI runs as a child of this bridge process, so it inherits this env;
  // ??= keeps any operator-provided override authoritative.
  process.env.CLAUDE_CODE_EFFORT_LEVEL ??= "unset";`;
const CLAUDE_CODE_BRIDGE_QUERY_OPTIONS_NEEDLE = `...start.model ? { model: start.model } : {},
      ...start.maxTurns !== void 0 ? { maxTurns: start.maxTurns } : {},`;
const CLAUDE_CODE_BRIDGE_QUERY_OPTIONS_PATCH = `...start.model ? { model: start.model } : {},
      ...(gatewayModelOverrideSettings ? { settings: gatewayModelOverrideSettings } : {}),
      ...start.maxTurns !== void 0 ? { maxTurns: start.maxTurns } : {},`;

function patchClaudeCodeBridgeContent(content: string): string {
  let patched = content;
  if (!patched.includes("parent_tool_use_id")) {
    if (!patched.includes(CLAUDE_CODE_BRIDGE_USER_MESSAGE_NEEDLE)) {
      throw new Error(
        "Unable to patch Claude Code bridge bootstrap: user-message shape changed"
      );
    }
    patched = patched.replace(
      CLAUDE_CODE_BRIDGE_USER_MESSAGE_NEEDLE,
      CLAUDE_CODE_BRIDGE_USER_MESSAGE_PATCH
    );
  }

  if (!patched.includes("emitAssistantTextFallback")) {
    for (const [needle, replacement] of [
      [
        CLAUDE_CODE_BRIDGE_TEXT_STATE_NEEDLE,
        CLAUDE_CODE_BRIDGE_TEXT_STATE_PATCH,
      ],
      [
        CLAUDE_CODE_BRIDGE_STREAM_EVENT_NEEDLE,
        CLAUDE_CODE_BRIDGE_STREAM_EVENT_PATCH,
      ],
      [
        CLAUDE_CODE_BRIDGE_ASSISTANT_TEXT_NEEDLE,
        CLAUDE_CODE_BRIDGE_ASSISTANT_TEXT_PATCH,
      ],
      [
        CLAUDE_CODE_BRIDGE_RESULT_TEXT_NEEDLE,
        CLAUDE_CODE_BRIDGE_RESULT_TEXT_PATCH,
      ],
    ] as const) {
      if (!patched.includes(needle)) {
        throw new Error(
          "Unable to patch Claude Code bridge bootstrap: assistant text shape changed"
        );
      }
      patched = patched.replace(needle, replacement);
    }
  }

  if (!patched.includes("gatewayModelOverrideSettings")) {
    for (const [needle, replacement] of [
      [
        CLAUDE_CODE_BRIDGE_MODEL_OVERRIDES_NEEDLE,
        CLAUDE_CODE_BRIDGE_MODEL_OVERRIDES_PATCH,
      ],
      [
        CLAUDE_CODE_BRIDGE_QUERY_OPTIONS_NEEDLE,
        CLAUDE_CODE_BRIDGE_QUERY_OPTIONS_PATCH,
      ],
    ] as const) {
      if (!patched.includes(needle)) {
        throw new Error(
          "Unable to patch Claude Code bridge bootstrap: model override shape changed"
        );
      }
      patched = patched.replace(needle, replacement);
    }
  }

  return patched;
}

export function patchClaudeCodeHarnessBootstrap(
  harness: HarnessAgentAdapter
): HarnessAgentAdapter {
  const originalGetBootstrap = harness.getBootstrap?.bind(harness);
  if (!originalGetBootstrap) return harness;

  let cachedPatchedBootstrap:
    | Awaited<ReturnType<NonNullable<typeof originalGetBootstrap>>>
    | undefined;

  return {
    ...harness,
    getBootstrap: async (...args) => {
      if (cachedPatchedBootstrap) return cachedPatchedBootstrap;
      const bootstrap = await originalGetBootstrap(...args);
      cachedPatchedBootstrap = {
        ...bootstrap,
        files: bootstrap.files.map((file) =>
          file.path.endsWith("/bridge.mjs")
            ? { ...file, content: patchClaudeCodeBridgeContent(file.content) }
            : file
        ),
      };
      return cachedPatchedBootstrap;
    },
  };
}

/** Map a host model id (Gateway `creator/model`, e.g.
 *  `anthropic/claude-opus-4.7`) to a Claude Code native model id. Haiku is the
 *  exception: Claude Code accepts the `haiku` alias as a main model, but rejects
 *  `claude-haiku-4-5` as a selectable main model. The patched bridge adds
 *  `settings.modelOverrides` so aliases/native ids still talk to the Gateway
 *  provider-specific id on the wire. */
function toClaudeCodeModel(modelId: string): string | undefined {
  const m = modelId.toLowerCase();
  const withoutProvider = m.startsWith("anthropic/")
    ? m.slice("anthropic/".length)
    : m;
  // Trailing (?:-\d+)? absorbs an optional dated/pinned snapshot suffix
  // (e.g. "claude-haiku-4-5-20251001", the exact shape Claude Code's own
  // internal alias resolution can produce on the wire — see the bridge's
  // modelOverrides keys below) without being captured; the return value only
  // ever depends on family/major/minor, same as the undated shape.
  const match = withoutProvider.match(
    /^claude-(haiku|sonnet|opus)-(\d+)(?:[.-](\d+))?(?:-\d+)?$/
  );
  if (match) {
    const [, family, major, minor] = match;
    // Claude Code accepts "haiku" as a selectable main model but rejects the
    // native shape ("claude-haiku-4-5") — only THIS shortcut needs the alias;
    // gated on the regex match so it can't fire for a non-Anthropic or
    // malformed id that merely contains "haiku" as a substring.
    if (family === "haiku") return "haiku";
    return `claude-${family}-${major}${minor ? `-${minor}` : ""}`;
  }
  if (
    withoutProvider === "haiku" ||
    withoutProvider === "sonnet" ||
    withoutProvider === "opus"
  ) {
    return withoutProvider;
  }
  return undefined;
}

/** Map a host model id to a Codex-native OpenAI model. ALLOWLIST, not a blanket
 *  `openai/` strip: only the gpt-5 family (what Codex CLI runs) passes through;
 *  anything else ⇒ undefined so Codex uses its own pinned default rather than
 *  being forced onto a model it can't run. */
function toCodexModel(modelId: string): string | undefined {
  if (!modelId.toLowerCase().startsWith("openai/")) return undefined;
  const slug = modelId.slice("openai/".length);
  return /^gpt-5/i.test(slug) ? slug : undefined;
}

/** Convert a built-in tool's input schema to JSON Schema, or omit on failure.
 *  The adapter's schemas are **Zod v3** (from its bundled `zod`), which the
 *  inspector's own `zod@4` `z.toJSONSchema` can't read — so use `ai`'s
 *  `asSchema`, which handles both Zod versions and yields a JSON Schema. */
function builtinInputJsonSchema(
  schema: unknown
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

/** Normalize a harness's static `builtinTools` ToolSet into the display catalog.
 *  Shared by every adapter so a new harness reuses the exact same shaping. */
function normalizeHarnessBuiltinTools(
  builtinTools: Record<string, unknown>
): HarnessBuiltinToolInfo[] {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const list = Object.entries(builtinTools).map(([key, raw]) => {
    const tool = (raw ?? {}) as {
      description?: unknown;
      inputSchema?: unknown;
      nativeName?: unknown;
      commonName?: unknown;
      toolUseKind?: unknown;
    };
    const inputSchema = builtinInputJsonSchema(tool.inputSchema);
    return {
      key,
      name: str(tool.nativeName) ?? key,
      ...(str(tool.commonName) ? { commonName: str(tool.commonName) } : {}),
      ...(str(tool.toolUseKind) ? { toolUseKind: str(tool.toolUseKind) } : {}),
      ...(str(tool.description) ? { description: str(tool.description) } : {}),
      ...(inputSchema ? { inputSchema } : {}),
    } as HarnessBuiltinToolInfo;
  });
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

/** Build a memoized `listBuiltinTools` for an adapter. The set is constant per
 *  process, and constructing the adapter (no auth, no sandbox) just to read its
 *  static `builtinTools` once is enough. */
function memoizedBuiltinTools(
  build: () => { builtinTools: unknown }
): () => HarnessBuiltinToolInfo[] {
  let cache: HarnessBuiltinToolInfo[] | undefined;
  return () => {
    if (!cache) {
      cache = normalizeHarnessBuiltinTools(
        build().builtinTools as Record<string, unknown>
      );
    }
    return cache;
  };
}

/** Shared credential resolver — both harnesses fetch the same member-gated AI
 *  Gateway key from Convex and map it to `auth.gateway`. SECURITY: a `baseUrl`
 *  is always passed so the adapter never falls back to the host env for the
 *  gateway base URL (see `MCPJAM_GATEWAY_BASE_URL`). Each adapter supplies a
 *  `normalizeBaseUrl` because one Convex-issued URL can't serve both wire
 *  protocols (see the normalizers below). */
async function resolveGatewayAuth(
  args: {
    projectId: string;
    modelId: string;
    bearer: string;
    signal?: AbortSignal;
  },
  normalizeBaseUrl: (baseUrl: string) => string
): Promise<HarnessGatewayAuth> {
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
      // Always present: prefer the Convex-issued base URL, else the expected
      // Gateway default — never undefined (which would let the adapter read the
      // host env for the base URL).
      baseUrl: normalizeBaseUrl(
        result.credential.baseUrl ?? MCPJAM_GATEWAY_BASE_URL
      ),
    },
  };
}

/** The expected AI Gateway base URL. Used as the fail-safe default so an adapter
 *  can never resolve the gateway base URL from the host environment. Adapters
 *  normalize it per wire protocol before use. */
const MCPJAM_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

/** Claude Code's CLI speaks the Anthropic protocol and joins
 *  `${ANTHROPIC_BASE_URL}/v1/messages` itself, so its gateway base must be the
 *  bare origin — a `/v1`-suffixed base yields `…/v1/v1/messages`, which the
 *  live gateway 404s on every model call. */
export function toAnthropicGatewayBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Codex's CLI treats `OPENAI_BASE_URL` as an OpenAI-compatible `/v1` root
 *  (`/chat/completions` etc. live directly under it), so ensure the suffix. */
export function toOpenAiCompatGatewayBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

const claudeCodeAdapter: HarnessRuntimeAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  requiresComputer: true,
  defaultPermissionMode: "allow-all",
  supportsNativeToolApproval: false,
  supportsMcpToolApproval: false,
  supportsHostExecutedToolApproval: false,
  supportsSelectedMcpServers: true,
  supportsSkills: true,
  // Claude Code does not emit file-change stream parts.
  fileChangeToolName: undefined,
  listBuiltinTools: memoizedBuiltinTools(() => createClaudeCode()),
  resolveAuth: (args) => resolveGatewayAuth(args, toAnthropicGatewayBaseUrl),
  toNativeModel: toClaudeCodeModel,
  // The CLI runs any Anthropic model we map into its native id shape; other
  // providers are left to the runtime default rather than blocked in preflight.
  supportsModel: () => true,
  parseToolName: parseHarnessToolName,
  async deliverMcpServers({ writeTextFile, sessionWorkDir, mcpJson }) {
    // Write the host's MCP servers into the session workdir before Claude Code
    // starts, so it connects to them on launch.
    await writeTextFile({
      path: `${sessionWorkDir}/.mcp.json`,
      content: serializeHarnessMcpJson(mcpJson),
    });
  },
  createHarness({ modelId, auth }) {
    const nativeModel = toClaudeCodeModel(modelId);
    // Dual-`ai` boundary cast: createClaudeCode returns a HarnessV1 from its own
    // (nested) @ai-sdk/harness copy, nominally distinct from this server's copy
    // that HarnessAgent uses. Structurally identical; the drive reads loosely.
    return patchClaudeCodeHarnessBootstrap(
      createClaudeCode({
        ...(nativeModel ? { model: nativeModel } : {}),
        auth,
        // Unset, Claude Code defaults to ADAPTIVE thinking, a first-party
        // Anthropic API shape the AI Gateway's Anthropic-compat schema rejects
        // (400: expected 'disabled' | 'enabled'). Pin thinking off until the
        // gateway accepts adaptive.
        thinking: "off",
      }) as unknown as HarnessAgentAdapter
    );
  },
};

const codexAdapter: HarnessRuntimeAdapter = {
  id: "codex",
  displayName: "Codex",
  requiresComputer: true,
  // Codex doesn't support built-in tool approval requests — use allow-all.
  defaultPermissionMode: "allow-all",
  supportsNativeToolApproval: false,
  supportsMcpToolApproval: false,
  // Codex docs say host-executed AI SDK approvals can work, but it's not wired/
  // tested in MCPJam yet — keep false for v1; flip without code churn later.
  supportsHostExecutedToolApproval: false,
  // v1: no MCP servers on Codex. `.mcp.json` is Claude-specific and the Codex
  // bridge has MCP exposure limits; the preflight blocks a Codex host that has
  // selected servers. (No deliverMcpServers / parseToolName MCP path.)
  supportsSelectedMcpServers: false,
  supportsSkills: false,
  // Codex surfaces file mutations as `file-change` stream parts (some don't
  // originate from a model-callable tool); we render them as this native tool.
  fileChangeToolName: "fileChange",
  listBuiltinTools: memoizedBuiltinTools(() => createCodex()),
  resolveAuth: (args) => resolveGatewayAuth(args, toOpenAiCompatGatewayBaseUrl),
  toNativeModel: toCodexModel,
  // Codex only runs the gpt-5 family it maps; anything else would silently fall
  // back to Codex's default model, so the preflight rejects it.
  supportsModel: (modelId) => toCodexModel(modelId) !== undefined,
  // No MCP namespacing in v1 — pass the name through as a native tool.
  parseToolName: (rawToolName) => ({ toolName: rawToolName }),
  createHarness({ modelId, auth }) {
    const nativeModel = toCodexModel(modelId);
    // Same dual-`ai` boundary cast as Claude Code. `auth.gateway` is accepted by
    // createCodex (CodexAuthOptions.gateway) — we always pass an explicit
    // baseUrl so it never reads the host env for it.
    return createCodex({
      ...(nativeModel ? { model: nativeModel } : {}),
      auth,
    }) as unknown as HarnessAgentAdapter;
  },
};

const HARNESS_ADAPTERS: Record<HarnessId, HarnessRuntimeAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
};

/** Membership test against the installed adapters (own-property, prototype-safe).
 *  The single check `readHarness`/dispatch route through to narrow an untrusted
 *  value to a `HarnessId`. */
export function isHarnessId(value: unknown): value is HarnessId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(HARNESS_ADAPTERS, value)
  );
}

export function getHarnessAdapter(id: string): HarnessRuntimeAdapter {
  // Own-property guard: a prototype key (`__proto__`, `constructor`, …) would
  // otherwise resolve to an inherited value and slip past the `!adapter` check,
  // yielding a 500 downstream instead of a controlled unsupported-harness error.
  if (!isHarnessId(id)) {
    throw new Error(`Unsupported harness: ${id}`);
  }
  return HARNESS_ADAPTERS[id];
}

/** The registered harness ids (for parity assertions against the SDK list). */
export function registeredHarnessIds(): HarnessId[] {
  return Object.keys(HARNESS_ADAPTERS) as HarnessId[];
}
