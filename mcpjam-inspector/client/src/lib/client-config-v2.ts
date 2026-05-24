/**
 * Frontend types + utilities for HostConfig v2.
 *
 * Mirrors the shape declared in the backend's
 * `convex/lib/hostConfigV2.ts`. Kept in sync by hand: this file is the
 * single client-side source of truth so all four editors (Project Settings,
 * Chatbox Editor/Builder, Eval Suite Settings, Connection Settings) speak
 * one shape.
 *
 * Phase 1 (additive). Subsequent phases will switch read/write paths in
 * place; the shape below is stable.
 */

import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { ChatboxHostStyle } from "@/lib/chatbox-client-style";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  stableStringifyJson,
} from "@/lib/client-config";
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
import { getDefaultClientCapabilities } from "@mcpjam/sdk/browser";

export type HostStyleId = ChatboxHostStyle;

/**
 * Permissions Policy feature tokens corresponding to the four SEP-1865
 * spec permissions. KEBAB-CASE browser tokens (as they appear in iframe
 * `allow=` attributes), NOT the camelCase keys used in
 * `mcpProfile.permissions.allow`. The backend canonicalizer drops any
 * key in this list from `allowFeatures` — `permissions.allow` is the
 * single source of truth. Mirror of the same constant in
 * `convex/lib/hostConfigV2.ts`.
 *
 * Naming gap (intentional): `permissions.allow.clipboardWrite` (camel,
 * spec field name) ↔ `allowFeatures["clipboard-write"]` (kebab,
 * Permissions Policy token). Do NOT normalize casing on either side.
 */
export const SEP_1865_PERMISSION_FEATURES = [
  "camera",
  "microphone",
  "geolocation",
  "clipboard-write",
] as const;

export type HostConfigConnectionDefaults = {
  headers: Record<string, string>;
  requestTimeout: number;
};

/**
 * Four parallel allowlists keyed by CSP directive family (SEP-1865 is
 * allowlist-only; there's no deny concept). Mirrors `CspDomainSet` in the
 * backend (`convex/lib/hostConfigV2.ts`). Canonicalized server-side as a set
 * (trimmed, deduped, sorted); the client may emit arrays in any order — the
 * backend hash dedupes regardless.
 */
export type CspDomainSet = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

/**
 * Versioned envelope for host-level MCP state. Mirror of
 * `HostConfigMcpProfileV1` in `convex/lib/hostConfigV2.ts` — kept in sync by
 * hand so the inspector and backend speak one shape.
 *
 * `profileVersion: 1` is a forward-compat trip wire: a future incompatible
 * shape will introduce `profileVersion: 2`. The backend rejects any other
 * value at write time.
 *
 * Every field is optional; `undefined` at any nest depth means "use SDK
 * defaults / no host-level override." `undefined` and `{ profileVersion: 1 }`
 * (empty envelope) hash distinctly on the backend, so the inspector MUST NOT
 * synthesize an empty envelope when the user hasn't opted in.
 */
/**
 * Outbound MCP wire mode for a server connection. "legacy" (the implicit
 * default when absent) uses the upstream `Client` + initialize handshake;
 * "stateless-draft-2026-v1" selects the experimental DRAFT-2026-v1
 * stateless preview transport implemented in `@mcpjam/sdk`. Mirror of
 * `McpWireMode` in `convex/lib/hostConfigV2.ts`.
 */
export type McpWireMode = "legacy" | "stateless-draft-2026-v1";

/**
 * Resolve the effective outbound wire mode for a server connection.
 * Mirror of the rule the backend stamps into `serverConnectionOverrides`
 * at fan-out time, applied at the bridge / wire-client factory site to
 * pick between `OfficialSdkClientAdapter` and
 * `StatelessDraft2026V1PreviewClient`.
 *
 *   server override wins; otherwise host default; otherwise "legacy"
 *
 * Both inputs are optional so callers can read straight off the hydrated
 * host config row without normalizing first. `undefined` arms of the
 * union mean "no opinion at this layer."
 */
export function resolveEffectiveMcpWireMode(
  serverOverride: McpWireMode | undefined,
  hostDefault: McpWireMode | undefined,
): McpWireMode {
  return serverOverride ?? hostDefault ?? "legacy";
}

export type HostConfigMcpProfileV1 = {
  profileVersion: 1;
  /**
   * Host-level default outbound MCP wire mode. Absent → resolves to
   * `"legacy"` at the wire-client factory. Sibling of `initialize` and
   * `apps` because stateless explicitly skips initialize — keeping it
   * out of `mcpProfile.initialize` keeps the source-of-truth obvious.
   *
   * Per-server overrides live on `serverConnectionOverrides[serverId]
   * .mcpWireModeOverride`. Resolution rule: server override wins;
   * otherwise this default; otherwise `"legacy"`.
   */
  mcpWireMode?: McpWireMode;
  initialize?: {
    /**
     * Ordered accept-list. First entry is sent in
     * `initialize.params.protocolVersion`; all entries form the accept-set.
     * Order is semantic — do NOT sort on the client.
     */
    supportedProtocolVersions?: string[];
    /**
     * The exact `initialize.clientInfo` object the SDK should send. Backend
     * soft-validates `name` and `version` (non-empty strings, required when
     * `clientInfo` is set) and passes everything else through verbatim so
     * future spec additions (e.g. `title`) land here without a schema
     * migration.
     */
    clientInfo?: Record<string, unknown>;
  };
  apps?: {
    sandbox?: {
      csp?: {
        /** Picks the starting baseline; restrictTo applies on top regardless of mode. */
        mode?: "host-default" | "declared" | "relaxed";
        /** Intersection — never adds undeclared domains (SEP-1865). */
        restrictTo?: CspDomainSet;
        /**
         * Per-directive CSP source-expression overrides emitted in the inner
         * doc's `<meta http-equiv="Content-Security-Policy">`. Keys are CSP
         * directive names (`script-src`, `style-src`, …); values are
         * source-expression token arrays (`["'unsafe-eval'", "'wasm-unsafe-eval'"]`).
         * Stored verbatim — no enum — so future tokens (nonces, hashes,
         * `'strict-dynamic'`) land here without schema churn.
         * Inspector-only emission knob: NOT advertised in SEP-1865 metadata;
         * models what real hosts emit at the browser layer.
         */
        cspDirectives?: Record<string, string[]>;
        extensions?: Record<string, unknown>;
      };
      permissions?: {
        mode?: "resource-declared" | "deny-all" | "custom";
        allow?: Record<string, boolean>;
        extensions?: Record<string, unknown>;
      };
      /**
       * Extra outer/inner iframe `sandbox=` tokens unioned with the mandatory
       * `allow-scripts allow-same-origin`. Inspector-only emission knob.
       */
      sandboxAttrs?: string[];
      /**
       * Extra Permissions Policy entries appended to the OUTER iframe's
       * `allow=` attribute ONLY. The inner iframe gets only the 4 spec
       * permissions (from `permissions.allow`), matching real claude.ai's
       * pattern where the outer grants `fullscreen *; clipboard-write *`
       * but the inner trims to `clipboard-write *`. Keys are RAW
       * kebab-case Permissions Policy tokens (`clipboard-write`, not
       * `clipboardWrite`); values are allowlist strings (`*`, `'self'`,
       * an origin). The 4 spec features (camera / microphone /
       * geolocation / clipboard-write) are silently dropped by the
       * canonicalizer — `permissions.allow` is the single source of
       * truth for them. Inspector-only.
       */
      allowFeatures?: Record<string, string>;
    };
    /**
     * Overrides for the MCP Apps `ui/initialize` response advertised to
     * the View iframe (SEP-1865). Sibling to `apps.sandbox` because the
     * `ui/initialize` envelope is the MCP Apps extension's negotiation
     * step — distinct from the base-protocol `initialize` whose overrides
     * live under `mcpProfile.initialize`.
     */
    uiInitialize?: {
      /**
       * The exact `hostInfo` the inspector should report in the
       * `ui/initialize` result. Backend soft-validates `name` and
       * `version` (non-empty strings, required when `hostInfo` is set)
       * and passes everything else through verbatim so future spec
       * additions (e.g. `title`) land here without a schema migration.
       * Mirror of `initialize.clientInfo`.
       */
      hostInfo?: Record<string, unknown>;
    };
    /**
     * Vendor compat-runtime shims the inspector injects into widget
     * HTML before handing it to the sandbox. Claude/Cursor/Codex-style
     * hosts leave these surfaces off; ChatGPT/Copilot and MCPJam's dev
     * surface enable them. Absent → resolver falls back to the host
     * style preset (see `resolveEffectiveCompatRuntime`).
     */
    compatRuntime?: {
      /**
       * Inject the OpenAI Apps SDK `window.openai` shim
       * (`@mcpjam/sdk`'s `injectOpenAICompat`). Only enable when
       * emulating a host that historically exposed this surface, or
       * when the widget under test depends on it.
       *
       * Semantics:
       * - `undefined` (or field absent) → fall back to the host style preset.
       * - `true` → inject the shim (per-method surface controlled by
       *   `openaiAppsOverrides` merged over the preset's `openaiAppsCapabilities`).
       * - `false` → do NOT inject the shim. Per-method overrides are
       *   ignored when injection is off; `window.openai` is `undefined`
       *   in the widget, which is what SEP-1865-only hosts advertise.
       */
      openaiApps?: boolean;
      /**
       * Sparse per-method overrides applied on top of the host style
       * preset when the shim IS injected. Each present field replaces
       * the corresponding preset value; absent fields fall back to the
       * preset. Use this to model a specific host's published subset
       * (e.g. Microsoft 365 Copilot's "no requestModal, no uploadFile,
       * fullscreen-only display mode") without redefining the whole
       * surface.
       */
      openaiAppsOverrides?: OpenAiAppsCapabilities;
    };
    /**
     * Sparse user override on the SEP-1865 MCP Apps spec-bridge per-
     * dimension matrix. Independent of {@link compatRuntime} — the spec
     * bridge is the primary protocol, not a vendor shim, so the override
     * is its own sibling. Each present field replaces the corresponding
     * preset value; absent fields fall back to the host style preset's
     * {@link ResolvedMcpAppsCapabilities}. Use this to model a host's
     * published subset (e.g. Microsoft 365 Copilot's "no
     * `tool-input-partial`, fullscreen-only display modes, no
     * `_meta.ui.prefersBorder` honoring") without redefining the whole
     * matrix.
     */
    mcpAppsOverrides?: McpAppsCapabilities;
  };
  extensions?: Record<string, unknown>;
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
  serverIds: string[];
  optionalServerIds: string[];
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
  serverConnectionOverrides?: Record<string, {
    headersOverride?: Record<string, string>;
    requestTimeoutOverride?: number;
    /**
     * Per-server override of the outbound MCP wire mode. Wins over
     * `mcpProfile.mcpWireMode`. Mirror of the execution-plane field
     * fanned out from `projectServerRefs.mcpWireModeOverride` by
     * `fanOutProjectServerConfigToHosts`.
     */
    mcpWireModeOverride?: McpWireMode;
  }>;
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
  serverIds: string[];
  optionalServerIds: string[];
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
  serverConnectionOverrides?: Record<string, {
    headersOverride?: Record<string, string>;
    requestTimeoutOverride?: number;
    mcpWireModeOverride?: McpWireMode;
  }>;
};

export const DEFAULT_HOST_STYLE_V2: HostStyleId = "mcpjam";
export const DEFAULT_TEMPERATURE_V2 = 0.7;

export function emptyHostConfigInputV2(
  partial: Partial<HostConfigInputV2> = {},
): HostConfigInputV2 {
  // Clone every caller-provided array/record so the returned config can
  // be mutated freely without aliasing the input. Matches the cloning
  // behavior of hostConfigDtoToInput.
  return {
    hostStyle: partial.hostStyle ?? DEFAULT_HOST_STYLE_V2,
    modelId: partial.modelId ?? "",
    systemPrompt: partial.systemPrompt ?? "",
    temperature: partial.temperature ?? DEFAULT_TEMPERATURE_V2,
    requireToolApproval: partial.requireToolApproval ?? false,
    serverIds: partial.serverIds ? [...partial.serverIds] : [],
    optionalServerIds: partial.optionalServerIds
      ? [...partial.optionalServerIds]
      : [],
    connectionDefaults: {
      headers: partial.connectionDefaults?.headers
        ? { ...partial.connectionDefaults.headers }
        : {},
      requestTimeout:
        partial.connectionDefaults?.requestTimeout ??
        DEFAULT_REQUEST_TIMEOUT_MS,
    },
    // Seed with the SDK's default capabilities (which include the MCP UI
    // extension and any other built-ins) so a brand-new project/chatbox/
    // eval host config keeps advertising them. The legacy
    // ProjectClientConfig path also seeds from getDefaultClientCapabilities;
    // an empty {} here would silently drop MCP Apps support until the
    // user manually edited the capability JSON.
    //
    // Deep-clone — clientCapabilities and hostContext can be nested
    // (e.g. extensions.mimeTypes arrays). A shallow spread would alias
    // the inner trees with the partial/source, allowing later mutations
    // to leak through.
    clientCapabilities: partial.clientCapabilities
      ? deepCloneJsonRecord(partial.clientCapabilities)
      : deepCloneJsonRecord(
          getDefaultClientCapabilities() as Record<string, unknown>,
        ),
    hostContext: partial.hostContext
      ? deepCloneJsonRecord(partial.hostContext)
      : {},
    hostCapabilitiesOverride: partial.hostCapabilitiesOverride
      ? deepCloneJsonRecord(partial.hostCapabilitiesOverride)
      : undefined,
    chatUiOverride: partial.chatUiOverride
      ? cloneChatUiOverride(partial.chatUiOverride)
      : undefined,
    // Same `undefined`-preservation rule as hostCapabilitiesOverride.
    // Backend distinguishes `undefined` (use SDK defaults) from
    // `{ profileVersion: 1 }` (empty envelope) on the hash, so a brand-new
    // input MUST stay undefined until the user opts in via the editor.
    mcpProfile: partial.mcpProfile
      ? cloneMcpProfile(partial.mcpProfile)
      : undefined,
    serverConnectionOverrides: partial.serverConnectionOverrides
      ? Object.fromEntries(
          Object.entries(partial.serverConnectionOverrides).map(([k, v]) => [
            k,
            {
              ...(v.headersOverride !== undefined
                ? { headersOverride: { ...v.headersOverride } }
                : {}),
              ...(v.requestTimeoutOverride !== undefined
                ? { requestTimeoutOverride: v.requestTimeoutOverride }
                : {}),
              ...(v.mcpWireModeOverride !== undefined
                ? { mcpWireModeOverride: v.mcpWireModeOverride }
                : {}),
            },
          ]),
        )
      : undefined,
  };
}

export function hostConfigDtoToInput(
  dto: HostConfigDtoV2,
): HostConfigInputV2 {
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
    serverIds: [...dto.serverIds],
    optionalServerIds: [...dto.optionalServerIds],
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
              ...(v.mcpWireModeOverride !== undefined
                ? { mcpWireModeOverride: v.mcpWireModeOverride }
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
    requestDisplayMode:
      override.requestDisplayMode ?? base.requestDisplayMode,
    notifyIntrinsicHeight:
      override.notifyIntrinsicHeight ?? base.notifyIntrinsicHeight,
    openExternal: override.openExternal ?? base.openExternal,
    setOpenInAppUrl: override.setOpenInAppUrl ?? base.setOpenInAppUrl,
    requestModal: override.requestModal ?? base.requestModal,
    uploadFile: override.uploadFile ?? base.uploadFile,
    selectFiles: override.selectFiles ?? base.selectFiles,
    getFileDownloadUrl:
      override.getFileDownloadUrl ?? base.getFileDownloadUrl,
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
  override: McpAppsCapabilities | undefined,
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
    hostContextChanged:
      override.hostContextChanged ?? base.hostContextChanged,
    resourceTeardown: override.resourceTeardown ?? base.resourceTeardown,
    toolInfo: override.toolInfo ?? base.toolInfo,
    openLinks: override.openLinks ?? base.openLinks,
    serverTools: override.serverTools ?? base.serverTools,
    serverResources: override.serverResources ?? base.serverResources,
    logging: override.logging ?? base.logging,
    updateModelContext:
      override.updateModelContext ?? base.updateModelContext,
    message: override.message ?? base.message,
    sandboxPermissions:
      override.sandboxPermissions ?? base.sandboxPermissions,
    cspFrameDomains: override.cspFrameDomains ?? base.cspFrameDomains,
    cspBaseUriDomains:
      override.cspBaseUriDomains ?? base.cspBaseUriDomains,
    resourcePrefersBorder:
      override.resourcePrefersBorder ?? base.resourcePrefersBorder,
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
  if (a.systemPrompt !== b.systemPrompt) return false;
  if (a.temperature !== b.temperature) return false;
  if (a.requireToolApproval !== b.requireToolApproval) return false;
  if (!stringArrayEq(a.serverIds, b.serverIds)) return false;
  if (!stringArrayEq(a.optionalServerIds, b.optionalServerIds)) return false;
  if (
    a.connectionDefaults.requestTimeout !==
    b.connectionDefaults.requestTimeout
  )
    return false;
  if (!jsonRecordEq(a.connectionDefaults.headers, b.connectionDefaults.headers))
    return false;
  if (!jsonRecordEq(a.clientCapabilities, b.clientCapabilities)) return false;
  if (!jsonRecordEq(a.hostContext, b.hostContext)) return false;
  if (!optionalJsonRecordEq(a.hostCapabilitiesOverride, b.hostCapabilitiesOverride))
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
  ): Record<string, { headersOverride?: Record<string, string>; requestTimeoutOverride?: number; mcpWireModeOverride?: McpWireMode }> => {
    if (!overrides) return {};
    const result: Record<string, { headersOverride?: Record<string, string>; requestTimeoutOverride?: number; mcpWireModeOverride?: McpWireMode }> = {};
    for (const [key, entry] of Object.entries(overrides)) {
      if (!entry) continue;
      const hasHeaders =
        entry.headersOverride !== undefined &&
        Object.keys(entry.headersOverride).length > 0;
      const hasTimeout = entry.requestTimeoutOverride !== undefined;
      const hasWireMode = entry.mcpWireModeOverride !== undefined;
      if (hasHeaders || hasTimeout || hasWireMode) {
        result[key] = {
          ...(hasHeaders ? { headersOverride: entry.headersOverride } : {}),
          ...(hasTimeout ? { requestTimeoutOverride: entry.requestTimeoutOverride } : {}),
          ...(hasWireMode ? { mcpWireModeOverride: entry.mcpWireModeOverride } : {}),
        };
      }
    }
    return result;
  };
  return stableStringifyJson(normalize(a)) === stableStringifyJson(normalize(b));
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
