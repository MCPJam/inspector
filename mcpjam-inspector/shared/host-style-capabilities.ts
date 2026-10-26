/**
 * MCP Apps host capabilities shared by chat (the client's host styles) and the
 * eval/swarm browser harness, so both advertise the same `ui/initialize` blob.
 */

import type { McpAppsCapabilities as SdkMcpAppsCapabilities } from "@mcpjam/sdk/host-config";
import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  HOST_STYLE_CAPABILITIES,
  MCP_APPS_FULL_SURFACE,
  MCP_APPS_NO_CLAIMS_SURFACE,
} from "./host-style-presets";

export {
  HOST_STYLE_CAPABILITIES,
  MCP_APPS_FULL_SURFACE,
  MCP_APPS_CLAUDE_SURFACE,
  MCP_APPS_CHATGPT_SURFACE,
  MCP_APPS_CURSOR_SURFACE,
  MCP_APPS_NO_CLAIMS_SURFACE,
  MCP_APPS_COPILOT_SURFACE,
  MCP_APPS_GOOSE_SURFACE,
  MCP_APPS_SLACK_SURFACE,
} from "./host-style-presets";

type HostCapabilitiesDetail = Partial<Omit<McpUiHostCapabilities, "sandbox">>;

/** The capability part of a host style: matrix plus preset-only detail. */
export type HostStyleCapabilities = {
  mcpAppsCapabilities: ResolvedMcpAppsCapabilities;
  hostCapabilitiesAugment?: HostCapabilitiesDetail;
  hostCapabilitiesReplacement?: HostCapabilitiesDetail;
};

/** Finds a host style's capabilities: chat's registry, or the built-in table. */
export type FindStyleCapabilities = (
  hostStyle: string | null | undefined,
) => HostStyleCapabilities | undefined;

/** The part of a saved profile these resolvers read. */
type McpProfileWithApps = { apps?: { mcpAppsOverrides?: McpAppsCapabilities } };

/** Inspector emulates the SDK matrix except resource-cache TTL behavior; the
 * SDK type documents what each row gates. */
export type McpAppsCapabilities = Omit<SdkMcpAppsCapabilities, "resourceCacheTtl">;
export type McpAppsCspConnectDomains = NonNullable<
  McpAppsCapabilities["cspConnectDomains"]
>;
export type McpAppsCspResourceDomains = NonNullable<
  McpAppsCapabilities["cspResourceDomains"]
>;
export type McpAppsToolResultPolicy = NonNullable<McpAppsCapabilities["toolResult"]>;

/** Probe-derived records stay sparse; every other preset dimension is required. */
type OptionalCapabilityRecords =
  | "cspConnectDomains"
  | "cspResourceDomains"
  | "toolResult";

export type ResolvedMcpAppsCapabilities = Required<
  Omit<McpAppsCapabilities, OptionalCapabilityRecords>
> & Pick<McpAppsCapabilities, OptionalCapabilityRecords>;

/**
 * Last-resort fallback used when no host style resolves (e.g., the caller
 * passed an unknown id and we don't want to silently inherit Claude's
 * capability blob). Mirrors the "advertise nothing" position from the SEP —
 * widgets that gate on optional fields will treat them as unsupported.
 *
 * `sandbox` is intentionally omitted; it's per-resource runtime data.
 */
export const SPEC_DEFAULT_HOST_CAPABILITIES: Omit<
  McpUiHostCapabilities,
  "sandbox"
> = {};

/**
 * Build the `HostCapabilities` blob advertised in `ui/initialize` from a
 * resolved per-dimension matrix plus optional preset-only augment/replacement
 * detail. This is the single derivation point for advertisement — the matrix
 * is the source of truth (per the foundation PR's D1 decision).
 *
 * Every advertised field is matrix-controlled:
 *   - `openLinks` / `serverTools` / `serverResources` / `logging` /
 *     `updateModelContext` / `message` — advertised when the matrix
 *     sets `true`. (`openLinks` and `serverTools` are conventionally on
 *     for every built-in preset, but staying matrix-controlled lets
 *     legacy `hostCapabilitiesOverride: {}` migrate to a truly empty
 *     advertised blob without the resolver silently re-adding them.)
 *   - `downloadFile` — matrix-controlled. When the row is true the wire
 *     blob carries `downloadFile: {}` and the renderer wires
 *     `bridge.ondownloadfile`. Off for honest-no-claims presets.
 *   - `sandbox` — NOT added here; the renderer composes it separately
 *     via `resolveSandboxCsp` / `resolveSandboxPermissions` and adds it
 *     onto the advertised blob before passing to AppBridge.
 *
 * `augment` carries preset-specific sub-fields merged onto a matrix-derived
 * key (for example Cursor's `listChanged: false`). `replacement` carries an
 * exact typed value that must replace the generic matrix-derived shape (for
 * example VS Code's non-text updateModelContext set). Neither can add a key
 * the matrix omitted.
 */
export function buildHostCapabilities(
  matrix: ResolvedMcpAppsCapabilities,
  augment?: Partial<Omit<McpUiHostCapabilities, "sandbox">>,
  replacement?: Partial<Omit<McpUiHostCapabilities, "sandbox">>
): Omit<McpUiHostCapabilities, "sandbox"> {
  const caps: Omit<McpUiHostCapabilities, "sandbox"> = {};
  if (matrix.openLinks) caps.openLinks = {};
  if (matrix.serverTools) caps.serverTools = {};
  if (matrix.serverResources) caps.serverResources = {};
  if (matrix.logging) caps.logging = {};
  if (matrix.updateModelContext) caps.updateModelContext = { text: {} };
  if (matrix.message) caps.message = { text: {} };
  if (matrix.downloadFile) caps.downloadFile = {};
  if (augment) {
    for (const [key, value] of Object.entries(augment) as Array<
      [
        keyof Omit<McpUiHostCapabilities, "sandbox">,
        Omit<McpUiHostCapabilities, "sandbox">[keyof Omit<
          McpUiHostCapabilities,
          "sandbox"
        >]
      ]
    >) {
      if (caps[key] === undefined) continue;
      (caps as Record<string, unknown>)[key] = {
        ...(caps[key] as object),
        ...(value as object),
      };
    }
  }
  if (replacement) {
    for (const [key, value] of Object.entries(replacement)) {
      if ((caps as Record<string, unknown>)[key] === undefined) continue;
      (caps as Record<string, unknown>)[key] = value;
    }
  }
  return caps;
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
  const cspConnectDomains =
    base.cspConnectDomains || override.cspConnectDomains
      ? { ...base.cspConnectDomains, ...override.cspConnectDomains }
      : undefined;
  const cspResourceDomains =
    base.cspResourceDomains || override.cspResourceDomains
      ? { ...base.cspResourceDomains, ...override.cspResourceDomains }
      : undefined;
  // Two levels deep, so a shallow spread would let an override that names
  // only `structuredContent` erase the preset's per-block-kind answers.
  const toolResult =
    base.toolResult || override.toolResult
      ? {
          ...base.toolResult,
          ...override.toolResult,
          ...(base.toolResult?.content || override.toolResult?.content
            ? {
                content: {
                  ...base.toolResult?.content,
                  ...override.toolResult?.content,
                },
              }
            : {}),
        }
      : undefined;
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
    cspConnectDomains,
    cspResourceDomains,
    toolResult,
    resourcePrefersBorder:
      override.resourcePrefersBorder ?? base.resourcePrefersBorder,
    downloadFile: override.downloadFile ?? base.downloadFile,
    requestTeardown: override.requestTeardown ?? base.requestTeardown,
    safeAreaInsets: override.safeAreaInsets ?? base.safeAreaInsets,
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
export function resolveMcpAppsCapabilities(
  args: {
    profile: McpProfileWithApps | undefined;
    hostStyle: string | null | undefined;
  },
  findStyle: FindStyleCapabilities,
): ResolvedMcpAppsCapabilities {
  const hostStylePreset = findStyle(args.hostStyle)?.mcpAppsCapabilities;
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
 * Resolve the `hostCapabilities` blob the MCP Apps iframe handshake should
 * advertise for a given host config. Precedence:
 *   1. Profile-level `mcpAppsOverrides` matrix (merged with the host style
 *      preset via {@link resolveMcpAppsCapabilities} → derived
 *      blob via {@link buildHostCapabilities}).
 *   2. Legacy top-level `hostCapabilitiesOverride` (verbatim, when present
 *      and the new matrix override is absent). Deprecated — migrated to
 *      `mcpAppsOverrides` at profile load via
 *      {@link hostCapabilitiesOverrideToMatrix}; readable for one release
 *      window so old persisted configs don't break.
 *   3. The active host style's preset (matrix-derived).
 *   4. Spec-default "no claims" baseline (handled inside
 *      {@link SPEC_DEFAULT_HOST_CAPABILITIES}).
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
export function resolveHostCapabilities(
  args: {
  hostStyle: string | null | undefined;
  /** Versioned profile carrying the new `mcpAppsOverrides` matrix. */
  profile?: McpProfileWithApps;
  /**
   * Legacy override. Deprecated; pass-through path while configs migrate.
   * If both `profile.apps.mcpAppsOverrides` and this are present, the
   * matrix wins (per the foundation PR's precedence rule).
   */
  hostCapabilitiesOverride?: Record<string, unknown>;
  },
  findStyle: FindStyleCapabilities,
): Omit<McpUiHostCapabilities, "sandbox"> {
  // 1. New matrix path — wins whenever the profile carries an
  // `mcpAppsOverrides`. Threaded through the renderer, canvas, Apps tab,
  // and saved-view consumers so a persisted matrix actually affects the
  // wire advertisement.
  if (args.profile?.apps?.mcpAppsOverrides !== undefined) {
    const matrix = resolveMcpAppsCapabilities(
      { profile: args.profile, hostStyle: args.hostStyle },
      findStyle,
    );
    const style = findStyle(args.hostStyle);
    return buildHostCapabilities(
      matrix,
      style?.hostCapabilitiesAugment,
      style?.hostCapabilitiesReplacement,
    );
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
  // 3. No override → matrix-derived from the host style preset, or the
  // spec-default "no claims" baseline for an unknown id.
  const style = findStyle(args.hostStyle);
  if (!style) return SPEC_DEFAULT_HOST_CAPABILITIES;
  return buildHostCapabilities(
    style.mcpAppsCapabilities,
    style.hostCapabilitiesAugment,
    style.hostCapabilitiesReplacement,
  );
}

const BUILT_IN_STYLES: Readonly<Record<string, HostStyleCapabilities | undefined>> =
  HOST_STYLE_CAPABILITIES;

export function findBuiltInStyleCapabilities(
  hostStyle: string | null | undefined,
): HostStyleCapabilities | undefined {
  return hostStyle && Object.hasOwn(BUILT_IN_STYLES, hostStyle)
    ? BUILT_IN_STYLES[hostStyle]
    : undefined;
}

/** What eval and swarm advertise: chat's resolution over the built-in table. */
export function resolveBuiltInHostCapabilities(
  args: Parameters<typeof resolveHostCapabilities>[0],
): Omit<McpUiHostCapabilities, "sandbox"> {
  return resolveHostCapabilities(args, findBuiltInStyleCapabilities);
}
