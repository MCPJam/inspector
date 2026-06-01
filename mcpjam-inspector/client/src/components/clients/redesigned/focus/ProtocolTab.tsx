import { useState } from "react";
import { JsonEditor, type JsonEditorMode } from "@/components/ui/json-editor";
import { hostConfigField } from "@/lib/host-config-field-schema";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { isKnownProtocolVersion } from "@mcpjam/sdk/browser";
import {
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
  type McpProtocolVersion,
} from "@/lib/client-config-v2";
import type { HostAttentionIssue } from "../types";
import { useJsonDraftBuffer } from "./useJsonDraftBuffer";

type HostProtocolDropdownValue = "latest" | "rc";

const HOST_PROTOCOL_OPTIONS: Array<{
  value: HostProtocolDropdownValue;
  label: string;
}> = [
  { value: "latest", label: "Latest (2025-11-25)" },
  { value: "rc", label: "2026 RC (2026-07-28)" },
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
  capabilities?: Record<string, unknown>;
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

function protocolToJson(draft: HostConfigInputV2): ProtocolDoc {
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

  if (
    draft.clientCapabilities &&
    Object.keys(draft.clientCapabilities).length > 0
  ) {
    doc.capabilities = draft.clientCapabilities;
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

function patchProfile(
  prev: HostConfigMcpProfileV1 | undefined,
  patch: (base: HostConfigMcpProfileV1) => HostConfigMcpProfileV1 | undefined
): HostConfigMcpProfileV1 | undefined {
  return patch(prev ?? { profileVersion: 1 });
}

function applyJsonToDraft(
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
    };

    const allEmpty =
      next.initialize === undefined &&
      next.mcpProtocolVersion === undefined &&
      !next.apps &&
      !next.extensions;
    return allEmpty ? undefined : next;
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
  const statelessMcpEnabled = useFeatureFlagEnabled("stateless-mcp-enabled");
  // Stored stateful literals (legacy carry-over) collapse to "Latest"
  // since they route to the same code path; saving normalizes back to
  // undefined.
  const selectedDropdownValue: HostProtocolDropdownValue =
    draft.mcpProfile?.mcpProtocolVersion === "2026-07-28" ? "rc" : "latest";

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
      const allEmpty =
        updated.initialize === undefined &&
        updated.mcpProtocolVersion === undefined &&
        !updated.apps &&
        !updated.extensions;
      return {
        ...prev,
        mcpProfile: allEmpty ? undefined : updated,
      };
    });
  };

  // Shared with the cross-host comparison matrix via the field schema.
  const fProtocolVersion = hostConfigField("mcpProtocolVersion");

  return (
    <div className="flex h-full min-h-[480px] flex-col gap-3">
      {statelessMcpEnabled ? (
        <div className="rounded-[10px] border border-border bg-background px-3.5 py-2.5">
          <div className="flex items-center gap-3">
            <span
              className="text-[12px] font-medium"
              title="Latest: current stable MCP wire version (2025-11-25). 2026 RC: MCPJam's current 2026-07-28 stateless preview over Streamable HTTP POST."
            >
              {fProtocolVersion.label}
            </span>
            <Select
              value={selectedDropdownValue}
              onValueChange={(next) => {
                setProtocolVersion(next === "rc" ? "2026-07-28" : undefined);
              }}
              disabled={readOnly}
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Latest" />
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
        </div>
      ) : null}
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
