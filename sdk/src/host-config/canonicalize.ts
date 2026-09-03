/**
 * HostConfig v2 canonicalizer — pure, browser-safe, byte-stable.
 *
 * SOURCE OF TRUTH — and the ONLY implementation: `convex/lib/hostConfigV2.ts`
 * imports this function rather than mirroring it (mcpjam-backend PR #409).
 *
 * Stable key ordering matters for hash stability across runtimes: we
 * JSON.stringify the canonical object; Object.keys preserves insertion order,
 * so we build output with a fixed key order rather than spreading user input.
 * Adding a new OPTIONAL field is safe for existing hashes as long as it is
 * omitted when absent — the golden vectors in
 * `sdk/tests/host-config-parity.test.ts` prove it and must keep passing
 * WITHOUT regeneration. See the `./types.ts` header for the backend
 * persistence caveat.
 */

import {
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
  MCP_PROTOCOL_VERSIONS,
  type McpProtocolVersion,
} from "../mcp-client-manager/mcp-protocol-version.js";
import {
  HARNESS_IDS,
  HOST_CONFIG_SCHEMA_VERSION_V2,
  isHarness,
  OAUTH_AUTH_MODELS,
  OAUTH_PROFILE_EVIDENCE_STATUSES,
  OAUTH_SCOPE_REQUEST_MODES,
  OAUTH_TOKEN_ENDPOINT_AUTH_METHODS,
  MRTR_SUPPORT_MODES,
  PAGINATION_TRAVERSAL_MODES,
  SEP_1865_PERMISSION_FEATURES,
  TOOL_PARAM_HEADER_MIRRORING_MODES,
  type CanonicalHostConfigSkillSelection,
  type CanonicalHostConfigV2,
  type CspDomainSet,
  type HostConfigComputer,
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
  type HostConfigOAuthProfile,
  type HostConfigOAuthProfileV1,
  type HostConfigOAuthProfileV2,
  type OAuthAuthModel,
  type OAuthDcrIdentity,
  type OAuthProfileEvidence,
  type OAuthProtocolVersionPinning,
  type OAuthScopeRequest,
  type OAuthSpecVersionClaim,
  type OAuthTokenEndpointAuthMethod,
  type McpAppsCapabilities,
  type McpToolResultBlobVisibility,
  type McpToolResultImageRenderingPolicy,
  type ModelVisibleMcpToolResults,
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
  OPENAI_APPS_CAPABILITY_KEYS
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
  "cspConnectDomains",
  "cspResourceDomains",
  "resourceCacheTtl",
  "toolResult",
  "resourcePrefersBorder",
  "downloadFile",
  "requestTeardown",
  "widgetDisplayModeRequests",
] as const satisfies ReadonlyArray<keyof McpAppsCapabilities>;

const MCP_APPS_CAPABILITY_KEY_SET: ReadonlySet<string> = new Set(
  MCP_APPS_CAPABILITY_KEYS
);

const MCP_APPS_DISPLAY_MODE_VALUES = ["inline", "fullscreen", "pip"] as const;

const MCP_APPS_WIDGET_DISPLAY_MODE_REQUEST_VALUES = [
  "accept",
  "user-initiated-only",
  "decline",
] as const;
const MCP_APPS_DISPLAY_MODE_VALUE_SET: ReadonlySet<string> = new Set(
  MCP_APPS_DISPLAY_MODE_VALUES
);

function sortStringKeys<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input).sort()) out[k] = input[k];
  return out as T;
}

// Fail-fast guard for fields the HostConfigInputV2 type marks required
// but the canonicalizer historically coalesced via `?? {}`. The empty-object
// fallback hides a real write-path bug: a caller passing undefined silently
// dedupes into whichever existing row also happens to have empty caps.
// Plain-object check defends against arrays/primitives slipping past
// upstream `v.any()` validators. Returns a deep-sorted copy so nested key
// order doesn't leak into the hash.
function requireRecord(
  value: unknown,
  fieldName: string
): Record<string, unknown> {
  if (value === undefined) {
    throw new Error(`hostConfigV2: ${fieldName} is required`);
  }
  // Reuses the shared isPlainObject predicate (now prototype-guarded), so
  // Date / class instance / Map / Set inputs hit a hard error here instead
  // of silently canonicalizing to `{}` and merging with the empty-record
  // dedupe pool. Only `{}` literals and Object.create(null) records are
  // accepted — both are valid JSON-serializable plain objects.
  if (!isPlainObject(value)) {
    throw new Error(`hostConfigV2: ${fieldName} must be a plain object`);
  }
  return deepSortStringKeys(value);
}

const DIRECT_CONTENT_VISIBILITY_KEYS = ["text", "image", "audio"] as const;
const RESOURCE_VISIBILITY_KEYS = ["text", "blob"] as const;
const BLOB_VISIBILITY_KEYS = [
  "enabled",
  "image",
  "audio",
  "document",
  "video",
  "otherBinary",
] as const;
const MCP_TOOL_RESULT_IMAGE_RENDERING_KEYS = [
  "placement",
  "directContent",
  "embeddedResources",
  "linkedResources",
] as const;
const MCP_TOOL_RESULT_IMAGE_RENDERING_DIRECT_CONTENT_KEYS = ["image"] as const;
const MCP_TOOL_RESULT_IMAGE_RENDERING_RESOURCE_KEYS = ["blob"] as const;
const MCP_TOOL_RESULT_IMAGE_RENDERING_BLOB_KEYS = ["image"] as const;

function assertOnlyKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  fieldName: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`hostConfigV2: ${fieldName}.${key} is not supported`);
    }
  }
}

function readOptionalBoolean(
  value: Record<string, unknown>,
  key: string,
  fieldName: string
): boolean | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") {
    throw new Error(`hostConfigV2: ${fieldName}.${key} must be a boolean`);
  }
  return raw;
}

function canonicalizeBooleanLeaves<const Keys extends ReadonlyArray<string>>(
  value: unknown,
  keys: Keys,
  fieldName: string
): { [K in Keys[number]]?: boolean } | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(`hostConfigV2: ${fieldName} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  assertOnlyKnownKeys(record, new Set(keys), fieldName);

  const out: Record<string, boolean> = {};
  for (const key of keys) {
    const bool = readOptionalBoolean(record, key, fieldName);
    if (bool !== undefined) out[key] = bool;
  }
  return Object.keys(out).length > 0
    ? (out as { [K in Keys[number]]?: boolean })
    : undefined;
}

function canonicalizeBlobVisibility(
  value: unknown,
  fieldName: string
): McpToolResultBlobVisibility | undefined {
  return canonicalizeBooleanLeaves(value, BLOB_VISIBILITY_KEYS, fieldName);
}

function canonicalizeResourceVisibility(
  value: unknown,
  fieldName: string
):
  | {
      text?: boolean;
      blob?: McpToolResultBlobVisibility;
    }
  | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(`hostConfigV2: ${fieldName} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  assertOnlyKnownKeys(record, new Set(RESOURCE_VISIBILITY_KEYS), fieldName);

  const text = readOptionalBoolean(record, "text", fieldName);
  const blob = canonicalizeBlobVisibility(record.blob, `${fieldName}.blob`);
  const out = {
    ...(text !== undefined ? { text } : {}),
    ...(blob !== undefined ? { blob } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function canonicalizeModelVisibleMcpToolResults(
  value: unknown
): ModelVisibleMcpToolResults | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(
      "hostConfigV2: modelVisibleMcpToolResults must be a plain object"
    );
  }
  const record = value as Record<string, unknown>;
  assertOnlyKnownKeys(
    record,
    new Set(["directContent", "embeddedResources", "linkedResources"]),
    "modelVisibleMcpToolResults"
  );

  const directContent = canonicalizeBooleanLeaves(
    record.directContent,
    DIRECT_CONTENT_VISIBILITY_KEYS,
    "modelVisibleMcpToolResults.directContent"
  );
  const embeddedResources = canonicalizeResourceVisibility(
    record.embeddedResources,
    "modelVisibleMcpToolResults.embeddedResources"
  );
  const linkedResources = canonicalizeResourceVisibility(
    record.linkedResources,
    "modelVisibleMcpToolResults.linkedResources"
  );
  const out = {
    ...(directContent !== undefined ? { directContent } : {}),
    ...(embeddedResources !== undefined ? { embeddedResources } : {}),
    ...(linkedResources !== undefined ? { linkedResources } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function readOptionalMcpToolResultImageRenderPlacement(
  value: Record<string, unknown>,
  key: string,
  fieldName: string
): "none" | "collapsed" | "inline" | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (raw !== "none" && raw !== "collapsed" && raw !== "inline") {
    throw new Error(
      `hostConfigV2: ${fieldName}.${key} must be "none", "collapsed", or "inline"`
    );
  }
  return raw;
}

function canonicalizeImageRenderingResource(
  value: unknown,
  fieldName: string
):
  | {
      blob?: {
        image?: boolean;
      };
    }
  | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(`hostConfigV2: ${fieldName} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  assertOnlyKnownKeys(
    record,
    new Set(MCP_TOOL_RESULT_IMAGE_RENDERING_RESOURCE_KEYS),
    fieldName
  );
  const blob = canonicalizeBooleanLeaves(
    record.blob,
    MCP_TOOL_RESULT_IMAGE_RENDERING_BLOB_KEYS,
    `${fieldName}.blob`
  );
  const out = {
    ...(blob !== undefined ? { blob } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function canonicalizeMcpToolResultImageRenderingPolicy(
  value: unknown
): McpToolResultImageRenderingPolicy | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(
      "hostConfigV2: mcpToolResultImageRendering must be a plain object"
    );
  }
  const record = value as Record<string, unknown>;
  assertOnlyKnownKeys(
    record,
    new Set(MCP_TOOL_RESULT_IMAGE_RENDERING_KEYS),
    "mcpToolResultImageRendering"
  );

  const placement = readOptionalMcpToolResultImageRenderPlacement(
    record,
    "placement",
    "mcpToolResultImageRendering"
  );
  const directContent = canonicalizeBooleanLeaves(
    record.directContent,
    MCP_TOOL_RESULT_IMAGE_RENDERING_DIRECT_CONTENT_KEYS,
    "mcpToolResultImageRendering.directContent"
  );
  const embeddedResources = canonicalizeImageRenderingResource(
    record.embeddedResources,
    "mcpToolResultImageRendering.embeddedResources"
  );
  const linkedResources = canonicalizeImageRenderingResource(
    record.linkedResources,
    "mcpToolResultImageRendering.linkedResources"
  );
  const out = {
    ...(placement !== undefined ? { placement } : {}),
    ...(directContent !== undefined ? { directContent } : {}),
    ...(embeddedResources !== undefined ? { embeddedResources } : {}),
    ...(linkedResources !== undefined ? { linkedResources } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
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

function sortUniqueServerIds(
  ids: Array<ServerId> | undefined
): Array<ServerId> {
  return Array.from(new Set(ids ?? [])).sort() as Array<ServerId>;
}

// Canonicalize built-in tool ids as a SET: validate wire shape, dedupe, sort.
// IDs are OPAQUE to the SDK — there is NO enum/catalog check here (the backend
// validates existence + org scope against the `builtInTools` table). Order is
// not semantic, so we dedupe + sort like serverIds. Absent (undefined) OR empty
// ([]) collapses to `undefined` so the key is dropped from the canonical JSON,
// keeping every pre-feature row's hash byte-identical (precedent: the
// allowFeatures / serverConnectionOverrides empty-collapse). Entries are stored
// verbatim (never trimmed) so a malformed id like "web_search " is preserved
// and rejected downstream by the catalog scope check rather than silently fixed.
function canonicalizeBuiltInToolIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("hostConfigV2: builtInToolIds must be a string[]");
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error("hostConfigV2: builtInToolIds entries must be strings");
    }
    if (entry.trim() === "") {
      throw new Error(
        "hostConfigV2: builtInToolIds entries must be non-empty strings"
      );
    }
    seen.add(entry);
  }
  if (seen.size === 0) return undefined;
  return Array.from(seen).sort();
}

// Allowed keys per skillSelection mode. Explicit construction below keeps
// stray keys out of the canonical JSON; these sets make a stray key a loud
// error instead of a silent drop (the `computer` precedent).
const SKILL_SELECTION_ALL_VISIBLE_KEYS = new Set(["mode"]);
const SKILL_SELECTION_EXPLICIT_KEYS = new Set(["mode", "skillIds"]);

// Canonicalize the skill selection policy.
//
// SINGLE-IDENTITY RULE: `{ mode: "all-visible" }` canonicalizes to ABSENT
// (returns undefined, dropping the key). Absent and explicit all-visible have
// identical runtime behavior — the legacy "advertise every visible skill"
// path — so keeping both encodings would mint two content-addressed
// identities for one behavior, breaking hostConfig dedupe and host
// comparison. One behavior, one canonical byte sequence.
//
// `{ mode: "explicit", skillIds }` is preserved — INCLUDING an empty
// skillIds, which means "explicitly no skills" and must hash
// distinctly from absent (absence is semantic here; contrast the
// builtInToolIds empty-collapse). Explicit skillIds are deduped + sorted
// like every other unordered id set. Entries are OPAQUE skill ids to the SDK:
// wire-shape validated only, never dereferenced.
function canonicalizeSkillSelection(
  value: unknown
): CanonicalHostConfigSkillSelection | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error("hostConfigV2: skillSelection must be a plain object");
  }
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  if (mode === "all-visible") {
    assertOnlyKnownKeys(
      record,
      SKILL_SELECTION_ALL_VISIBLE_KEYS,
      "skillSelection"
    );
    // Same behavior as absent → same identity (see SINGLE-IDENTITY RULE).
    return undefined;
  }
  if (mode === "explicit") {
    assertOnlyKnownKeys(
      record,
      SKILL_SELECTION_EXPLICIT_KEYS,
      "skillSelection"
    );
    const skillIds = record.skillIds;
    if (!Array.isArray(skillIds)) {
      throw new Error(
        'hostConfigV2: skillSelection.skillIds must be a string[] when mode is "explicit"'
      );
    }
    const seen = new Set<string>();
    for (const entry of skillIds) {
      if (typeof entry !== "string") {
        throw new Error(
          "hostConfigV2: skillSelection.skillIds entries must be strings"
        );
      }
      if (entry.trim() === "") {
        throw new Error(
          "hostConfigV2: skillSelection.skillIds entries must be non-empty strings"
        );
      }
      seen.add(entry);
    }
    // Key order (mode, skillIds) is already sorted — stable canonical JSON.
    return { mode: "explicit", skillIds: Array.from(seen).sort() };
  }
  throw new Error(
    'hostConfigV2: skillSelection.mode must be "all-visible" | "explicit"'
  );
}

// Plain-object guard shared by hostCapabilitiesOverride and mcpProfile.
// Arrays/null satisfy `typeof === 'object'`; the canonicalizer is the
// chokepoint.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  // Reject Date, Map, Set, class instances, etc. — `Object.keys` returns
  // `[]` on most of these, so without this guard they'd canonicalize to
  // `{}` and silently merge with the empty-record dedupe pool. Plain
  // objects have a prototype of either `Object.prototype` (literal `{}`)
  // or `null` (Object.create(null)).
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonicalBooleanCapabilityRecord(
  path: string,
  value: unknown,
  allowedKeys: readonly string[]
): Record<string, boolean> {
  if (!isPlainObject(value)) {
    throw new Error(`hostConfigV2: ${path} must be a plain object`);
  }
  const out: Record<string, boolean> = {};
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`hostConfigV2: ${path} has unknown key "${key}"`);
    }
    if (typeof value[key] !== "boolean") {
      throw new Error(`hostConfigV2: ${path}.${key} must be a boolean`);
    }
  }
  for (const key of allowedKeys) {
    if (value[key] !== undefined) out[key] = value[key] as boolean;
  }
  return out;
}

// Canonicalize a CSP domain list as a SET: trim, drop empty, dedupe, sort.
// Order has no meaning for CSP allowlists (contrast supportedProtocolVersions,
// where order IS semantic).
function canonicalizeCspDomainList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      "hostConfigV2: mcpProfile CSP domain list must be a string[]"
    );
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        "hostConfigV2: mcpProfile CSP domain list entries must be strings"
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
      "hostConfigV2: mcpProfile CSP restrictTo must be a plain object"
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
  value: unknown
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(
      "hostConfigV2: mcpProfile.apps.sandbox.allowFeatures must be a plain object"
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
        `hostConfigV2: mcpProfile.apps.sandbox.allowFeatures key "${k}" must be a lowercase kebab-case Permissions Policy token (^[a-z][a-z0-9-]*$)`
      );
    }
    if (dropped.has(k)) continue;
    const v = (value as Record<string, unknown>)[k];
    if (typeof v !== "string") {
      throw new Error(
        `hostConfigV2: mcpProfile.apps.sandbox.allowFeatures.${k} must be a string`
      );
    }
    // Reject Permissions Policy directive separators in values (`;` iframe
    // allow= separator, `,` HTTP header separator) — injection guard.
    if (/[;,]/.test(v)) {
      throw new Error(
        `hostConfigV2: mcpProfile.apps.sandbox.allowFeatures.${k} must not contain ';' or ',' (Permissions Policy directive separators)`
      );
    }
    out[k] = v;
  }
  // Collapse to absent when every key was dropped (input was `{}` or only
  // contained spec-feature keys). Matches the sibling `openaiAppsOverrides`
  // behavior so an empty allowlist doesn't hash distinctly from "no entries".
  if (Object.keys(out).length === 0) return undefined;
  return out;
}

// Canonicalize the inspector-only `cspDirectives` per-directive
// source-expression overrides. Rejects `;`/`,` in names and values
// (CSP directive separators) — injection guard.
function canonicalizeCspDirectives(
  value: unknown
): Record<string, string[]> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(
      "hostConfigV2: mcpProfile.apps.sandbox.csp.cspDirectives must be a plain object"
    );
  }
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(value).sort()) {
    if (!/^[a-z][a-z0-9-]*$/.test(k)) {
      throw new Error(
        `hostConfigV2: mcpProfile.apps.sandbox.csp.cspDirectives key "${k}" must be a lowercase kebab-case CSP directive name (^[a-z][a-z0-9-]*$)`
      );
    }
    const arr = (value as Record<string, unknown>)[k];
    if (!Array.isArray(arr)) {
      throw new Error(
        `hostConfigV2: mcpProfile.apps.sandbox.csp.cspDirectives.${k} must be a string[]`
      );
    }
    const seen = new Set<string>();
    for (const entry of arr) {
      if (typeof entry !== "string") {
        throw new Error(
          `hostConfigV2: mcpProfile.apps.sandbox.csp.cspDirectives.${k} entries must be strings`
        );
      }
      const trimmed = entry.trim();
      if (trimmed === "") continue;
      if (/[;,]/.test(trimmed)) {
        throw new Error(
          `hostConfigV2: mcpProfile.apps.sandbox.csp.cspDirectives.${k} entry "${trimmed}" must not contain ';' or ',' (CSP directive separators — injection guard)`
        );
      }
      seen.add(trimmed);
    }
    out[k] = Array.from(seen).sort();
  }
  return out;
}

function canonicalizeMcpProfile(
  input: HostConfigMcpProfileV1 | undefined
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

  // Host-default protocol selection. `auto` is a storage-only policy; concrete
  // values are wire pins. Absent stays accepted for legacy rows.
  if (input.mcpProtocolVersion !== undefined) {
    if (
      input.mcpProtocolVersion !== "auto" &&
      !isKnownProtocolVersion(input.mcpProtocolVersion)
    ) {
      throw new Error(
        `hostConfigV2: mcpProfile.mcpProtocolVersion must be "auto" or one of ${MCP_PROTOCOL_VERSIONS.join(
          ", "
        )} (got "${String(input.mcpProtocolVersion)}")`
      );
    }
    out.mcpProtocolVersion = input.mcpProtocolVersion;
  }

  // SEP-2243 `Mcp-Param-*` mirroring policy for the simulated client. Same
  // omit-when-absent discipline as the pin above: absent → the SDK mirrors
  // (spec-conforming), and pre-feature rows keep hashing identically.
  if (input.toolParamHeaderMirroring !== undefined) {
    if (
      !TOOL_PARAM_HEADER_MIRRORING_MODES.includes(
        input.toolParamHeaderMirroring as (typeof TOOL_PARAM_HEADER_MIRRORING_MODES)[number]
      )
    ) {
      throw new Error(
        `hostConfigV2: mcpProfile.toolParamHeaderMirroring must be one of ${TOOL_PARAM_HEADER_MIRRORING_MODES.join(
          ", "
        )} (got "${String(input.toolParamHeaderMirroring)}")`
      );
    }
    out.toolParamHeaderMirroring = input.toolParamHeaderMirroring;
  }

  // Nested boolean record like `toolListChanged` below, one leaf per era: a
  // host can cancel on 2025 and not on 2026. Absent per leaf is the conforming
  // answer, so only an explicit `false` is emitted, and a malformed value is
  // rejected rather than coerced — the backend validates this field the same
  // way, and a coerced value would hash differently on the two sides.
  if (input.toolCallCancellation !== undefined) {
    const cancellation = canonicalBooleanCapabilityRecord(
      "mcpProfile.toolCallCancellation",
      input.toolCallCancellation,
      ["legacy", "modern"]
    );
    if (Object.keys(cancellation).length > 0) {
      out.toolCallCancellation = cancellation;
    }
  }

  // Client-conformance knobs (siblings of toolParamHeaderMirroring). Same
  // omit-when-absent discipline: absent → spec-conforming, hashes stable.
  // One validation loop; the top-level re-key below sorts every emitted
  // field into canonical position.
  const conformanceKnobs = [
    ["paginationTraversal", PAGINATION_TRAVERSAL_MODES],
    ["mrtrSupport", MRTR_SUPPORT_MODES],
  ] as const;
  for (const [key, modes] of conformanceKnobs) {
    const value = input[key];
    if (value === undefined) continue;
    if (!(modes as readonly string[]).includes(value as string)) {
      throw new Error(
        `hostConfigV2: mcpProfile.${key} must be one of ${modes.join(
          ", "
        )} (got "${String(value)}")`
      );
    }
    (out as Record<string, unknown>)[key] = value;
  }

  if (input.initialize !== undefined) {
    if (!isPlainObject(input.initialize)) {
      throw new Error(
        "hostConfigV2: mcpProfile.initialize must be a plain object"
      );
    }
    const initOut: NonNullable<HostConfigMcpProfileV1["initialize"]> = {};

    if (input.initialize.supportedProtocolVersions !== undefined) {
      const versions = input.initialize.supportedProtocolVersions;
      if (!Array.isArray(versions)) {
        throw new Error(
          "hostConfigV2: mcpProfile.initialize.supportedProtocolVersions must be a string[]"
        );
      }
      if (versions.length === 0) {
        throw new Error(
          "hostConfigV2: mcpProfile.initialize.supportedProtocolVersions must be a non-empty array when set (omit the field to use SDK defaults)"
        );
      }
      for (const v of versions) {
        if (typeof v !== "string") {
          throw new Error(
            "hostConfigV2: mcpProfile.initialize.supportedProtocolVersions entries must be strings"
          );
        }
        if (v.trim() === "") {
          throw new Error(
            "hostConfigV2: mcpProfile.initialize.supportedProtocolVersions entries must be non-empty strings"
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
          "hostConfigV2: mcpProfile.initialize.clientInfo must be a plain object"
        );
      }
      // Soft validation — name & version required by the MCP lifecycle spec.
      const name = ci.name;
      const version = ci.version;
      if (typeof name !== "string" || name.trim() === "") {
        throw new Error(
          "hostConfigV2: mcpProfile.initialize.clientInfo.name must be a non-empty string"
        );
      }
      if (typeof version !== "string" || version.trim() === "") {
        throw new Error(
          "hostConfigV2: mcpProfile.initialize.clientInfo.version must be a non-empty string"
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

  // Sibling to the enum-typed conformance knobs above, but a nested boolean
  // record (two independently-measured facts) rather than a mode string.
  // Same omit-when-absent discipline: absent -> spec-conforming, hashes
  // stable.
  if (input.toolListChanged !== undefined) {
    const listChanged = canonicalBooleanCapabilityRecord(
      "mcpProfile.toolListChanged",
      input.toolListChanged,
      ["listens", "refetches"]
    );
    if (Object.keys(listChanged).length > 0) {
      out.toolListChanged = listChanged;
    }
  }

  // A legacy pin must be one of the versions accepted by initialize. Derive a
  // missing list because initialize needs one. Modern pins use server/discover
  // and are deliberately separate from the legacy initialize accept-list.
  if (
    out.mcpProtocolVersion !== undefined &&
    out.mcpProtocolVersion !== "auto" &&
    !isStatelessProtocolVersion(out.mcpProtocolVersion)
  ) {
    const advertised = out.initialize?.supportedProtocolVersions;
    if (advertised === undefined) {
      const initBase = out.initialize ?? {};
      const initWithDerived: NonNullable<HostConfigMcpProfileV1["initialize"]> =
        {
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
        `hostConfigV2: ConflictingProtocolVersionPin — mcpProtocolVersion "${
          out.mcpProtocolVersion
        }" is not in initialize.supportedProtocolVersions [${advertised.join(
          ", "
        )}]. Either omit one or align them.`
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
          "hostConfigV2: mcpProfile.apps.sandbox must be a plain object"
        );
      }
      const sandboxIn = input.apps.sandbox;
      const sandboxOut: NonNullable<
        NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
      > = {};

      if (sandboxIn.csp !== undefined) {
        if (!isPlainObject(sandboxIn.csp)) {
          throw new Error(
            "hostConfigV2: mcpProfile.apps.sandbox.csp must be a plain object"
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
              "hostConfigV2: mcpProfile.apps.sandbox.csp.mode must be 'host-default' | 'declared' | 'relaxed'"
            );
          }
          cspOut.mode = sandboxIn.csp.mode;
        }
        const restrictTo = canonicalizeCspDomainSet(sandboxIn.csp.restrictTo);
        if (restrictTo !== undefined) cspOut.restrictTo = restrictTo;
        const cspDirectives = canonicalizeCspDirectives(
          (sandboxIn.csp as { cspDirectives?: unknown }).cspDirectives
        );
        if (cspDirectives !== undefined)
          (
            cspOut as { cspDirectives?: Record<string, string[]> }
          ).cspDirectives = cspDirectives;
        if (sandboxIn.csp.extensions !== undefined) {
          if (!isPlainObject(sandboxIn.csp.extensions)) {
            throw new Error(
              "hostConfigV2: mcpProfile.apps.sandbox.csp.extensions must be a plain object"
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
            "hostConfigV2: mcpProfile.apps.sandbox.permissions must be a plain object"
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
              "hostConfigV2: mcpProfile.apps.sandbox.permissions.mode must be 'resource-declared' | 'deny-all' | 'custom'"
            );
          }
          permsOut.mode = permsIn.mode;
        }
        if (permsIn.allow !== undefined) {
          if (!isPlainObject(permsIn.allow)) {
            throw new Error(
              "hostConfigV2: mcpProfile.apps.sandbox.permissions.allow must be a plain object"
            );
          }
          const allowOut: Record<string, boolean> = {};
          for (const k of Object.keys(permsIn.allow).sort()) {
            const v = (permsIn.allow as Record<string, unknown>)[k];
            if (typeof v !== "boolean") {
              throw new Error(
                `hostConfigV2: mcpProfile.apps.sandbox.permissions.allow.${k} must be a boolean`
              );
            }
            allowOut[k] = v;
          }
          permsOut.allow = allowOut;
        }
        if (permsIn.extensions !== undefined) {
          if (!isPlainObject(permsIn.extensions)) {
            throw new Error(
              "hostConfigV2: mcpProfile.apps.sandbox.permissions.extensions must be a plain object"
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
        (sandboxIn as { browserStorage?: unknown }).browserStorage !== undefined
      ) {
        const browserStorage = canonicalBooleanCapabilityRecord(
          "mcpProfile.apps.sandbox.browserStorage",
          (sandboxIn as { browserStorage?: unknown }).browserStorage,
          ["localStorage", "sessionStorage", "indexedDB"]
        );
        if (Object.keys(browserStorage).length > 0) {
          (
            sandboxOut as { browserStorage?: Record<string, boolean> }
          ).browserStorage = browserStorage;
        }
      }

      if (
        (sandboxIn as { sandboxAttrs?: unknown }).sandboxAttrs !== undefined
      ) {
        const sandboxAttrs = canonicalizeCspDomainList(
          (sandboxIn as { sandboxAttrs?: unknown }).sandboxAttrs
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
          (sandboxIn as { allowFeatures?: unknown }).allowFeatures
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
          "hostConfigV2: mcpProfile.apps.uiInitialize must be a plain object"
        );
      }
      const uiInitOut: NonNullable<
        NonNullable<HostConfigMcpProfileV1["apps"]>["uiInitialize"]
      > = {};
      if (input.apps.uiInitialize.hostInfo !== undefined) {
        const hi = input.apps.uiInitialize.hostInfo;
        if (!isPlainObject(hi)) {
          throw new Error(
            "hostConfigV2: mcpProfile.apps.uiInitialize.hostInfo must be a plain object"
          );
        }
        // Mirror the soft validation applied to initialize.clientInfo.
        const name = (hi as Record<string, unknown>).name;
        if (typeof name !== "string" || name.trim() === "") {
          throw new Error(
            "hostConfigV2: mcpProfile.apps.uiInitialize.hostInfo.name must be a non-empty string"
          );
        }
        const version = (hi as Record<string, unknown>).version;
        if (typeof version !== "string" || version.trim() === "") {
          throw new Error(
            "hostConfigV2: mcpProfile.apps.uiInitialize.hostInfo.version must be a non-empty string"
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
          "hostConfigV2: mcpProfile.apps.compatRuntime must be a plain object"
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
            "hostConfigV2: mcpProfile.apps.compatRuntime.openaiApps must be a boolean"
          );
        }
        compatRuntimeOut.openaiApps = openaiApps;
      }
      const openaiAppsOverridesIn = compatRecord.openaiAppsOverrides;
      if (openaiAppsOverridesIn !== undefined) {
        if (!isPlainObject(openaiAppsOverridesIn)) {
          throw new Error(
            "hostConfigV2: mcpProfile.apps.compatRuntime.openaiAppsOverrides must be a plain object"
          );
        }
        const overridesOut: OpenAiAppsCapabilities = {};
        for (const [key, value] of Object.entries(openaiAppsOverridesIn)) {
          if (!OPENAI_APPS_CAPABILITY_KEY_SET.has(key)) {
            throw new Error(
              `hostConfigV2: mcpProfile.apps.compatRuntime.openaiAppsOverrides has unknown key "${key}"`
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
                'hostConfigV2: mcpProfile.apps.compatRuntime.openaiAppsOverrides.requestDisplayMode must be "all" | "fullscreen-only" | "none"'
              );
            }
            overridesOut.requestDisplayMode =
              value as OpenAiAppsCapabilities["requestDisplayMode"];
          } else {
            if (typeof value !== "boolean") {
              throw new Error(
                `hostConfigV2: mcpProfile.apps.compatRuntime.openaiAppsOverrides.${key} must be a boolean`
              );
            }
            (overridesOut as Record<string, unknown>)[key] = value;
          }
        }
        // Empty `{}` collapses to absent (same runtime behavior as absent).
        // Also drop when injection is explicitly disabled: the resolver
        // ignores per-method overrides when `openaiApps: false`, so letting
        // them affect the hash would mint distinct rows that resolve to
        // identical runtime behavior.
        if (
          Object.keys(overridesOut).length > 0 &&
          compatRuntimeOut.openaiApps !== false
        ) {
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
          "hostConfigV2: mcpProfile.apps.mcpAppsOverrides must be a plain object"
        );
      }
      const mcpAppsOverridesOut: McpAppsCapabilities = {};
      for (const [key, value] of Object.entries(mcpAppsOverridesIn)) {
        if (!MCP_APPS_CAPABILITY_KEY_SET.has(key)) {
          throw new Error(
            `hostConfigV2: mcpProfile.apps.mcpAppsOverrides has unknown key "${key}"`
          );
        }
        if (key === "availableDisplayModes") {
          if (!Array.isArray(value)) {
            throw new Error(
              "hostConfigV2: mcpProfile.apps.mcpAppsOverrides.availableDisplayModes must be an array"
            );
          }
          if (value.length === 0) {
            throw new Error(
              "hostConfigV2: mcpProfile.apps.mcpAppsOverrides.availableDisplayModes must contain at least one mode"
            );
          }
          const seen = new Set<string>();
          for (const entry of value) {
            if (
              typeof entry !== "string" ||
              !MCP_APPS_DISPLAY_MODE_VALUE_SET.has(entry)
            ) {
              throw new Error(
                'hostConfigV2: mcpProfile.apps.mcpAppsOverrides.availableDisplayModes entries must be "inline" | "fullscreen" | "pip"'
              );
            }
            seen.add(entry);
          }
          mcpAppsOverridesOut.availableDisplayModes =
            MCP_APPS_DISPLAY_MODE_VALUES.filter((m) =>
              seen.has(m)
            ) as McpAppsCapabilities["availableDisplayModes"];
        } else if (key === "cspConnectDomains") {
          const domains = canonicalBooleanCapabilityRecord(
            "mcpProfile.apps.mcpAppsOverrides.cspConnectDomains",
            value,
            ["fetch", "xhr", "websocket"]
          );
          if (Object.keys(domains).length > 0) {
            mcpAppsOverridesOut.cspConnectDomains = domains;
          }
        } else if (key === "cspResourceDomains") {
          const domains = canonicalBooleanCapabilityRecord(
            "mcpProfile.apps.mcpAppsOverrides.cspResourceDomains",
            value,
            ["script", "stylesheet", "image", "font", "media"]
          );
          if (Object.keys(domains).length > 0) {
            mcpAppsOverridesOut.cspResourceDomains = domains;
          }
        } else if (key === "toolResult") {
          // Two levels: a flat `structuredContent` boolean and a nested
          // `content` record of ContentBlock kinds. Both collapse to absent
          // when empty so a probe that measured nothing hashes identically
          // to a config that never mentioned the field.
          if (!isPlainObject(value)) {
            throw new Error(
              "hostConfigV2: mcpProfile.apps.mcpAppsOverrides.toolResult must be a plain object"
            );
          }
          for (const k of Object.keys(value)) {
            if (k !== "structuredContent" && k !== "content") {
              throw new Error(
                `hostConfigV2: mcpProfile.apps.mcpAppsOverrides.toolResult has unknown key "${k}"`
              );
            }
          }
          const toolResultOut: NonNullable<McpAppsCapabilities["toolResult"]> =
            {};
          if (value.structuredContent !== undefined) {
            if (typeof value.structuredContent !== "boolean") {
              throw new Error(
                "hostConfigV2: mcpProfile.apps.mcpAppsOverrides.toolResult.structuredContent must be a boolean"
              );
            }
            toolResultOut.structuredContent = value.structuredContent;
          }
          if (value.content !== undefined) {
            const content = canonicalBooleanCapabilityRecord(
              "mcpProfile.apps.mcpAppsOverrides.toolResult.content",
              value.content,
              ["text", "image", "audio", "resource", "resourceLink"]
            );
            if (Object.keys(content).length > 0) {
              toolResultOut.content = content;
            }
          }
          if (Object.keys(toolResultOut).length > 0) {
            const sortedToolResult = {} as typeof toolResultOut;
            for (const k of Object.keys(toolResultOut).sort()) {
              (sortedToolResult as Record<string, unknown>)[k] = (
                toolResultOut as Record<string, unknown>
              )[k];
            }
            mcpAppsOverridesOut.toolResult = sortedToolResult;
          }
        } else if (key === "widgetDisplayModeRequests") {
          if (
            typeof value !== "string" ||
            !(
              MCP_APPS_WIDGET_DISPLAY_MODE_REQUEST_VALUES as readonly string[]
            ).includes(value)
          ) {
            throw new Error(
              'hostConfigV2: mcpProfile.apps.mcpAppsOverrides.widgetDisplayModeRequests must be "accept" | "user-initiated-only" | "decline"'
            );
          }
          mcpAppsOverridesOut.widgetDisplayModeRequests =
            value as McpAppsCapabilities["widgetDisplayModeRequests"];
        } else {
          if (typeof value !== "boolean") {
            throw new Error(
              `hostConfigV2: mcpProfile.apps.mcpAppsOverrides.${key} must be a boolean`
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
        "hostConfigV2: mcpProfile.extensions must be a plain object"
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
// ── OAuth profile (HP-3) ───────────────────────────────────────────────

const OAUTH_PROFILE_KEYS = [
  "profileVersion",
  "sendsResourceIndicator",
  "oauthSpecVersion",
  "protocolVersionPinning",
  "dcrIdentity",
  "authModel",
  "extensions",
] as const;
const OAUTH_PROFILE_KEY_SET: ReadonlySet<string> = new Set(OAUTH_PROFILE_KEYS);

// V2 = V1 + the two emulator fields. V1's key set stays FROZEN — a V1 row
// carrying a V2-only key is an error, not a silent widen, so the V1
// canonicalization contract cannot drift.
const OAUTH_PROFILE_V2_KEYS = [
  "profileVersion",
  "sendsResourceIndicator",
  "oauthSpecVersion",
  "protocolVersionPinning",
  "dcrIdentity",
  "authModel",
  "scopeRequest",
  "tokenEndpointAuthMethod",
  "extensions",
] as const;
const OAUTH_PROFILE_V2_KEY_SET: ReadonlySet<string> = new Set(
  OAUTH_PROFILE_V2_KEYS
);

const OAUTH_SCOPE_REQUEST_MODE_SET: ReadonlySet<string> = new Set(
  OAUTH_SCOPE_REQUEST_MODES
);
// Per-mode key sets, module-scoped like every other key set in this file
// (no per-call Set allocation, and each accepted shape is named).
const OAUTH_SCOPE_REQUEST_FIXED_KEY_SET: ReadonlySet<string> = new Set([
  "mode",
  "scopes",
]);
const OAUTH_SCOPE_REQUEST_MODE_ONLY_KEY_SET: ReadonlySet<string> = new Set([
  "mode",
]);
const OAUTH_TOKEN_ENDPOINT_AUTH_METHOD_SET: ReadonlySet<string> = new Set(
  OAUTH_TOKEN_ENDPOINT_AUTH_METHODS
);

const OAUTH_EVIDENCE_KEYS = [
  "status",
  "value",
  "source",
  "capturedAt",
  "reason",
] as const;
const OAUTH_EVIDENCE_KEY_SET: ReadonlySet<string> = new Set(
  OAUTH_EVIDENCE_KEYS
);
const OAUTH_EVIDENCE_STATUS_SET: ReadonlySet<string> = new Set(
  OAUTH_PROFILE_EVIDENCE_STATUSES
);
const OAUTH_AUTH_MODEL_SET: ReadonlySet<string> = new Set(OAUTH_AUTH_MODELS);

const OAUTH_DCR_IDENTITY_KEYS = [
  "clientName",
  "redirectUris",
  "userAgent",
] as const;
const OAUTH_DCR_IDENTITY_KEY_SET: ReadonlySet<string> = new Set(
  OAUTH_DCR_IDENTITY_KEYS
);

/** Non-empty-after-trim string reader. Returns the TRIMMED value so
 * whitespace-only differences can't fork the hash. */
function requireTrimmedString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`hostConfigV2: ${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Same emptiness rule as `requireTrimmedString`, but returns the value
 * VERBATIM. For fields whose bytes are the point (V2 `dcrIdentity.clientName`,
 * which the emulator replays into a registration body a server may gate on):
 * whitespace-only is still a missing capture, but surrounding whitespace in a
 * real capture is data that must survive canonicalization.
 */
function requireVerbatimString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`hostConfigV2: ${fieldName} must be a non-empty string`);
  }
  return value;
}

/**
 * Strict `YYYY-MM-DD` calendar date. Regex alone would accept `2026-02-31`,
 * so the parsed date is round-tripped back to string — a capture date that
 * doesn't exist is a data-entry bug and silently storing it would make
 * staleness reporting lie.
 */
function requireIsoCalendarDate(value: unknown, fieldName: string): string {
  // Report the SHAPE requirement even when the field is simply missing —
  // "must be a non-empty string" for an absent date sends callers looking for
  // the wrong bug.
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `hostConfigV2: ${fieldName} must be an ISO calendar date (YYYY-MM-DD)`
    );
  }
  const raw = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(
      `hostConfigV2: ${fieldName} must be an ISO calendar date (YYYY-MM-DD), got "${raw}"`
    );
  }
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`hostConfigV2: ${fieldName} is not a real date ("${raw}")`);
  }
  if (parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error(`hostConfigV2: ${fieldName} is not a real date ("${raw}")`);
  }
  return raw;
}

/**
 * Canonicalize one evidence envelope.
 *
 * Enforces the invariant the type encodes for TS callers, for untyped JS
 * callers too: an `unverifiable` field may NOT carry `value` or `source`.
 * Rejecting rather than dropping is deliberate — silently stripping a value
 * would let a caller believe an unverified reading had been persisted, which
 * is precisely the failure mode this profile exists to prevent (HP-17).
 */
function canonicalizeOAuthEvidence<T>(
  input: unknown,
  fieldName: string,
  canonicalizeValue: (raw: unknown, fieldName: string) => T
): OAuthProfileEvidence<T> | undefined {
  if (input === undefined) return undefined;
  if (!isPlainObject(input)) {
    throw new Error(`hostConfigV2: ${fieldName} must be a plain object`);
  }
  assertOnlyKnownKeys(input, OAUTH_EVIDENCE_KEY_SET, fieldName);

  const status = input.status;
  if (typeof status !== "string" || !OAUTH_EVIDENCE_STATUS_SET.has(status)) {
    throw new Error(
      `hostConfigV2: ${fieldName}.status must be one of ${OAUTH_PROFILE_EVIDENCE_STATUSES.join(
        ", "
      )}`
    );
  }

  if (status === "unverifiable") {
    if (input.value !== undefined) {
      throw new Error(
        `hostConfigV2: ${fieldName}.value must be omitted when status is "unverifiable" — an unverified reading is not a value, use status "verified" with a source or leave it out`
      );
    }
    if (input.source !== undefined) {
      throw new Error(
        `hostConfigV2: ${fieldName}.source must be omitted when status is "unverifiable"`
      );
    }
    const reason = requireTrimmedString(input.reason, `${fieldName}.reason`);
    const capturedAt =
      input.capturedAt === undefined
        ? undefined
        : requireIsoCalendarDate(input.capturedAt, `${fieldName}.capturedAt`);
    // Fixed key order (see module header) — never spread user input.
    return capturedAt === undefined
      ? ({ status: "unverifiable", reason } as OAuthProfileEvidence<T>)
      : ({
          status: "unverifiable",
          reason,
          capturedAt,
        } as OAuthProfileEvidence<T>);
  }

  if (input.reason !== undefined) {
    throw new Error(
      `hostConfigV2: ${fieldName}.reason is only valid when status is "unverifiable"`
    );
  }
  if (input.value === undefined) {
    throw new Error(
      `hostConfigV2: ${fieldName}.value is required when status is "${status}"`
    );
  }
  const value = canonicalizeValue(input.value, `${fieldName}.value`);
  const source = requireTrimmedString(input.source, `${fieldName}.source`);
  const capturedAt = requireIsoCalendarDate(
    input.capturedAt,
    `${fieldName}.capturedAt`
  );
  return {
    status: status as "verified" | "refuted",
    value,
    source,
    capturedAt,
  };
}

function readOAuthBooleanValue(raw: unknown, fieldName: string): boolean {
  if (typeof raw !== "boolean") {
    throw new Error(`hostConfigV2: ${fieldName} must be a boolean`);
  }
  return raw;
}

/**
 * Spec revisions are validated by FORMAT, not against MCP_PROTOCOL_VERSIONS —
 * that enum is what this inspector speaks, not what a third-party client
 * implements. See the `OAuthSpecRevision` doc comment.
 */
function readOAuthSpecRevision(raw: unknown, fieldName: string): string {
  return requireIsoCalendarDate(raw, fieldName);
}

function readOAuthSpecVersionValue(
  raw: unknown,
  fieldName: string
): OAuthSpecVersionClaim {
  if (!isPlainObject(raw)) {
    throw new Error(
      `hostConfigV2: ${fieldName} must be a plain object with a "basis" of "constant" or "behavioral"`
    );
  }

  if (raw.basis === "constant") {
    assertOnlyKnownKeys(raw, new Set(["basis", "revisions"]), fieldName);
    if (!Array.isArray(raw.revisions)) {
      throw new Error(
        `hostConfigV2: ${fieldName}.revisions must be a string[]`
      );
    }
    if (raw.revisions.length === 0) {
      throw new Error(
        `hostConfigV2: ${fieldName}.revisions must be non-empty when basis is "constant"`
      );
    }
    const revisions = raw.revisions.map((revision, i) =>
      readOAuthSpecRevision(revision, `${fieldName}.revisions[${i}]`)
    );
    // A SET of implemented revisions — unlike `authModel`, order carries no
    // meaning here, so dedupe + sort for hash stability.
    return { basis: "constant", revisions: [...new Set(revisions)].sort() };
  }

  if (raw.basis === "behavioral") {
    assertOnlyKnownKeys(raw, new Set(["basis", "minimumRevision"]), fieldName);
    return {
      basis: "behavioral",
      minimumRevision: readOAuthSpecRevision(
        raw.minimumRevision,
        `${fieldName}.minimumRevision`
      ),
    };
  }

  throw new Error(
    `hostConfigV2: ${fieldName}.basis must be "constant" or "behavioral"`
  );
}

function readOAuthAuthModelValue(
  raw: unknown,
  fieldName: string
): OAuthAuthModel[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `hostConfigV2: ${fieldName} must be a non-empty array of auth models in preference order`
    );
  }
  if (raw.length === 0) {
    throw new Error(
      `hostConfigV2: ${fieldName} must be non-empty when set (omit the field instead)`
    );
  }
  const out: OAuthAuthModel[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== "string" || !OAUTH_AUTH_MODEL_SET.has(entry)) {
      throw new Error(
        `hostConfigV2: ${fieldName}[${i}] must be one of ${OAUTH_AUTH_MODELS.join(
          ", "
        )}`
      );
    }
    // Reject rather than dedupe: a repeat makes the precedence list ambiguous,
    // and silently collapsing it would hide the caller's mistake.
    if (out.includes(entry as OAuthAuthModel)) {
      throw new Error(
        `hostConfigV2: ${fieldName} contains duplicate entry "${entry}" — the preference order must be unambiguous`
      );
    }
    out.push(entry as OAuthAuthModel);
  }
  // "none" is the ABSENCE of an auth mechanism, not one more fallback beside
  // the others (see the `authModel` doc comment): it is how "this client has
  // no OAuth" is spelled. Paired with a concrete model the list asserts both
  // at once, and HP-43's emulator has no defined behavior for a host that
  // both does and does not authenticate. Rejected in any position — order
  // cannot rescue the contradiction.
  if (out.length > 1 && out.includes("none")) {
    throw new Error(
      `hostConfigV2: ${fieldName} contains "none" alongside other entries — "none" means the client has no auth at all, so it must be the sole entry`
    );
  }
  // Order is semantic (first = preferred) — preserve verbatim, do NOT sort.
  return out;
}

function readOAuthProtocolVersionPinningValue(
  raw: unknown,
  fieldName: string
): OAuthProtocolVersionPinning {
  if (!isPlainObject(raw)) {
    throw new Error(`hostConfigV2: ${fieldName} must be a plain object`);
  }
  const mode = raw.mode;
  if (mode === "negotiated") {
    if (raw.version !== undefined) {
      throw new Error(
        `hostConfigV2: ${fieldName}.version must be omitted when mode is "negotiated"`
      );
    }
    assertOnlyKnownKeys(raw, new Set(["mode"]), fieldName);
    return { mode: "negotiated" };
  }
  if (mode === "pinned") {
    assertOnlyKnownKeys(raw, new Set(["mode", "version"]), fieldName);
    // Format-validated, not enum-checked: a client can pin a revision this
    // inspector does not speak (rmcp pins 2024-11-05 on OAuth discovery).
    const version = readOAuthSpecRevision(raw.version, `${fieldName}.version`);
    return { mode: "pinned", version };
  }
  throw new Error(
    `hostConfigV2: ${fieldName}.mode must be "pinned" or "negotiated"`
  );
}

function readOAuthDcrIdentityValue(
  raw: unknown,
  fieldName: string
): OAuthDcrIdentity {
  if (!isPlainObject(raw)) {
    throw new Error(`hostConfigV2: ${fieldName} must be a plain object`);
  }
  assertOnlyKnownKeys(raw, OAUTH_DCR_IDENTITY_KEY_SET, fieldName);

  const out: OAuthDcrIdentity = {};
  // Fixed key order, matching OAUTH_DCR_IDENTITY_KEYS.
  if (raw.clientName !== undefined) {
    // NOT case-normalized: servers in the wild gate authorization policy on
    // the exact `client_name` string, so emulator replay must be byte-exact.
    out.clientName = requireTrimmedString(
      raw.clientName,
      `${fieldName}.clientName`
    );
  }
  if (raw.redirectUris !== undefined) {
    if (!Array.isArray(raw.redirectUris)) {
      throw new Error(
        `hostConfigV2: ${fieldName}.redirectUris must be a string[]`
      );
    }
    if (raw.redirectUris.length === 0) {
      throw new Error(
        `hostConfigV2: ${fieldName}.redirectUris must be non-empty when set (omit the field instead)`
      );
    }
    const uris = raw.redirectUris.map((uri, i) =>
      requireTrimmedString(uri, `${fieldName}.redirectUris[${i}]`)
    );
    // Registration order carries no meaning in RFC 7591, so dedupe + sort:
    // two hosts registering the same URI set must hash identically.
    out.redirectUris = [...new Set(uris)].sort();
  }
  if (raw.userAgent !== undefined) {
    out.userAgent = requireTrimmedString(
      raw.userAgent,
      `${fieldName}.userAgent`
    );
  }

  if (Object.keys(out).length === 0) {
    throw new Error(
      `hostConfigV2: ${fieldName} must set at least one of ${OAUTH_DCR_IDENTITY_KEYS.join(
        ", "
      )}`
    );
  }
  return out;
}

/**
 * V2 DCR identity reader. Same shape as V1 with two deliberate divergences,
 * both because V2 replays the registration body BYTE-EXACTLY:
 *
 *   - `redirectUris` preserves the CAPTURED order and rejects duplicates,
 *     where V1 deduped + sorted. Canonicalization must not reorder what was
 *     observed on the wire, and a duplicate means the capture itself is
 *     ambiguous — silently collapsing it would hide that.
 *   - `clientName` is stored VERBATIM, where V1 trimmed. Servers gate policy
 *     on the exact `client_name` string, so trailing/leading whitespace in a
 *     capture is data, not noise: rewriting it would make the emulator send
 *     bytes the real client never sent. Empty/whitespace-only is still
 *     rejected — that is a missing capture, not a name.
 *
 * `redirectUris` entries and (elsewhere) scope tokens keep trimming: a URI
 * cannot legally contain whitespace, and a scope token with whitespace would
 * corrupt the space-delimited scope string it is joined into.
 */
function readOAuthDcrIdentityValueV2(
  raw: unknown,
  fieldName: string
): OAuthDcrIdentity {
  if (!isPlainObject(raw)) {
    throw new Error(`hostConfigV2: ${fieldName} must be a plain object`);
  }
  assertOnlyKnownKeys(raw, OAUTH_DCR_IDENTITY_KEY_SET, fieldName);

  const out: OAuthDcrIdentity = {};
  // Fixed key order, matching OAUTH_DCR_IDENTITY_KEYS.
  if (raw.clientName !== undefined) {
    // Neither case-normalized NOR trimmed: servers in the wild gate
    // authorization policy on the exact `client_name` string, so V2 replay
    // must be byte-exact — including whitespace the real client sent.
    out.clientName = requireVerbatimString(
      raw.clientName,
      `${fieldName}.clientName`
    );
  }
  if (raw.redirectUris !== undefined) {
    if (!Array.isArray(raw.redirectUris)) {
      throw new Error(
        `hostConfigV2: ${fieldName}.redirectUris must be a string[]`
      );
    }
    if (raw.redirectUris.length === 0) {
      throw new Error(
        `hostConfigV2: ${fieldName}.redirectUris must be non-empty when set (omit the field instead)`
      );
    }
    const uris: string[] = [];
    for (const [i, entry] of raw.redirectUris.entries()) {
      const uri = requireTrimmedString(
        entry,
        `${fieldName}.redirectUris[${i}]`
      );
      if (uris.includes(uri)) {
        throw new Error(
          `hostConfigV2: ${fieldName}.redirectUris contains duplicate entry "${uri}" — the captured registration order must be unambiguous`
        );
      }
      uris.push(uri);
    }
    out.redirectUris = uris;
  }
  if (raw.userAgent !== undefined) {
    out.userAgent = requireTrimmedString(
      raw.userAgent,
      `${fieldName}.userAgent`
    );
  }

  if (Object.keys(out).length === 0) {
    throw new Error(
      `hostConfigV2: ${fieldName} must set at least one of ${OAUTH_DCR_IDENTITY_KEYS.join(
        ", "
      )}`
    );
  }
  return out;
}

function readOAuthScopeRequestValue(
  raw: unknown,
  fieldName: string
): OAuthScopeRequest {
  if (!isPlainObject(raw)) {
    throw new Error(
      `hostConfigV2: ${fieldName} must be a plain object with a "mode" of ${OAUTH_SCOPE_REQUEST_MODES.join(
        ", "
      )}`
    );
  }
  const mode = raw.mode;
  if (typeof mode !== "string" || !OAUTH_SCOPE_REQUEST_MODE_SET.has(mode)) {
    throw new Error(
      `hostConfigV2: ${fieldName}.mode must be one of ${OAUTH_SCOPE_REQUEST_MODES.join(
        ", "
      )}`
    );
  }
  switch (mode as OAuthScopeRequest["mode"]) {
    case "fixed": {
      assertOnlyKnownKeys(raw, OAUTH_SCOPE_REQUEST_FIXED_KEY_SET, fieldName);
      if (!Array.isArray(raw.scopes)) {
        throw new Error(
          `hostConfigV2: ${fieldName}.scopes must be a string[] when mode is "fixed"`
        );
      }
      if (raw.scopes.length === 0) {
        throw new Error(
          `hostConfigV2: ${fieldName}.scopes must be non-empty when mode is "fixed" — a client that sends no scope is mode "omit"`
        );
      }
      // Captured wire order — preserved verbatim, duplicates rejected. The
      // emulator joins this list into the scope string byte-for-byte.
      const scopes: string[] = [];
      for (const [i, entry] of raw.scopes.entries()) {
        const scope = requireTrimmedString(entry, `${fieldName}.scopes[${i}]`);
        if (scopes.includes(scope)) {
          throw new Error(
            `hostConfigV2: ${fieldName}.scopes contains duplicate entry "${scope}" — the captured scope order must be unambiguous`
          );
        }
        scopes.push(scope);
      }
      return { mode: "fixed", scopes };
    }
    case "omit":
    case "challenge":
    case "all-supported": {
      if (raw.scopes !== undefined) {
        throw new Error(
          `hostConfigV2: ${fieldName}.scopes is only valid when mode is "fixed"`
        );
      }
      assertOnlyKnownKeys(
        raw,
        OAUTH_SCOPE_REQUEST_MODE_ONLY_KEY_SET,
        fieldName
      );
      return { mode: mode as "omit" | "challenge" | "all-supported" };
    }
    default: {
      // Exhaustiveness gate. The membership check above admits every entry of
      // OAUTH_SCOPE_REQUEST_MODES, so adding a mode there without a case here
      // would otherwise fall out of the switch and canonicalize to `undefined`
      // — a silently wrong profile. `never` makes that a compile error, and
      // the throw makes it loud for untyped JS callers.
      const exhaustive: never = mode as never;
      throw new Error(
        `hostConfigV2: ${fieldName}.mode "${String(
          exhaustive
        )}" is a known mode with no canonicalization rule — add a case`
      );
    }
  }
}

function readOAuthTokenEndpointAuthMethodValue(
  raw: unknown,
  fieldName: string
): OAuthTokenEndpointAuthMethod {
  if (
    typeof raw !== "string" ||
    !OAUTH_TOKEN_ENDPOINT_AUTH_METHOD_SET.has(raw)
  ) {
    throw new Error(
      `hostConfigV2: ${fieldName} must be one of ${OAUTH_TOKEN_ENDPOINT_AUTH_METHODS.join(
        ", "
      )}`
    );
  }
  return raw as OAuthTokenEndpointAuthMethod;
}

/**
 * Canonicalize the per-host OAuth profile (HP-3 / HP-43).
 *
 * Exported because HP-45 (seed validated findings) and HP-47 (per-client
 * sweep) build profiles outside a full HostConfig and need to normalize +
 * validate them standalone before they are attached to a host — the private
 * catalog resolves its rows through this same entry point.
 *
 * Dispatches on `profileVersion`. V1 canonicalization is FROZEN (existing
 * content-addressed hashes must stay valid) and a V1 row is never rewritten
 * to V2 — whichever version came in is what comes out.
 */
export function canonicalizeOAuthProfile(
  input: HostConfigOAuthProfile | undefined
): HostConfigOAuthProfile | undefined {
  if (input === undefined) return undefined;
  if (!isPlainObject(input)) {
    throw new Error("hostConfigV2: oauthProfile must be a plain object");
  }
  const version = (input as { profileVersion?: unknown }).profileVersion;
  switch (version) {
    case 1:
      return canonicalizeOAuthProfileV1(input as HostConfigOAuthProfileV1);
    case 2:
      return canonicalizeOAuthProfileV2(input as HostConfigOAuthProfileV2);
    default:
      // Forward-compat trip wire, mirroring mcpProfile: a future
      // profileVersion: 3 shape must NOT silently round-trip through this
      // reader.
      throw new Error(
        "hostConfigV2: oauthProfile.profileVersion must be 1 or 2"
      );
  }
}

/** FROZEN — V1 rows must canonicalize byte-identically forever. Do not edit. */
function canonicalizeOAuthProfileV1(
  input: HostConfigOAuthProfileV1
): HostConfigOAuthProfileV1 {
  assertOnlyKnownKeys(
    input as unknown as Record<string, unknown>,
    OAUTH_PROFILE_KEY_SET,
    "oauthProfile"
  );

  // Fixed key order (see module header) — build explicitly, never spread.
  const out: HostConfigOAuthProfileV1 = { profileVersion: 1 };

  const sendsResourceIndicator = canonicalizeOAuthEvidence(
    input.sendsResourceIndicator,
    "oauthProfile.sendsResourceIndicator",
    readOAuthBooleanValue
  );
  if (sendsResourceIndicator !== undefined) {
    out.sendsResourceIndicator = sendsResourceIndicator;
  }

  const oauthSpecVersion = canonicalizeOAuthEvidence(
    input.oauthSpecVersion,
    "oauthProfile.oauthSpecVersion",
    readOAuthSpecVersionValue
  );
  if (oauthSpecVersion !== undefined) {
    out.oauthSpecVersion = oauthSpecVersion;
  }

  const protocolVersionPinning = canonicalizeOAuthEvidence(
    input.protocolVersionPinning,
    "oauthProfile.protocolVersionPinning",
    readOAuthProtocolVersionPinningValue
  );
  if (protocolVersionPinning !== undefined) {
    out.protocolVersionPinning = protocolVersionPinning;
  }

  const dcrIdentity = canonicalizeOAuthEvidence(
    input.dcrIdentity,
    "oauthProfile.dcrIdentity",
    readOAuthDcrIdentityValue
  );
  if (dcrIdentity !== undefined) {
    out.dcrIdentity = dcrIdentity;
  }

  const authModel = canonicalizeOAuthEvidence(
    input.authModel,
    "oauthProfile.authModel",
    readOAuthAuthModelValue
  );
  if (authModel !== undefined) {
    out.authModel = authModel;
  }

  if (input.extensions !== undefined) {
    if (!isPlainObject(input.extensions)) {
      throw new Error(
        "hostConfigV2: oauthProfile.extensions must be a plain object"
      );
    }
    out.extensions = deepSortStringKeys(input.extensions);
  }

  return out;
}

/**
 * V2 canonicalization. Shares the evidence-envelope machinery with V1;
 * differs only where V2's contract differs: two new fields (`scopeRequest`,
 * `tokenEndpointAuthMethod`) and order-preserving `dcrIdentity.redirectUris`.
 * Absent fields are omitted from the canonical JSON — never null/default
 * filled — same as V1.
 */
function canonicalizeOAuthProfileV2(
  input: HostConfigOAuthProfileV2
): HostConfigOAuthProfileV2 {
  assertOnlyKnownKeys(
    input as unknown as Record<string, unknown>,
    OAUTH_PROFILE_V2_KEY_SET,
    "oauthProfile"
  );

  // Fixed key order (see module header) — build explicitly, never spread.
  const out: HostConfigOAuthProfileV2 = { profileVersion: 2 };

  const sendsResourceIndicator = canonicalizeOAuthEvidence(
    input.sendsResourceIndicator,
    "oauthProfile.sendsResourceIndicator",
    readOAuthBooleanValue
  );
  if (sendsResourceIndicator !== undefined) {
    out.sendsResourceIndicator = sendsResourceIndicator;
  }

  const oauthSpecVersion = canonicalizeOAuthEvidence(
    input.oauthSpecVersion,
    "oauthProfile.oauthSpecVersion",
    readOAuthSpecVersionValue
  );
  if (oauthSpecVersion !== undefined) {
    out.oauthSpecVersion = oauthSpecVersion;
  }

  const protocolVersionPinning = canonicalizeOAuthEvidence(
    input.protocolVersionPinning,
    "oauthProfile.protocolVersionPinning",
    readOAuthProtocolVersionPinningValue
  );
  if (protocolVersionPinning !== undefined) {
    out.protocolVersionPinning = protocolVersionPinning;
  }

  const dcrIdentity = canonicalizeOAuthEvidence(
    input.dcrIdentity,
    "oauthProfile.dcrIdentity",
    readOAuthDcrIdentityValueV2
  );
  if (dcrIdentity !== undefined) {
    out.dcrIdentity = dcrIdentity;
  }

  const authModel = canonicalizeOAuthEvidence(
    input.authModel,
    "oauthProfile.authModel",
    readOAuthAuthModelValue
  );
  if (authModel !== undefined) {
    out.authModel = authModel;
  }

  const scopeRequest = canonicalizeOAuthEvidence(
    input.scopeRequest,
    "oauthProfile.scopeRequest",
    readOAuthScopeRequestValue
  );
  if (scopeRequest !== undefined) {
    out.scopeRequest = scopeRequest;
  }

  const tokenEndpointAuthMethod = canonicalizeOAuthEvidence(
    input.tokenEndpointAuthMethod,
    "oauthProfile.tokenEndpointAuthMethod",
    readOAuthTokenEndpointAuthMethodValue
  );
  if (tokenEndpointAuthMethod !== undefined) {
    out.tokenEndpointAuthMethod = tokenEndpointAuthMethod;
  }

  if (input.extensions !== undefined) {
    if (!isPlainObject(input.extensions)) {
      throw new Error(
        "hostConfigV2: oauthProfile.extensions must be a plain object"
      );
    }
    out.extensions = deepSortStringKeys(input.extensions);
  }

  return out;
}

function canonicalizeServerConnectionOverrides(
  serverIds: Array<ServerId>,
  optionalServerIds: Array<ServerId>,
  overrides: HostConfigInputV2["serverConnectionOverrides"]
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
        `hostConfigV2: serverConnectionOverrides key "${serverId}" is not in serverIds or optionalServerIds`
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
          `hostConfigV2: serverConnectionOverrides["${serverId}"].mcpProtocolVersionOverride must be one of ${MCP_PROTOCOL_VERSIONS.join(
            ", "
          )} (got "${String(entry.mcpProtocolVersionOverride)}")`
        );
      }
      mcpProtocolVersionOverride = entry.mcpProtocolVersionOverride;
    }
    if (
      entry.requestTimeoutOverride !== undefined &&
      !Number.isFinite(entry.requestTimeoutOverride)
    ) {
      throw new Error(
        `hostConfigV2: serverConnectionOverrides["${serverId}"].requestTimeoutOverride must be finite`
      );
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
    result
  ) as CanonicalHostConfigV2["serverConnectionOverrides"];
}

// Allowed keys on `computer`. Explicit construction below (never a spread of
// user input) keeps stray keys out of the canonical JSON; this set makes the
// stray key a loud error instead of a silent drop. `toolset` is the legacy
// MVP capability key: still ACCEPTED on input (validated when present) but
// never emitted — capabilities moved to `builtInToolIds`, and the canonical
// `computer` is the resource attachment only.
const COMPUTER_KEYS = new Set(["kind", "toolset", "workdir"]);

/**
 * Canonicalize the optional `computer` field. `null` collapses to undefined
 * ("cleared" hashes identically to "never set"); `workdir` is trimmed, with
 * empty-after-trim collapsing to absent; legacy `toolset` input is dropped
 * for EVERY kind (so `{ kind, toolset: "bash" }` and `{ kind }` hash
 * identically). Output keys are built in sorted order (kind, workdir) for
 * hash stability.
 *
 * `kind` is a closed union of two values:
 *   - `"personal"`  — the per-(project, user) cloud workstation. The only
 *                     kind an author can ever write; every public authoring
 *                     input (`HostComputerInput`, `HostInit.computer`) is
 *                     narrowed to it.
 *   - `"ephemeral"` — a per-run box minted by the platform at a snapshot
 *                     boundary (eval runs pin one box per iteration and boot
 *                     it from the run's frozen environment image). RUNTIME-
 *                     MINTED ONLY: it appears on canonical/persisted rows,
 *                     never on authored input. The image is NOT carried here
 *                     — it comes from the run's frozen environment pin.
 *
 * `workdir` is handled identically for both kinds, deliberately. A per-run box
 * takes its working directory from provisioning, so the platform's minting site
 * emits no `workdir` — but that is a rule about what gets WRITTEN, enforced
 * there, and this function does not re-check it. Canonicalization is pure
 * content-addressing: making one field's treatment depend on another's value
 * would mean the same input hashing differently for a reason no caller can see.
 * Nothing can author an ephemeral computer (every input type is personal-only),
 * so there is no shape here for such a rule to catch.
 */
function canonicalizeComputer(
  computer: HostConfigInputV2["computer"]
): HostConfigComputer | undefined {
  if (computer === undefined || computer === null) return undefined;
  if (!isPlainObject(computer)) {
    throw new Error("hostConfigV2: computer must be a plain object or null");
  }
  for (const key of Object.keys(computer)) {
    if (!COMPUTER_KEYS.has(key)) {
      throw new Error(`hostConfigV2: computer has unknown key "${key}"`);
    }
  }
  if (computer.kind !== "personal" && computer.kind !== "ephemeral") {
    throw new Error(
      'hostConfigV2: computer.kind must be "personal" or "ephemeral"'
    );
  }
  // Legacy input only: when present it must be the one value that ever
  // existed, then it's dropped from the canonical form.
  if (computer.toolset !== undefined && computer.toolset !== "bash") {
    throw new Error('hostConfigV2: computer.toolset must be "bash"');
  }
  let workdir: string | undefined;
  if (computer.workdir !== undefined) {
    if (typeof computer.workdir !== "string") {
      throw new Error("hostConfigV2: computer.workdir must be a string");
    }
    const trimmed = computer.workdir.trim();
    workdir = trimmed === "" ? undefined : trimmed;
  }
  return {
    kind: computer.kind,
    ...(workdir !== undefined ? { workdir } : {}),
  };
}

export function canonicalizeHostConfigV2(
  input: HostConfigInputV2
): CanonicalHostConfigV2 {
  if (!Number.isFinite(input.temperature)) {
    throw new Error("hostConfigV2: temperature must be finite");
  }
  if (!Number.isFinite(input.connectionDefaults.requestTimeout)) {
    throw new Error(
      "hostConfigV2: connectionDefaults.requestTimeout must be finite"
    );
  }
  if (
    input.hostCapabilitiesOverride !== undefined &&
    (input.hostCapabilitiesOverride === null ||
      typeof input.hostCapabilitiesOverride !== "object" ||
      Array.isArray(input.hostCapabilitiesOverride))
  ) {
    throw new Error(
      "hostConfigV2: hostCapabilitiesOverride must be a plain object"
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
  // Closed enum: reject unknown harness ids so untyped (JS) callers can't
  // persist a value the runtime can't honor. Membership is checked against the
  // portable HARNESS_IDS source of truth (mirrored by the backend). The "harness
  // requires a computer" rule is enforced at the backend write-path (next to
  // builtInTools' requiresComputer), not here — the canonicalizer stays a pure
  // normalizer.
  if (input.harness !== undefined && !isHarness(input.harness)) {
    throw new Error(
      `hostConfigV2: harness must be one of ${HARNESS_IDS.map(
        (h) => `"${h}"`
      ).join(", ")} when set`
    );
  }
  const serverIds = sortUniqueServerIds(input.serverIds);
  const optionalServerIds = sortUniqueServerIds(input.optionalServerIds);
  const hostContext = requireRecord(input.hostContext, "hostContext");
  const modelVisibleMcpToolResults = canonicalizeModelVisibleMcpToolResults(
    input.modelVisibleMcpToolResults
  );
  const mcpToolResultImageRendering =
    canonicalizeMcpToolResultImageRenderingPolicy(
      input.mcpToolResultImageRendering
    );
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
    // Validated pass-through (value checked above). Absent ⇒ emulated;
    // JSON.stringify drops undefined so pre-feature rows hash byte-identically.
    harness: input.harness,
    // Absent/null ⇒ key omitted, hashing byte-identically to pre-feature rows.
    computer: canonicalizeComputer(input.computer),
    // Normalize undefined → [] and dedupe before sort so canonical/hash output
    // is identical for semantically equivalent server lists.
    serverIds,
    optionalServerIds,
    // Opaque built-in tool ids. Helper returns undefined for absent/empty, so
    // JSON.stringify drops the key and pre-feature rows hash byte-identically.
    builtInToolIds: canonicalizeBuiltInToolIds(input.builtInToolIds),
    // Skill selection. all-visible collapses to absent (single identity per
    // behavior); explicit — including explicit-empty — survives.
    skillSelection: canonicalizeSkillSelection(input.skillSelection),
    // Preserve undefined-vs-set: absent rows keep their historical hash, while
    // explicit off/on leaves survive template hostContext reseeds.
    modelVisibleMcpToolResults,
    mcpToolResultImageRendering,
    connectionDefaults: {
      headers: sortStringKeys(input.connectionDefaults.headers),
      requestTimeout: input.connectionDefaults.requestTimeout,
    },
    // Deep-sort: nested key order shouldn't leak into the hash. Shallow
    // sort would let `{ extensions: { ui: { a, b } } }` and the same with
    // `{ b, a }` produce distinct hashes for identical capabilities.
    // Fail-fast on missing: HostConfigInputV2 requires both fields; a
    // `?? {}` fallback hides write-path bugs that would silently dedupe
    // distinct callers' configs into a stray empty-capability row.
    clientCapabilities: requireRecord(
      input.clientCapabilities,
      "clientCapabilities"
    ),
    hostContext,
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
    // Absent ⇒ key omitted, so every row written before the OAuth profile
    // existed hashes byte-identically (guarded by an explicit legacy test).
    oauthProfile: canonicalizeOAuthProfile(input.oauthProfile),
    serverConnectionOverrides: canonicalizeServerConnectionOverrides(
      serverIds,
      optionalServerIds,
      input.serverConnectionOverrides
    ),
  };
}
