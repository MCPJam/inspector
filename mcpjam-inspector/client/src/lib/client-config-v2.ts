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
  getCompatRuntimeForStyle,
  getHostCapabilitiesForStyle,
} from "@/lib/client-styles";
import type { ChatUiOverride } from "@/lib/client-styles";
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
export type HostConfigMcpProfileV1 = {
  profileVersion: 1;
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
       */
      openaiApps?: boolean;
    };
  };
  extensions?: Record<string, unknown>;
};

/**
 * Mutable input shape. All fields are required at write time so the editor
 * can't accidentally erase a section.
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
            },
          ])
        )
      : undefined,
  };
}

/**
 * Resolve the `hostCapabilities` blob the MCP Apps iframe handshake should
 * advertise for a given host config. Precedence:
 *   1. User-saved `hostCapabilitiesOverride` (verbatim, when present)
 *   2. The active host style's preset
 *   3. Spec-default "no claims" baseline (handled inside
 *      {@link getHostCapabilitiesForStyle})
 *
 * **Sandbox is intentionally NOT resolved here.** Per SEP-1865, sandbox
 * CSP/permissions are approved per-UI-resource at runtime and merged into
 * the final blob by the renderer. Profile presets and user overrides cover
 * vendor-trait fields only.
 *
 * **Conformance gap (advertise vs. enforce):** This returns the value the
 * handshake will advertise. Until enforcement gates land in the renderer's
 * request handlers, behavior may still service methods this blob omits.
 * Use this value as the single source of truth when enforcement ships so
 * advertise and enforce stay in lockstep.
 */
export function resolveEffectiveHostCapabilities(args: {
  hostStyle: HostStyleId | null | undefined;
  hostCapabilitiesOverride?: Record<string, unknown>;
}): Omit<McpUiHostCapabilities, "sandbox"> {
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
 * Resolve the effective compat-runtime shim flags for a host config:
 *   1. user override on the profile (when explicitly boolean)
 *   2. host style preset (Apps SDK hosts → true; SEP-1865 hosts → false)
 *   3. honest "no shim" default when neither resolves
 *
 * Mirror of {@link resolveEffectiveHostCapabilities}: presets live in
 * the host style registry, overrides live on the persisted profile,
 * and the resolver decides per call. Consumers (renderer, modal,
 * server routes) pass the resolved boolean across the wire so the
 * decision is made once and travels with the request.
 */
export function resolveEffectiveCompatRuntime(args: {
  profile: HostConfigMcpProfileV1 | undefined;
  hostStyle: ChatboxHostStyle | string | null | undefined;
}): { openaiApps: boolean } {
  const preset = getCompatRuntimeForStyle(args.hostStyle);
  const override = args.profile?.apps?.compatRuntime?.openaiApps;
  return {
    openaiApps:
      typeof override === "boolean" ? override : preset.openaiApps,
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
  ): Record<string, { headersOverride?: Record<string, string>; requestTimeoutOverride?: number }> => {
    if (!overrides) return {};
    const result: Record<string, { headersOverride?: Record<string, string>; requestTimeoutOverride?: number }> = {};
    for (const [key, entry] of Object.entries(overrides)) {
      if (!entry) continue;
      const hasHeaders =
        entry.headersOverride !== undefined &&
        Object.keys(entry.headersOverride).length > 0;
      const hasTimeout = entry.requestTimeoutOverride !== undefined;
      if (hasHeaders || hasTimeout) {
        result[key] = {
          ...(hasHeaders ? { headersOverride: entry.headersOverride } : {}),
          ...(hasTimeout ? { requestTimeoutOverride: entry.requestTimeoutOverride } : {}),
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
