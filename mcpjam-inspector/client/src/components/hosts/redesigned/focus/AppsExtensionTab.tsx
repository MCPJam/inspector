import { JsonEditor } from "@/components/ui/json-editor";
import {
  resolveEffectiveHostCapabilities,
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
} from "@/lib/host-config-v2";
import { stableStringifyJson } from "@/lib/client-config";
import type { HostAttentionIssue } from "../types";
import { useJsonDraftBuffer } from "./useJsonDraftBuffer";

interface AppsExtensionTabProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  attention: ReadonlyArray<HostAttentionIssue>;
}

/**
 * User-facing JSON document. The shape matches the SEP-1865 nomenclature
 * the View sees rather than the storage layout: `hostCapabilities` is the
 * EFFECTIVE merged value (preset for the active hostStyle, overlaid with
 * the user's `hostCapabilitiesOverride` when defined). On parse-back we
 * diff against the preset to decide whether an override needs to be stored,
 * so editing the JSON back to the preset's exact shape cleanly reverts to
 * "no override" — the backend hashes that distinctly from an explicit `{}`.
 */
type AppsDoc = {
  extensions?: Record<string, unknown>;
  hostCapabilities?: Record<string, unknown>;
  hostContext: Record<string, unknown>;
  uiInitialize?: {
    hostInfo?: Record<string, unknown>;
  };
  sandbox?: {
    csp?: NonNullable<
      NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
    >["csp"];
    permissions?: NonNullable<
      NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
    >["permissions"];
  };
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickIfNonEmpty<T extends Record<string, unknown>>(
  obj: T | undefined,
): T | undefined {
  if (!obj || Object.keys(obj).length === 0) return undefined;
  return obj;
}

function appsToJson(draft: HostConfigInputV2): AppsDoc {
  // hostContext is required by the type and always present — render even
  // when empty so the user sees the literal field rather than wondering
  // why it disappears.
  const doc: AppsDoc = { hostContext: draft.hostContext };

  // clientCapabilities.extensions — render verbatim if non-empty.
  const ext = draft.clientCapabilities?.extensions;
  if (isPlainObject(ext) && Object.keys(ext).length > 0) {
    doc.extensions = ext;
  }

  // hostCapabilities — show the EFFECTIVE merged value (preset + override)
  // so the JSON matches what the host actually advertises. resolveEffective
  // strips `sandbox` defensively, mirroring the runtime contract.
  const effectiveCaps = resolveEffectiveHostCapabilities({
    hostStyle: draft.hostStyle,
    hostCapabilitiesOverride: draft.hostCapabilitiesOverride,
  }) as Record<string, unknown>;
  if (Object.keys(effectiveCaps).length > 0) {
    doc.hostCapabilities = effectiveCaps;
  }

  // mcpProfile.apps.uiInitialize.hostInfo
  const hostInfo = draft.mcpProfile?.apps?.uiInitialize?.hostInfo;
  if (isPlainObject(hostInfo) && Object.keys(hostInfo).length > 0) {
    doc.uiInitialize = { hostInfo };
  }

  // mcpProfile.apps.sandbox — only render sub-keys with content.
  const sandbox = draft.mcpProfile?.apps?.sandbox;
  const csp = sandbox?.csp;
  const perms = sandbox?.permissions;
  const cspNonEmpty =
    csp &&
    (csp.mode !== undefined ||
      pickIfNonEmpty(csp.restrictTo as Record<string, unknown> | undefined) ||
      pickIfNonEmpty(csp.deny as Record<string, unknown> | undefined) ||
      pickIfNonEmpty(csp.extensions));
  const permsNonEmpty =
    perms &&
    (perms.mode !== undefined ||
      pickIfNonEmpty(perms.allow as Record<string, unknown> | undefined) ||
      (perms.deny && perms.deny.length > 0) ||
      pickIfNonEmpty(perms.extensions));
  if (cspNonEmpty || permsNonEmpty) {
    doc.sandbox = {};
    if (cspNonEmpty) doc.sandbox.csp = csp;
    if (permsNonEmpty) doc.sandbox.permissions = perms;
  }

  return doc;
}

function applyJsonToDraft(
  parsed: unknown,
  prev: HostConfigInputV2,
): HostConfigInputV2 | null {
  if (!isPlainObject(parsed)) return null;

  // extensions — write the parsed record back to clientCapabilities. Empty
  // or missing keys collapse to "no extensions advertised", matching the
  // form's writeExtension() behavior.
  const nextCaps: Record<string, unknown> = { ...prev.clientCapabilities };
  const incomingExts = parsed.extensions;
  if (isPlainObject(incomingExts) && Object.keys(incomingExts).length > 0) {
    nextCaps.extensions = incomingExts;
  } else {
    delete nextCaps.extensions;
  }

  // hostCapabilities — the user sees the EFFECTIVE merged value, so on
  // parse-back we diff against the preset to decide whether to store an
  // override:
  //   - absent in JSON → undefined override (revert to preset)
  //   - equal to preset → undefined override (clean revert)
  //   - different from preset → override = parsed value (incl. `{}` for
  //     "advertise nothing")
  // `sandbox` is stripped defensively per SEP-1865 (sandbox is per-resource
  // at runtime, never a vendor trait).
  const presetEffective = resolveEffectiveHostCapabilities({
    hostStyle: prev.hostStyle,
    hostCapabilitiesOverride: undefined,
  }) as Record<string, unknown>;
  let nextOverride: Record<string, unknown> | undefined = undefined;
  if ("hostCapabilities" in parsed) {
    if (isPlainObject(parsed.hostCapabilities)) {
      const { sandbox: _sandbox, ...incoming } = parsed.hostCapabilities;
      if (stableStringifyJson(incoming) === stableStringifyJson(presetEffective)) {
        nextOverride = undefined;
      } else {
        nextOverride = incoming;
      }
    }
    // else (null / non-object): treat as "leave override alone" rather
    // than silently nuking it.
    else nextOverride = prev.hostCapabilitiesOverride;
  }

  // hostContext — record passthrough. Default to `{}` when omitted (the
  // type field is required as a record).
  let nextHostContext: Record<string, unknown> = {};
  if (isPlainObject(parsed.hostContext)) {
    nextHostContext = parsed.hostContext;
  }

  // mcpProfile.apps reconstruction. We rebuild only the `apps` half and
  // splice back the user's existing `initialize` (edited in ProtocolTab)
  // and any unknown future keys so cross-tab edits don't trample each
  // other.
  const prevProfile = prev.mcpProfile;
  const incomingUiInit = isPlainObject(parsed.uiInitialize)
    ? parsed.uiInitialize
    : undefined;
  const incomingSandbox = isPlainObject(parsed.sandbox)
    ? parsed.sandbox
    : undefined;

  const newAppsHostInfo =
    incomingUiInit && isPlainObject(incomingUiInit.hostInfo)
      ? incomingUiInit.hostInfo
      : undefined;
  const newSandboxCsp =
    incomingSandbox && isPlainObject(incomingSandbox.csp)
      ? (incomingSandbox.csp as NonNullable<
          NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
        >["csp"])
      : undefined;
  const newSandboxPerms =
    incomingSandbox && isPlainObject(incomingSandbox.permissions)
      ? (incomingSandbox.permissions as NonNullable<
          NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
        >["permissions"])
      : undefined;

  const appsBlock: NonNullable<HostConfigMcpProfileV1["apps"]> = {};
  if (newSandboxCsp || newSandboxPerms) {
    appsBlock.sandbox = {};
    if (newSandboxCsp) appsBlock.sandbox.csp = newSandboxCsp;
    if (newSandboxPerms) appsBlock.sandbox.permissions = newSandboxPerms;
  }
  if (newAppsHostInfo) {
    appsBlock.uiInitialize = { hostInfo: newAppsHostInfo };
  }
  const hasApps = Object.keys(appsBlock).length > 0;

  const baseProfile: HostConfigMcpProfileV1 =
    prevProfile ?? { profileVersion: 1 };
  const nextProfile: HostConfigMcpProfileV1 = {
    ...baseProfile,
    apps: hasApps ? appsBlock : undefined,
  };
  const hasInitialize =
    nextProfile.initialize !== undefined &&
    (nextProfile.initialize.clientInfo !== undefined ||
      (nextProfile.initialize.supportedProtocolVersions &&
        nextProfile.initialize.supportedProtocolVersions.length > 0));
  const profileEmpty = !hasApps && !hasInitialize && !nextProfile.extensions;

  return {
    ...prev,
    clientCapabilities: nextCaps,
    hostCapabilitiesOverride: nextOverride,
    hostContext: nextHostContext,
    mcpProfile: profileEmpty ? undefined : nextProfile,
  };
}

export function AppsExtensionTab({
  draft,
  onDraftChange,
}: AppsExtensionTabProps) {
  const { content, onRawChange } = useJsonDraftBuffer({
    draft,
    serialize: appsToJson,
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
