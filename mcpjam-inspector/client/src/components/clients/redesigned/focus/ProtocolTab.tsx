import { JsonEditor } from "@/components/ui/json-editor";
import {
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
} from "@/lib/client-config-v2";
import type { HostAttentionIssue } from "../types";
import { useJsonDraftBuffer } from "./useJsonDraftBuffer";

interface ProtocolTabProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  attention: ReadonlyArray<HostAttentionIssue>;
}

/**
 * A compact JSON view over the editable subset of HostConfigInputV2.
 * Only includes keys that are actually set on the draft — absence is
 * semantic in MCP and must round-trip through this editor faithfully.
 */
type ProtocolDoc = {
  clientInfo?: { name: string; version: string };
  supportedProtocolVersions?: string[];
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
  headers: Record<string, string>,
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

  if (
    draft.clientCapabilities &&
    Object.keys(draft.clientCapabilities).length > 0
  ) {
    doc.capabilities = draft.clientCapabilities;
  }

  const headers = draft.connectionDefaults.headers ?? {};
  const visibleEntries = Object.entries(headers).filter(
    ([k]) => k.trim() !== "" && k.toLowerCase() !== "authorization",
  );
  if (visibleEntries.length > 0) {
    doc.connectionDefaults.headers = Object.fromEntries(visibleEntries);
  }

  return doc;
}

function patchProfile(
  prev: HostConfigMcpProfileV1 | undefined,
  patch: (base: HostConfigMcpProfileV1) => HostConfigMcpProfileV1 | undefined,
): HostConfigMcpProfileV1 | undefined {
  return patch(prev ?? { profileVersion: 1 });
}

function applyJsonToDraft(
  parsed: unknown,
  prev: HostConfigInputV2,
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
    typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
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
    };

    const allEmpty =
      next.initialize === undefined && !next.apps && !next.extensions;
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

export function ProtocolTab({ draft, onDraftChange }: ProtocolTabProps) {
  const { content, onRawChange } = useJsonDraftBuffer({
    draft,
    serialize: protocolToJson,
    applyParsedToDraft: applyJsonToDraft,
    onDraftChange,
  });

  return (
    <div className="flex h-full min-h-[480px] flex-col">
      <JsonEditor
        rawContent={content}
        onRawChange={onRawChange}
        mode="edit"
        showModeToggle
        showToolbar
        showLineNumbers
        autoFormatOnEdit={false}
        height="100%"
      />
    </div>
  );
}
