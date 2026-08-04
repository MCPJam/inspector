import { useState } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { JsonEditor, type JsonEditorMode } from "@/components/ui/json-editor";
import { hostConfigField } from "@/lib/host-config-field-schema";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Switch } from "@mcpjam/design-system/switch";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import {
  clearTasksPolicy,
  describeInvalidTasksPolicy,
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
  MCP_PROTOCOL_VERSIONS,
  readTasksPolicy,
  readXaaEnterprisePolicy,
  setTasksPolicy,
  withXaaEnterprisePolicy,
  withoutXaaEnterprisePolicy,
  XAA_MCP_EXTENSION,
  type TasksPolicy,
} from "@mcpjam/sdk/browser";
import {
  isMcpProfileEmpty,
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
  type McpProtocolVersion,
} from "@/lib/client-config-v2";
import type {
  MrtrSupport,
  PaginationTraversalMode,
  ToolParamHeaderMirroring,
} from "@mcpjam/sdk/browser";
import type { HostAttentionIssue } from "../types";
import { useJsonDraftBuffer } from "./useJsonDraftBuffer";

/**
 * "auto" is the UI-only sentinel for "no pin stored" — it maps to
 * `mcpProfile.mcpProtocolVersion === undefined`, NOT to a wire literal.
 * Deliberately not labelled with a version number: absence means the SDK
 * picks the version at connect time, so hardcoding a revision into that
 * label would go stale the moment the SDK's default moves (the sequenced
 * Phase-5 `versionNegotiation: 'auto'` activation) without anything in
 * this file changing.
 *
 * Every other entry is a real wire literal and writes itself through
 * verbatim. This matters — a stateful pin is NOT cosmetic: it narrows the
 * legacy client's `supportedProtocolVersions` accept-list, so
 * `initialize.params.protocolVersion` goes out as the pinned value
 * instead of the SDK's built-in newest default
 * (`MCPClientManager.ts`, `resolveVersionNegotiation` call site).
 */
type HostProtocolDropdownValue = "auto" | McpProtocolVersion;

/**
 * The three choices the tri-state policy offers. "default" is the UI sentinel
 * for `unset` — the same absent-means-something idiom as `"auto"` above, and
 * for the same hash reason: it clears the stored entry rather than writing a
 * third value.
 *
 * "Use default" is a real choice here, not a reset button. It restores today's
 * behavior (the Tools tab keeps its explicit per-call controls and nothing
 * else turns on), which is distinct from Off — Off actively removes those
 * controls too.
 */
type TasksPolicyChoice = "default" | "on" | "off";

const TASKS_POLICY_OPTIONS: ReadonlyArray<{
  value: TasksPolicyChoice;
  label: string;
}> = [
  { value: "default", label: "Use default" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

/**
 * Stored policy → dropdown value. `invalid` is absent on purpose: it has no
 * dropdown value, and the control renders its placeholder instead.
 */
const TASKS_POLICY_VALUE: Partial<Record<TasksPolicy, TasksPolicyChoice>> = {
  unset: "default",
  on: "on",
  off: "off",
};

/**
 * Decorate the two newest revisions with their product labels:
 *
 * - **Latest** = newest known revision. Derived from
 *   `MCP_PROTOCOL_VERSIONS` so the marker walks forward automatically.
 * - **November** = the 2025-11-25 revision.
 *
 * `MCP_PROTOCOL_VERSIONS` is ordered oldest-first; the dropdown lists
 * newest-first.
 */
const LATEST_PROTOCOL_VERSION: McpProtocolVersion | undefined =
  MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1];

function protocolVersionLabel(version: McpProtocolVersion): string {
  if (version === LATEST_PROTOCOL_VERSION) return `Latest (${version})`;
  if (version === "2025-11-25") return `November (${version})`;
  return version;
}

const HOST_PROTOCOL_OPTIONS: Array<{
  value: HostProtocolDropdownValue;
  label: string;
}> = [
  { value: "auto", label: "Automatic" },
  ...[...MCP_PROTOCOL_VERSIONS].reverse().map((version) => ({
    value: version,
    label: protocolVersionLabel(version),
  })),
];

interface ProtocolTabProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2
  ) => void;
  attention: ReadonlyArray<HostAttentionIssue>;
  /**
   * When true, the protocol-version dropdown and JSON editor render
   * non-editable. See `BehaviorTab` for the same prop on its surface.
   */
  readOnly?: boolean;
}

/**
 * A compact JSON view over the editable subset of HostConfigInputV2.
 * Only includes keys that are actually set on the draft — absence is
 * semantic in MCP and must round-trip through this editor faithfully.
 */
type ProtocolDoc = {
  clientInfo?: { name: string; version: string };
  supportedProtocolVersions?: string[];
  /**
   * Host-level default pinned MCP protocol version. Absent → SDK
   * chooses at request time. Stateful values (per
   * `isStatelessProtocolVersion`) use the legacy `Client` + initialize
   * handshake; stateless values route through
   * `StatelessMcpHttpPreviewClient`. Sibling of `clientInfo` and
   * `supportedProtocolVersions` because stateless versions explicitly
   * skip initialize — nesting it under either of those would be
   * misleading. Maps onto `mcpProfile.mcpProtocolVersion` on
   * persistence; per-server pins live on the server card's Connection
   * overrides section.
   */
  mcpProtocolVersion?: McpProtocolVersion;
  /**
   * Whether the simulated client mirrors `x-mcp-header` tool arguments into
   * `Mcp-Param-*` request headers (SEP-2243, 2026-07-28). Absent → `"mirror"`,
   * the spec-conforming default, so a host that never touches the control
   * hashes exactly as it did before the field existed. `"omit"` deliberately
   * simulates a non-conforming client. Maps onto
   * `mcpProfile.toolParamHeaderMirroring` — a sibling of the version pin, not
   * a per-server override: conformance is a property of the CLIENT.
   */
  toolParamHeaderMirroring?: ToolParamHeaderMirroring;
  /**
   * Sibling client-conformance knobs. Absent → the full behavior, written
   * back as absence for the same hash reason as the mirroring knob above:
   * a host that never touches the control must keep hashing exactly as it
   * did before the field existed. Map onto `mcpProfile.paginationTraversal`
   * / `mcpProfile.mrtrSupport`.
   */
  paginationTraversal?: PaginationTraversalMode;
  mrtrSupport?: MrtrSupport;
  capabilities?: Record<string, unknown>;
  /**
   * Host-level MCP profile extensions (`mcpProfile.extensions`) — freeform
   * JSON deep-sorted into the canonical hash. Carries the enterprise-managed
   * authorization policy under `com.mcpjam/enterprise-managed-auth` (the
   * Switch above the editor is its structured control). Distinct from
   * `capabilities.extensions`, which are the wire `initialize` capability
   * extensions.
   */
  extensions?: Record<string, unknown>;
  connectionDefaults: {
    requestTimeout: number;
    headers?: Record<string, string>;
  };
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function findAuthorizationKey(
  headers: Record<string, string>
): string | undefined {
  return Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
}

export function protocolToJson(draft: HostConfigInputV2): ProtocolDoc {
  const doc: ProtocolDoc = {
    connectionDefaults: {
      requestTimeout: draft.connectionDefaults.requestTimeout,
    },
  };

  const ci = draft.mcpProfile?.initialize?.clientInfo;
  if (
    ci &&
    typeof ci.name === "string" &&
    ci.name.trim() !== "" &&
    typeof ci.version === "string" &&
    ci.version.trim() !== ""
  ) {
    doc.clientInfo = { name: ci.name, version: ci.version };
  }

  const versions = draft.mcpProfile?.initialize?.supportedProtocolVersions;
  if (versions && versions.length > 0) {
    doc.supportedProtocolVersions = [...versions];
  }

  // Surface mcpProtocolVersion only when explicitly set. Absence is
  // semantic ("SDK default") and must round-trip through the editor
  // verbatim — materializing a placeholder here would churn canonical
  // hashes for legacy rows that haven't opted into a pin. The dropdown
  // in the surrounding tab is how users discover the field; the JSON
  // view doesn't need to advertise it.
  if (draft.mcpProfile?.mcpProtocolVersion !== undefined) {
    doc.mcpProtocolVersion = draft.mcpProfile.mcpProtocolVersion;
  }

  // Same only-when-set rule as the pin above, for the same hash reason.
  if (draft.mcpProfile?.toolParamHeaderMirroring !== undefined) {
    doc.toolParamHeaderMirroring = draft.mcpProfile.toolParamHeaderMirroring;
  }

  // Same only-when-set rule again for the sibling conformance knobs.
  if (draft.mcpProfile?.paginationTraversal !== undefined) {
    doc.paginationTraversal = draft.mcpProfile.paginationTraversal;
  }
  if (draft.mcpProfile?.mrtrSupport !== undefined) {
    doc.mrtrSupport = draft.mcpProfile.mrtrSupport;
  }

  if (
    draft.clientCapabilities &&
    Object.keys(draft.clientCapabilities).length > 0
  ) {
    doc.capabilities = draft.clientCapabilities;
  }

  // Surface mcpProfile.extensions only when set — absence is semantic (no
  // extensions key hashes byte-identically to a pre-feature row).
  if (draft.mcpProfile?.extensions !== undefined) {
    doc.extensions = draft.mcpProfile.extensions as Record<string, unknown>;
  }

  const headers = draft.connectionDefaults.headers ?? {};
  const visibleEntries = Object.entries(headers).filter(
    ([k]) => k.trim() !== "" && k.toLowerCase() !== "authorization"
  );
  if (visibleEntries.length > 0) {
    doc.connectionDefaults.headers = Object.fromEntries(visibleEntries);
  }

  return doc;
}

/**
 * Whether the draft's stored clientCapabilities advertise the MCP
 * Enterprise-Managed Authorization extension. `extensions` is freeform
 * JSON, so guard for a plain object before the key check — presence of
 * the key is the signal, whatever its value.
 */
export function hasEmaExtension(
  capabilities: Record<string, unknown> | undefined
): boolean {
  const exts = capabilities?.extensions;
  return (
    isPlainObject(exts) &&
    Object.prototype.hasOwnProperty.call(exts, XAA_MCP_EXTENSION)
  );
}

/**
 * Advertise the EMA extension in the stored clientCapabilities. Unlike the
 * Apps tab's `withMcpUiExtension` (which resets to the default payload),
 * a pre-existing value object is preserved — same `?? {}` semantics as the
 * server's connect-time `withXaaExtensionCapability` merge, so toggling
 * never clobbers a hand-edited payload.
 */
export function withEmaExtension(prev: HostConfigInputV2): HostConfigInputV2 {
  const nextCaps: Record<string, unknown> = {
    ...(prev.clientCapabilities ?? {}),
  };
  const exts: Record<string, unknown> = isPlainObject(nextCaps.extensions)
    ? { ...nextCaps.extensions }
    : {};
  exts[XAA_MCP_EXTENSION] = exts[XAA_MCP_EXTENSION] ?? {};
  nextCaps.extensions = exts;
  return { ...prev, clientCapabilities: nextCaps };
}

/**
 * Stop advertising the EMA extension. Touches ONLY the extensions map:
 * sibling extensions are preserved, a now-empty `extensions` container is
 * dropped (an empty `extensions: {}` on a config that never had the key
 * reads as a diff to the deep-equal dirty check), and `clientCapabilities`
 * itself always stays an object — the canonicalizer requires it. Mistral's
 * inert `extensions: {}` marker is restored the same way
 * `withoutMcpUiExtension` restores it.
 */
export function withoutEmaExtension(
  prev: HostConfigInputV2
): HostConfigInputV2 {
  const nextCaps: Record<string, unknown> = {
    ...(prev.clientCapabilities ?? {}),
  };
  const exts: Record<string, unknown> = isPlainObject(nextCaps.extensions)
    ? { ...nextCaps.extensions }
    : {};
  delete exts[XAA_MCP_EXTENSION];
  if (Object.keys(exts).length > 0) {
    nextCaps.extensions = exts;
  } else {
    delete nextCaps.extensions;
  }
  if (prev.hostStyle === "mistral" && Object.keys(nextCaps).length === 0) {
    nextCaps.extensions = {};
  }
  return { ...prev, clientCapabilities: nextCaps };
}

/**
 * Read the elicitation slice of the stored clientCapabilities.
 *
 * Deliberately LENIENT on `enabled`: the wire shape is freeform per MCP, and
 * the host catalog ships BOTH a bare `elicitation: {}` (claude-code, cursor,
 * vscode…) and `elicitation: { form: {} }` (goose, codex) — see
 * `sdk/src/host-compat/catalog.generated.ts`. Any plain object means the host
 * advertises elicitation, so the switch must read `{}` as ON rather than
 * demanding our own canonical shape.
 *
 * `url` is the narrow mode probe: only a plain `elicitation.url` object counts
 * (a bare `{}` is form-only). The SDK enforces the same reading when it
 * rejects undeclared modes.
 *
 * Note this is a TOP-LEVEL capability key, unlike the EMA extension above
 * which lives under `clientCapabilities.extensions` — the SDK reads and strips
 * `clientCapabilities.elicitation` directly (`buildCapabilities` in
 * `MCPClientManager.ts`).
 */
export function elicitationCapabilityState(
  capabilities: Record<string, unknown> | undefined
): { enabled: boolean; url: boolean } {
  const elicitation = capabilities?.elicitation;
  if (!isPlainObject(elicitation)) return { enabled: false, url: false };
  return { enabled: true, url: isPlainObject(elicitation.url) };
}

/**
 * Advertise the elicitation capability, with or without URL mode.
 *
 * Writes `{ form: {} }` or `{ form: {}, url: {} }`, but merges over any
 * pre-existing elicitation object rather than replacing it: unknown sibling
 * sub-keys and a hand-edited `form`/`url` payload survive the toggle, same
 * `?? {}` preservation semantics as `withEmaExtension`. `url` is re-guarded
 * with `isPlainObject` so the value we write always reads back as ON through
 * `elicitationCapabilityState` — a junk `url: "yes"` left in place would make
 * the checkbox ignore its own click.
 *
 * Never mutates `prev`: both the capabilities record and the elicitation
 * object are copied before assignment.
 */
export function withElicitation(
  prev: HostConfigInputV2,
  options: { url: boolean }
): HostConfigInputV2 {
  const nextCaps: Record<string, unknown> = {
    ...(prev.clientCapabilities ?? {}),
  };
  const existing: Record<string, unknown> = isPlainObject(nextCaps.elicitation)
    ? nextCaps.elicitation
    : {};
  const nextElicitation: Record<string, unknown> = { ...existing };
  nextElicitation.form = existing.form ?? {};
  if (options.url) {
    nextElicitation.url = isPlainObject(existing.url) ? existing.url : {};
  } else {
    delete nextElicitation.url;
  }
  nextCaps.elicitation = nextElicitation;
  return { ...prev, clientCapabilities: nextCaps };
}

/**
 * Stop advertising elicitation. Touches ONLY the top-level `elicitation` key —
 * every sibling capability is preserved and `clientCapabilities` itself always
 * stays an object, because the canonicalizer throws on undefined.
 *
 * No mistral inert-marker guard here, unlike `withoutEmaExtension`: that guard
 * exists to RESTORE the `extensions: {}` marker that the EMA helper itself had
 * just deleted when the container went empty. This helper never touches
 * `extensions`, so mistral's marker survives untouched; synthesizing one here
 * would invent a key the toggle has no business writing and would break the
 * byte-exact on→off round-trip back to `{}`.
 */
export function withoutElicitation(prev: HostConfigInputV2): HostConfigInputV2 {
  const nextCaps: Record<string, unknown> = {
    ...(prev.clientCapabilities ?? {}),
  };
  delete nextCaps.elicitation;
  return { ...prev, clientCapabilities: nextCaps };
}

function patchProfile(
  prev: HostConfigMcpProfileV1 | undefined,
  patch: (base: HostConfigMcpProfileV1) => HostConfigMcpProfileV1 | undefined
): HostConfigMcpProfileV1 | undefined {
  return patch(prev ?? { profileVersion: 1 });
}

export function applyJsonToDraft(
  parsed: unknown,
  prev: HostConfigInputV2
): HostConfigInputV2 | null {
  if (!isPlainObject(parsed)) return null;

  // clientInfo — require both name and version, like the form did. A bare
  // `{}` or partial object collapses to "not set", matching the persisted
  // tri-state semantics.
  let clientInfo: { name: string; version: string } | undefined;
  if (isPlainObject(parsed.clientInfo)) {
    const name = parsed.clientInfo.name;
    const version = parsed.clientInfo.version;
    if (
      typeof name === "string" &&
      name.trim() !== "" &&
      typeof version === "string" &&
      version.trim() !== ""
    ) {
      clientInfo = { name, version };
    }
  }

  // supportedProtocolVersions — string array, drop blanks.
  let supportedProtocolVersions: string[] | undefined;
  if (Array.isArray(parsed.supportedProtocolVersions)) {
    const cleaned = parsed.supportedProtocolVersions
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v !== "");
    if (cleaned.length > 0) supportedProtocolVersions = cleaned;
  }

  // mcpProtocolVersion — membership-gate via `isKnownProtocolVersion`
  // so typo strings fall back to `undefined` (= "SDK default") rather
  // than slipping through to the SDK's open-routing predicate. Absent
  // / wrong type also collapses to undefined for the same canonical-
  // hash-stability reason documented in the type.
  let mcpProtocolVersion: McpProtocolVersion | undefined;
  const rawProtocolVersion = parsed.mcpProtocolVersion;
  if (
    typeof rawProtocolVersion === "string" &&
    isKnownProtocolVersion(rawProtocolVersion)
  ) {
    mcpProtocolVersion = rawProtocolVersion;
  }

  // toolParamHeaderMirroring — closed enum, so an unknown literal collapses
  // to undefined (= mirror) rather than reaching the canonicalizer, which
  // would throw and reject the whole save.
  const rawMirroring = parsed.toolParamHeaderMirroring;
  const toolParamHeaderMirroring: ToolParamHeaderMirroring | undefined =
    rawMirroring === "mirror" || rawMirroring === "omit"
      ? rawMirroring
      : undefined;

  // Same closed-enum collapse for the sibling knobs: an unknown literal must
  // not reach the canonicalizer, which throws and rejects the whole save.
  const rawPagination = parsed.paginationTraversal;
  const paginationTraversal: PaginationTraversalMode | undefined =
    rawPagination === "full" || rawPagination === "firstPageOnly"
      ? rawPagination
      : undefined;
  const rawMrtr = parsed.mrtrSupport;
  const mrtrSupport: MrtrSupport | undefined =
    rawMrtr === "full" || rawMrtr === "none" ? rawMrtr : undefined;

  // capabilities — pass through verbatim as Record<string, unknown> only if
  // the user supplied an object. Absence vs `{}` is preserved: missing key
  // clears clientCapabilities; explicit `{}` advertises nothing but keeps
  // the property addressable.
  let nextCapabilities: Record<string, unknown> = {};
  if (isPlainObject(parsed.capabilities)) {
    nextCapabilities = parsed.capabilities;
  }

  // connectionDefaults — requestTimeout is required by the type. Keep prev
  // value if missing or invalid. Headers preserve any Authorization that
  // lived on the persisted record (managed elsewhere; not user-editable here).
  const cd = isPlainObject(parsed.connectionDefaults)
    ? parsed.connectionDefaults
    : {};
  const rawTimeout = cd.requestTimeout;
  const requestTimeout =
    typeof rawTimeout === "number" &&
    Number.isFinite(rawTimeout) &&
    rawTimeout > 0
      ? rawTimeout
      : prev.connectionDefaults.requestTimeout;

  const prevHeaders = prev.connectionDefaults.headers ?? {};
  const prevAuthKey = findAuthorizationKey(prevHeaders);
  const incomingHeaders = isPlainObject(cd.headers) ? cd.headers : {};
  const cleanIncoming: Record<string, string> = {};
  for (const [k, v] of Object.entries(incomingHeaders)) {
    if (k.trim() === "") continue;
    if (k.toLowerCase() === "authorization") continue;
    if (typeof v !== "string") continue;
    cleanIncoming[k] = v;
  }
  const nextHeaders =
    prevAuthKey !== undefined
      ? { ...cleanIncoming, [prevAuthKey]: prevHeaders[prevAuthKey] }
      : cleanIncoming;

  // mcpProfile.extensions — PARSED-AUTHORITATIVE now that the editor
  // surfaces the key: deleting it in the JSON clears the stored extensions
  // (including the enterprise-auth policy), editing it wins over the
  // previous value. An explicit `{}` collapses to absent like the other
  // tri-state fields, so hand-emptying the object doesn't churn the
  // canonical hash against a pre-feature row.
  let profileExtensions: Record<string, unknown> | undefined;
  if (
    isPlainObject(parsed.extensions) &&
    Object.keys(parsed.extensions).length > 0
  ) {
    profileExtensions = parsed.extensions;
  }

  // Build the new mcpProfile envelope, collapsing to undefined when empty so
  // the canonical hash stays stable with the form-based editor's outputs.
  const nextProfile = patchProfile(prev.mcpProfile, (base) => {
    const initialize: HostConfigMcpProfileV1["initialize"] = {};
    if (clientInfo) initialize.clientInfo = clientInfo;
    if (supportedProtocolVersions)
      initialize.supportedProtocolVersions = supportedProtocolVersions;
    const initHasFields =
      initialize.clientInfo !== undefined ||
      (initialize.supportedProtocolVersions &&
        initialize.supportedProtocolVersions.length > 0);

    const next: HostConfigMcpProfileV1 = {
      ...base,
      initialize: initHasFields ? initialize : undefined,
      mcpProtocolVersion,
      toolParamHeaderMirroring,
      paginationTraversal,
      mrtrSupport,
      extensions: profileExtensions,
    };

    return isMcpProfileEmpty(next) ? undefined : next;
  });

  return {
    ...prev,
    clientCapabilities: nextCapabilities,
    connectionDefaults: {
      requestTimeout,
      headers: nextHeaders,
    },
    mcpProfile: nextProfile,
  };
}

export function ProtocolTab({
  draft,
  onDraftChange,
  readOnly = false,
}: ProtocolTabProps) {
  const [jsonMode, setJsonMode] = useState<JsonEditorMode>("edit");
  const effectiveJsonMode: JsonEditorMode = readOnly ? "view" : jsonMode;
  const { content, onRawChange } = useJsonDraftBuffer({
    draft,
    serialize: protocolToJson,
    applyParsedToDraft: applyJsonToDraft,
    onDraftChange,
  });
  // Every known version has its own entry, so a stored pin shows itself
  // rather than collapsing onto a neighbour. Only genuinely unknown values
  // (hand-edited junk, a version retired from the SDK) fall back to
  // "Automatic" — matching what the connect path does with them anyway.
  const storedProtocolVersion = draft.mcpProfile?.mcpProtocolVersion;
  const selectedDropdownValue: HostProtocolDropdownValue =
    storedProtocolVersion !== undefined &&
    isKnownProtocolVersion(storedProtocolVersion)
      ? storedProtocolVersion
      : "auto";

  // Dropdown handler. Writes through to `draft.mcpProfile.mcpProtocolVersion`
  // directly (parallel to the JSON editor's applyJsonToDraft path) so the
  // JSON view round-trips immediately. Maps the UI-only "default" sentinel
  // to `undefined` — preserves canonical-hash stability so the SDK can
  // upgrade its default version without churning every stored host config.
  const setProtocolVersion = (next: McpProtocolVersion | undefined) => {
    onDraftChange((prev) => {
      const base: HostConfigMcpProfileV1 = prev.mcpProfile ?? {
        profileVersion: 1,
      };
      const updated: HostConfigMcpProfileV1 = {
        ...base,
        mcpProtocolVersion: next,
      };
      return {
        ...prev,
        mcpProfile: isMcpProfileEmpty(updated) ? undefined : updated,
      };
    });
  };

  // Shared with the cross-host comparison matrix via the field schema.
  const fProtocolVersion = hostConfigField("mcpProtocolVersion");

  // SEP-2243 `Mcp-Param-*` mirroring. A real host-behavior knob, not a
  // preference: client support in the wild is uneven (browser clients never
  // mirror), so "Omit" is how a user checks what their server does when the
  // headers do not arrive. Absent means "Mirror" — the spec-conforming
  // default — and is written back as absence so an untouched host keeps its
  // canonical hash.
  const storedMirroring = draft.mcpProfile?.toolParamHeaderMirroring;
  const setToolParamHeaderMirroring = (
    next: ToolParamHeaderMirroring | undefined,
  ) => {
    onDraftChange((prev) => {
      const base: HostConfigMcpProfileV1 = prev.mcpProfile ?? {
        profileVersion: 1,
      };
      const updated: HostConfigMcpProfileV1 = {
        ...base,
        toolParamHeaderMirroring: next,
      };
      return {
        ...prev,
        mcpProfile: isMcpProfileEmpty(updated) ? undefined : updated,
      };
    });
  };

  // Client-conformance knobs (siblings of the mirroring control above). Both
  // model how REAL hosts differ, so the default is written back as ABSENCE
  // and only the degraded value is stored.
  const storedPagination = draft.mcpProfile?.paginationTraversal;
  const storedMrtrSupport = draft.mcpProfile?.mrtrSupport;
  const setConformanceKnob = <K extends "paginationTraversal" | "mrtrSupport">(
    key: K,
    next: HostConfigMcpProfileV1[K] | undefined,
  ) => {
    onDraftChange((prev) => {
      const base: HostConfigMcpProfileV1 = prev.mcpProfile ?? {
        profileVersion: 1,
      };
      const updated: HostConfigMcpProfileV1 = { ...base, [key]: next };
      return {
        ...prev,
        mcpProfile: isMcpProfileEmpty(updated) ? undefined : updated,
      };
    });
  };

  // Enterprise-managed authorization POLICY (simulates Claude's org-admin
  // "authorize once for the whole org"): when on, every HTTP server whose
  // auth method is Auto resolves to XAA via the host's IdP; explicit
  // per-server methods override; unregistered servers fail to connect with
  // a first-class error instead of silently falling back to OAuth. Stored
  // under mcpProfile.extensions (surfaced in the JSON editor below); the
  // EMA capability advertisement is DERIVED from the policy at connect
  // time, no longer independently stored by this Switch.
  const policyState = readXaaEnterprisePolicy(draft.mcpProfile);
  const policyOn = policyState.kind === "on";
  const policyInvalid = policyState.kind === "invalid";
  // Gated on the same `xaa` flag as the per-server XAA auth option
  // (AuthenticationSection's `showXaaOption`) — without it a flag-off user
  // could turn the policy on, make every Auto server fail closed, and have
  // no UI left to add the XAA registration that fixes them. Same escape
  // hatch as that gate: an already-on (or malformed) stored policy always
  // renders, so a host is never stranded with an invisible active policy
  // it can't turn off.
  const xaaFlagEnabled = useFeatureFlagEnabled("xaa");
  const showPolicyToggle =
    xaaFlagEnabled === true || policyState.kind !== "off";
  const setPolicyOn = (next: boolean) => {
    onDraftChange((prev) => {
      const profile = prev.mcpProfile as Record<string, unknown> | undefined;
      return {
        ...prev,
        mcpProfile: (next
          ? withXaaEnterprisePolicy(profile)
          : withoutXaaEnterprisePolicy(profile)) as
          | HostConfigMcpProfileV1
          | undefined,
      };
    });
  };

  // MCPJam's Tasks product policy. NOT the `io.modelcontextprotocol/tasks`
  // wire capability — that one is advertised to servers and is edited as a
  // client capability; this one is MCPJam configuration that no server ever
  // sees. Same derive-per-render rule as elicitation below.
  const tasksPolicy = readTasksPolicy(draft);
  const tasksPolicyInvalid = tasksPolicy === "invalid";
  // Wider escape hatch than the XAA gate above. XAA tests `!== "off"` because
  // "off" doubles as absent there; this policy has a real explicit-off state,
  // and a host stored as explicitly `off` must still render the control or it
  // is stranded with tasks disabled and no UI left to re-enable them.
  const tasksFlagEnabled = useFeatureFlagEnabled("mcp-tasks");
  const showTasksPolicy = tasksFlagEnabled === true || tasksPolicy !== "unset";
  const fTasksPolicy = hostConfigField("tasksPolicy");
  const setTasksPolicyChoice = (next: TasksPolicyChoice) => {
    onDraftChange((prev) =>
      next === "default"
        ? clearTasksPolicy(prev)
        : setTasksPolicy(prev, next === "on"),
    );
  };

  // Derived per render from the draft rather than mirrored into state: catalog
  // rows already ship an elicitation shape, and seeding local state from it
  // would write our canonical shape back on mount and churn the config hash
  // before the user ever touched the switch.
  const elicitation = elicitationCapabilityState(draft.clientCapabilities);
  const setElicitationEnabled = (next: boolean) => {
    onDraftChange((prev) =>
      next ? withElicitation(prev, { url: false }) : withoutElicitation(prev)
    );
  };
  const setElicitationUrlMode = (next: boolean) => {
    onDraftChange((prev) => withElicitation(prev, { url: next }));
  };

  return (
    <div className="flex h-full min-h-[480px] flex-col gap-3">
      <div className="rounded-[10px] border border-border bg-background px-3.5 py-2.5">
        <div className="flex items-center gap-3">
          <span
            className="text-[12px] font-medium"
            title="Automatic: store no pin — MCPJam picks the wire version at connect time. Any other choice pins that exact revision for every server on this client."
          >
            {fProtocolVersion.label}
          </span>
          <Select
            value={selectedDropdownValue}
            onValueChange={(next) => {
              setProtocolVersion(
                next === "auto" ? undefined : (next as McpProtocolVersion)
              );
            }}
            disabled={readOnly}
          >
            {/* The visible label is a plain <span>, not a <label>, so the
                trigger needs its own accessible name — and there is now more
                than one Select in this panel. */}
            <SelectTrigger aria-label="MCP protocol version" className="h-9 text-xs">
              <SelectValue placeholder="Automatic" />
            </SelectTrigger>
            <SelectContent>
              {HOST_PROTOCOL_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* Spells out what a pin actually stores. The two pinned cases differ
            materially, so they get their own copy: a stateless pin has no
            legacy fallback, while a stateful pin narrows the initialize
            handshake to that one version. "Automatic" gets no line — the
            absence of a pin needs no explanation and keeps the panel quiet in
            the default state. */}
        {selectedDropdownValue !== "auto" && (
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
            {isStatelessProtocolVersion(selectedDropdownValue)
              ? `Pinned to ${selectedDropdownValue} for every server on this client. The server must offer it at connect time; there is no fallback to 2025. A server's own protocol override still wins.`
              : `Pinned to ${selectedDropdownValue} — the initialize handshake offers only this version. A server's own protocol override still wins.`}
          </p>
        )}
        <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border/50 pt-2.5">
          <div className="min-w-0">
            <span className="text-[12px] font-medium">
              Mirror tool params into Mcp-Param-* headers (SEP-2243)
            </span>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {storedMirroring === "omit"
                ? "Omitting them — this client behaves like one that has not implemented SEP-2243. A conforming 2026-07-28 server should answer -32020 HeaderMismatch."
                : "Mirroring a tool's x-mcp-header arguments onto the request, as the spec requires. Switch to Omit to see how your server handles a client that doesn't."}
            </p>
          </div>
          <Select
            value={storedMirroring ?? "mirror"}
            onValueChange={(next) => {
              // "mirror" writes ABSENCE, not the literal: the conforming
              // default must keep hashing like a host that never opted in.
              setToolParamHeaderMirroring(
                next === "omit" ? "omit" : undefined,
              );
            }}
            disabled={readOnly}
          >
            <SelectTrigger
              aria-label="Mcp-Param-* mirroring"
              className="h-9 w-[220px] flex-shrink-0 text-xs"
            >
              <SelectValue placeholder="Mirror" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mirror">Mirror (default)</SelectItem>
              <SelectItem value="omit">
                Omit (simulate non-conforming client)
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border/50 pt-2.5">
          <div className="min-w-0">
            <span className="text-[12px] font-medium">
              Paginated list traversal
            </span>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {storedPagination === "firstPageOnly"
                ? "Reading only the first page, like the hosts that never follow nextCursor. Tools past page one are invisible — and on 2026-07-28 their calls also lose the mirrored Mcp-Param-* headers, because the mirroring source is the page-one list this client cached."
                : "Following nextCursor to the end of the list, as a conforming client does. Switch to first page only to see your server through a host that stops after one page."}
            </p>
          </div>
          <Select
            value={storedPagination ?? "full"}
            onValueChange={(next) => {
              // "full" writes ABSENCE — the default must keep hashing like a
              // host that never opted in.
              setConformanceKnob(
                "paginationTraversal",
                next === "firstPageOnly" ? "firstPageOnly" : undefined,
              );
            }}
            disabled={readOnly}
          >
            <SelectTrigger
              aria-label="Paginated list traversal"
              className="h-9 w-[220px] flex-shrink-0 text-xs"
            >
              <SelectValue placeholder="Walk every page" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="full">Walk every page (default)</SelectItem>
              <SelectItem value="firstPageOnly">First page only</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border/50 pt-2.5">
          <div className="min-w-0">
            <span className="text-[12px] font-medium">
              Multi-round tool results (MRTR)
            </span>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {storedMrtrSupport === "none"
                ? "Not driving input_required rounds — this client behaves like one that never implemented the 2026 pattern. It stops advertising elicitation on a modern connection, so a server that would have elicited answers -32021 instead."
                : "Driving input_required rounds, so a server can collect input mid-call. Switch to Not supported to see what your server does with a client that cannot. Which elicitation modes are offered is set by this host's client capabilities."}
            </p>
          </div>
          <Select
            value={storedMrtrSupport ?? "full"}
            onValueChange={(next) => {
              setConformanceKnob(
                "mrtrSupport",
                next === "none" ? "none" : undefined,
              );
            }}
            disabled={readOnly}
          >
            <SelectTrigger
              aria-label="Multi-round tool results"
              className="h-9 w-[220px] flex-shrink-0 text-xs"
            >
              <SelectValue placeholder="Supported" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="full">Supported (default)</SelectItem>
              <SelectItem value="none">Not supported</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {showPolicyToggle && (
        <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border/50 pt-2.5">
          <div className="min-w-0">
            <span className="text-[12px] font-medium">
              Enterprise-managed authorization
            </span>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Route every HTTP server connection through your IdP (XAA) by
              default. A server&apos;s explicit auth method overrides.
              Servers without an XAA client registration fail to connect.
              Applies on the next connect.
            </p>
            {policyInvalid ? (
              <p className="text-[11px] leading-snug text-destructive">
                This host&apos;s stored policy value is unsupported —
                connections will fail until it is fixed. Toggling on repairs
                it; toggling off removes it.
              </p>
            ) : null}
          </div>
          <Switch
            checked={policyOn}
            onCheckedChange={setPolicyOn}
            disabled={readOnly}
            aria-label="Enterprise-managed authorization"
          />
        </div>
        )}
        {showTasksPolicy && (
        <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border/50 pt-2.5">
          <div className="min-w-0">
            <span className="text-[12px] font-medium">
              {fTasksPolicy.label}
            </span>
            <p className="text-[11px] leading-snug text-muted-foreground">
              Whether chat, the agent and evals may run tools as MCP tasks on
              servers that support them. Use default keeps today&apos;s
              behavior: the Tools tab&apos;s own per-call controls, and nothing
              else. Off removes every task affordance.
            </p>
            {tasksPolicyInvalid ? (
              <p className="text-[11px] leading-snug text-destructive">
                {describeInvalidTasksPolicy(draft) ??
                  "This host's stored task policy is unsupported."}{" "}
                Tasks stay disabled until it is fixed; any choice below repairs
                it.
              </p>
            ) : null}
          </div>
          <Select
            value={tasksPolicyInvalid ? undefined : TASKS_POLICY_VALUE[tasksPolicy]}
            onValueChange={(next) =>
              setTasksPolicyChoice(next as TasksPolicyChoice)
            }
            disabled={readOnly}
          >
            <SelectTrigger className="h-9 w-[150px] shrink-0 text-xs">
              {/* An invalid stored value shows the placeholder rather than
                  snapping to "Use default": pretending a broken config is the
                  default would hide the very thing the warning is about. */}
              <SelectValue placeholder="Unsupported value" />
            </SelectTrigger>
            <SelectContent>
              {TASKS_POLICY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        )}
        <div className="mt-2.5 border-t border-border/50 pt-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="text-[12px] font-medium">Elicitation</span>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Advertises the elicitation client capability. When enabled,
                hosted chat pauses tool calls to collect your input.
              </p>
            </div>
            <Switch
              checked={elicitation.enabled}
              onCheckedChange={setElicitationEnabled}
              disabled={readOnly}
              aria-label="Elicitation"
            />
          </div>
          {elicitation.enabled ? (
            <div className="mt-2.5 flex items-start gap-2 pl-4">
              <Checkbox
                id="elicitation-url-mode"
                className="mt-0.5"
                checked={elicitation.url}
                onCheckedChange={(checked) =>
                  setElicitationUrlMode(checked === true)
                }
                disabled={readOnly}
              />
              <label
                htmlFor="elicitation-url-mode"
                className="text-[11px] leading-snug text-muted-foreground"
              >
                URL mode — allow servers to ask you to open a URL (you always
                review it first).
              </label>
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <JsonEditor
          rawContent={content}
          onRawChange={onRawChange}
          mode={effectiveJsonMode}
          onModeChange={readOnly ? undefined : setJsonMode}
          showModeToggle={!readOnly}
          showToolbar
          showLineNumbers
          autoFormatOnEdit={false}
          height="100%"
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}
