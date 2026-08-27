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
import {
  HARNESS_MCP_DELIVERY,
  type HarnessMcpDelivery,
} from "@/shared/harness-mcp-delivery";
import {
  parseHarnessToolName,
  serializeHarnessMcpJson,
  type HarnessMcpJson,
} from "./mcp-config.js";
import {
  prepareClaudeCodeSkills,
  prepareCodexSkills,
  type PreparedHarnessSkills,
  type RuntimeSkill,
} from "./runtime-skills.js";
import { CLAUDE_CODE_SKILLS_BASE, CODEX_SKILLS_BASE } from "./skill-roots.js";

/** A harness id this inspector has a runtime adapter for. Derived from the SDK's
 *  portable `Harness` union (the persistence-contract source of truth), so the
 *  registry can't accept an id the storage layer would reject. `HARNESS_ADAPTERS`
 *  is typed `Record<HarnessId, …>`, so a new SDK id without an adapter here is a
 *  COMPILE error — parity is enforced by the type, and a test asserts the keys
 *  match `HARNESS_IDS` at runtime too. */
export type HarnessId = Harness;

/** Auth the inspector hands an adapter — BROKER-ONLY (COMP-23): dummy
 *  `anthropic`/`openaiCompatible` creds pointed at the model proxy. The REAL
 *  lease is injected by E2B OUTSIDE the VM, so these placeholders only satisfy
 *  the CLI's auth env. (The `gateway` variant carried the raw AI Gateway key on
 *  the retired client path — removed; the inspector never holds a real model
 *  credential.) All-optional so a single value type is accepted by both
 *  `createClaudeCode` and `createCodex`. */
export type HarnessAuth = {
  anthropic?: { apiKey: string; authToken: string; baseUrl: string };
  openaiCompatible?: { apiKey: string; baseUrl: string };
};

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

/** One verified plugin bundle to install into a sandbox, as resolved for the
 *  turn. `root` is a CONTENT-ADDRESSED local directory produced by
 *  `PluginBundleCache.materialize` (INS-6): its hash is re-verified against
 *  `bundleHash` before it is handed over, and it is never the user's own plugin
 *  folder — that absolute path is deliberately not persisted anywhere. */
export type HarnessPluginBundle = {
  pluginId: string;
  pluginVersionId: string;
  name: string;
  bundleHash: string;
  root: string;
};

/** Args for an adapter's native PLUGIN-BUNDLE installation into a fresh sandbox
 *  session — the whole plugin folder (skills + MCP components + assets), not the
 *  per-kind projections MCPJam delivers today.
 *
 *  No adapter implements this yet; see `supportsPluginBundles` for why. The
 *  shape is fixed here so the eventual implementation consumes the verified
 *  cache rather than re-deriving bundle content, and so the capability/hook
 *  invariant (advertise ⇒ implement) is enforceable in `runHarnessTurn`. */
export type HarnessPluginDeliveryArgs = {
  /** Write a UTF-8 text file into the fresh sandbox session. */
  writeTextFile(args: { path: string; content: string }): Promise<void>;
  /** Write bytes into the fresh sandbox session (no 16k exec cap). */
  writeBinaryFile(args: { path: string; content: Uint8Array }): Promise<void>;
  /** Run a command in the fresh sandbox session (mkdir, install CLI, …). */
  run(args: {
    command: string;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  sessionWorkDir: string;
  bundles: HarnessPluginBundle[];
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

/**
 * HOW a harness gets the host's selected MCP servers — a MODE, not a boolean,
 * so the two mechanisms are mutually exclusive by construction rather than by
 * comment. Every adapter has exactly one, so "this harness can't do MCP at all"
 * is no longer representable (the state the old `supportsSelectedMcpServers:
 * false` encoded, which forced a pre-flight refusal).
 *
 *  - `native` — the runtime's own MCP client connects to the servers. The
 *    adapter writes runtime-specific config into the sandbox
 *    (`deliverMcpServers`), pointed at MCPJam's signed per-server proxy, and
 *    the model calls the tools through native function calling. Claude Code.
 *
 *  - `host-executed` — the runtime cannot make an MCP tool model-callable
 *    (Codex: `codex exec --experimental-json` completes the MCP handshake and
 *    answers `tools/list`, but never registers the tools as callable functions
 *    — openai/codex#19425, and see `@ai-sdk/harness-codex`'s
 *    `src/bridge/cli-relay.ts`, whose whole existence is the harness authors
 *    hitting this same wall for their OWN host tools). MCPJam instead projects
 *    each selected server's tools into host-executed AI SDK tools passed as the
 *    agent's `tools`, which the bridge relays back out of the sandbox and
 *    MCPJam executes IN-PROCESS against the already-authorized
 *    `MCPClientManager`. See `host-executed-mcp-tools.ts`.
 *
 * The two must never both run for one turn or the model would see every MCP
 * tool twice (once natively, once as a host tool); the adapter union below
 * makes that unrepresentable.
 *
 * WHICH mode each harness uses is declared in `@/shared/harness-mcp-delivery`,
 * not here: the CLIENT has to derive its Behavior-tab promises from the same
 * answer (a knob that acts at tool-construction time bites on `host-executed`
 * and cannot on `native`), and it cannot import this server-only module. The
 * adapters below read that map, and `__tests__/registry.test.ts` asserts the two
 * can never disagree.
 */
export type { HarnessMcpDelivery };

type HarnessRuntimeAdapterBase = {
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
   *  (Bash/Edit/Write/…)? Claude Code: yes (WS3) — the turn pauses on a
   *  `tool-approval-request` and resumes with the decision. Codex v1: false. */
  supportsNativeToolApproval: boolean;
  /** Permission mode used when the host requires tool approval (WS3). Gates
   *  side-effecting built-ins behind approval while reads stay free — the
   *  closest faithful mapping to the emulated engine, which gates tool CALLS,
   *  never reads. Only honored when `supportsNativeToolApproval` is true. */
  approvalPermissionMode: HarnessV1PermissionMode;
  /** Can the runtime pause for approval of MCP-server tools it calls in-sandbox?
   *  Both current adapters: false. */
  supportsMcpToolApproval: boolean;
  /** Can host-executed AI SDK tools (run on MCPJam's server) be approval-gated?
   *  Modeled separately; false for v1 (not wired/tested in MCPJam yet). */
  supportsHostExecutedToolApproval: boolean;
  /** HOW this adapter gets the host's selected MCP servers to the model — see
   *  `HarnessMcpDelivery`. Every adapter delivers them one way or the other, so
   *  there is no "MCP unsupported" arm and no MCP pre-flight refusal. */
  mcpDelivery: HarnessMcpDelivery;
  /** Does the adapter deliver runtime (Cloud) skills into the sandbox? Claude
   *  Code: yes. Codex: yes (INS-8) — its `writeSkills` materializes the same
   *  `skills` param under its own root before the CLI starts. */
  supportsSkills: boolean;
  /** Where THIS runtime keeps skills on the box. MCPJam's own passes (stale-dir
   *  reconcile, supporting-file materialization, extra-frontmatter rewrite,
   *  turn-end adoption) must address the dirs the ADAPTER wrote, so the root
   *  travels with the adapter instead of being hardcoded per pass. */
  skillsBaseDir: string;
  /** Shape the runtime skills into this adapter's `skills` param, and report
   *  which skills that actually amounts to (a runtime may reject a name outright
   *  — Codex throws mid-`doStart`, which would fail the whole turn). The caller
   *  drives its own passes off `delivered`, so they never target a dir the
   *  adapter will not create. */
  prepareSkills(skills: RuntimeSkill[]): PreparedHarnessSkills;
  /** Can the adapter install a whole PLUGIN BUNDLE natively (the plugin folder
   *  as the runtime's own plugin/marketplace unit), rather than MCPJam projecting
   *  the bundle's components into per-kind channels (skills param, `.mcp.json`)?
   *
   *  FALSE for both adapters today, and deliberately so (INS-8):
   *   - Codex's installed harness (`@ai-sdk/harness-codex`) exposes no
   *     plugin-install hook, and its bridge documents that MCP tools are not
   *     model-callable through `codex exec --experimental-json` at all
   *     (openai/codex#19425) — half a bundle is not an installed bundle.
   *   - Claude Code's adapter delivers skills + `.mcp.json`, not a plugin unit.
   *  Advertising it means enforcing it: `runHarnessTurn` throws if an adapter
   *  sets this without `deliverPluginBundles`. */
  supportsPluginBundles: boolean;
  /** Native-tool name used to surface this runtime's `file-change` stream parts
   *  as a synthetic tool call. Undefined ⇒ the runtime doesn't emit file-change. */
  fileChangeToolName?: string;
  /** Construct the harness adapter (already cast to the server's HarnessAgent
   *  boundary type) for the given host model + broker dummy auth. (The
   *  per-adapter `resolveAuth` credential fetch was removed in COMP-23 —
   *  credentials are broker-delivered outside the VM; see
   *  `buildBrokerDummyAuth`.) */
  createHarness(args: {
    modelId: string;
    auth: HarnessAuth;
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
  /** Install verified plugin bundles into a fresh sandbox session, before the
   *  runtime process starts. REQUIRED when `supportsPluginBundles`. */
  deliverPluginBundles?(args: HarnessPluginDeliveryArgs): Promise<void>;
};

/**
 * The two MCP-delivery arms, as a discriminated union rather than a boolean +
 * an optional hook. This is what makes "the model never sees a tool twice" a
 * TYPE invariant:
 *   - `native` REQUIRES `deliverMcpServers` (advertise = implement, checked by
 *     the compiler instead of by a runtime throw in `runHarnessTurn`);
 *   - `host-executed` FORBIDS it (`?: never`), so an adapter cannot half-adopt
 *     the relay while still writing runtime MCP config.
 */
export type HarnessRuntimeAdapter = HarnessRuntimeAdapterBase &
  (
    | {
        mcpDelivery: "native";
        /** Write the host's MCP servers into a fresh sandbox session, before the
         *  runtime process starts. */
        deliverMcpServers(args: HarnessMcpDeliveryArgs): Promise<void>;
      }
    | {
        mcpDelivery: "host-executed";
        /** Never present: this arm's servers reach the model as host-executed
         *  tools, not as runtime config in the sandbox. */
        deliverMcpServers?: never;
      }
  );

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

/**
 * The `.npmrc` written beside the adapter's bundled manifest, so its
 * `pnpm install` is allowed to run dependency build scripts.
 *
 * WHY THIS EXISTS. `@anthropic-ai/claude-code` ships a `postinstall`
 * (`node install.cjs`) that fetches its platform-native binary; without it the
 * CLI starts and immediately reports `claude native binary not installed`.
 * pnpm 10 stopped running dependency build scripts by default, and the
 * computer template installs pnpm UNPINNED (`npm install -g pnpm`), so the
 * behaviour of a rebuilt image changes with whatever pnpm is current.
 *
 * The adapter's own recipe already anticipates the skip: after `pnpm install`
 * it re-runs `install.cjs` by hand. That rescue only fires when the install
 * step EXITS ZERO. Where the skip is a hard error rather than a warning —
 * `ERR_PNPM_IGNORED_BUILDS`, which is what a strict or newer pnpm produces —
 * the install step aborts the whole recipe and the rescue never runs. That is
 * the failure this file prevents, and it is why a warning-only pnpm looks fine.
 *
 * WHY A FILE AND NOT THE MANIFEST. `onlyBuiltDependencies` would be narrower,
 * but pnpm reads it only from `package.json` / `pnpm-workspace.yaml` — never
 * from `.npmrc` — and the manifest here is a bundled asset of
 * `@ai-sdk/harness-claude-code`, not ours to amend. Editing it would also
 * invalidate the `--frozen-lockfile` the adapter installs with. A sibling
 * `.npmrc` changes neither, and `--dir` makes pnpm read it.
 *
 * The permissiveness is bounded by where it lands: one directory inside a
 * disposable sandbox that already runs an agent with full shell access.
 */
const CLAUDE_CODE_BOOTSTRAP_NPMRC = "dangerously-allow-all-builds=true\n";

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
        // Appended rather than merged over an existing entry: the adapter
        // ships no `.npmrc` today, and if a future version starts shipping one
        // we want the duplicate to surface instead of silently winning.
        files: [
          ...bootstrap.files.map((file) =>
            file.path.endsWith("/bridge.mjs")
              ? { ...file, content: patchClaudeCodeBridgeContent(file.content) }
              : file
          ),
          {
            path: `${bootstrap.bootstrapDir}/.npmrc`,
            content: CLAUDE_CODE_BOOTSTRAP_NPMRC,
          },
        ],
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
  // Trailing 8-digit date absorbs an optional dated/pinned snapshot suffix
  // (e.g. "claude-haiku-4-5-20251001", the exact shape Claude Code's own
  // internal alias resolution can produce on the wire — see the bridge's
  // modelOverrides keys below) without being captured; the return value only
  // ever depends on family/major/minor, same as the undated shape. The
  // alternation tries the bare "major + date, no minor" shape FIRST
  // (-\d{8}) — a plain (?:-\d+)? suffix here is wrong: the earlier optional
  // minor group's greedy \d+ swallows the date digits as if they were a
  // minor version (e.g. "claude-opus-4-20250929" -> minor="20250929"),
  // producing an invalid native model string instead of "claude-opus-4".
  const match = withoutProvider.match(
    /^claude-(haiku|sonnet|opus)-(\d+)(?:-\d{8}|[.-](\d+)(?:-\d{8})?)?$/
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

// The shared `resolveGatewayAuth` credential resolver (and its per-protocol
// base-URL normalizers) lived here until COMP-23: it fetched the raw system AI
// Gateway key from Convex's /web/harness/model-credential — spend that
// bypassed all metering. Credentials are now broker-delivered: Convex installs
// a short-lived lease into E2B's egress transform (outside the VM) and the CLI
// runs with `buildBrokerDummyAuth` placeholders pointed at the metered model
// proxy, which normalizes its own per-protocol proxyBaseUrl.

const claudeCodeAdapter: HarnessRuntimeAdapter = {
  id: "claude-code",
  displayName: "Claude Code",
  requiresComputer: true,
  defaultPermissionMode: "allow-all",
  // WS3: the CLI pauses on a tool-approval-request for side-effecting
  // built-ins under "allow-edits"; the turn suspends and resumes with the
  // user's decision (see run-harness-turn's approval-continuation path).
  supportsNativeToolApproval: true,
  approvalPermissionMode: "allow-edits",
  supportsMcpToolApproval: false,
  // WS3 wires host-executed tools through `toolApproval` (the agent pauses on
  // tool-approval-request and resumes with the decision), same path as native.
  supportsHostExecutedToolApproval: true,
  // The CLI's own MCP client connects to the servers from inside the sandbox,
  // via the `.mcp.json` written below — real native function calling. Read from
  // the shared declaration so the host editor's promises about which knobs bite
  // move with this, instead of being re-asserted by hand on the client.
  mcpDelivery: HARNESS_MCP_DELIVERY["claude-code"],
  supportsSkills: true,
  skillsBaseDir: CLAUDE_CODE_SKILLS_BASE,
  prepareSkills: prepareClaudeCodeSkills,
  // No native plugin-unit install: this adapter delivers a plugin's COMPONENTS
  // (skills param + `.mcp.json`), which is not the same contract.
  supportsPluginBundles: false,
  // Claude Code does not emit file-change stream parts.
  fileChangeToolName: undefined,
  listBuiltinTools: memoizedBuiltinTools(() => createClaudeCode()),
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
  // Never honored while supportsNativeToolApproval is false; keep it the
  // same as the default mode so a future flip is an explicit decision.
  approvalPermissionMode: "allow-all",
  supportsMcpToolApproval: false,
  // Codex docs say host-executed AI SDK approvals can work, but it's not wired/
  // tested in MCPJam yet — keep false for v1; flip without code churn later.
  supportsHostExecutedToolApproval: false,
  // COMP-39: Codex reaches the host's MCP servers, but NOT through
  // `mcp_servers`. Writing `~/.codex/config.toml` merges cleanly and is a
  // silent no-op — the codex bridge documents that codex never registers an MCP
  // tool as model-callable in `codex exec --experimental-json` (the mode the
  // SDK drives): the handshake completes and `tools/list` answers, but the
  // model can't call anything (openai/codex#19425). So MCPJam projects each
  // selected server's tools into HOST-EXECUTED AI SDK tools instead; the bridge
  // relays the invocations back out (`cli-relay.ts`) and MCPJam runs them
  // in-process. See `HarnessMcpDelivery` and `host-executed-mcp-tools.ts`.
  // Read from the shared declaration — the client's Behavior tab derives from
  // the same value, so "MCPJam builds these tools, so the host's construction
  // knobs apply" is stated once for both sides.
  mcpDelivery: HARNESS_MCP_DELIVERY.codex,
  // INS-8: skills ARE delivered. `codex-harness.ts` writes every `skills` entry
  // to `$HOME/.agents/skills/<name>/SKILL.md` during `doStart`, before it spawns
  // the CLI, and points the process at that HOME — the same delivery contract
  // Claude Code has. Parity with the Claude path (payload shape, on-box target
  // paths, supporting files, name acceptance) is asserted against the REAL
  // adapter in `__tests__/codex-skill-parity.test.ts`.
  supportsSkills: true,
  skillsBaseDir: CODEX_SKILLS_BASE,
  prepareSkills: prepareCodexSkills,
  // Codex has no plugin-install interface in the installed harness — MCPJam
  // still projects a plugin's components (skills param, host-executed MCP
  // tools), which is not the same contract as a native bundle install.
  supportsPluginBundles: false,
  // Codex surfaces file mutations as `file-change` stream parts (some don't
  // originate from a model-callable tool); we render them as this native tool.
  fileChangeToolName: "fileChange",
  listBuiltinTools: memoizedBuiltinTools(() => createCodex()),
  toNativeModel: toCodexModel,
  // Codex only runs the gpt-5 family it maps; anything else would silently fall
  // back to Codex's default model, so the preflight rejects it.
  supportsModel: (modelId) => toCodexModel(modelId) !== undefined,
  // SAME scheme as Claude Code, deliberately: the projected host tools are named
  // `mcp__<sanitizedServer>__<tool>` (see `host-executed-mcp-tools.ts`), so a
  // relayed call attributes back to its serverId exactly as a native Claude Code
  // call does — eval assertions and trace spans written against a Claude Code
  // run match a Codex run tool-for-tool. Codex's own natives arrive as common
  // names (`bash`, `read`, …), which have no prefix and pass through unchanged.
  parseToolName: parseHarnessToolName,
  createHarness({ modelId, auth }) {
    const nativeModel = toCodexModel(modelId);
    // Same dual-`ai` boundary cast as Claude Code. `auth.openaiCompatible` is
    // accepted by createCodex — the broker dummy auth always carries an
    // explicit baseUrl so the CLI never reads the host env for it.
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

/**
 * Whether a harness id can deliver skills at all, WITHOUT throwing on an
 * unknown id. Surfaces that DESCRIBE a turn (environment preview, telemetry)
 * need this before the turn runs, and describing a turn must never be the thing
 * that fails the request — an unrecognized harness reports `false` ("we cannot
 * say skills would be delivered"), the same honest answer a skills-incapable
 * adapter would give.
 */
export function harnessSupportsSkills(id: string): boolean {
  return isHarnessId(id) ? HARNESS_ADAPTERS[id].supportsSkills : false;
}
