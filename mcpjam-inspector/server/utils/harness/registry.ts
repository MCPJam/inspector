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
import { createClaudeCodeHarness } from "./claude-code-bootstrap.js";
import { createHostedClaudeCodeHarness } from "./claude-code-typed-errors.js";
export { patchClaudeCodeHarnessBootstrap } from "./claude-code-bootstrap.js";
import { createCursor } from "@ai-sdk/harness-cursor";
import { createCodexAppServer } from "./codex-appserver/index.js";
import type { CodexWorkspaceWriteSandboxPolicy } from "./codex-appserver/shared/sandbox-policy.js";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import type {
  HarnessV1AuthenticationEnvironment,
  HarnessV1PermissionMode,
} from "@ai-sdk/harness";
import { asSchema } from "ai";
import {
  HARNESS_REASONING_EFFORTS,
  type Harness,
} from "@mcpjam/sdk/host-config/internal";
import type { ModelReasoningEffort } from "@mcpjam/sdk/browser";
import {
  harnessModelSupport,
  harnessPinnedVersion,
  type HarnessModelSupportVerdict,
} from "@/shared/harness-model-support";
import {
  HARNESS_MCP_DELIVERY,
  type HarnessMcpDelivery,
} from "@/shared/harness-mcp-delivery";
import {
  attributeCursorToolCall,
  parseHarnessToolName,
  toAcpMcpServers,
  type HarnessMcpJson,
} from "./mcp-config.js";
import {
  prepareClaudeCodeSkills,
  prepareCodexSkills,
  prepareNoSkills,
  type PreparedHarnessSkills,
  type RuntimeSkill,
} from "./runtime-skills.js";
import {
  CLAUDE_CODE_SKILLS_BASE,
  CODEX_SKILLS_BASE,
  CURSOR_SKILLS_BASE,
} from "./skill-roots.js";

/** A harness id this inspector has a runtime adapter for. Derived from the SDK's
 *  portable `Harness` union (the persistence-contract source of truth), so the
 *  registry can't accept an id the storage layer would reject. `HARNESS_ADAPTERS`
 *  is typed `Record<HarnessId, …>`, so a new SDK id without an adapter here is a
 *  COMPILE error — parity is enforced by the type, and a test asserts the keys
 *  match `HARNESS_IDS` at runtime too. */
export type HarnessId = Harness;

/** Auth the inspector hands an adapter — BROKER-ONLY (COMP-23): dummy
 *  credentials pointed at the model proxy. The REAL lease is injected by E2B
 *  OUTSIDE the VM, so these placeholders only satisfy the CLI's auth env. (A
 *  `gateway` variant carried the raw AI Gateway key on the retired client path
 *  — removed; the inspector never holds a real model credential.)
 *
 *  Since `@ai-sdk/harness@1.0.x` this is the adapters' `HarnessV1Authentication`
 *  ENVIRONMENT arm: a flat env map, rather than the canary line's structured
 *  `{ anthropic }` / `{ openaiCompatible }` objects. Supplying the map (instead
 *  of `'auto'` / `'ai-gateway'` / `'direct'`) is what keeps the adapters from
 *  reading the SERVER's own process env for a model credential — the property
 *  COMP-23 depends on. One flat type is accepted by both `createClaudeCode` and
 *  `createCodexAppServer`. */
export type HarnessAuth = HarnessV1AuthenticationEnvironment;

/** Escape a value for safe interpolation INSIDE a single-quoted shell word.
 *
 *  A single quote is the only character with meaning there, and the standard
 *  close-escape-reopen dance is the replacement: `'` becomes `'\''` — end the
 *  quoted word, an escaped literal quote, start a new quoted word.
 *
 *  A REGULAR string, not a template literal. In a template literal `\'` is just
 *  `'` (JS drops the backslash), so the obvious-looking `` `'\''` `` silently
 *  produces three quotes — which CLOSES the quoted word and leaves the rest of
 *  the path unquoted, restoring the very `$(…)` execution this exists to
 *  prevent. `__tests__/registry.test.ts` pins the emitted bytes. */
function shellSingleQuote(value: string): string {
  return value.replaceAll("'", "'\\''");
}

/** Placeholder credential value handed to the in-sandbox CLI on the broker path.
 *  It is never used for auth (the proxy ignores VM-supplied Authorization/
 *  x-api-key and trusts only E2B's injected `x-mcpjam-harness-lease`); it just
 *  has to be present so the CLI makes the request. */
const BROKER_DUMMY_CREDENTIAL = "mcpjam-broker-dummy";

/** Build the dummy broker auth pointed at the proxy base URL. Claude Code reads
 *  `ANTHROPIC_AUTH_TOKEN` (Bearer) + `ANTHROPIC_BASE_URL`; Codex reads
 *  `CODEX_API_KEY` + `OPENAI_BASE_URL`.
 *
 *  `ANTHROPIC_API_KEY` is deliberately ABSENT rather than empty: the adapter
 *  keys its credential-forwarding transformations off which variables are
 *  present, and an empty string would register an `x-api-key` rewrite for a
 *  header the CLI never sends on the auth-token path.
 *
 *  EXHAUSTIVE, and it THROWS for an external-account harness. This used to be a
 *  fallthrough `if (codex) … else Anthropic`, which meant any harness id that
 *  was not codex silently received Claude Code's `ANTHROPIC_*` environment —
 *  so a cursor turn would have been handed an Anthropic base URL and a dummy
 *  token for a proxy it never talks to, and the failure would have surfaced as
 *  a confusing runtime error inside the box rather than here. An
 *  external-account harness has NO broker lease by construction
 *  (`modelAccess`), so asking for its broker auth is a caller bug; the caller's
 *  own `modelAccess` branch is what must skip this. */
export function buildBrokerDummyAuth(
  harnessId: HarnessId,
  proxyBaseUrl: string,
): HarnessAuth {
  switch (harnessId) {
    case "claude-code":
      return {
        ANTHROPIC_AUTH_TOKEN: BROKER_DUMMY_CREDENTIAL,
        ANTHROPIC_BASE_URL: proxyBaseUrl,
      };
    case "codex":
      return {
        CODEX_API_KEY: BROKER_DUMMY_CREDENTIAL,
        OPENAI_BASE_URL: proxyBaseUrl,
      };
    case "cursor":
      throw new Error(
        "The Cursor harness authenticates with the customer's own Cursor " +
          "account (modelAccess: 'external-account') and takes no broker " +
          "lease — buildBrokerDummyAuth must not be called for it.",
      );
    default: {
      const unhandled: never = harnessId;
      throw new Error(
        `No broker auth strategy for harness: ${String(unhandled)}`,
      );
    }
  }
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
 *  - `host-executed` — MCPJam keeps enforcement in its own process (Codex:
 *    the retired `codex exec` transport could not make an MCP tool
 *    model-callable at all, openai/codex#19425; on app-server the relay keeps
 *    MCPJam's tool policy and approval gate the single authority). MCPJam projects
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

/**
 * WHERE a harness's model spend lands — and therefore whether MCPJam brokers a
 * credential for it at all.
 *
 *  - `broker`           — MCPJam mints a short-lived lease, E2B injects it into
 *    the box's egress outside the VM, the model proxy meters every request and
 *    MCPJam is billed. Claude Code, Codex. The CLI itself runs with
 *    `buildBrokerDummyAuth` placeholders.
 *
 *  - `external-account` — the runtime reaches its model provider on the
 *    CUSTOMER's own account, and MCPJam has no seam to broker at. Cursor's CLI
 *    has no provider/gateway routing whatsoever: it authenticates with a
 *    `CURSOR_API_KEY`, every request transits Cursor's servers, and the spend
 *    is billed to that Cursor account. Verified three ways plus Cursor's own
 *    docs before this arm existed.
 *
 * Not a cosmetic label. Everything below keys off it, and each is actively
 * wrong for the other arm:
 *   - the broker start is SKIPPED, and `buildBrokerDummyAuth` THROWS;
 *   - the box reservation is HELD for the turn instead of being consumed by a
 *     lease that never exists;
 *   - the credential comes out of the project's materialized secrets and is
 *     removed from the box's session env;
 *   - the model gates — the preflight's model-hosted / model-supported checks
 *     and the turn's `supportsModel` backstop — are skipped, because the model
 *     MCPJam knows about is not the model that runs;
 *   - the broker kill switch does not apply (there is no broker to kill);
 *   - the turn is tagged `modelSource: 'external-account'` rather than
 *     `'mcpjam'`, so it does not consume the org's MCPJam spend limit;
 *   - the entitlement-wall check runs (see `external-account-plan-wall.ts`) —
 *     an external-account runtime can answer "upgrade your plan" as a normal
 *     successful turn, which a brokered one cannot.
 */
export type HarnessModelAccess = "broker" | "external-account";

type HarnessRuntimeAdapterBase = {
  id: HarnessId;
  /**
   * WHICH TRANSPORT this arm speaks, when a harness has more than one.
   *
   * Codex has two — the published `codex exec` adapter and MCPJam's own
   * `codex app-server` one — and they are the same HOST with the same id and
   * the same history. What differs is the protocol, and with it the
   * capabilities: only app-server can pause for approval.
   *
   * Undefined means "this harness has one transport and the question does not
   * arise". `"exec"` and undefined are treated identically by the runtime
   * fingerprint, so adding this field forks no existing session.
   */
  transport?: "exec" | "app-server";
  /**
   * Does a PENDING approval live in the runtime PROCESS rather than on disk?
   *
   * Claude Code's conversation is on disk, so a local turn paused on an
   * approval can be torn down and re-driven. Codex app-server's pending
   * approval is an open JSON-RPC request inside one live process (and, for a
   * host tool, an open relay call), so a local pause must PARK that process
   * (`local/approval-park.ts`) and the decision must be delivered to it —
   * never replayed into a new one.
   */
  liveApprovalRuntime?: boolean;
  /**
   * The adapter applies `HarnessCreateArgs.sandboxPolicy` to its runtime. An
   * adapter without this flag cannot contain an unattended local turn, so the
   * turn runner refuses to start one rather than run it unrestricted.
   */
  acceptsSandboxPolicy?: boolean;
  /** Human-facing runtime name for preflight/availability messages + UI. */
  displayName: string;
  /**
   * The reasoning efforts this adapter is VERIFIED to apply when handed one
   * through `HarnessCreateArgs.reasoningEffort`. Declared per adapter and
   * REQUIRED, so a new adapter has to say (empty = "none yet"): a saved
   * effort on a harness host is refused before any spend when the adapter
   * does not list it, never silently dropped. Read from the SDK table
   * (`HARNESS_REASONING_EFFORTS`) so the UI's picker and this gate agree.
   */
  supportedReasoningEfforts: readonly ModelReasoningEffort[];
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
  /** The options THIS adapter's runtime passes to `writeSkills` for its
   *  turn-time on-box write, mirrored exactly so the `onSandboxSession`
   *  pre-seed (see `preseed-adapter-skills.ts`) produces the identical
   *  projected content hash and the adapter's own write becomes a no-op.
   *  Claude Code passes `trailingNewline: true`; Codex takes the default.
   *  Verified against the installed packages' `writeClaudeCodeSkills` /
   *  `writeCodexSkills` — re-verify on adapter bumps. */
  skillsWriteOptions: { trailingNewline: boolean };
  /** Shape the runtime skills into this adapter's `skills` param, and report
   *  which skills that actually amounts to (a runtime may reject a name outright
   *  — Codex throws mid-`doStart`, which would fail the whole turn). The caller
   *  drives its own passes off `delivered`, so they never target a dir the
   *  adapter will not create. */
  prepareSkills(skills: RuntimeSkill[]): PreparedHarnessSkills;
  /** Can the adapter install a whole PLUGIN BUNDLE natively (the plugin folder
   *  as the runtime's own plugin/marketplace unit), rather than MCPJam projecting
   *  the bundle's components into per-kind channels (skills, native MCP config)?
   *
   *  FALSE for both adapters today, and deliberately so (INS-8):
   *   - Codex's adapter exposes no plugin-install hook, and its MCP tools are
   *     host-executed — half a bundle is not an installed bundle.
   *   - Claude Code's adapter delivers skills + MCP config, not a plugin unit.
   *  Advertising it means enforcing it: `runHarnessTurn` throws if an adapter
   *  sets this without `deliverPluginBundles`. */
  supportsPluginBundles: boolean;
  /** Native-tool name used to surface this runtime's `file-change` stream parts
   *  as a synthetic tool call. Undefined ⇒ the runtime doesn't emit file-change. */
  fileChangeToolName?: string;
  /** The harness's native built-in tools as a normalized, display-only catalog.
   *  No auth/sandbox needed — read straight from the constructed adapter's
   *  static `builtinTools` ToolSet. */
  listBuiltinTools(): HarnessBuiltinToolInfo[];
  /** Map a host model id to the harness's native model id/alias, if it needs
   *  one. Undefined ⇒ let the harness use its default. */
  toNativeModel?(modelId: string): string | undefined;
  /** The runtime CLI version this adapter pins (`HARNESS_PINNED_VERSIONS`),
   *  or undefined when the adapter does not pin one (Cursor). The model-support
   *  evidence is evaluated against it. */
  pinnedRuntimeVersion: string | undefined;
  /** The evidence-table verdict for the given CANONICAL host model at this
   *  adapter's pinned runtime version — see `shared/harness-model-support.ts`.
   *  `supported` / `unsupported` / `unknown`, with the reason and the row. */
  modelSupport(modelId: string): HarnessModelSupportVerdict;
  /** Can this runtime run the given host model? True only for a `supported`
   *  verdict, or an `unknown` one when the caller passes `allowUnknown`
   *  (Playground chat). The preflight rejects the rest rather than letting the
   *  runtime silently fall back to its own default. */
  supportsModel(modelId: string, opts?: { allowUnknown?: boolean }): boolean;
  /** Map a runtime tool name back to MCPJam tool identity. Claude Code namespaces
   *  MCP tools `mcp__<server>__<tool>`; other harnesses differ, so this is
   *  per-adapter rather than pinned to Claude's scheme. */
  parseToolName(
    rawToolName: string,
    keyToServerId: Record<string, string>,
  ): HarnessToolAttribution;
  /** Map a tool CALL — name *and* input — back to MCPJam tool identity.
   *
   *  A superset of `parseToolName`, and the hook the turn runner actually calls.
   *  It exists because not every runtime puts the identity in the NAME: Cursor
   *  streams every MCP call under an opaque per-session `acp_tool_<id>` and
   *  carries `{ providerIdentifier, toolName, args }` in the input instead, so a
   *  name-only signature cannot attribute one at all.
   *
   *  Optional: an adapter that omits it falls back to its own `parseToolName`
   *  at the call site. Both stay because they answer different questions —
   *  `parseToolName` is also called where only a name exists (a result part
   *  that omits the input). */
  attributeToolCall?(args: {
    rawToolName: string;
    input: unknown;
    keyToServerId: Record<string, string>;
  }): HarnessToolAttribution;
  /** Install verified plugin bundles into a fresh sandbox session, before the
   *  runtime process starts. REQUIRED when `supportsPluginBundles`. */
  deliverPluginBundles?(args: HarnessPluginDeliveryArgs): Promise<void>;
  /**
   * Shell command that prints the INSTALLED runtime's version, given the
   * session workdir — for adapters whose CLI version is NOT pinned by the
   * package pin.
   *
   * Claude Code and Codex bootstrap a version-pinned npm package, so the
   * installed CLI is knowable from the lockfile and this is absent. Cursor's
   * bootstrap runs `curl https://cursor.com/install | bash`, which always
   * fetches the CURRENT build: two builds observed four months apart behaved
   * differently, so what actually ran is only knowable by asking the box.
   *
   * Read at turn end and recorded as telemetry, FAIL-SOFT throughout: a command
   * that errors, times out, or stops matching the adapter's bootstrap layout
   * records no version and never affects the turn. A canary is not worth a
   * failed run.
   */
  runtimeVersionCommand?(sessionWorkDir: string): string;
};

/** Base args every adapter's `createHarness` receives. (The per-adapter
 *  `resolveAuth` credential fetch was removed in COMP-23 — brokered credentials
 *  are delivered outside the VM, see `buildBrokerDummyAuth`; an
 *  external-account harness gets its customer credential in `auth` instead.) */
export type HarnessCreateArgs = {
  modelId: string;
  auth: HarnessAuth;
  /**
   * The reasoning effort this turn asked for. An adapter that lists efforts in
   * `supportedReasoningEfforts` MUST apply it through its own runtime option;
   * one that lists none never receives it (the refusal helper stops the turn
   * first), so a value arriving here is always one the adapter declared.
   */
  reasoningEffort?: ModelReasoningEffort;
  /**
   * The command-sandbox policy an UNATTENDED local turn runs under (D2), set
   * only by the local arm from the compatibility manifest
   * (`localSandboxPolicyFor`). It is not a permission mode: the turn is
   * `allow-all` because nobody is there to approve, and this policy is what
   * contains its commands. Only an adapter with `acceptsSandboxPolicy` may
   * receive it; the turn refuses to hand it to any other rather than let it be
   * silently dropped.
   */
  sandboxPolicy?: Readonly<CodexWorkspaceWriteSandboxPolicy>;
};

/** Brokered model access: MCPJam supplies the credential, so the adapter needs
 *  nothing from the customer's own secrets. */
type BrokeredModelAccessArm = {
  modelAccess: "broker";
  externalAccountCredentialEnv?: never;
  externalAccountBrokerBinding?: never;
};

/** External-account model access: the runtime authenticates with the
 *  CUSTOMER's credential, so it must SAY which one. */
type ExternalAccountModelAccessArm = {
  modelAccess: "external-account";
  /**
   * The environment variable names this runtime needs from the project's
   * secrets, e.g. `["CURSOR_API_KEY"]` (which is exactly what
   * `@ai-sdk/harness-cursor` declares as its own `credentialEnv`).
   *
   * REQUIRED on this arm, and that is the point: an external-account harness
   * that did not name its credential would have the turn runner silently start
   * it with no auth at all, and the failure would surface as an opaque error
   * from inside the box. A missing secret is refused up front instead, with
   * copy that names the variable and where to set it.
   *
   * The turn runner treats every name here as required, pulls them OUT of the
   * box's session env (so they are not also handed to every other command that
   * runs there) and passes them to the adapter as its auth environment.
   */
  externalAccountCredentialEnv: readonly [string, ...string[]];
  /**
   * How each credential above can be satisfied by a BROKERED project secret
   * instead of a materialized one — the binding the row has to carry for the
   * backend's egress transform to actually deliver it.
   *
   * Keyed by the same env-var name. A name with no entry here can only ever be
   * satisfied materialized, which is the honest default: brokering works only
   * when the runtime authenticates by putting the credential in a HEADER, on a
   * host we can name up front.
   *
   * These values are not a guess. They are read off the adapter's own
   * `credentialBrokering` declaration — the request it says carries the key —
   * so a runtime that changes where it authenticates changes this too, rather
   * than silently brokering nothing.
   */
  externalAccountBrokerBinding?: Readonly<
    Record<string, HarnessExternalAccountBrokerBinding>
  >;
};

/**
 * The project-secret binding that makes one external-account credential
 * deliverable by MCPJam's egress proxy rather than as a value in the box.
 *
 * Mirrors the backend's `projectSecrets` broker triple exactly
 * (`brokerHosts` / `brokerHeader` / `brokerTemplate`), because that is what a
 * user has to type into Project Settings → Secrets and what the refusal copy
 * has to be able to quote back at them.
 */
export type HarnessExternalAccountBrokerBinding = {
  /** Exact hostnames the credential header must be injected on. */
  hosts: readonly [string, ...string[]];
  /** HTTP header name, LOWERCASE — the backend canonicalizes rows that way. */
  header: string;
  /** Header value template; `{}` is where the plaintext is substituted. */
  template: string;
};

/** NATIVE delivery, `sandbox-files` mechanism: MCPJam writes runtime config
 *  into the box before the process starts. */
type NativeSandboxFilesArm = {
  mcpDelivery: "native";
  mcpNativeDelivery: "sandbox-files";
  /** Write the host's MCP servers into a fresh sandbox session, before the
   *  runtime process starts. */
  deliverMcpServers(args: HarnessMcpDeliveryArgs): Promise<void>;
  createHarness(args: HarnessCreateArgs): HarnessAgentAdapter;
};

/** NATIVE delivery, `session-config` mechanism: there is no file to write —
 *  the servers are a CONSTRUCTOR setting the adapter forwards into its session
 *  handshake (Claude Code's start message or Cursor's ACP `session/new`). */
type NativeSessionConfigArm = {
  mcpDelivery: "native";
  mcpNativeDelivery: "session-config";
  /** Never present: nothing is written into the box for this mechanism. */
  deliverMcpServers?: never;
  /** `mcpJson` is REQUIRED here, and that is the whole point of the arm: an
   *  adapter whose only channel for MCP config is construction cannot be
   *  constructed without it, so the config can never be silently dropped. */
  createHarness(
    args: HarnessCreateArgs & { mcpJson: HarnessMcpJson },
  ): HarnessAgentAdapter;
};

/** HOST-EXECUTED delivery: the servers reach the model as host-executed tools
 *  MCPJam runs in-process, never as runtime config in the sandbox. */
type HostExecutedArm = {
  mcpDelivery: "host-executed";
  mcpNativeDelivery?: never;
  deliverMcpServers?: never;
  createHarness(args: HarnessCreateArgs): HarnessAgentAdapter;
};

/**
 * The MCP-delivery arms, as a discriminated union rather than a boolean + an
 * optional hook. This is what makes "the model never sees a tool twice" a TYPE
 * invariant:
 *   - `native` REQUIRES a delivery mechanism, and each mechanism requires the
 *     hook that implements it (advertise = implement, checked by the compiler
 *     instead of by a runtime throw in `runHarnessTurn`);
 *   - `host-executed` FORBIDS both (`?: never`), so an adapter cannot
 *     half-adopt the relay while still writing runtime MCP config.
 *
 * `native` is NESTED rather than flat because the two native mechanisms need
 * different hooks — one writes a file into the session, the other takes the
 * config at construction — and a flat arm would have had to make both optional,
 * which is exactly the "advertises MCP, delivers nothing" state this union
 * exists to make unrepresentable. The MODE (does the traffic cross MCPJam's
 * proxy? — what evidence capture keys off) stays `mcpDelivery`; the MECHANISM
 * is `mcpNativeDelivery` and is invisible to everything but construction.
 */
export type HarnessRuntimeAdapter = HarnessRuntimeAdapterBase &
  (BrokeredModelAccessArm | ExternalAccountModelAccessArm) &
  (NativeSandboxFilesArm | NativeSessionConfigArm | HostExecutedArm);

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
    /^claude-(haiku|sonnet|opus)-(\d+)(?:-\d{8}|[.-](\d+)(?:-\d{8})?)?$/,
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
  // Another Anthropic model (the evidence table's `unknown` row: no native id
  // verified). Playground chat may still run it with a warning, and then the
  // honest attempt is the model's own id — passing nothing would let the CLI
  // silently run its DEFAULT model under this model's name. Evals and swarms
  // never get here: they refuse an unverified pair before the turn starts.
  if (m.startsWith("anthropic/") && /^claude-[a-z0-9.-]+$/.test(withoutProvider)) {
    return withoutProvider;
  }
  return undefined;
}

/**
 * Model support is no longer decided here. Which models each harness can run
 * is an evidence table keyed by the runtime VERSION
 * (`shared/harness-model-support-evidence.json`, read through
 * `shared/harness-model-support.ts`), and every adapter asks it at its pinned
 * CLI version — see {@link modelSupportFor}.
 *
 * The Codex tool-less gate that used to live here (`gpt-5.6*` refused because
 * the pinned 0.149.x CLI resolves the line but equips it with NO tools —
 * measured by `.spike-codex-appserver` gate P5, re-run with
 * `node probe/run-gates.mjs --gate P5` on a version bump) is now the table's
 * `codex <=0.149.x` row, with the measurement as its evidence. A newer CLI
 * reads that pair as `unknown` until someone measures it, instead of silently
 * inheriting the old verdict.
 */

/** Map a host model id to a Codex-native OpenAI model. ALLOWLIST, not a blanket
 *  `openai/` strip: only the gpt-5 family (what Codex CLI runs) passes through;
 *  anything else ⇒ undefined so Codex uses its own pinned default rather than
 *  being forced onto a model it can't run. Whether a mapped model is actually
 *  RUN is the evidence table's call ({@link modelSupportFor}), so a line the
 *  pinned CLI runs without tools is refused by the preflight, not dropped
 *  here. */
function toCodexModel(modelId: string): string | undefined {
  if (!modelId.toLowerCase().startsWith("openai/")) return undefined;
  const slug = modelId.slice("openai/".length);
  if (!/^gpt-5/i.test(slug)) return undefined;
  return slug;
}

/** The evidence-table verdict for `modelId` on `harnessId` at its pinned
 *  runtime version. One helper so every adapter (both Codex transports
 *  included) reads the same table the same way. */
function modelSupportFor(
  harnessId: HarnessId,
): (modelId: string) => HarnessModelSupportVerdict {
  return (modelId) =>
    harnessModelSupport({
      harnessId,
      runtimeVersion: harnessPinnedVersion(harnessId),
      modelId,
    });
}

/** `supportsModel` derived from the verdict: `supported`, or `unknown` when
 *  the caller explicitly allows an unverified pair (Playground chat). */
function supportsModelFor(
  harnessId: HarnessId,
): (modelId: string, opts?: { allowUnknown?: boolean }) => boolean {
  const support = modelSupportFor(harnessId);
  return (modelId, opts) => {
    const { status } = support(modelId);
    return (
      status === "supported" ||
      (status === "unknown" && opts?.allowUnknown === true)
    );
  };
}

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

/** Normalize a harness's static `builtinTools` ToolSet into the display catalog.
 *  Shared by every adapter so a new harness reuses the exact same shaping. */
function normalizeHarnessBuiltinTools(
  builtinTools: Record<string, unknown>,
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
  build: () => { builtinTools: unknown },
): () => HarnessBuiltinToolInfo[] {
  let cache: HarnessBuiltinToolInfo[] | undefined;
  return () => {
    if (!cache) {
      cache = normalizeHarnessBuiltinTools(
        build().builtinTools as Record<string, unknown>,
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
  // Nothing verified yet: an effort on this harness is refused, not dropped.
  // `createHarness` below already maps an effort (`effort` option + adaptive
  // thinking), but it stays inert (the SDK row is empty) until the live check
  // against the AI Gateway verifies it. See `HARNESS_REASONING_EFFORTS`.
  supportedReasoningEfforts: HARNESS_REASONING_EFFORTS["claude-code"],
  requiresComputer: true,
  // MCPJam brokers the model credential: Convex mints a lease, E2B injects it
  // outside the VM, and the model proxy meters the spend.
  modelAccess: "broker",
  defaultPermissionMode: "allow-all",
  // WS3: the CLI pauses on a tool-approval-request for side-effecting tools;
  // the turn suspends and resumes with the user's decision (see
  // run-harness-turn's approval-continuation path).
  supportsNativeToolApproval: true,
  // "allow-reads", NOT "allow-edits" — and the difference is what makes MCP
  // tools approvable at all.
  //
  // The adapter's in-sandbox bridge routes EVERY tool call through a
  // `canUseTool` callback before the CLI may run it, MCP tools included: it
  // emits `tool-approval-request` over the bridge socket and awaits the host's
  // `submitToolApproval`. Which calls reach that pause is decided by the
  // bridge's `nativeToolRequiresApproval`, and the load-bearing line is its
  // default: a tool name it does not recognize is treated as kind "edit".
  // An external MCP tool (`mcp__<server>__<tool>`) is never in that table, so
  //   - "allow-all"   → never pauses.
  //   - "allow-edits" → pauses only on kind "bash", so MCP tools run free.
  //   - "allow-reads" → pauses on "edit" and "bash", so MCP tools pause.
  // "allow-reads" is therefore the only mode under which an approval host can
  // honestly claim to gate a Claude Code MCP call.
  //
  // The cost is a wider prompt surface: native edit-class built-ins (Write,
  // Edit, NotebookEdit, TodoWrite, the Task* family) now prompt too, where
  // "allow-edits" let them through. That is the right trade for a host that
  // explicitly asked for approval — reads still stay free, which keeps the
  // faithful mapping to the emulated engine (it gates tool CALLS, never reads).
  approvalPermissionMode: "allow-reads",
  // True because of the mechanism above, verified against the vendored bridge
  // rather than assumed. This was previously false on the belief that the CLI's
  // own MCP client called those tools from inside the sandbox with nothing for
  // MCPJam to interpose on; `canUseTool` IS that interposition point, and it
  // runs before the call is dispatched.
  supportsMcpToolApproval: true,
  // WS3 wires host-executed tools through `toolApproval` (the agent pauses on
  // tool-approval-request and resumes with the decision), same path as native.
  supportsHostExecutedToolApproval: true,
  // The CLI's own MCP client connects to the servers from inside the sandbox,
  // via its session MCP configuration — real native function calling. Read from
  // the shared declaration so the host editor's promises about which knobs bite
  // move with this, instead of being re-asserted by hand on the client.
  mcpDelivery: HARNESS_MCP_DELIVERY["claude-code"],
  // …through the SDK session configuration, without writing into the workspace.
  mcpNativeDelivery: "session-config",
  supportsSkills: true,
  skillsBaseDir: CLAUDE_CODE_SKILLS_BASE,
  // Mirrors `writeClaudeCodeSkills` in `@ai-sdk/harness-claude-code`.
  skillsWriteOptions: { trailingNewline: true },
  prepareSkills: prepareClaudeCodeSkills,
  // No native plugin-unit install: this adapter delivers a plugin's COMPONENTS
  // (skills param + MCP configuration), which is not the same contract.
  supportsPluginBundles: false,
  // Claude Code does not emit file-change stream parts.
  fileChangeToolName: undefined,
  listBuiltinTools: memoizedBuiltinTools(() => createClaudeCodeHarness()),
  toNativeModel: toClaudeCodeModel,
  // Which models the pinned CLI runs is the evidence table's call, at the
  // pinned version: haiku/sonnet/opus supported, other Anthropic ids unknown,
  // everything else unsupported.
  pinnedRuntimeVersion: harnessPinnedVersion("claude-code"),
  modelSupport: modelSupportFor("claude-code"),
  supportsModel: supportsModelFor("claude-code"),
  parseToolName: parseHarnessToolName,
  // No `model` here: the adapter no longer reads one at construction. The
  // turn hands `toNativeModel(modelId)` to `HarnessAgent` instead.
  createHarness({ auth, mcpJson, reasoningEffort }) {
    // The HOSTED recipe: shared bootstrap + typed terminal errors, so a
    // provider failure reaches an eval as fields rather than a sentence. A
    // local session swaps this bootstrap for its verified pack's own
    // (`withLocalPackBootstrap`), so the local pack bytes are untouched.
    return createHostedClaudeCodeHarness({
      mcpServers: mcpJson.mcpServers,
      auth,
      // Unset, Claude Code defaults to ADAPTIVE thinking, a first-party
      // Anthropic API shape the AI Gateway's Anthropic-compat schema rejects
      // (400: expected 'disabled' | 'enabled'). Pin thinking off until the
      // gateway accepts adaptive. (`"off"` on the canary line; the stable
      // line takes the richer `{ type }` config, where `'disabled'` is the
      // same wire behavior.)
      //
      // WITH an effort the turn asks for adaptive thinking (the only shape the
      // `effort` option controls), so the disabled pin is dropped for it.
      // A turn with no effort keeps the exact options above.
      ...(reasoningEffort ? {} : { thinking: { type: "disabled" as const } }),
      // AI Gateway's Anthropic-compat schema rejects the newer
      // output_config.effort request field ("400 output_config.effort: Extra
      // inputs are not permitted"). "unset" makes the CLI omit the field
      // entirely (verified in CLI 0.2.x-2.1.x: CLAUDE_CODE_EFFORT_LEVEL of
      // "unset"/"auto" short-circuits effort resolution).
      //
      // This used to be a `process.env.… ??=` write injected into the bridge
      // source. Stable's first-class `env` merges OVER the bridge process
      // env, so unlike `??=` it is now authoritative rather than a default —
      // deliberate: the sandbox env is ours, and the adapter's own `effort`
      // option is the supported way to ask for a value.
      //
      // With an effort, the env is set to that level instead: it beats the
      // `--effort` flag, so leaving "unset" would silently drop the request.
      ...(reasoningEffort
        ? {
            effort: reasoningEffort,
            thinking: { type: "adaptive" as const },
            env: { CLAUDE_CODE_EFFORT_LEVEL: reasoningEffort },
          }
        : { env: { CLAUDE_CODE_EFFORT_LEVEL: "unset" } }),
    });
  },
};

/**
 * Codex, over MCPJam's own `codex app-server` adapter (`codex-appserver/`), in
 * every venue: local and hosted Playground, evals and swarms.
 *
 * It replaced the published `@ai-sdk/harness-codex` adapter, which drove
 * `codex exec`: that bridge built its thread with `approvalPolicy: "never"` and
 * `danger-full-access` hardcoded and refused every permission mode but
 * `allow-all`, so a Codex host could never pause for approval and every
 * approval host was refused. app-server raises real
 * `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`
 * requests under `untrusted`, verified against the pinned binary — a denied
 * command reports `declined` and does not run — and reports typed items for
 * shell, patches and web search, so the trace shows what actually happened.
 *
 * MCP delivery is HOST-EXECUTED, in both venues: every MCP call is relayed back
 * to this process and runs on its own manager, under the tool policy and the
 * framework's `toolApproval`, wherever the Codex process itself runs. Codex
 * 0.149.1 does raise its own approval for an MCP `tools/call` (an
 * `mcp_tool_call` elicitation, PROBES.md (d)), but the relay is rendered with
 * `default_tools_approval_mode = "approve"` so MCPJam's gate is the single
 * authority instead of a second prompt nobody answers. Native delivery stays a
 * follow-up: it would move enforcement into a process MCPJam does not own.
 */
const codexAdapter: HarnessRuntimeAdapter = {
  id: "codex",
  // Folded into the runtime fingerprint, so a lane saved under the retired
  // exec transport forks (with a visible "runtime-changed" reset) instead of
  // resuming onto a different protocol.
  transport: "app-server",
  displayName: "Codex",
  supportedReasoningEfforts: HARNESS_REASONING_EFFORTS["codex"],
  requiresComputer: true,
  // Brokered, same as Claude Code — an OpenAI-protocol lease instead of an
  // Anthropic one.
  modelAccess: "broker",
  // Hosted: `never` + `danger-full-access`, the disposable box being the
  // boundary. Locally the bridge refuses `allow-all` without an explicit
  // workspace-write sandbox policy, so it never becomes full access there.
  defaultPermissionMode: "allow-all",
  liveApprovalRuntime: true,
  // `turn/start.sandboxPolicy`; the bridge refuses `allow-all` without it
  // whenever it is supervised locally.
  acceptsSandboxPolicy: true,
  // The pause is real. `HarnessAgent` also refuses to construct with a
  // non-allow-all mode unless the underlying harness declares
  // `supportsBuiltinToolApprovals`, which `createCodexAppServer` does.
  supportsNativeToolApproval: true,
  // "allow-reads" for the same reason as Claude Code and Cursor: it is the
  // narrowest framework mode that pauses on side-effecting work. The bridge
  // maps it to Codex's `untrusted` policy, which on 0.149.1 asks about EVERY
  // command — reads included — and every file change (PROBES.md (c)). So an
  // approval-gated Codex host prompts more than a Claude Code one; nothing
  // here may claim reads run without a prompt.
  approvalPermissionMode: "allow-reads",
  // MCPJam's tools run in MCPJam's process and the framework gates them there,
  // before `execute`, through `HarnessAgent`'s `toolApproval` map. This is the
  // flag `harnessToolApprovalRefusalReason` reads for Codex, because Codex's
  // MCP delivery is host-executed.
  supportsHostExecutedToolApproval: true,
  // False because MCP delivery is host-executed: MCPJam's own gate applies to
  // relayed calls (above), and codex's MCP approval is configured off for the
  // relay. Only relevant if MCP delivery ever becomes native.
  supportsMcpToolApproval: false,
  // COMP-39: MCPJam projects each selected server's tools into HOST-EXECUTED
  // AI SDK tools; the bridge relays the invocations back out and MCPJam runs
  // them in-process. See `HarnessMcpDelivery` and `host-executed-mcp-tools.ts`.
  // Read from the shared declaration — the client's Behavior tab derives from
  // the same value, so "MCPJam builds these tools, so the host's construction
  // knobs apply" is stated once for both sides.
  mcpDelivery: HARNESS_MCP_DELIVERY.codex,
  // INS-8: skills ARE delivered. The adapter writes every `skills` entry to
  // `$HOME/.agents/skills/<name>/SKILL.md` before it starts Codex, the same
  // root the retired exec transport used.
  supportsSkills: true,
  skillsBaseDir: CODEX_SKILLS_BASE,
  skillsWriteOptions: { trailingNewline: false },
  prepareSkills: prepareCodexSkills,
  // Codex has no plugin-install interface — MCPJam still projects a plugin's
  // components (skills param, host-executed MCP tools), which is not the same
  // contract as a native bundle install.
  supportsPluginBundles: false,
  // The bridge emits patches as a real `tool-call`/`tool-result` pair (an
  // approval must attach to a tool call, and a `file-change` part has no
  // toolCallId), so the turn runner's synthetic file-change tool naming is not
  // wanted here.
  fileChangeToolName: undefined,
  listBuiltinTools: memoizedBuiltinTools(() => createCodexAppServer()),
  toNativeModel: toCodexModel,
  // Codex only runs the gpt-5 family, and at the pinned 0.149.x not the
  // tool-less gpt-5.6 line; anything else would silently fall back to Codex's
  // default model (or run without tools), so the preflight rejects it.
  pinnedRuntimeVersion: harnessPinnedVersion("codex"),
  modelSupport: modelSupportFor("codex"),
  supportsModel: supportsModelFor("codex"),
  // SAME scheme as Claude Code, deliberately: the projected host tools are named
  // `mcp__<sanitizedServer>__<tool>` (see `host-executed-mcp-tools.ts`), so a
  // relayed call attributes back to its serverId exactly as a native Claude Code
  // call does — eval assertions and trace spans written against a Claude Code
  // run match a Codex run tool-for-tool. Codex's own natives arrive as common
  // names (`bash`, `read`, …), which have no prefix and pass through unchanged.
  parseToolName: parseHarnessToolName,
  createHarness({ modelId, auth, sandboxPolicy, reasoningEffort }) {
    const nativeModel = toCodexModel(modelId);
    return createCodexAppServer({
      ...(nativeModel ? { model: nativeModel } : {}),
      // Forwarded on the bridge `start` message, which sends it as
      // `turn/start` `effort`.
      ...(reasoningEffort ? { reasoningEffort } : {}),
      auth,
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
    }) as unknown as HarnessAgentAdapter;
  },
};

const cursorAdapter: HarnessRuntimeAdapter = {
  id: "cursor",
  // "Cursor CLI", not "Cursor" — the emulated `cursor` host style (the IDE's
  // chat panel) keeps that name, and the two are different products with
  // different surfaces. Every preflight/refusal message a user reads comes from
  // here, so the distinction has to be in the name itself.
  displayName: "Cursor CLI",
  // Nothing verified yet: an effort on this harness is refused, not dropped.
  supportedReasoningEfforts: HARNESS_REASONING_EFFORTS["cursor"],
  requiresComputer: true,
  // NO BROKER. cursor-agent has no provider or gateway routing at all: it
  // authenticates with a `CURSOR_API_KEY` (the adapter's own `credentialEnv`
  // says so), every model request transits Cursor's servers, and the spend
  // lands on that Cursor account. There is no seam for MCPJam to mint a lease
  // at, so the turn skips the broker start entirely and `buildBrokerDummyAuth`
  // throws if anything asks it for one.
  modelAccess: "external-account",
  // The name the CLI itself reads — `@ai-sdk/harness-cursor` declares exactly
  // this as its `credentialEnv`. Delivered as a PROJECT SECRET: one key per
  // environment, set once by an admin under Project Settings → Secrets.
  // Missing ⇒ the turn is refused up front with copy that says so, never
  // defaulted.
  externalAccountCredentialEnv: ["CURSOR_API_KEY"],
  // …and it can be BROKERED, which is the preferred delivery and the only
  // one hosted evals and swarms accept at all (they refuse an environment that
  // selects materialized secrets — `evalSandboxes.ts`'s
  // `materialized_secrets_unsupported`, `journeyRuns.ts`'s
  // `ENV_MATERIALIZED_SECRETS_UNSUPPORTED` — because only the chat path
  // resolves and injects a materialized value, so on a runner-claimed attempt
  // it would be silently absent).
  //
  // The triple is READ OFF THE ADAPTER, not invented: `@ai-sdk/harness-cursor`
  // declares its own `credentialBrokering` against
  // `POST https://api2.cursor.sh/auth/exchange_user_api_key` carrying
  // `Authorization: Bearer <CURSOR_API_KEY>`. MCPJam's egress transform is
  // host-scoped rather than path-scoped, so brokering the host covers that
  // exchange and any sibling call that authenticates the same way.
  externalAccountBrokerBinding: {
    CURSOR_API_KEY: {
      hosts: ["api2.cursor.sh"],
      // LOWERCASE: `validateBrokerBinding` canonicalizes stored rows that way,
      // so this is what a saved secret compares equal to.
      header: "authorization",
      template: "Bearer {}",
    },
  },
  defaultPermissionMode: "allow-all",
  // The ACP bridge routes every tool call through `session/request_permission`
  // and emits `tool-approval-request` for anything it does not auto-approve,
  // then resumes on the host's decision — the same pause/resume contract Claude
  // Code offers. Verified on a live cursor-agent during the harness spike.
  supportsNativeToolApproval: true,
  // "allow-reads" for the same reason as Claude Code, though by a different
  // mechanism. The bridge's `shouldAutoApprove(permissionMode, kind)` lets a
  // call through when the mode is "allow-all", when the ACP tool KIND is one of
  // read/search/think/fetch, or — under "allow-edits" only — edit/delete/move.
  // So "allow-reads" is the narrowest mode that still pauses on execute-class
  // work while leaving reads free: the faithful mapping to the emulated engine,
  // which gates tool CALLS and never reads.
  approvalPermissionMode: "allow-reads",
  // FALSE pending a live measurement, and deliberately not inferred.
  //
  // The mechanism is clearly there — an MCP call reaches the same
  // `requestPermission` path as a native one, and the bridge's
  // `claimHostToolPermission` short-circuit covers only HarnessAgent's OWN tool
  // channel, not the host's servers. What is NOT established is the one fact
  // that decides the answer: which ACP `toolCall.kind` cursor-agent reports for
  // an MCP tool. `other`/`execute` would pause under "allow-reads"; a kind of
  // read/search/fetch/think would be auto-approved and the call would run with
  // no prompt at all.
  //
  // Claiming `true` on the strength of the mechanism would mean a host that
  // explicitly asked for approval could silently execute MCP tools unapproved —
  // the one failure this flag exists to prevent. At `false`, such a host is
  // refused at preflight with a message that says why
  // (`harnessToolApprovalRefusalReason`), and approval-free Cursor hosts are
  // unaffected. Flip this to `true` — a one-line change — once a live run with
  // `requireToolApproval` and a selected MCP server is observed pausing on the
  // MCP call.
  supportsMcpToolApproval: false,
  // Not wired or tested for this adapter; same posture as Codex.
  supportsHostExecutedToolApproval: false,
  // NATIVE: the CLI's own MCP client dials MCPJam's signed per-server proxy, so
  // every `tools/call` crosses the seam where firsthand evidence is captured.
  // Read from the shared declaration, which the client's Behavior tab derives
  // its promises from too.
  mcpDelivery: HARNESS_MCP_DELIVERY.cursor,
  // …but via the ACP `session/new` config rather than a file in the box: the
  // servers are a CONSTRUCTOR setting (see createHarness). Same mode, different
  // mechanism — which is exactly the distinction this field carries.
  mcpNativeDelivery: "session-config",
  // OFF for v1. ACP supports skills (`DEFAULT_ACP_SKILLS_DIRECTORY`), so this
  // is a scope decision rather than a capability wall: shipping skills means
  // owning the same delivery/reconcile/adopt passes the other two adapters
  // have, plus a parity test against the real adapter. Tracked as a follow-up.
  supportsSkills: false,
  // Dormant while the flag above is false; see CURSOR_SKILLS_BASE.
  skillsBaseDir: CURSOR_SKILLS_BASE,
  skillsWriteOptions: { trailingNewline: false },
  // Never called (`runHarnessTurn` guards on supportsSkills), and honest if the
  // guard ever moves: nothing delivered, every skill reported skipped.
  prepareSkills: prepareNoSkills,
  supportsPluginBundles: false,
  // Cursor does not emit file-change stream parts.
  fileChangeToolName: undefined,
  // The ACP wrapper carries a static builtin catalog (31 tools), so the generic
  // `/v1/harness/:id/builtin-tools` route works with no per-harness edits.
  listBuiltinTools: memoizedBuiltinTools(() => createCursor()),
  // AUTO. The adapter passes no model, so Cursor picks — which is the only
  // honest thing to do while MCPJam has no view of the account's entitlements
  // (a plan-gated model does not error; it answers "Upgrade your plan to
  // continue" in a normal end_turn, which the turn runner detects separately).
  toNativeModel: () => undefined,
  // Never consulted by the gates: `runHarnessTurn` and the preflight skip every
  // model gate for an external-account harness, because the model MCPJam knows
  // about is not the model that runs (the sentinel rule replaces them). Read
  // from the same table anyway — it says `cursor/auto` only — so a picker that
  // asks gets the same answer. The CLI version is not pinned (see
  // `runtimeVersionCommand`), and every Cursor row is version-independent.
  pinnedRuntimeVersion: harnessPinnedVersion("cursor"),
  modelSupport: modelSupportFor("cursor"),
  supportsModel: supportsModelFor("cursor"),
  // Name-only attribution, for the result parts that arrive without an input.
  // Cursor's stream name is an opaque `acp_tool_<id>`, so this can only ever
  // return it verbatim with no serverId — which is the correct answer for a
  // name that carries no identity. The real work is in attributeToolCall.
  parseToolName: parseHarnessToolName,
  // The identity lives in the INPUT (`{ providerIdentifier, toolName, args }`
  // — the adapter's own `isMcpToolCall` predicate keys off exactly those three
  // fields), so this hook is what makes Cursor MCP calls attributable at all.
  attributeToolCall: attributeCursorToolCall,
  // The installed CLI is whatever `curl https://cursor.com/install | bash`
  // fetched at bootstrap — the adapter pins its own version but NOT the CLI's,
  // and two observed builds are four months of behaviour apart. Recording the
  // version per session is what makes a silent upstream change attributable
  // instead of a mystery regression.
  runtimeVersionCommand: (sessionWorkDir) =>
    // Layout taken from the adapter's own bootstrap: `bootstrapDir` is
    // `.harness-bootstrap/<harnessId>` under the session workdir, and
    // `implementation.json` puts the executable at
    // `implementation/home/.local/bin/agent` (privateHome: true).
    //
    // SINGLE-quoted with embedded quotes escaped, not double-quoted: the
    // workdir is host-configured, and `$(…)`/backticks inside double quotes
    // are still expanded by the shell. `resolveWorkingDirectory` confines the
    // value to /home/user but does not reject shell metacharacters, so a path
    // like `/home/user/$(id)` would otherwise run `id` during session setup.
    `'${shellSingleQuote(
      sessionWorkDir,
    )}/.harness-bootstrap/cursor/implementation/home/.local/bin/agent' --version`,
  createHarness({ auth, mcpJson }) {
    // Dual-`ai` boundary cast, same as the other two adapters.
    return createCursor({
      // The customer's own CURSOR_API_KEY, as the environment arm of
      // HarnessV1Authentication. Passing an explicit env map (rather than
      // 'auto' / 'ai-gateway' / 'direct') is what stops the adapter reading the
      // SERVER's process env for a credential — and the routing modes would
      // only produce a warning here anyway, since Cursor cannot be re-routed.
      auth,
      // REQUIRED by this arm's signature: `session-config` delivery has no
      // other channel, so a construction that forgot the servers would be a
      // silently tool-less turn. The type makes that unwritable.
      mcpServers: toAcpMcpServers(mcpJson),
    }) as unknown as HarnessAgentAdapter;
  },
};

const HARNESS_ADAPTERS: Record<HarnessId, HarnessRuntimeAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
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

/**
 * Does this harness pay for its own model spend on the CUSTOMER's account with
 * the runtime vendor (`modelAccess: 'external-account'`)?
 *
 * Same non-throwing shape as `harnessSupportsSkills`, and the default matters:
 * an unrecognized id answers `false` — "we cannot say this is customer-billed".
 * The read decides how a turn is BILLED, so the safe direction is MCPJam's own
 * ledger, where an over-recorded turn is reconciled rather than written off as
 * someone else's spend.
 */
export function harnessUsesExternalAccount(id: string): boolean {
  return isHarnessId(id)
    ? HARNESS_ADAPTERS[id].modelAccess === "external-account"
    : false;
}
