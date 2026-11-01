import type { SystemPromptDefault } from "@mcpjam/sdk/host-config/internal";
/**
 * Frontend types + utilities for HostConfig v2.
 *
 * Shareable leaf primitives (`CspDomainSet`, `HostConfigConnectionDefaults`,
 * `HostConfigMcpProfileV1`, `McpProtocolVersion`,
 * `SEP_1865_PERMISSION_FEATURES`, `DEFAULT_TEMPERATURE_V2`,
 * `resolveEffectiveMcpProtocolVersion`) live in
 * `@mcpjam/sdk/host-config/internal` — single source of truth shared with the
 * backend canonicalizer. Re-exported below so the 60+ files importing from
 * `@/lib/client-config-v2` don't churn.
 *
 * Strict aggregate types (`HostConfigInputV2`, `HostConfigDtoV2`,
 * `HostStyleId`) stay client-owned: the editor enforces invariants the
 * storage layer leaves optional (required `serverIds`/`optionalServerIds`/
 * `respectToolVisibility`, structured `ChatUiOverride`, closed
 * `ScenarioHostStyle` union). Single client-side source of truth so all four
 * editors (Project Settings, Scenario Editor/Builder, Eval Suite Settings,
 * Connection Settings) speak one shape.
 */

import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { ScenarioHostStyle } from "@/lib/scenario-client-style";
import { stableStringifyJson } from "@/lib/client-config";
import type { ThemeMode } from "@/types/preferences/theme";
import {
  findHostStyle,
  getCompatRuntimeForStyle,
  OPENAI_APPS_FULL_SURFACE,
} from "@/lib/client-styles";
import {
  resolveHostCapabilities,
  resolveMcpAppsCapabilities,
} from "@/shared/host-style-capabilities";
import type {
  ChatUiOverride,
  EffectiveCompatRuntime,
  McpAppsCapabilities,
  OpenAiAppsCapabilities,
  ResolvedMcpAppsCapabilities,
  ResolvedOpenAiAppsCapabilities,
} from "@/lib/client-styles";
// Single source of truth for the empty host-config builder: the same
// Node-safe function the server `--template` resolver and the CLI use.
import {
  DEFAULT_TEMPLATE_MODEL_ID,
  emptyHostConfigInputV2 as sdkEmptyHostConfigInputV2,
} from "@mcpjam/sdk/host-config/templates";
// Shareable host-config primitives + the portable protocol-version resolver
// live in @mcpjam/sdk/host-config/internal — single source of truth for the
// backend canonicalizer and the inspector client. Re-exported below so the
// 60+ files importing from "@/lib/client-config-v2" don't churn.
import {
  DEFAULT_TEMPERATURE_V2,
  resolveEffectiveMcpProtocolVersion,
  SEP_1865_PERMISSION_FEATURES,
} from "@mcpjam/sdk/host-config/internal";
import type {
  CspDomainSet,
  Harness,
  HostConfigConnectionDefaults,
  HostConfigMcpProfileV1,
  McpToolResultImageRenderPlacement,
  McpToolResultImageRenderingPolicy,
  McpProtocolVersion,
} from "@mcpjam/sdk/host-config/internal";
import type { ModelVisibleMcpToolResults } from "@mcpjam/sdk/host-config";
import {
  selectionConfigKey,
  type LegacyModelSelection,
  type ModelSelection,
} from "@mcpjam/sdk/browser";

export {
  DEFAULT_TEMPERATURE_V2,
  resolveEffectiveMcpProtocolVersion,
  SEP_1865_PERMISSION_FEATURES,
};
export type {
  CspDomainSet,
  HostConfigConnectionDefaults,
  HostConfigMcpProfileV1,
  McpToolResultImageRenderPlacement,
  McpToolResultImageRenderingPolicy,
  McpProtocolVersion,
  ModelVisibleMcpToolResults,
};

export type HostStyleId = ScenarioHostStyle;

/**
 * Computer attached to a host. The resource attachment only; capabilities
 * (e.g. `bash`) ride `builtInToolIds`. Mirrors the SDK's resource shape — the
 * legacy `toolset` key is dropped from the client model (the backend still
 * persists it vestigially while pinned to the published SDK, and strips it on
 * read into this shape).
 *
 * `kind` is a closed union:
 *   - `"personal"` — the per-(project, user) cloud workstation, and the only
 *     kind anything in this app can AUTHOR. Every editor writes this.
 *   - `"ephemeral"` — a per-run box the platform mints at a run-snapshot
 *     boundary (an eval run pins one per iteration, booted from the run's
 *     frozen environment image). READ-ONLY snapshot data: it can appear when
 *     reading a run's pinned config back, and must never be routed through a
 *     host-save flow.
 *
 * The read path deliberately does NOT normalize an unknown kind to
 * `"personal"`. Doing so would let a run's pinned config be read, laundered
 * into a personal attachment, and saved onto a live host — turning a
 * disposable per-run box into a claim on somebody's actual machine.
 */
export type HostConfigComputerKindV2 = "personal" | "ephemeral";

export type HostConfigComputerV2 = {
  kind: HostConfigComputerKindV2;
  /** Optional initial working directory for shell/terminal sessions. Present
   *  only on the personal kind; provisioning supplies an ephemeral box's cwd. */
  workdir?: string;
};

/** True when this attachment is platform-minted and therefore not editable. */
export function isReadOnlyHostComputer(
  computer: HostConfigComputerV2 | undefined,
): boolean {
  return computer !== undefined && computer.kind !== "personal";
}

export type McpToolResultImageRendering = McpToolResultImageRenderingPolicy;

/**
 * Real agent harness for this host. `"claude-code"` / `"codex"` / `"cursor"` run
 * the real CLI runtime (the `@ai-sdk/harness-claude-code` adapter, MCPJam's
 * Codex app-server adapter, or the `@ai-sdk/harness-cursor` adapter) inside the
 * attached personal computer instead of MCPJam's emulated engine. Absent ⇒
 * emulated. The backend enforces `harness ⇒ computer`.
 *
 * ALIASED, not re-listed. This was a hand-copied union that had to be edited
 * in lockstep with `HARNESS_IDS`, and the dangerous direction is narrow drift:
 * the editor would reject a harness the API and the backend validator both
 * accept, which reads as "that host cannot be built" rather than as a stale
 * type. The name stays because 60+ files import it from here.
 */
export type HostConfigHarnessV2 = Harness;

/**
 * Mutable input shape. All fields are required at write time so the editor
 * can't accidentally erase a section.
 *
 * Note: the backend validator (`hostConfigInputV2Validator` in
 * `mcpjam-backend/convex/lib/hostConfigV2.ts`) has been relaxed to make
 * `serverIds`, `optionalServerIds`, and `serverConnectionOverrides`
 * optional as part of the project-scoped server config rollout (Option A:
 * optional + canonicalize → [] before hashing). The inspector type is
 * intentionally kept strict during P1/P2/P3 so the editor draft can't
 * silently drop a section; P4 will loosen this as the iterative-host
 * write path stops sending server fields.
 */
export type HostConfigInputV2 = {
  /** Editor-only metadata, saved on the client rather than its immutable config. */
  localBrowserEnabled?: boolean;
  hostStyle: HostStyleId;
  modelId: string;
  /**
   * The saved selection behind `modelId` (whose credentials run it). Optional;
   * when present its `modelId` equals `modelId` — the SDK canonicalizer and
   * the backend both refuse a disagreeing pair, so writers set or clear the
   * two together. The stored legacy form (a model id outside the hosted
   * catalog, saved without a selection) round-trips unchanged: editors treat
   * it as no selection (`nonLegacySelection`) and never write settings on it.
   */
  modelSelection?: ModelSelection | LegacyModelSelection;
  systemPrompt: string;
  systemPromptDefault?: SystemPromptDefault;
  temperature: number;
  requireToolApproval: boolean;
  /**
   * Host-level switch for SEP-1865 `_meta.ui.visibility` filtering. When
   * `true`, tools whose visibility doesn't include "model" are hidden
   * from the agent's tool list (spec-default). When `false`, every tool
   * flows to the model — faithful to hosts that don't yet honor
   * visibility (e.g. real Cursor today). Defaults to `true` for new
   * configs; Cursor's template explicitly sets it to `false`.
   */
  respectToolVisibility: boolean;
  /**
   * Host-level opt-in for progressive MCP tool discovery
   * (`search_mcp_tools` / `load_mcp_tools` meta-tools instead of sending
   * every tool definition every turn). Optional and undefined-by-default:
   * the chat orchestrator interprets `undefined` as "use the auto policy"
   * (currently: off for hosted unless the env override is set), explicit
   * `true` as "force on", explicit `false` as "force off". Backend hashes
   * the three states distinctly so flipping the toggle mints a fresh
   * hostConfig row.
   */
  progressiveToolDiscovery?: boolean;
  requireNativeToolDiscovery?: boolean;
  /**
   * Host/client policies for which MCP tool-result content/resource shapes are
   * exposed to the model. Optional so untouched hosts use runtime defaults
   * without forcing a new snapshot.
   */
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  /** Human-facing rendering policy for MCP tool-returned images. */
  mcpToolResultImageRendering?: McpToolResultImageRendering;
  serverIds: string[];
  optionalServerIds: string[];
  /**
   * Catalog ids of host-managed built-in tools (e.g. "web_search") attached
   * to this config — a peer dimension to serverIds. Required at write time
   * (defaults to []) so the editor draft can't silently drop the section.
   * Resolved to AI SDK tools server-side via the built-in tool registry and
   * validated against the backend `builtInTools` catalog on save.
   */
  builtInToolIds: string[];
  /**
   * Personal cloud workstation attached to this host (Project Computers).
   * The RESOURCE only — the capabilities the model gets on it (e.g. the
   * `bash` built-in tool) ride `builtInToolIds`, gated by the catalog's
   * `requiresComputer` flag. Absent ⇒ no computer. `{ kind: "personal" }`
   * is the only shape; `workdir` optionally pins the initial shell cwd.
   */
  computer?: HostConfigComputerV2;
  /** Optional saved browser profile selected for hosted browser sessions. */
  browserProfileId?: string;
  /**
   * Real agent harness (see {@link HostConfigHarnessV2}). `"claude-code"` runs
   * the real Claude Code runtime on the attached computer; absent ⇒ MCPJam's
   * emulated engine. Server-authoritative — never sourced from a chat body.
   */
  harness?: HostConfigHarnessV2;
  agentLoop?: HostConfigHarnessV2;
  connectionDefaults: HostConfigConnectionDefaults;
  clientCapabilities: Record<string, unknown>;
  hostContext: Record<string, unknown>;
  /**
   * User override for the MCP Apps `hostCapabilities` blob advertised in the
   * `ui/initialize` response. When undefined, the renderer falls back to the
   * preset declared by the active `hostStyle`. Tracked as an **override** so
   * source is unambiguous: switching host styles must not drag a stale base
   * value along, and "Reset to profile" is a one-line undefined write.
   */
  hostCapabilitiesOverride?: Record<string, unknown>;
  /**
   * User override for the chat-UI chrome (logo, palette, indicator, fonts).
   * Mirrors {@link hostCapabilitiesOverride}: undefined means "inherit from
   * the preset resolved by `hostStyle`"; a partial object replaces only the
   * fields it defines. Lets users bring their own host styling as
   * persisted data without registering a new built-in. Resolution lives in
   * `resolveEffectiveHostStyle` (lib/host-styles/registry.ts).
   */
  chatUiOverride?: ChatUiOverride;
  /**
   * Versioned envelope for host-level MCP state — see
   * {@link HostConfigMcpProfileV1}. Optional; absent means "use SDK
   * defaults / no host-level sandbox override." Must NOT be synthesized as
   * `{ profileVersion: 1 }` when the user hasn't opted in — backend hashes
   * the two states distinctly.
   */
  mcpProfile?: HostConfigMcpProfileV1;
  /**
   * Per-server connection overrides scoped to this host config. Keys are
   * server IDs. When present for a server, these win over host-wide
   * connectionDefaults for that specific server. Included in the canonical
   * hash so hosts that differ only in overrides get distinct rows.
   */
  serverConnectionOverrides?: Record<
    string,
    {
      headersOverride?: Record<string, string>;
      requestTimeoutOverride?: number;
      /**
       * Per-server override of the outbound MCP wire mode. Wins over
       * `mcpProfile.mcpProtocolVersion`. Mirror of the execution-plane field
       * fanned out from `projectServerRefs.mcpProtocolVersionOverride` by
       * `fanOutProjectServerConfigToHosts`.
       */
      mcpProtocolVersionOverride?: McpProtocolVersion;
    }
  >;
};

/**
 * Hydrated DTO returned by v2 read paths. Includes the row id so the editor
 * can detect "no change" vs "modified" and skip unnecessary writes.
 */
export type HostConfigDtoV2 = {
  /** Effective shared local setting (client override or project default). */
  localBrowserEnabled?: boolean;
  id: string;
  schemaVersion: number;
  hostStyle: HostStyleId;
  modelId: string;
  /**
   * Saved selection behind `modelId`; absent on rows saved without one. The
   * backend's stored form: full, or legacy (`{ source: "legacy", modelId }`,
   * no `fallback`, no `settings`) for an id outside the hosted catalog.
   */
  modelSelection?: ModelSelection | LegacyModelSelection;
  systemPrompt: string;
  systemPromptDefault?: SystemPromptDefault;
  temperature: number;
  requireToolApproval: boolean;
  /**
   * See HostConfigInputV2.respectToolVisibility. Optional on the DTO
   * because pre-feature rows persisted without it; `hostConfigDtoToInput`
   * coerces `undefined` to the spec default (`true`).
   */
  respectToolVisibility?: boolean;
  /** Surfaced verbatim — see HostConfigInputV2.progressiveToolDiscovery. */
  progressiveToolDiscovery?: boolean;
  requireNativeToolDiscovery?: boolean;
  /** Surfaced verbatim — see HostConfigInputV2.modelVisibleMcpToolResults. */
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  /** Surfaced verbatim — see HostConfigInputV2.mcpToolResultImageRendering. */
  mcpToolResultImageRendering?: McpToolResultImageRendering;
  serverIds: string[];
  optionalServerIds: string[];
  /**
   * Catalog ids of attached built-in tools. Optional on the DTO because
   * pre-feature rows persisted without it; `hostConfigDtoToInput` coerces
   * `undefined` to [].
   */
  builtInToolIds?: string[];
  /**
   * Personal computer attachment (see HostConfigInputV2.computer). Optional;
   * absent ⇒ no computer. The backend may carry a vestigial `toolset` on the
   * wire — `hostConfigDtoToInput` reads only `kind`/`workdir`.
   */
  computer?: HostConfigComputerV2 & { toolset?: string };
  /** Optional saved browser profile selected for hosted browser sessions. */
  browserProfileId?: string;
  /**
   * Real agent harness (see HostConfigInputV2.harness). Optional; pre-feature
   * rows and non-harness hosts omit it.
   */
  harness?: HostConfigHarnessV2;
  agentLoop?: HostConfigHarnessV2;
  connectionDefaults: HostConfigConnectionDefaults;
  clientCapabilities: Record<string, unknown>;
  hostContext: Record<string, unknown>;
  /** Optional user override (see HostConfigInputV2.hostCapabilitiesOverride). */
  hostCapabilitiesOverride?: Record<string, unknown>;
  /** Optional chat-UI override (see HostConfigInputV2.chatUiOverride). */
  chatUiOverride?: ChatUiOverride;
  /**
   * Optional versioned envelope (see HostConfigInputV2.mcpProfile). Surfaced
   * verbatim — `undefined` means "use SDK defaults"; do NOT substitute a
   * default empty envelope.
   */
  mcpProfile?: HostConfigMcpProfileV1;
  /** Per-server connection overrides hydrated from hostConfigServerRefs. */
  serverConnectionOverrides?: Record<
    string,
    {
      headersOverride?: Record<string, string>;
      requestTimeoutOverride?: number;
      mcpProtocolVersionOverride?: McpProtocolVersion;
    }
  >;
};

export const DEFAULT_HOST_STYLE_V2: HostStyleId = "mcpjam";

// Cheap MCPJam-provided model pinned onto auto-seeded "MCPJam" hosts (the
// host bar / playground backstops for empty projects). Interactive chat
// papers over an unset host model via getDefaultModel's picker fallback,
// but synthetic/swarm runs consume the pinned value directly and fail on
// "" — seeding a real model keeps the default host runnable everywhere.
// Matches the top of getDefaultModel's priority list and the dominant
// template choice. Re-exported from the SDK's default template so the seeded
// host and the "mcpjam" template can't drift; getDefaultModel's list still
// needs to lead with the same id.
export const DEFAULT_SEEDED_HOST_MODEL_ID = DEFAULT_TEMPLATE_MODEL_ID;

// Delegates to the Node-safe SDK builder so the empty-config defaults have a
// single source of truth shared with the server `--template` resolver and the
// CLI. Cast to the strict client aggregate — the runtime object is
// field-identical (guarded by host-template-seed-parity.test.ts).
export const emptyHostConfigInputV2 = sdkEmptyHostConfigInputV2 as unknown as (
  partial?: Partial<HostConfigInputV2>,
) => HostConfigInputV2;

/**
 * Strip a platform-minted computer from a config about to become an EDITABLE
 * draft.
 *
 * `kind: "ephemeral"` names a per-run box the platform provisioned for one
 * eval iteration. It is meaningful only inside that run, and the public write
 * path cannot express it anyway (the backend's exported arg validator is
 * `v.literal('personal')`), so a draft carrying one would be rejected on save
 * at best — and at worst, if it were laundered to `"personal"` first, would
 * turn a disposable box into a claim on the member's own machine.
 *
 * Dropping the attachment rather than converting it is the honest answer: the
 * draft starts with no computer, which the editor already renders as
 * "attach one", instead of silently claiming a box the user never attached.
 */
export function withoutReadOnlyComputer(
  input: HostConfigInputV2,
): HostConfigInputV2 {
  if (!isReadOnlyHostComputer(input.computer)) return input;
  const { computer: _dropped, ...rest } = input;
  return rest as HostConfigInputV2;
}

export function cloneHostTemplateInput(
  value: unknown,
  options: { themeMode?: ThemeMode } = {},
): HostConfigInputV2 {
  const input = deepCloneJsonValue(value) as HostConfigInputV2;
  if (options.themeMode !== undefined) {
    input.hostContext = {
      ...input.hostContext,
      theme: options.themeMode,
    };
  }
  // Every editor draft starts here, so this is the one place a platform-minted
  // computer has to be dropped — see `withoutReadOnlyComputer`.
  return withoutReadOnlyComputer(input);
}

export function hostConfigDtoToInput(dto: HostConfigDtoV2): HostConfigInputV2 {
  // Deep-clone the JSON record fields. clientCapabilities and
  // hostContext can be nested (e.g. the SDK's default capabilities
  // include an `extensions` object with arrays). A shallow spread
  // would leave the inner trees aliased to the source DTO; any nested
  // edit through the returned input would silently mutate the
  // baseline used for resets and dirty comparisons.
  return {
    hostStyle: dto.hostStyle,
    modelId: dto.modelId,
    // Kept only while it still names `modelId` (a disagreeing pair would be
    // refused on save).
    ...(dto.modelSelection?.modelId === dto.modelId
      ? { modelSelection: dto.modelSelection }
      : {}),
    systemPrompt: dto.systemPrompt,
    systemPromptDefault: dto.systemPromptDefault,
    temperature: dto.temperature,
    requireToolApproval: dto.requireToolApproval,
    // DTO carries `undefined` when the persisted row predates this
    // feature; treat that as the spec default (filter app-only tools).
    respectToolVisibility: dto.respectToolVisibility ?? true,
    progressiveToolDiscovery: dto.progressiveToolDiscovery,
    requireNativeToolDiscovery: dto.requireNativeToolDiscovery,
    modelVisibleMcpToolResults: dto.modelVisibleMcpToolResults
      ? cloneModelVisibleMcpToolResults(dto.modelVisibleMcpToolResults)
      : undefined,
    mcpToolResultImageRendering: dto.mcpToolResultImageRendering
      ? cloneMcpToolResultImageRendering(dto.mcpToolResultImageRendering)
      : undefined,
    serverIds: [...dto.serverIds],
    optionalServerIds: [...dto.optionalServerIds],
    builtInToolIds: dto.builtInToolIds ? [...dto.builtInToolIds] : [],
    // Read only the resource shape; the backend may carry a vestigial
    // `toolset` on the wire (legacy key) which the client model omits.
    //
    // `kind` is CARRIED, not rewritten. This used to hardcode `"personal"`,
    // which meant any kind the backend sent came back as a personal
    // attachment — so reading a run's pinned config and saving it would
    // convert a disposable per-run box into a claim on the member's own
    // machine. A non-personal kind is read-only snapshot data
    // (`isReadOnlyHostComputer`); surfaces must not route it through a save.
    computer: dto.computer
      ? {
          kind: dto.computer.kind,
          ...(dto.computer.workdir ? { workdir: dto.computer.workdir } : {}),
        }
      : undefined,
    browserProfileId: dto.browserProfileId,
    // String literal pass-through; absent ⇒ emulated engine.
    harness: dto.harness,
    agentLoop: dto.agentLoop,
    connectionDefaults: {
      headers: { ...dto.connectionDefaults.headers },
      requestTimeout: dto.connectionDefaults.requestTimeout,
    },
    clientCapabilities: deepCloneJsonRecord(dto.clientCapabilities),
    hostContext: deepCloneJsonRecord(dto.hostContext),
    hostCapabilitiesOverride: dto.hostCapabilitiesOverride
      ? deepCloneJsonRecord(dto.hostCapabilitiesOverride)
      : undefined,
    chatUiOverride: dto.chatUiOverride
      ? cloneChatUiOverride(dto.chatUiOverride)
      : undefined,
    mcpProfile: dto.mcpProfile ? cloneMcpProfile(dto.mcpProfile) : undefined,
    serverConnectionOverrides: dto.serverConnectionOverrides
      ? Object.fromEntries(
          Object.entries(dto.serverConnectionOverrides).map(([k, v]) => [
            k,
            {
              ...(v.headersOverride !== undefined
                ? { headersOverride: { ...v.headersOverride } }
                : {}),
              ...(v.requestTimeoutOverride !== undefined
                ? { requestTimeoutOverride: v.requestTimeoutOverride }
                : {}),
              ...(v.mcpProtocolVersionOverride !== undefined
                ? { mcpProtocolVersionOverride: v.mcpProtocolVersionOverride }
                : {}),
            },
          ]),
        )
      : undefined,
  };
}

/** Chat's advertised capabilities; see {@link resolveHostCapabilities}. */
export function resolveEffectiveHostCapabilities(args: {
  hostStyle: HostStyleId | null | undefined;
  profile?: HostConfigMcpProfileV1;
  hostCapabilitiesOverride?: Record<string, unknown>;
}): Omit<McpUiHostCapabilities, "sandbox"> {
  return resolveHostCapabilities(args, findRegisteredStyleCapabilities);
}

/**
 * Resolve the `clientInfo` the SDK should send in MCP `initialize` for a
 * given host config. Returns `undefined` when the profile is unset — that
 * sentinel signals the SDK to fall back to its hardcoded inspector
 * defaults. Centralized here so the "undefined means SDK default" contract
 * stays one-grep-able.
 */
export function resolveClientInfo(
  profile: HostConfigMcpProfileV1 | undefined,
): Record<string, unknown> | undefined {
  return profile?.initialize?.clientInfo;
}

/**
 * Resolve the supported protocol versions array for a given host config.
 * First entry is what the SDK should propose in
 * `initialize.params.protocolVersion`; the full set is the accept-list.
 * `undefined` means "use SDK defaults"; an empty array would propose no
 * version and is rejected by the backend canonicalizer at write time so
 * callers never see it here.
 */
export function resolveSupportedProtocolVersions(
  profile: HostConfigMcpProfileV1 | undefined,
): string[] | undefined {
  return profile?.initialize?.supportedProtocolVersions;
}

/**
 * Resolve the `hostInfo` advertised in the MCP Apps `ui/initialize`
 * response. `undefined` means "use the renderer's built-in default
 * (mcpjam-inspector + __APP_VERSION__)" — preserves the historic value
 * for hosts that haven't opted into the override.
 *
 * Sibling of {@link resolveClientInfo}: same shape, different protocol
 * layer (base-protocol `initialize` vs. MCP Apps `ui/initialize`).
 */
export function resolveHostInfo(
  profile: HostConfigMcpProfileV1 | undefined,
): Record<string, unknown> | undefined {
  return profile?.apps?.uiInitialize?.hostInfo;
}

/**
 * Resolve the effective compat-runtime state for a host config. Returns a
 * sum type so consumers can't accidentally read per-method capabilities
 * when the shim isn't being injected.
 *
 * Resolution order:
 *   1. `compatRuntime.openaiApps === false` → `{ injected: false }`
 *      (per-method overrides ignored — injection is off).
 *   2. `compatRuntime.openaiApps === true` → injected; capabilities =
 *      preset's per-method baseline (or the full surface if the preset
 *      doesn't specify), with `openaiAppsOverrides` merged on top.
 *   3. `compatRuntime.openaiApps === undefined` → fall back to the host
 *      style preset's injection decision; if the preset injects, merge
 *      `openaiAppsOverrides` on top of its per-method baseline.
 *
 * Mirror of {@link resolveEffectiveHostCapabilities}: presets live in
 * the host style registry, overrides live on the persisted profile,
 * and the resolver decides per call. Consumers (renderer, modal,
 * server routes) pass the resolved value across the wire so the
 * decision is made once and travels with the request.
 */
export function resolveEffectiveCompatRuntime(args: {
  profile: HostConfigMcpProfileV1 | undefined;
  hostStyle: ScenarioHostStyle | string | null | undefined;
}): EffectiveCompatRuntime {
  const preset = getCompatRuntimeForStyle(args.hostStyle);
  const override = args.profile?.apps?.compatRuntime;
  const injectOverride = override?.openaiApps;

  // Explicit `false` override short-circuits — injection off, per-method
  // overrides are meaningless without the shim.
  if (injectOverride === false) return { injected: false };

  // Effective injection: explicit override wins; otherwise the preset.
  const injected =
    typeof injectOverride === "boolean" ? injectOverride : preset.injected;
  if (!injected) return { injected: false };

  // Inject path: pick the base per-method surface (preset's, or the full
  // surface if the preset doesn't claim one — happens when a user flips
  // injection on for a host style that defaults to off).
  const baseCapabilities: ResolvedOpenAiAppsCapabilities = preset.injected
    ? preset.capabilities
    : OPENAI_APPS_FULL_SURFACE;

  return {
    injected: true,
    capabilities: mergeOpenAiAppsCapabilities(
      baseCapabilities,
      override?.openaiAppsOverrides,
    ),
  };
}

/**
 * Apply a sparse per-method override on top of a fully-resolved baseline.
 * Each present field in `override` replaces the corresponding baseline
 * field; absent fields pass through. Returns a new object — neither
 * input is mutated.
 *
 * Centralized here (rather than inlined in callers) so canvas summary
 * code, the UI matrix, and the resolver share one merge contract — a
 * UI that displays "what's effective" agrees with the wire payload.
 */
export function mergeOpenAiAppsCapabilities(
  base: ResolvedOpenAiAppsCapabilities,
  override: OpenAiAppsCapabilities | undefined,
): ResolvedOpenAiAppsCapabilities {
  if (!override) return base;
  return {
    callTool: override.callTool ?? base.callTool,
    sendFollowUpMessage:
      override.sendFollowUpMessage ?? base.sendFollowUpMessage,
    setWidgetState: override.setWidgetState ?? base.setWidgetState,
    requestDisplayMode: override.requestDisplayMode ?? base.requestDisplayMode,
    notifyIntrinsicHeight:
      override.notifyIntrinsicHeight ?? base.notifyIntrinsicHeight,
    openExternal: override.openExternal ?? base.openExternal,
    setOpenInAppUrl: override.setOpenInAppUrl ?? base.setOpenInAppUrl,
    requestModal: override.requestModal ?? base.requestModal,
    uploadFile: override.uploadFile ?? base.uploadFile,
    selectFiles: override.selectFiles ?? base.selectFiles,
    getFileDownloadUrl: override.getFileDownloadUrl ?? base.getFileDownloadUrl,
    requestCheckout: override.requestCheckout ?? base.requestCheckout,
    requestClose: override.requestClose ?? base.requestClose,
  };
}


export { mergeMcpAppsCapabilities } from "@/shared/host-style-capabilities";

/** Chat's MCP Apps matrix; see {@link resolveMcpAppsCapabilities}. */
export function resolveEffectiveMcpAppsCapabilities(args: {
  profile: HostConfigMcpProfileV1 | undefined;
  hostStyle: ScenarioHostStyle | string | null | undefined;
}): ResolvedMcpAppsCapabilities {
  return resolveMcpAppsCapabilities(args, findRegisteredStyleCapabilities);
}

/** Chat resolves against the client registry, which tests can extend. */
function findRegisteredStyleCapabilities(hostStyle: string | null | undefined) {
  return findHostStyle(hostStyle)?.mcp;
}

/**
 * Convert a legacy {@link HostConfigInputV2.hostCapabilitiesOverride}
 * raw blob into the sparse {@link McpAppsCapabilities} matrix shape used
 * by the new resolver. One-way: feed this at load time when the new
 * field is absent and the legacy field exists, persist the result on
 * next save, then leave the legacy field alone (precedence rule:
 * `mcpAppsOverrides` wins if both are present).
 *
 * Maps every M365-grain advertise key — including `openLinks` and
 * `serverTools` so legacy `hostCapabilitiesOverride: {}` ("advertise
 * nothing") survives migration losslessly. Sub-field detail like
 * `serverTools.listChanged: false` is preserved by the per-host preset
 * augment (`hostCapabilitiesAugment`), so a legacy override carrying
 * that detail still resolves to the right wire shape after migration.
 *
 * NB: a legacy override that declares only a subset (e.g.
 * `{ openLinks: {} }`) implies the user wanted exactly that subset, so
 * non-mentioned keys are explicitly `false`. Mirrors the old
 * resolver's strip-then-return semantics in
 * `resolveEffectiveHostCapabilities`.
 */
export function hostCapabilitiesOverrideToMatrix(
  legacy: Record<string, unknown> | undefined,
): McpAppsCapabilities | undefined {
  if (legacy === undefined) return undefined;
  return {
    openLinks: legacy.openLinks !== undefined,
    serverTools: legacy.serverTools !== undefined,
    serverResources: legacy.serverResources !== undefined,
    logging: legacy.logging !== undefined,
    updateModelContext: legacy.updateModelContext !== undefined,
    message: legacy.message !== undefined,
    downloadFile: legacy.downloadFile !== undefined,
  };
}

/**
 * Set/clear the sparse MCP Apps capability override matrix on a host draft.
 * Preserves sibling `mcpProfile.apps` fields and collapses an otherwise empty
 * profile back to `undefined`, matching the JSON editor's draft cleanup.
 */
/**
 * True when an `mcpProfile` carries nothing worth persisting, so a write
 * collapses it to `undefined` and an untouched host keeps its canonical hash
 * (host configs are content-addressed, so a spurious profile mints a row).
 *
 * ONE definition for every write path — the host editor's three sites and the
 * apps-override clear below. It used to be inlined at each, which meant every
 * new profile field had to be added in four places; miss one and a profile
 * carrying only that field silently collapses, losing the user's setting on
 * save with no error.
 *
 * `initialize` counts as carrying nothing unless it actually holds a
 * `clientInfo` or a non-empty `supportedProtocolVersions`: an empty envelope
 * is dropped by the canonicalizer anyway, so treating it as content would
 * persist a profile that hashes identically to no profile at all.
 */
export function isMcpProfileEmpty(profile: HostConfigMcpProfileV1): boolean {
  const hasInitialize =
    profile.initialize !== undefined &&
    (profile.initialize.clientInfo !== undefined ||
      (profile.initialize.supportedProtocolVersions !== undefined &&
        profile.initialize.supportedProtocolVersions.length > 0));
  return (
    !hasInitialize &&
    profile.mcpProtocolVersion === undefined &&
    profile.toolParamHeaderMirroring === undefined &&
    profile.paginationTraversal === undefined &&
    profile.mrtrSupport === undefined &&
    // A record, so emptiness is per-leaf: `{}` carries nothing (the
    // canonicalizer drops it), but any boolean leaf is a real setting.
    (profile.toolListChanged === undefined ||
      Object.values(profile.toolListChanged).every(
        (value) => value === undefined,
      )) &&
    // Same per-leaf emptiness as `toolListChanged`. Omitting this collapsed
    // the whole profile the moment cancellation was the ONLY thing set, so
    // turning an era off silently wrote nothing.
    (profile.toolCallCancellation === undefined ||
      Object.values(profile.toolCallCancellation).every(
        (value) => value === undefined,
      )) &&
    !profile.apps &&
    !profile.extensions
  );
}

export function setMcpAppsOverridesOnDraft(
  prev: HostConfigInputV2,
  next: McpAppsCapabilities | undefined,
): HostConfigInputV2 {
  const hasKeys = next !== undefined && Object.keys(next).length > 0;
  const prevProfile = prev.mcpProfile;
  const prevApps = prevProfile?.apps ?? {};

  const nextApps: NonNullable<HostConfigMcpProfileV1["apps"]> = {};
  for (const [key, value] of Object.entries(prevApps)) {
    if (key === "mcpAppsOverrides") continue;
    if (value !== undefined) {
      (nextApps as Record<string, unknown>)[key] = value;
    }
  }
  if (hasKeys) nextApps.mcpAppsOverrides = next;
  const appsEmpty = Object.keys(nextApps).length === 0;

  if (prevProfile === undefined && appsEmpty) {
    return prev;
  }

  const baseProfile: HostConfigMcpProfileV1 = prevProfile ?? {
    profileVersion: 1,
  };
  // Evaluate emptiness on the profile this write actually produces — the
  // apps envelope has already been cleared when `appsEmpty`.
  const nextProfile: HostConfigMcpProfileV1 = {
    ...baseProfile,
    apps: appsEmpty ? undefined : nextApps,
  };

  return {
    ...prev,
    mcpProfile: isMcpProfileEmpty(nextProfile) ? undefined : nextProfile,
  };
}

/**
 * Deep-clone an mcpProfile so editor mutations can't alias the source.
 * Goes through deepCloneJsonValue, but preserves the
 * `HostConfigMcpProfileV1` type at the boundary.
 */
function cloneMcpProfile(
  profile: HostConfigMcpProfileV1,
): HostConfigMcpProfileV1 {
  return deepCloneJsonValue(profile) as HostConfigMcpProfileV1;
}

/**
 * Deep-clone a `ChatUiOverride` so the returned config can be mutated
 * freely without aliasing the input. Same JSON-only round-trip as
 * `cloneMcpProfile` — ChatUiOverride is JSON-serializable by design (no
 * functions, no React component refs).
 */
function cloneChatUiOverride(override: ChatUiOverride): ChatUiOverride {
  return deepCloneJsonValue(override) as ChatUiOverride;
}

function deepCloneJsonRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return deepCloneJsonValue(value) as Record<string, unknown>;
}

function deepCloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepCloneJsonValue);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepCloneJsonValue(v);
    }
    return out;
  }
  return value;
}

export function cloneModelVisibleMcpToolResults(
  value: ModelVisibleMcpToolResults,
): ModelVisibleMcpToolResults {
  return deepCloneJsonValue(value) as ModelVisibleMcpToolResults;
}

export function cloneMcpToolResultImageRendering(
  value: McpToolResultImageRenderingPolicy,
): McpToolResultImageRenderingPolicy {
  return deepCloneJsonValue(value) as McpToolResultImageRenderingPolicy;
}

export function isMcpDirectContentImageVisible(
  policy: ModelVisibleMcpToolResults | undefined,
): boolean {
  return policy?.directContent?.image ?? true;
}

export function isMcpEmbeddedResourceBlobImageVisible(
  policy: ModelVisibleMcpToolResults | undefined,
): boolean {
  return (
    (policy?.embeddedResources?.blob?.enabled ?? true) &&
    (policy?.embeddedResources?.blob?.image ?? true)
  );
}

export function isMcpLinkedResourceBlobImageVisible(
  policy: ModelVisibleMcpToolResults | undefined,
): boolean {
  return (
    (policy?.linkedResources?.blob?.enabled ?? true) &&
    (policy?.linkedResources?.blob?.image ?? true)
  );
}

export function setMcpDirectContentImageVisible(
  policy: ModelVisibleMcpToolResults | undefined,
  visible: boolean,
): ModelVisibleMcpToolResults {
  return {
    ...policy,
    directContent: {
      ...policy?.directContent,
      image: visible,
    },
  };
}

export function setMcpEmbeddedResourceBlobImageVisible(
  policy: ModelVisibleMcpToolResults | undefined,
  visible: boolean,
): ModelVisibleMcpToolResults {
  return {
    ...policy,
    embeddedResources: {
      ...policy?.embeddedResources,
      blob: {
        ...policy?.embeddedResources?.blob,
        image: visible,
      },
    },
  };
}

export function setMcpLinkedResourceBlobImageVisible(
  policy: ModelVisibleMcpToolResults | undefined,
  visible: boolean,
): ModelVisibleMcpToolResults {
  return {
    ...policy,
    linkedResources: {
      ...policy?.linkedResources,
      blob: {
        ...policy?.linkedResources?.blob,
        image: visible,
      },
    },
  };
}

export function getMcpToolResultImageRenderPlacement(
  policy: McpToolResultImageRenderingPolicy | undefined,
): McpToolResultImageRenderPlacement {
  return policy?.placement ?? "inline";
}

export function isMcpDirectContentImageRendered(
  policy: McpToolResultImageRenderingPolicy | undefined,
): boolean {
  return policy?.directContent?.image ?? true;
}

export function isMcpEmbeddedResourceBlobImageRendered(
  policy: McpToolResultImageRenderingPolicy | undefined,
): boolean {
  return policy?.embeddedResources?.blob?.image ?? true;
}

export function isMcpLinkedResourceBlobImageRendered(
  policy: McpToolResultImageRenderingPolicy | undefined,
): boolean {
  return policy?.linkedResources?.blob?.image ?? true;
}

export function setMcpToolResultImageRenderPlacement(
  policy: McpToolResultImageRenderingPolicy | undefined,
  placement: McpToolResultImageRenderPlacement,
): McpToolResultImageRenderingPolicy {
  return {
    ...policy,
    placement,
  };
}

export function setMcpDirectContentImageRendered(
  policy: McpToolResultImageRenderingPolicy | undefined,
  rendered: boolean,
): McpToolResultImageRenderingPolicy {
  return {
    ...policy,
    directContent: {
      ...policy?.directContent,
      image: rendered,
    },
  };
}

export function setMcpEmbeddedResourceBlobImageRendered(
  policy: McpToolResultImageRenderingPolicy | undefined,
  rendered: boolean,
): McpToolResultImageRenderingPolicy {
  return {
    ...policy,
    embeddedResources: {
      ...policy?.embeddedResources,
      blob: {
        ...policy?.embeddedResources?.blob,
        image: rendered,
      },
    },
  };
}

export function setMcpLinkedResourceBlobImageRendered(
  policy: McpToolResultImageRenderingPolicy | undefined,
  rendered: boolean,
): McpToolResultImageRenderingPolicy {
  return {
    ...policy,
    linkedResources: {
      ...policy?.linkedResources,
      blob: {
        ...policy?.linkedResources?.blob,
        image: rendered,
      },
    },
  };
}

export function gateMcpToolResultImageRenderingByModelVisibility(
  renderingPolicy: McpToolResultImageRenderingPolicy | undefined,
  modelVisiblePolicy: ModelVisibleMcpToolResults | undefined,
): McpToolResultImageRenderingPolicy | undefined {
  const directVisible = isMcpDirectContentImageVisible(modelVisiblePolicy);
  const embeddedVisible =
    isMcpEmbeddedResourceBlobImageVisible(modelVisiblePolicy);
  const linkedVisible = isMcpLinkedResourceBlobImageVisible(modelVisiblePolicy);

  if (directVisible && embeddedVisible && linkedVisible) {
    return renderingPolicy;
  }

  let next = renderingPolicy;
  if (!directVisible) {
    next = setMcpDirectContentImageRendered(next, false);
  }
  if (!embeddedVisible) {
    next = setMcpEmbeddedResourceBlobImageRendered(next, false);
  }
  if (!linkedVisible) {
    next = setMcpLinkedResourceBlobImageRendered(next, false);
  }
  return next;
}

/**
 * Equality on the canonical fields (ignoring `id` and any extra
 * metadata). Used by editors to detect "no changes" before submitting.
 *
 * Headers/clientCapabilities/hostContext are compared as JSON-serialized
 * deep trees (key order normalized via sorting). This is intentional: they
 * may legitimately be nested objects, and reference equality would always
 * be false after `hostConfigDtoToInput` clones them.
 */
export function hostConfigInputsEqual(
  a: HostConfigInputV2,
  b: HostConfigInputV2,
): boolean {
  if (a.hostStyle !== b.hostStyle) return false;
  if (a.modelId !== b.modelId) return false;
  // `selectionConfigKey`, not `selectionKey`: the row key ignores settings, so
  // an effort-only (or temperature-only) edit would read as "unchanged" and
  // leave Save disabled.
  if (
    (a.modelSelection ? selectionConfigKey(a.modelSelection) : "") !==
    (b.modelSelection ? selectionConfigKey(b.modelSelection) : "")
  )
    return false;
  if (a.systemPrompt !== b.systemPrompt) return false;
  if (a.temperature !== b.temperature) return false;
  if (a.requireToolApproval !== b.requireToolApproval) return false;
  if (a.respectToolVisibility !== b.respectToolVisibility) return false;
  // Optional boolean: undefined / true / false are three distinct states
  // (backend hashes them distinctly). A strict !== covers all three since
  // we never coerce undefined to false elsewhere in the input pipeline.
  if (a.progressiveToolDiscovery !== b.progressiveToolDiscovery) return false;
  if (a.requireNativeToolDiscovery !== b.requireNativeToolDiscovery) return false;
  if (
    !optionalModelVisibleMcpToolResultsEq(
      a.modelVisibleMcpToolResults,
      b.modelVisibleMcpToolResults,
    )
  )
    return false;
  if (
    !optionalMcpToolResultImageRenderingEq(
      a.mcpToolResultImageRendering,
      b.mcpToolResultImageRendering,
    )
  ) {
    return false;
  }
  if (!stringArrayEq(a.serverIds, b.serverIds)) return false;
  if (!stringArrayEq(a.optionalServerIds, b.optionalServerIds)) return false;
  // Order-insensitive, same semantics as server ids — toggling a built-in
  // marks the draft dirty in the host/project/eval editors.
  if (!stringArrayEq(a.builtInToolIds, b.builtInToolIds)) return false;
  if (a.localBrowserEnabled !== b.localBrowserEnabled) return false;
  // Computer: presence, KIND and workdir. Attaching/detaching or changing the
  // workdir marks the draft dirty. `kind` is compared because it is no longer
  // always 'personal' — a run's pinned config can carry the platform-minted
  // 'ephemeral' kind, and without this a personal and an ephemeral attachment
  // with the same workdir would compare equal.
  if ((a.computer === undefined) !== (b.computer === undefined)) return false;
  if (a.computer && b.computer) {
    if (a.computer.kind !== b.computer.kind) return false;
    if (a.computer.workdir !== b.computer.workdir) return false;
  }
  if (a.browserProfileId !== b.browserProfileId) return false;
  // Harness selector: undefined vs "claude-code" are distinct states (backend
  // hashes them distinctly). Switching engines marks the draft dirty.
  if (a.harness !== b.harness || a.agentLoop !== b.agentLoop) return false;
  if (
    a.connectionDefaults.requestTimeout !== b.connectionDefaults.requestTimeout
  )
    return false;
  if (!jsonRecordEq(a.connectionDefaults.headers, b.connectionDefaults.headers))
    return false;
  if (!jsonRecordEq(a.clientCapabilities, b.clientCapabilities)) return false;
  if (!jsonRecordEq(a.hostContext, b.hostContext)) return false;
  if (
    !optionalJsonRecordEq(
      a.hostCapabilitiesOverride,
      b.hostCapabilitiesOverride,
    )
  )
    return false;
  if (!optionalChatUiOverrideEq(a.chatUiOverride, b.chatUiOverride))
    return false;
  if (!optionalMcpProfileEq(a.mcpProfile, b.mcpProfile)) return false;
  if (
    !serverConnectionOverridesEqual(
      a.serverConnectionOverrides,
      b.serverConnectionOverrides,
    )
  )
    return false;
  return true;
}

/**
 * Deep equality for serverConnectionOverrides maps. Normalizes empty/undefined
 * entries so `undefined`, `{}`, and an entry with all undefined fields all
 * compare equal (no override).
 */
export function serverConnectionOverridesEqual(
  a: HostConfigInputV2["serverConnectionOverrides"],
  b: HostConfigInputV2["serverConnectionOverrides"],
): boolean {
  const normalize = (
    overrides: HostConfigInputV2["serverConnectionOverrides"],
  ): Record<
    string,
    {
      headersOverride?: Record<string, string>;
      requestTimeoutOverride?: number;
      mcpProtocolVersionOverride?: McpProtocolVersion;
    }
  > => {
    if (!overrides) return {};
    const result: Record<
      string,
      {
        headersOverride?: Record<string, string>;
        requestTimeoutOverride?: number;
        mcpProtocolVersionOverride?: McpProtocolVersion;
      }
    > = {};
    for (const [key, entry] of Object.entries(overrides)) {
      if (!entry) continue;
      const hasHeaders =
        entry.headersOverride !== undefined &&
        Object.keys(entry.headersOverride).length > 0;
      const hasTimeout = entry.requestTimeoutOverride !== undefined;
      const hasWireMode = entry.mcpProtocolVersionOverride !== undefined;
      if (hasHeaders || hasTimeout || hasWireMode) {
        result[key] = {
          ...(hasHeaders ? { headersOverride: entry.headersOverride } : {}),
          ...(hasTimeout
            ? { requestTimeoutOverride: entry.requestTimeoutOverride }
            : {}),
          ...(hasWireMode
            ? { mcpProtocolVersionOverride: entry.mcpProtocolVersionOverride }
            : {}),
        };
      }
    }
    return result;
  };
  return (
    stableStringifyJson(normalize(a)) === stableStringifyJson(normalize(b))
  );
}

function optionalMcpProfileEq(
  a: HostConfigMcpProfileV1 | undefined,
  b: HostConfigMcpProfileV1 | undefined,
): boolean {
  // Same undefined-vs-empty rule as optionalJsonRecordEq: backend hashes
  // `undefined` and `{ profileVersion: 1 }` distinctly, so flipping
  // between them must register as dirty even when no inner field changes.
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  // Compare the whole envelope as a canonicalized JSON tree. mcpProfile is
  // nested (initialize, apps.sandbox.{csp,permissions}, extensions); the
  // shared stableStringifyJson sorts keys at every level so semantically
  // equal envelopes built in different orders compare equal.
  return stableStringifyJson(a) === stableStringifyJson(b);
}

function optionalModelVisibleMcpToolResultsEq(
  a: ModelVisibleMcpToolResults | undefined,
  b: ModelVisibleMcpToolResults | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return stableStringifyJson(a) === stableStringifyJson(b);
}

function optionalMcpToolResultImageRenderingEq(
  a: McpToolResultImageRenderingPolicy | undefined,
  b: McpToolResultImageRenderingPolicy | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return stableStringifyJson(a) === stableStringifyJson(b);
}

function optionalJsonRecordEq(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  // Treat `undefined` (use profile preset) and `{}` (explicit empty override)
  // as distinct values — flipping between them changes the resolved blob and
  // must register as dirty.
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return jsonRecordEq(a, b);
}

/**
 * Equality on optional `ChatUiOverride`. Mirrors `optionalMcpProfileEq` —
 * `undefined` and `{}` are distinct values (one inherits the preset, the
 * other is an explicit empty override) and stable-stringify makes nested
 * objects with reordered keys compare equal.
 */
function optionalChatUiOverrideEq(
  a: ChatUiOverride | undefined,
  b: ChatUiOverride | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return stableStringifyJson(a) === stableStringifyJson(b);
}

function stringArrayEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}

function jsonRecordEq(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  // Use the shared canonicalizer so nested object key order doesn't make
  // semantically equal records compare unequal — e.g.
  // { capabilities: { a: 1, b: 2 } } vs { capabilities: { b: 2, a: 1 } }.
  // Top-level-only sorting (the previous implementation) reported these
  // as different and produced spurious dirty state in editors.
  return stableStringifyJson(a) === stableStringifyJson(b);
}
