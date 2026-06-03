/**
 * HostConfig v2 canonicalizer — pure, browser-safe, byte-stable.
 *
 * SOURCE OF TRUTH (hand-mirrored by `convex/lib/hostConfigV2.ts`). Stable key
 * ordering matters for hash stability across runtimes: we JSON.stringify the
 * canonical object; Object.keys preserves insertion order, so we build output
 * with a fixed key order rather than spreading user input. Any behavior change
 * here must be mirrored in the backend in lockstep and the parity fixtures
 * regenerated (see `./types.ts` header).
 */

import {
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
  MCP_PROTOCOL_VERSIONS,
  type McpProtocolVersion,
} from "../mcp-client-manager/mcp-protocol-version.js";
import {
  HOST_CONFIG_SCHEMA_VERSION_V2,
  SEP_1865_PERMISSION_FEATURES,
  type CanonicalHostConfigV2,
  type CspDomainSet,
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
  type McpAppsCapabilities,
  type OpenAiAppsCapabilities,
  type ServerId,
} from "./types.js";

// Allowed keys on `openaiAppsOverrides`. Centralized so the canonicalizer's
// typo-rejection stays in sync with the type — if you add a method to
// `OpenAiAppsCapabilities`, add it here too.
const OPENAI_APPS_CAPABILITY_KEYS = [
  "callTool",
  "sendFollowUpMessage",
  "setWidgetState",
  "requestDisplayMode",
  "notifyIntrinsicHeight",
  "openExternal",
  "setOpenInAppUrl",
  "requestModal",
  "uploadFile",
  "selectFiles",
  "getFileDownloadUrl",
  "requestCheckout",
  "requestClose",
] as const satisfies ReadonlyArray<keyof OpenAiAppsCapabilities>;

const OPENAI_APPS_CAPABILITY_KEY_SET: ReadonlySet<string> = new Set(
  OPENAI_APPS_CAPABILITY_KEYS,
);

const OPENAI_APPS_REQUEST_DISPLAY_MODE_VALUES = [
  "all",
  "fullscreen-only",
  "none",
] as const;

// Allowed keys on `mcpAppsOverrides`. Centralized for typo defense.
const MCP_APPS_CAPABILITY_KEYS = [
  "availableDisplayModes",
  "toolInputPartial",
  "toolCancelled",
  "hostContextChanged",
  "resourceTeardown",
  "toolInfo",
  "openLinks",
  "serverTools",
  "serverResources",
  "logging",
  "updateModelContext",
  "message",
  "sandboxPermissions",
  "cspFrameDomains",
  "cspBaseUriDomains",
  "resourcePrefersBorder",
  "downloadFile",
  "requestTeardown",
  "widgetDisplayModeRequests",
] as const satisfies ReadonlyArray<keyof McpAppsCapabilities>;

const MCP_APPS_CAPABILITY_KEY_SET: ReadonlySet<string> = new Set(
  MCP_APPS_CAPABILITY_KEYS,
);

const MCP_APPS_DISPLAY_MODE_VALUES = ["inline", "fullscreen", "pip"] as const;

const MCP_APPS_WIDGET_DISPLAY_MODE_REQUEST_VALUES = [
  "accept",
  "user-initiated-only",
  "decline",
] as const;

const MCP_APPS_DISPLAY_MODE_VALUE_SET: ReadonlySet<string> = new Set(
  MCP_APPS_DISPLAY_MODE_VALUES,
);

function sortStringKeys<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input).sort()) out[k] = input[k];
  return out as T;
}

// Deep variant: recursively sorts keys at every object level so nested
// records hash the same regardless of original key order.
function deepSortStringKeys<T>(input: T): T {
  if (Array.isArray(input)) {
    return input.map((v) => deepSortStringKeys(v)) as unknown as T;
  }
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    const src = input as Record<string, unknown>;
    for (const k of Object.keys(src).sort()) {
      out[k] = deepSortStringKeys(src[k]);
    }
    return out as T;
  }
  return input;
}

// Plain-object guard shared by hostCapabilitiesOverride and mcpProfile.
// Arrays/null satisfy `typeof === 'object'`; the canonicalizer is the
// chokepoint.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Canonicalize a CSP domain list as a SET: trim, drop empty, dedupe, sort.
// Order has no meaning for CSP allowlists (contrast supportedProtocolVersions,
// where order IS semantic).
function canonicalizeCspDomainList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      "hostConfigV2: mcpProfile CSP domain list must be a string[]",
    );
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        "hostConfigV2: mcpProfile CSP domain list entries must be strings",
      );
    }
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    seen.add(trimmed);
  }
  return Array.from(seen).sort();
}

function canonicalizeCspDomainSet(value: unknown): CspDomainSet | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(
      "hostConfigV2: mcpProfile CSP restrictTo must be a plain object",
    );
  }
  const out: CspDomainSet = {};
  const src = value as Record<string, unknown>;
  for (const key of [
    "connectDomains",
    "resourceDomains",
    "frameDomains",
    "baseUriDomains",
  ] as const) {
    const canonical = canonicalizeCspDomainList(src[key]);
    if (canonical !== undefined) out[key] = canonical;
  }
  // Preserve unknown keys verbatim so future CSP directive families
  // round-trip without a schema bump. Deep-sort them for hash stability.
  for (const key of Object.keys(src).sort()) {
    if (
      key === "connectDomains" ||
      key === "resourceDomains" ||
      key === "frameDomains" ||
      key === "baseUriDomains"
    ) {
      continue;
    }
    (out as Record<string, unknown>)[key] = deepSortStringKeys(src[key]);
  }
  // Re-key in sorted order for stable JSON output.
  const sorted: CspDomainSet = {};
  for (const key of Object.keys(out).sort()) {
    (sorted as Record<string, unknown>)[key] = (out as Record<string, unknown>)[
      key
    ];
  }
  return sorted;
}

// Canonicalize the inspector-only `allowFeatures` extra Permissions Policy
// entries. Keys are kebab-case Permissions Policy tokens; values are allowlist
// strings. The 4 spec features are silently dropped — `permissions.allow` is
// the single source of truth for them.
function canonicalizeAllowFeatures(
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(
      "hostConfigV2: mcpProfile.apps.sandbox.allowFeatures must be a plain object",
    );
  }
  const dropped = new Set<string>(SEP_1865_PERMISSION_FEATURES);
  const out: Record<string, string> = {};
  for (const k of Object.keys(value).sort()) {
    // Strict Permissions Policy feature-name token: lowercase ASCII kebab,
    // starting with a letter. Anything looser lets a pasted key like
    // " camera" slip past `dropped.has(k)` and re-grant a spec feature.
    if (!/^[a-z][a-z0-9-]*$/.test(k)) {
      throw new Error(
        `hostConfigV2: mcpProfile.apps.sandbox.allowFeatures key "${k}" must be a lowercase kebab-case Permissions Policy token (^[a-z][a-z0-9-]*$)`,
      );
    }
    if (dropped.has(k)) continue;
    const v = (value as Record<string, unknown>)[k];
    if (typeof v !== "string") {
      throw new Error(
        `hostConfigV2: mcpProfile.apps.sandbox.allowFeatures.${k} must be a string`,
      );
    }
    // Reject Permissions Policy directive separators in values (`;` iframe
    // allow= separator, `,` HTTP header separator) — injection guard.
    if (/[;,]/.test(v)) {
      throw new Error(
        `hostConfigV2: mcpProfile.apps.sandbox.allowFeatures.${k} must not contain ';' or ',' (Permissions Policy directive separators)`,
      );
    }
    out[k] = v;
  }
  return out;
}

// Canonicalize the inspector-only `cspDirectives` per-directive
// source-expression overrides. Rejects `;`/`,` in names and values
// (CSP directive separators) — injection guard.
function canonicalizeCspDirectives(
  value: unknown,
): Record<string, string[]> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(
      "hostConfigV2: mcpProfile.apps.sandbox.csp.cspDirectives must be a plain object",
    );
  }
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(value).sort()) {
    if (!/^[a-z][a-z0-9-]*$/.test(k)) {
      throw new Error(
        `hostConfigV2: mcpProfile.apps.sandbox.csp.cspDirectives key "${k}" must be a lowercase kebab-case CSP directive name (^[a-z][a-z0-9-]*$)`,
      );
    }
    const arr = (value as Record<string, unknown>)[k];
    if (!Array.isArray(arr)) {
      throw new Error(
        `hostConfigV2: mcpProfile.apps.sandbox.csp.cspDirectives.${k} must be a string[]`,
      );
    }
    const seen = new Set<string>();
    for (const entry of arr) {
      if (typeof entry !== "string") {
        throw new Error(
          `hostConfigV2: mcpProfile.apps.sandbox.csp.cspDirectives.${k} entries must be strings`,
        );
      }
      const trimmed = entry.trim();
      if (trimmed === "") continue;
      if (/[;,]/.test(trimmed)) {
        throw new Error(
          `hostConfigV2: mcpProfile.apps.sandbox.csp.cspDirectives.${k} entry "${trimmed}" must not contain ';' or ',' (CSP directive separators — injection guard)`,
        );
      }
      seen.add(trimmed);
    }
    out[k] = Array.from(seen).sort();
  }
  return out;
}

function canonicalizeMcpProfile(
  input: HostConfigMcpProfileV1 | undefined,
): HostConfigMcpProfileV1 | undefined {
  if (input === undefined) return undefined;
  if (!isPlainObject(input)) {
    throw new Error("hostConfigV2: mcpProfile must be a plain object");
  }
  // Forward-compat trip wire: a future profileVersion: 2 shape must NOT
  // silently round-trip through a v1 reader.
  if ((input as { profileVersion?: unknown }).profileVersion !== 1) {
    throw new Error("hostConfigV2: mcpProfile.profileVersion must be 1");
  }

  const out: HostConfigMcpProfileV1 = { profileVersion: 1 };

  // Host-default pinned MCP protocol version. Absent → SDK chooses at resolve
  // time; we drop the field when absent so pre-feature rows hash identically.
  if (input.mcpProtocolVersion !== undefined) {
    if (!isKnownProtocolVersion(input.mcpProtocolVersion)) {
      throw new Error(
        `hostConfigV2: mcpProfile.mcpProtocolVersion must be one of ${MCP_PROTOCOL_VERSIONS.join(", ")} (got "${String(input.mcpProtocolVersion)}")`,
      );
    }
    out.mcpProtocolVersion = input.mcpProtocolVersion;
  }

  if (input.initialize !== undefined) {
    if (!isPlainObject(input.initialize)) {
      throw new Error(
        "hostConfigV2: mcpProfile.initialize must be a plain object",
      );
    }
    const initOut: NonNullable<HostConfigMcpProfileV1["initialize"]> = {};

    if (input.initialize.supportedProtocolVersions !== undefined) {
      const versions = input.initialize.supportedProtocolVersions;
      if (!Array.isArray(versions)) {
        throw new Error(
          "hostConfigV2: mcpProfile.initialize.supportedProtocolVersions must be a string[]",
        );
      }
      if (versions.length === 0) {
        throw new Error(
          "hostConfigV2: mcpProfile.initialize.supportedProtocolVersions must be a non-empty array when set (omit the field to use SDK defaults)",
        );
      }
      for (const v of versions) {
        if (typeof v !== "string") {
          throw new Error(
            "hostConfigV2: mcpProfile.initialize.supportedProtocolVersions entries must be strings",
          );
        }
        if (v.trim() === "") {
          throw new Error(
            "hostConfigV2: mcpProfile.initialize.supportedProtocolVersions entries must be non-empty strings",
          );
        }
      }
      // Order is semantic — do NOT sort or dedupe. Preserve verbatim.
      initOut.supportedProtocolVersions = [...versions];
    }

    if (input.initialize.clientInfo !== undefined) {
      const ci = input.initialize.clientInfo;
      if (!isPlainObject(ci)) {
        throw new Error(
          "hostConfigV2: mcpProfile.initialize.clientInfo must be a plain object",
        );
      }
      // Soft validation — name & version required by the MCP lifecycle spec.
      const name = ci.name;
      const version = ci.version;
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error(
          "hostConfigV2: mcpProfile.initialize.clientInfo.name must be a non-empty string",
        );
      }
      if (typeof version !== "string" || version.trim() === "") {
        throw new Error(
          "hostConfigV2: mcpProfile.initialize.clientInfo.version must be a non-empty string",
        );
      }
      initOut.clientInfo = deepSortStringKeys(ci);
    }

    // Skip empty initialize{} so absent-vs-present hashing remains honest.
    if (Object.keys(initOut).length > 0) {
      const sortedInit: NonNullable<HostConfigMcpProfileV1["initialize"]> = {};
      for (const k of Object.keys(initOut).sort()) {
        (sortedInit as Record<string, unknown>)[k] = (
          initOut as Record<string, unknown>
        )[k];
      }
      out.initialize = sortedInit;
    }
  }

  // Cross-field rule (Option A): when `mcpProtocolVersion` pins a stateful
  // (pre-2026) version, the legacy `initialize` handshake runs and must
  // advertise that exact version. Derive when caller didn't set one; throw if
  // they set both AND the pin isn't in the list. Stateless versions skip
  // initialize entirely, so leave `supportedProtocolVersions` alone there.
  if (
    out.mcpProtocolVersion !== undefined &&
    !isStatelessProtocolVersion(out.mcpProtocolVersion)
  ) {
    const advertised = out.initialize?.supportedProtocolVersions;
    if (advertised === undefined) {
      const initBase = out.initialize ?? {};
      const initWithDerived: NonNullable<
        HostConfigMcpProfileV1["initialize"]
      > = {
        ...initBase,
        supportedProtocolVersions: [out.mcpProtocolVersion],
      };
      const sortedInit: NonNullable<HostConfigMcpProfileV1["initialize"]> = {};
      for (const k of Object.keys(initWithDerived).sort()) {
        (sortedInit as Record<string, unknown>)[k] = (
          initWithDerived as Record<string, unknown>
        )[k];
      }
      out.initialize = sortedInit;
    } else if (!advertised.includes(out.mcpProtocolVersion)) {
      throw new Error(
        `hostConfigV2: ConflictingProtocolVersionPin — mcpProtocolVersion "${out.mcpProtocolVersion}" is not in initialize.supportedProtocolVersions [${advertised.join(", ")}]. Either omit one or align them.`,
      );
    }
  }

  if (input.apps !== undefined) {
    if (!isPlainObject(input.apps)) {
      throw new Error("hostConfigV2: mcpProfile.apps must be a plain object");
    }
    const appsOut: NonNullable<HostConfigMcpProfileV1["apps"]> = {};
    if (input.apps.sandbox !== undefined) {
      if (!isPlainObject(input.apps.sandbox)) {
        throw new Error(
          "hostConfigV2: mcpProfile.apps.sandbox must be a plain object",
        );
      }
      const sandboxIn = input.apps.sandbox;
      const sandboxOut: NonNullable<
        NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
      > = {};

      if (sandboxIn.csp !== undefined) {
        if (!isPlainObject(sandboxIn.csp)) {
          throw new Error(
            "hostConfigV2: mcpProfile.apps.sandbox.csp must be a plain object",
          );
        }
        // Note: there is NO `csp.deny` field. SEP-1865 is allowlist-only —
        // `restrictTo` is the entire hardening lever. The runtime CSP
        // resolver (sdk `sandbox-policy.ts`) carries deny + a hosted clamp,
        // but that is a different layer and never persists here. If you're
        // tempted to add deny back, talk to whoever owns the resolver first.
        const cspOut: NonNullable<
          NonNullable<
            NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
          >["csp"]
        > = {};
        if (sandboxIn.csp.mode !== undefined) {
          if (
            sandboxIn.csp.mode !== "host-default" &&
            sandboxIn.csp.mode !== "declared" &&
            sandboxIn.csp.mode !== "relaxed"
          ) {
            throw new Error(
              "hostConfigV2: mcpProfile.apps.sandbox.csp.mode must be 'host-default' | 'declared' | 'relaxed'",
            );
          }
          cspOut.mode = sandboxIn.csp.mode;
        }
        const restrictTo = canonicalizeCspDomainSet(sandboxIn.csp.restrictTo);
        if (restrictTo !== undefined) cspOut.restrictTo = restrictTo;
        const cspDirectives = canonicalizeCspDirectives(
          (sandboxIn.csp as { cspDirectives?: unknown }).cspDirectives,
        );
        if (cspDirectives !== undefined)
          (
            cspOut as { cspDirectives?: Record<string, string[]> }
          ).cspDirectives = cspDirectives;
        if (sandboxIn.csp.extensions !== undefined) {
          if (!isPlainObject(sandboxIn.csp.extensions)) {
            throw new Error(
              "hostConfigV2: mcpProfile.apps.sandbox.csp.extensions must be a plain object",
            );
          }
          cspOut.extensions = deepSortStringKeys(sandboxIn.csp.extensions);
        }
        // Re-key in sorted order.
        const sortedCsp = {} as typeof cspOut;
        for (const k of Object.keys(cspOut).sort()) {
          (sortedCsp as Record<string, unknown>)[k] = (
            cspOut as Record<string, unknown>
          )[k];
        }
        sandboxOut.csp = sortedCsp;
      }

      if (sandboxIn.permissions !== undefined) {
        if (!isPlainObject(sandboxIn.permissions)) {
          throw new Error(
            "hostConfigV2: mcpProfile.apps.sandbox.permissions must be a plain object",
          );
        }
        const permsIn = sandboxIn.permissions;
        const permsOut: NonNullable<
          NonNullable<
            NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
          >["permissions"]
        > = {};
        if (permsIn.mode !== undefined) {
          if (
            permsIn.mode !== "resource-declared" &&
            permsIn.mode !== "deny-all" &&
            permsIn.mode !== "custom"
          ) {
            throw new Error(
              "hostConfigV2: mcpProfile.apps.sandbox.permissions.mode must be 'resource-declared' | 'deny-all' | 'custom'",
            );
          }
          permsOut.mode = permsIn.mode;
        }
        if (permsIn.allow !== undefined) {
          if (!isPlainObject(permsIn.allow)) {
            throw new Error(
              "hostConfigV2: mcpProfile.apps.sandbox.permissions.allow must be a plain object",
            );
          }
          const allowOut: Record<string, boolean> = {};
          for (const k of Object.keys(permsIn.allow).sort()) {
            const v = (permsIn.allow as Record<string, unknown>)[k];
            if (typeof v !== "boolean") {
              throw new Error(
                `hostConfigV2: mcpProfile.apps.sandbox.permissions.allow.${k} must be a boolean`,
              );
            }
            allowOut[k] = v;
          }
          permsOut.allow = allowOut;
        }
        if (permsIn.extensions !== undefined) {
          if (!isPlainObject(permsIn.extensions)) {
            throw new Error(
              "hostConfigV2: mcpProfile.apps.sandbox.permissions.extensions must be a plain object",
            );
          }
          permsOut.extensions = deepSortStringKeys(permsIn.extensions);
        }
        const sortedPerms = {} as typeof permsOut;
        for (const k of Object.keys(permsOut).sort()) {
          (sortedPerms as Record<string, unknown>)[k] = (
            permsOut as Record<string, unknown>
          )[k];
        }
        sandboxOut.permissions = sortedPerms;
      }

      if (
        (sandboxIn as { sandboxAttrs?: unknown }).sandboxAttrs !== undefined
      ) {
        const sandboxAttrs = canonicalizeCspDomainList(
          (sandboxIn as { sandboxAttrs?: unknown }).sandboxAttrs,
        );
        if (sandboxAttrs !== undefined) {
          (sandboxOut as { sandboxAttrs?: string[] }).sandboxAttrs =
            sandboxAttrs;
        }
      }

      if (
        (sandboxIn as { allowFeatures?: unknown }).allowFeatures !== undefined
      ) {
        const allowFeatures = canonicalizeAllowFeatures(
          (sandboxIn as { allowFeatures?: unknown }).allowFeatures,
        );
        if (allowFeatures !== undefined) {
          (
            sandboxOut as { allowFeatures?: Record<string, string> }
          ).allowFeatures = allowFeatures;
        }
      }

      if (Object.keys(sandboxOut).length > 0) {
        const sortedSandbox = {} as typeof sandboxOut;
        for (const k of Object.keys(sandboxOut).sort()) {
          (sortedSandbox as Record<string, unknown>)[k] = (
            sandboxOut as Record<string, unknown>
          )[k];
        }
        appsOut.sandbox = sortedSandbox;
      }
    }
    if (input.apps.uiInitialize !== undefined) {
      if (!isPlainObject(input.apps.uiInitialize)) {
        throw new Error(
          "hostConfigV2: mcpProfile.apps.uiInitialize must be a plain object",
        );
      }
      const uiInitOut: NonNullable<
        NonNullable<HostConfigMcpProfileV1["apps"]>["uiInitialize"]
      > = {};
      if (input.apps.uiInitialize.hostInfo !== undefined) {
        const hi = input.apps.uiInitialize.hostInfo;
        if (!isPlainObject(hi)) {
          throw new Error(
            "hostConfigV2: mcpProfile.apps.uiInitialize.hostInfo must be a plain object",
          );
        }
        // Mirror the soft validation applied to initialize.clientInfo.
        const name = (hi as Record<string, unknown>).name;
        if (typeof name !== "string" || name.trim() === "") {
          throw new Error(
            "hostConfigV2: mcpProfile.apps.uiInitialize.hostInfo.name must be a non-empty string",
          );
        }
        const version = (hi as Record<string, unknown>).version;
        if (typeof version !== "string" || version.trim() === "") {
          throw new Error(
            "hostConfigV2: mcpProfile.apps.uiInitialize.hostInfo.version must be a non-empty string",
          );
        }
        uiInitOut.hostInfo = deepSortStringKeys(hi);
      }
      if (Object.keys(uiInitOut).length > 0) {
        const sortedUiInit = {} as typeof uiInitOut;
        for (const k of Object.keys(uiInitOut).sort()) {
          (sortedUiInit as Record<string, unknown>)[k] = (
            uiInitOut as Record<string, unknown>
          )[k];
        }
        appsOut.uiInitialize = sortedUiInit;
      }
    }
    if (
      (input.apps as { compatRuntime?: unknown }).compatRuntime !== undefined
    ) {
      const compatRuntimeIn = (input.apps as { compatRuntime?: unknown })
        .compatRuntime;
      if (!isPlainObject(compatRuntimeIn)) {
        throw new Error(
          "hostConfigV2: mcpProfile.apps.compatRuntime must be a plain object",
        );
      }
      const compatRuntimeOut: NonNullable<
        NonNullable<HostConfigMcpProfileV1["apps"]>["compatRuntime"]
      > = {};
      const compatRecord = compatRuntimeIn as Record<string, unknown>;
      const openaiApps = compatRecord.openaiApps;
      if (openaiApps !== undefined) {
        if (typeof openaiApps !== "boolean") {
          throw new Error(
            "hostConfigV2: mcpProfile.apps.compatRuntime.openaiApps must be a boolean",
          );
        }
        compatRuntimeOut.openaiApps = openaiApps;
      }
      const openaiAppsOverridesIn = compatRecord.openaiAppsOverrides;
      if (openaiAppsOverridesIn !== undefined) {
        if (!isPlainObject(openaiAppsOverridesIn)) {
          throw new Error(
            "hostConfigV2: mcpProfile.apps.compatRuntime.openaiAppsOverrides must be a plain object",
          );
        }
        const overridesOut: OpenAiAppsCapabilities = {};
        for (const [key, value] of Object.entries(openaiAppsOverridesIn)) {
          if (!OPENAI_APPS_CAPABILITY_KEY_SET.has(key)) {
            throw new Error(
              `hostConfigV2: mcpProfile.apps.compatRuntime.openaiAppsOverrides has unknown key "${key}"`,
            );
          }
          if (key === "requestDisplayMode") {
            if (
              typeof value !== "string" ||
              !(
                OPENAI_APPS_REQUEST_DISPLAY_MODE_VALUES as readonly string[]
              ).includes(value)
            ) {
              throw new Error(
                'hostConfigV2: mcpProfile.apps.compatRuntime.openaiAppsOverrides.requestDisplayMode must be "all" | "fullscreen-only" | "none"',
              );
            }
            overridesOut.requestDisplayMode =
              value as OpenAiAppsCapabilities["requestDisplayMode"];
          } else {
            if (typeof value !== "boolean") {
              throw new Error(
                `hostConfigV2: mcpProfile.apps.compatRuntime.openaiAppsOverrides.${key} must be a boolean`,
              );
            }
            (overridesOut as Record<string, unknown>)[key] = value;
          }
        }
        // Empty `{}` collapses to absent (same runtime behavior as absent).
        if (Object.keys(overridesOut).length > 0) {
          const sortedOverrides = {} as OpenAiAppsCapabilities;
          for (const k of Object.keys(overridesOut).sort()) {
            (sortedOverrides as Record<string, unknown>)[k] = (
              overridesOut as Record<string, unknown>
            )[k];
          }
          compatRuntimeOut.openaiAppsOverrides = sortedOverrides;
        }
      }
      if (Object.keys(compatRuntimeOut).length > 0) {
        const sortedCompat = {} as typeof compatRuntimeOut;
        for (const k of Object.keys(compatRuntimeOut).sort()) {
          (sortedCompat as Record<string, unknown>)[k] = (
            compatRuntimeOut as Record<string, unknown>
          )[k];
        }
        appsOut.compatRuntime = sortedCompat;
      }
    }
    if (
      (input.apps as { mcpAppsOverrides?: unknown }).mcpAppsOverrides !==
      undefined
    ) {
      const mcpAppsOverridesIn = (input.apps as { mcpAppsOverrides?: unknown })
        .mcpAppsOverrides;
      if (!isPlainObject(mcpAppsOverridesIn)) {
        throw new Error(
          "hostConfigV2: mcpProfile.apps.mcpAppsOverrides must be a plain object",
        );
      }
      const mcpAppsOverridesOut: McpAppsCapabilities = {};
      for (const [key, value] of Object.entries(mcpAppsOverridesIn)) {
        if (!MCP_APPS_CAPABILITY_KEY_SET.has(key)) {
          throw new Error(
            `hostConfigV2: mcpProfile.apps.mcpAppsOverrides has unknown key "${key}"`,
          );
        }
        if (key === "availableDisplayModes") {
          if (!Array.isArray(value)) {
            throw new Error(
              "hostConfigV2: mcpProfile.apps.mcpAppsOverrides.availableDisplayModes must be an array",
            );
          }
          if (value.length === 0) {
            throw new Error(
              "hostConfigV2: mcpProfile.apps.mcpAppsOverrides.availableDisplayModes must contain at least one mode",
            );
          }
          const seen = new Set<string>();
          for (const entry of value) {
            if (
              typeof entry !== "string" ||
              !MCP_APPS_DISPLAY_MODE_VALUE_SET.has(entry)
            ) {
              throw new Error(
                'hostConfigV2: mcpProfile.apps.mcpAppsOverrides.availableDisplayModes entries must be "inline" | "fullscreen" | "pip"',
              );
            }
            seen.add(entry);
          }
          mcpAppsOverridesOut.availableDisplayModes =
            MCP_APPS_DISPLAY_MODE_VALUES.filter((m) =>
              seen.has(m),
            ) as McpAppsCapabilities["availableDisplayModes"];
        } else if (key === "widgetDisplayModeRequests") {
          if (
            typeof value !== "string" ||
            !(
              MCP_APPS_WIDGET_DISPLAY_MODE_REQUEST_VALUES as readonly string[]
            ).includes(value)
          ) {
            throw new Error(
              'hostConfigV2: mcpProfile.apps.mcpAppsOverrides.widgetDisplayModeRequests must be "accept" | "user-initiated-only" | "decline"',
            );
          }
          mcpAppsOverridesOut.widgetDisplayModeRequests =
            value as McpAppsCapabilities["widgetDisplayModeRequests"];
        } else {
          if (typeof value !== "boolean") {
            throw new Error(
              `hostConfigV2: mcpProfile.apps.mcpAppsOverrides.${key} must be a boolean`,
            );
          }
          (mcpAppsOverridesOut as Record<string, unknown>)[key] = value;
        }
      }
      // Empty `{}` collapses to absent (use preset for all dimensions).
      if (Object.keys(mcpAppsOverridesOut).length > 0) {
        const sortedMcpApps = {} as McpAppsCapabilities;
        for (const k of Object.keys(mcpAppsOverridesOut).sort()) {
          (sortedMcpApps as Record<string, unknown>)[k] = (
            mcpAppsOverridesOut as Record<string, unknown>
          )[k];
        }
        appsOut.mcpAppsOverrides = sortedMcpApps;
      }
    }
    if (Object.keys(appsOut).length > 0) {
      const sortedApps = {} as typeof appsOut;
      for (const k of Object.keys(appsOut).sort()) {
        (sortedApps as Record<string, unknown>)[k] = (
          appsOut as Record<string, unknown>
        )[k];
      }
      out.apps = sortedApps;
    }
  }

  if (input.extensions !== undefined) {
    if (!isPlainObject(input.extensions)) {
      throw new Error(
        "hostConfigV2: mcpProfile.extensions must be a plain object",
      );
    }
    out.extensions = deepSortStringKeys(input.extensions);
  }

  // Re-key the top level deterministically (profileVersion first, then sorted).
  const sorted: HostConfigMcpProfileV1 = { profileVersion: 1 };
  for (const k of Object.keys(out).sort()) {
    if (k === "profileVersion") continue;
    (sorted as Record<string, unknown>)[k] = (out as Record<string, unknown>)[
      k
    ];
  }
  return sorted;
}

// Normalize per-server connection overrides for stable hashing.
// - Validates all keys are in serverIds ∪ optionalServerIds.
// - Strips entries that carry no information.
// - Returns undefined when the normalized result is empty.
function canonicalizeServerConnectionOverrides(
  serverIds: Array<ServerId>,
  optionalServerIds: Array<ServerId>,
  overrides: HostConfigInputV2["serverConnectionOverrides"],
): CanonicalHostConfigV2["serverConnectionOverrides"] {
  if (!overrides || Object.keys(overrides).length === 0) return undefined;
  const allowedIds = new Set<string>([...serverIds, ...optionalServerIds]);
  const result: Record<
    string,
    {
      headersOverride?: Record<string, string>;
      requestTimeoutOverride?: number;
      mcpProtocolVersionOverride?: McpProtocolVersion;
    }
  > = {};
  for (const [serverId, entry] of Object.entries(overrides)) {
    if (!allowedIds.has(serverId)) {
      throw new Error(
        `hostConfigV2: serverConnectionOverrides key "${serverId}" is not in serverIds or optionalServerIds`,
      );
    }
    if (!entry) continue;
    const normalizedHeaders =
      entry.headersOverride && Object.keys(entry.headersOverride).length > 0
        ? sortStringKeys(entry.headersOverride)
        : undefined;
    let mcpProtocolVersionOverride: McpProtocolVersion | undefined;
    if (entry.mcpProtocolVersionOverride !== undefined) {
      if (!isKnownProtocolVersion(entry.mcpProtocolVersionOverride)) {
        throw new Error(
          `hostConfigV2: serverConnectionOverrides["${serverId}"].mcpProtocolVersionOverride must be one of ${MCP_PROTOCOL_VERSIONS.join(", ")} (got "${String(entry.mcpProtocolVersionOverride)}")`,
        );
      }
      mcpProtocolVersionOverride = entry.mcpProtocolVersionOverride;
    }
    const hasContent =
      normalizedHeaders !== undefined ||
      entry.requestTimeoutOverride !== undefined ||
      mcpProtocolVersionOverride !== undefined;
    if (hasContent) {
      const entryOut: {
        headersOverride?: Record<string, string>;
        requestTimeoutOverride?: number;
        mcpProtocolVersionOverride?: McpProtocolVersion;
      } = {
        ...(normalizedHeaders !== undefined
          ? { headersOverride: normalizedHeaders }
          : {}),
        ...(entry.requestTimeoutOverride !== undefined
          ? { requestTimeoutOverride: entry.requestTimeoutOverride }
          : {}),
        ...(mcpProtocolVersionOverride !== undefined
          ? { mcpProtocolVersionOverride }
          : {}),
      };
      // Sort inner keys for hash stability across runtimes.
      result[serverId] = sortStringKeys(entryOut);
    }
  }
  if (Object.keys(result).length === 0) return undefined;
  // Sort outer keys for hash stability.
  return sortStringKeys(
    result,
  ) as CanonicalHostConfigV2["serverConnectionOverrides"];
}

export function canonicalizeHostConfigV2(
  input: HostConfigInputV2,
): CanonicalHostConfigV2 {
  if (!Number.isFinite(input.temperature)) {
    throw new Error("hostConfigV2: temperature must be finite");
  }
  if (!Number.isFinite(input.connectionDefaults.requestTimeout)) {
    throw new Error(
      "hostConfigV2: connectionDefaults.requestTimeout must be finite",
    );
  }
  if (
    input.hostCapabilitiesOverride !== undefined &&
    (input.hostCapabilitiesOverride === null ||
      typeof input.hostCapabilitiesOverride !== "object" ||
      Array.isArray(input.hostCapabilitiesOverride))
  ) {
    throw new Error(
      "hostConfigV2: hostCapabilitiesOverride must be a plain object",
    );
  }
  if (
    input.chatUiOverride !== undefined &&
    (input.chatUiOverride === null ||
      typeof input.chatUiOverride !== "object" ||
      Array.isArray(input.chatUiOverride))
  ) {
    throw new Error("hostConfigV2: chatUiOverride must be a plain object");
  }
  return {
    schemaVersion: HOST_CONFIG_SCHEMA_VERSION_V2,
    hostStyle: input.hostStyle,
    modelId: input.modelId,
    systemPrompt: input.systemPrompt,
    temperature: input.temperature,
    requireToolApproval: input.requireToolApproval,
    // Preserve undefined-vs-set: absent hashes byte-identically to a
    // pre-feature row; explicit `false` writes a key and hashes distinctly.
    progressiveToolDiscovery: input.progressiveToolDiscovery,
    respectToolVisibility: input.respectToolVisibility,
    // Normalize undefined → [] BEFORE sort so canonical/hash output is
    // identical to the pre-tolerance "explicit empty array" case.
    serverIds: [...(input.serverIds ?? [])].sort() as Array<ServerId>,
    optionalServerIds: [...(input.optionalServerIds ?? [])].sort() as Array<
      ServerId
    >,
    connectionDefaults: {
      headers: sortStringKeys(input.connectionDefaults.headers),
      requestTimeout: input.connectionDefaults.requestTimeout,
    },
    clientCapabilities: sortStringKeys(input.clientCapabilities ?? {}),
    hostContext: sortStringKeys(input.hostContext ?? {}),
    // Preserve undefined (omitted → dedupes with preset) vs {} (explicit empty
    // → hashes distinctly).
    hostCapabilitiesOverride:
      input.hostCapabilitiesOverride === undefined
        ? undefined
        : deepSortStringKeys(input.hostCapabilitiesOverride),
    chatUiOverride:
      input.chatUiOverride === undefined
        ? undefined
        : deepSortStringKeys(input.chatUiOverride),
    mcpProfile: canonicalizeMcpProfile(input.mcpProfile),
    serverConnectionOverrides: canonicalizeServerConnectionOverrides(
      input.serverIds ?? [],
      input.optionalServerIds ?? [],
      input.serverConnectionOverrides,
    ),
  };
}
