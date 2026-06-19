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
 * `ChatboxHostStyle` union). Single client-side source of truth so all four
 * editors (Project Settings, Chatbox Editor/Builder, Eval Suite Settings,
 * Connection Settings) speak one shape.
 */

import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { ChatboxHostStyle } from "@/lib/chatbox-client-style";
import { stableStringifyJson } from "@/lib/client-config";
import {
  buildHostCapabilities,
  findHostStyle,
  getCompatRuntimeForStyle,
  getHostCapabilitiesForStyle,
  MCP_APPS_FULL_SURFACE,
  MCP_APPS_NO_CLAIMS_SURFACE,
  OPENAI_APPS_FULL_SURFACE,
} from "@/lib/client-styles";
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
import { emptyHostConfigInputV2 as sdkEmptyHostConfigInputV2 } from "@mcpjam/sdk/host-config/templates";
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
  HostConfigConnectionDefaults,
  HostConfigMcpProfileV1,
  McpProtocolVersion,
} from "@mcpjam/sdk/host-config/internal";

export {
  DEFAULT_TEMPERATURE_V2,
  resolveEffectiveMcpProtocolVersion,
  SEP_1865_PERMISSION_FEATURES,
};
export type {
  CspDomainSet,
  HostConfigConnectionDefaults,
  HostConfigMcpProfileV1,
  McpProtocolVersion,
};

export type HostStyleId = ChatboxHostStyle;

/**
 * Personal cloud workstation attached to a host (Project Computers). The
 * resource attachment only; capabilities (e.g. `bash`) ride `builtInToolIds`.
 * Mirrors the SDK's resource shape — the legacy `toolset` key is dropped from
 * the client model (the backend still persists it vestigially while pinned to
 * the published SDK, and strips it on read into this shape).
 */
export type HostConfigComputerV2 = {
  kind: "personal";
  /** Optional initial working directory for shell/terminal sessions. */
  workdir?: string;
};

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
  hostStyle: HostStyleId;
  modelId: string;
  systemPrompt: string;
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
  id: string;
  schemaVersion: number;
  hostStyle: HostStyleId;
  modelId: string;
  systemPrompt: string;
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

// Delegates to the Node-safe SDK builder so the empty-config defaults have a
// single source of truth shared with the server `--template` resolver and the
// CLI. Cast to the strict client aggregate — the runtime object is
// field-identical (guarded by host-template-seed-parity.test.ts).
export const emptyHostConfigInputV2 = sdkEmptyHostConfigInputV2 as unknown as (
  partial?: Partial<HostConfigInputV2>,
) => HostConfigInputV2;

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
    systemPrompt: dto.systemPrompt,
    temperature: dto.temperature,
    requireToolApproval: dto.requireToolApproval,
    // DTO carries `undefined` when the persisted row predates this
    // feature; treat that as the spec default (filter app-only tools).
    respectToolVisibility: dto.respectToolVisibility ?? true,
    progressiveToolDiscovery: dto.progressiveToolDiscovery,
    serverIds: [...dto.serverIds],
    optionalServerIds: [...dto.optionalServerIds],
    builtInToolIds: dto.builtInToolIds ? [...dto.builtInToolIds] : [],
    // Read only the resource shape; the backend may carry a vestigial
    // `toolset` on the wire (legacy key) which the client model omits.
    computer: dto.computer
      ? {
          kind: "personal",
          ...(dto.computer.workdir ? { workdir: dto.computer.workdir } : {}),
        }
      : undefined,
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
          ])
        )
      : undefined,
  };
}

/**
 * Resolve the `hostCapabilities` blob the MCP Apps iframe handshake should
 * advertise for a given host config. Precedence:
 *   1. Profile-level `mcpAppsOverrides` matrix (merged with the host style
 *      preset via {@link resolveEffectiveMcpAppsCapabilities} → derived
 *      blob via {@link buildHostCapabilities}).
 *   2. Legacy top-level `hostCapabilitiesOverride` (verbatim, when present
 *      and the new matrix override is absent). Deprecated — migrated to
 *      `mcpAppsOverrides` at profile load via
 *      {@link hostCapabilitiesOverrideToMatrix}; readable for one release
 *      window so old persisted configs don't break.
 *   3. The active host style's preset (matrix-derived).
 *   4. Spec-default "no claims" baseline (handled inside
 *      {@link getHostCapabilitiesForStyle}).
 *
 * **Sandbox is intentionally NOT resolved here.** Per SEP-1865, sandbox
 * CSP/permissions are approved per-UI-resource at runtime and merged into
 * the final blob by the renderer. Profile presets and user overrides cover
 * vendor-trait fields only.
 *
 * **Conformance gap (advertise vs. enforce):** This returns the value the
 * handshake will advertise. Notification/behavior gates that match the
 * matrix land in subsequent PRs (B/C/D in the foundation PR series); the
 * matrix's notification/resource-meta rows are advertised here but not
 * yet enforced in the renderer's request handlers. Use this value as the
 * single source of truth when enforcement ships so advertise and enforce
 * stay in lockstep.
 */
export function resolveEffectiveHostCapabilities(args: {
  hostStyle: HostStyleId | null | undefined;
  /** Versioned profile carrying the new `mcpAppsOverrides` matrix. */
  profile?: HostConfigMcpProfileV1;
  /**
   * Legacy override. Deprecated; pass-through path while configs migrate.
   * If both `profile.apps.mcpAppsOverrides` and this are present, the
   * matrix wins (per the foundation PR's precedence rule).
   */
  hostCapabilitiesOverride?: Record<string, unknown>;
}): Omit<McpUiHostCapabilities, "sandbox"> {
  // 1. New matrix path — wins whenever the profile carries an
  // `mcpAppsOverrides`. Threaded through the renderer, canvas, Apps tab,
  // and saved-view consumers so a persisted matrix actually affects the
  // wire advertisement.
  if (args.profile?.apps?.mcpAppsOverrides !== undefined) {
    const matrix = resolveEffectiveMcpAppsCapabilities({
      profile: args.profile,
      hostStyle: args.hostStyle,
    });
    const augment = findHostStyle(args.hostStyle)?.mcp.hostCapabilitiesAugment;
    return buildHostCapabilities(matrix, augment);
  }
  // 2. Legacy override path — strip-then-return semantics preserved from
  // pre-matrix behavior so configs with `hostCapabilitiesOverride` set but
  // not yet migrated continue to advertise the user's saved value.
  // `!== undefined` (not truthy-check): `{}` is a meaningful override
  // ("advertise nothing") and must take the strip-then-return path, not
  // silently fall through to the preset.
  if (args.hostCapabilitiesOverride !== undefined) {
    // Strip `sandbox` defensively: the JSON editor doesn't prevent users
    // from typing it in, and leaking a static sandbox blob into the
    // advertised handshake would violate the per-resource sandbox rule
    // (SEP-1865 — sandbox is approved per UI resource at runtime, not as
    // a vendor trait). Matches the return-type contract.
    const { sandbox: _sandbox, ...rest } = args.hostCapabilitiesOverride as {
      sandbox?: unknown;
    } & Record<string, unknown>;
    return rest as Omit<McpUiHostCapabilities, "sandbox">;
  }
  // 3. No override → matrix-derived from the host style preset.
  return getHostCapabilitiesForStyle(args.hostStyle);
}

/**
 * Resolve the `clientInfo` the SDK should send in MCP `initialize` for a
 * given host config. Returns `undefined` when the profile is unset — that
 * sentinel signals the SDK to fall back to its hardcoded inspector
 * defaults. Centralized here so the "undefined means SDK default" contract
 * stays one-grep-able.
 */
export function resolveClientInfo(
  profile: HostConfigMcpProfileV1 | undefined
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
  profile: HostConfigMcpProfileV1 | undefined
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
  profile: HostConfigMcpProfileV1 | undefined
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
  hostStyle: ChatboxHostStyle | string | null | undefined;
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
      override?.openaiAppsOverrides
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
  override: OpenAiAppsCapabilities | undefined
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

/**
 * Apply a sparse MCP Apps spec-bridge matrix override on top of a fully
 * resolved baseline. Mirrors {@link mergeOpenAiAppsCapabilities} for the
 * `app.*` surface. Each present field in `override` replaces the
 * corresponding baseline field; absent fields pass through.
 *
 * `availableDisplayModes` is REPLACED (not unioned) when present — the
 * array semantics is "exactly these modes." Empty arrays are coerced to
 * `["inline"]` (inline is the spec default; an empty allowlist would be
 * an unrenderable widget and the matrix UI prevents reaching this branch,
 * but the resolver enforces the invariant as a backstop).
 */
export function mergeMcpAppsCapabilities(
  base: ResolvedMcpAppsCapabilities,
  override: McpAppsCapabilities | undefined
): ResolvedMcpAppsCapabilities {
  if (!override) return base;
  const modesOverride = override.availableDisplayModes;
  const availableDisplayModes =
    modesOverride !== undefined
      ? modesOverride.length > 0
        ? modesOverride
        : (["inline"] as ResolvedMcpAppsCapabilities["availableDisplayModes"])
      : base.availableDisplayModes;
  return {
    availableDisplayModes,
    toolInputPartial: override.toolInputPartial ?? base.toolInputPartial,
    toolCancelled: override.toolCancelled ?? base.toolCancelled,
    hostContextChanged: override.hostContextChanged ?? base.hostContextChanged,
    resourceTeardown: override.resourceTeardown ?? base.resourceTeardown,
    toolInfo: override.toolInfo ?? base.toolInfo,
    openLinks: override.openLinks ?? base.openLinks,
    serverTools: override.serverTools ?? base.serverTools,
    serverResources: override.serverResources ?? base.serverResources,
    logging: override.logging ?? base.logging,
    updateModelContext: override.updateModelContext ?? base.updateModelContext,
    message: override.message ?? base.message,
    sandboxPermissions: override.sandboxPermissions ?? base.sandboxPermissions,
    cspFrameDomains: override.cspFrameDomains ?? base.cspFrameDomains,
    cspBaseUriDomains: override.cspBaseUriDomains ?? base.cspBaseUriDomains,
    resourcePrefersBorder:
      override.resourcePrefersBorder ?? base.resourcePrefersBorder,
    downloadFile: override.downloadFile ?? base.downloadFile,
    requestTeardown: override.requestTeardown ?? base.requestTeardown,
    widgetDisplayModeRequests:
      override.widgetDisplayModeRequests ?? base.widgetDisplayModeRequests,
  };
}

/**
 * Resolve the effective MCP Apps spec-bridge matrix for a host config.
 * Mirror of {@link resolveEffectiveCompatRuntime} for the spec bridge —
 * preset baseline from the host style + sparse user override from
 * `mcpProfile.apps.mcpAppsOverrides`, merged via
 * {@link mergeMcpAppsCapabilities}.
 *
 * Unlike `resolveEffectiveCompatRuntime`, this does NOT return a sum
 * type — the MCP Apps spec bridge is always active (it's the primary
 * protocol). Only the dimensions vary.
 */
export function resolveEffectiveMcpAppsCapabilities(args: {
  profile: HostConfigMcpProfileV1 | undefined;
  hostStyle: ChatboxHostStyle | string | null | undefined;
}): ResolvedMcpAppsCapabilities {
  const hostStylePreset = findHostStyle(args.hostStyle)?.mcp
    .mcpAppsCapabilities;
  const override = args.profile?.apps?.mcpAppsOverrides;
  // Unknown / unrecognized host style fallback depends on whether the
  // user has explicitly opted in via override:
  //
  // - **Override present + host style unknown** → start from
  //   NO_CLAIMS so the user's sparse override only enables rows
  //   they explicitly set. A persisted override against a removed
  //   host can't silently advertise near-full support — matches
  //   `getHostCapabilitiesForStyle`'s honest "no claims" baseline
  //   (`registry.ts:SPEC_DEFAULT_HOST_CAPABILITIES`).
  //
  // - **No override + host style unknown** → fall back to
  //   FULL_SURFACE so runtime behavior matches pre-matrix
  //   permissive defaults. Without this, callers that don't supply
  //   a host style (test renderers, edge cases during init) would
  //   suddenly suppress every notification — a runtime regression
  //   the matrix shouldn't introduce when there's literally nothing
  //   to honor.
  const preset =
    hostStylePreset ??
    (override !== undefined
      ? MCP_APPS_NO_CLAIMS_SURFACE
      : MCP_APPS_FULL_SURFACE);
  return mergeMcpAppsCapabilities(preset, override);
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
  legacy: Record<string, unknown> | undefined
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
 * Deep-clone an mcpProfile so editor mutations can't alias the source.
 * Goes through deepCloneJsonValue, but preserves the
 * `HostConfigMcpProfileV1` type at the boundary.
 */
function cloneMcpProfile(
  profile: HostConfigMcpProfileV1
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
  value: Record<string, unknown>
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
  b: HostConfigInputV2
): boolean {
  if (a.hostStyle !== b.hostStyle) return false;
  if (a.modelId !== b.modelId) return false;
  if (a.systemPrompt !== b.systemPrompt) return false;
  if (a.temperature !== b.temperature) return false;
  if (a.requireToolApproval !== b.requireToolApproval) return false;
  if (a.respectToolVisibility !== b.respectToolVisibility) return false;
  // Optional boolean: undefined / true / false are three distinct states
  // (backend hashes them distinctly). A strict !== covers all three since
  // we never coerce undefined to false elsewhere in the input pipeline.
  if (a.progressiveToolDiscovery !== b.progressiveToolDiscovery) return false;
  if (!stringArrayEq(a.serverIds, b.serverIds)) return false;
  if (!stringArrayEq(a.optionalServerIds, b.optionalServerIds)) return false;
  // Order-insensitive, same semantics as server ids — toggling a built-in
  // marks the draft dirty in the host/project/eval editors.
  if (!stringArrayEq(a.builtInToolIds, b.builtInToolIds)) return false;
  // Personal computer: presence + workdir (kind is always 'personal').
  // Attaching/detaching or changing the workdir marks the draft dirty.
  if ((a.computer === undefined) !== (b.computer === undefined)) return false;
  if (a.computer && b.computer && a.computer.workdir !== b.computer.workdir) {
    return false;
  }
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
      b.hostCapabilitiesOverride
    )
  )
    return false;
  if (!optionalChatUiOverrideEq(a.chatUiOverride, b.chatUiOverride))
    return false;
  if (!optionalMcpProfileEq(a.mcpProfile, b.mcpProfile)) return false;
  if (
    !serverConnectionOverridesEqual(
      a.serverConnectionOverrides,
      b.serverConnectionOverrides
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
  b: HostConfigInputV2["serverConnectionOverrides"]
): boolean {
  const normalize = (
    overrides: HostConfigInputV2["serverConnectionOverrides"]
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
  b: HostConfigMcpProfileV1 | undefined
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

function optionalJsonRecordEq(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined
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
  b: ChatUiOverride | undefined
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
  b: Record<string, unknown>
): boolean {
  // Use the shared canonicalizer so nested object key order doesn't make
  // semantically equal records compare unequal — e.g.
  // { capabilities: { a: 1, b: 2 } } vs { capabilities: { b: 2, a: 1 } }.
  // Top-level-only sorting (the previous implementation) reported these
  // as different and produced spurious dirty state in editors.
  return stableStringifyJson(a) === stableStringifyJson(b);
}
