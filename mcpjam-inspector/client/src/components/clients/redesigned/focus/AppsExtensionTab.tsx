import { useState } from "react";
import { JsonEditor, type JsonEditorMode } from "@/components/ui/json-editor";
import {
  resolveEffectiveHostCapabilities,
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
} from "@/lib/client-config-v2";
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
 * User-facing JSON document. Shape matches SEP-1865 verbatim so an MCP App
 * developer can read it against the spec without translating inspector-
 * specific concepts. Key points:
 *
 *  - `hostCapabilities` is the EFFECTIVE merged value (preset for the
 *    active hostStyle, overlaid with the user's `hostCapabilitiesOverride`
 *    when defined). On parse-back we diff against the preset to decide
 *    whether an override needs to be stored, so editing back to the
 *    preset's exact shape cleanly reverts to "no override" — the backend
 *    hashes that distinctly from an explicit `{}`.
 *
 *  - `hostCapabilities.sandbox` is the SPEC SHAPE — four allowlist arrays
 *    under `csp` (connectDomains, resourceDomains, frameDomains,
 *    baseUriDomains) and presence-flag objects under `permissions`
 *    (camera, microphone, geolocation, clipboardWrite). The inspector
 *    stores this as `mcpProfile.apps.sandbox.csp.restrictTo` /
 *    `permissions.allow`; we hoist it into spec position on serialize and
 *    lift it back on parse. Inspector-only knobs (`mode`, `extensions`)
 *    are intentionally not surfaced in this JSON — they aren't in the
 *    SEP and would confuse a developer reading the doc against the spec.
 *    They're preserved across edits.
 */
type SpecSandboxCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};
/**
 * The four currently-spec'd permission keys, kept around for type-aware
 * call sites. Permission keys outside this list (e.g. future SEP
 * additions, host-specific extensions) are NOT dropped — they round-trip
 * verbatim through serialize / parse so editing the JSON doesn't silently
 * erase policy data the inspector doesn't yet know about.
 */
type SpecSandboxPermissions = {
  camera?: Record<string, never>;
  microphone?: Record<string, never>;
  geolocation?: Record<string, never>;
  clipboardWrite?: Record<string, never>;
} & Record<string, unknown>;
type SpecHostCapabilitiesSandbox = {
  csp?: SpecSandboxCsp;
  permissions?: SpecSandboxPermissions;
};

type AppsDoc = {
  extensions?: Record<string, unknown>;
  hostCapabilities?: Record<string, unknown>;
  hostContext: Record<string, unknown>;
  uiInitialize?: {
    hostInfo?: Record<string, unknown>;
  };
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Build the spec-shaped `HostCapabilities.sandbox` from our internal
 * storage. We persist a richer policy (mode/restrictTo); the spec
 * only knows about the four domain allowlists and the four permission
 * presence-flags. `restrictTo` IS the spec's allowlist semantically —
 * "host MAY further restrict but MUST NOT allow undeclared domains" —
 * so we hoist it directly into spec position.
 */
function specSandboxFromPolicy(
  policy: NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"] | undefined,
): SpecHostCapabilitiesSandbox | undefined {
  if (!policy) return undefined;
  const out: SpecHostCapabilitiesSandbox = {};

  const restrict = policy.csp?.restrictTo;
  if (restrict) {
    const csp: SpecSandboxCsp = {};
    if (restrict.connectDomains && restrict.connectDomains.length > 0)
      csp.connectDomains = [...restrict.connectDomains];
    if (restrict.resourceDomains && restrict.resourceDomains.length > 0)
      csp.resourceDomains = [...restrict.resourceDomains];
    if (restrict.frameDomains && restrict.frameDomains.length > 0)
      csp.frameDomains = [...restrict.frameDomains];
    if (restrict.baseUriDomains && restrict.baseUriDomains.length > 0)
      csp.baseUriDomains = [...restrict.baseUriDomains];
    if (Object.keys(csp).length > 0) out.csp = csp;
  }

  const allow = policy.permissions?.allow;
  if (allow) {
    const perms: SpecSandboxPermissions = {};
    // Iterate ALL keys in storage — not just the spec-known set — so any
    // permission the inspector doesn't recognize round-trips through the
    // editor instead of being silently erased on the next save. Spec uses
    // presence: `camera: {}` means granted; absence means not granted.
    // Our storage uses a boolean map; `false` and missing both mean "not
    // granted".
    for (const [key, value] of Object.entries(allow)) {
      if (value === true) perms[key] = {};
    }
    if (Object.keys(perms).length > 0) out.permissions = perms;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

type SandboxPolicy = NonNullable<
  NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
>;
type SandboxPolicyCsp = NonNullable<SandboxPolicy["csp"]>;
type SandboxPolicyPerms = NonNullable<SandboxPolicy["permissions"]>;

/**
 * Inverse of `specSandboxFromPolicy`. Reads the spec-shaped
 * `hostCapabilities.sandbox` block coming out of the JSON editor and
 * folds it into the inspector's richer policy shape, preserving prev's
 * inspector-only knobs (`mode`, `extensions`).
 */
function liftSpecSandboxIntoPolicy(args: {
  incomingPresent: boolean;
  incoming: SpecHostCapabilitiesSandbox | undefined;
  prev: SandboxPolicy | undefined;
}): SandboxPolicy | undefined {
  const { incomingPresent, incoming, prev } = args;

  // No sandbox key in the JSON at all → don't touch policy. The user
  // either hasn't expanded the section or it's a no-op save.
  if (!incomingPresent) return prev;

  const prevCsp = prev?.csp;
  const prevPerms = prev?.permissions;

  // CSP: replace restrictTo wholesale with the parsed spec arrays.
  // Preserve mode / extensions from prev.
  const newRestrict: SpecSandboxCsp = {};
  const incomingCsp = incoming?.csp;
  if (incomingCsp?.connectDomains && incomingCsp.connectDomains.length > 0) {
    newRestrict.connectDomains = [...incomingCsp.connectDomains];
  }
  if (incomingCsp?.resourceDomains && incomingCsp.resourceDomains.length > 0) {
    newRestrict.resourceDomains = [...incomingCsp.resourceDomains];
  }
  if (incomingCsp?.frameDomains && incomingCsp.frameDomains.length > 0) {
    newRestrict.frameDomains = [...incomingCsp.frameDomains];
  }
  if (incomingCsp?.baseUriDomains && incomingCsp.baseUriDomains.length > 0) {
    newRestrict.baseUriDomains = [...incomingCsp.baseUriDomains];
  }

  const nextCsp: SandboxPolicyCsp = {};
  if (prevCsp?.mode !== undefined) nextCsp.mode = prevCsp.mode;
  if (prevCsp?.extensions !== undefined) nextCsp.extensions = prevCsp.extensions;
  // cspDirectives is an inspector-only emission knob — not in the spec JSON
  // shape. Preserve verbatim across a JSON edit; the user manages it from
  // the structured editor in `ClientConfigEditor`, not by typing it here.
  if (prevCsp?.cspDirectives !== undefined)
    nextCsp.cspDirectives = prevCsp.cspDirectives;
  if (Object.keys(newRestrict).length > 0) nextCsp.restrictTo = newRestrict;
  const cspNonEmpty = Object.keys(nextCsp).length > 0;

  // Permissions: rebuild `allow` from presence-flags. Preserve mode /
  // extensions from prev. Iterates every key in the incoming JSON (not
  // just the spec-known set) so a host using a permission the inspector
  // doesn't yet recognize survives a round-trip through the editor. The
  // spec encodes "granted" as a presence object (`{}`); any non-null
  // value in that slot reads as granted.
  const newAllow: Record<string, boolean> = {};
  const incomingPerms = incoming?.permissions;
  if (incomingPerms) {
    for (const [key, value] of Object.entries(incomingPerms)) {
      if (value !== undefined && value !== null) {
        newAllow[key] = true;
      }
    }
  }

  const nextPerms: SandboxPolicyPerms = {};
  if (prevPerms?.mode !== undefined) nextPerms.mode = prevPerms.mode;
  if (prevPerms?.extensions !== undefined)
    nextPerms.extensions = prevPerms.extensions;
  if (Object.keys(newAllow).length > 0) nextPerms.allow = newAllow;
  const permsNonEmpty = Object.keys(nextPerms).length > 0;

  // sandboxAttrs and allowFeatures are inspector-only emission knobs —
  // never surfaced in the spec JSON view. Preserve verbatim across a JSON
  // edit; the user manages them from the structured editor in
  // `ClientConfigEditor`, not by typing them here.
  const prevSandboxAttrs = prev?.sandboxAttrs;
  const prevAllowFeatures = prev?.allowFeatures;

  if (
    !cspNonEmpty &&
    !permsNonEmpty &&
    prevSandboxAttrs === undefined &&
    prevAllowFeatures === undefined
  ) {
    return undefined;
  }
  const next: SandboxPolicy = {};
  if (cspNonEmpty) next.csp = nextCsp;
  if (permsNonEmpty) next.permissions = nextPerms;
  if (prevSandboxAttrs !== undefined) next.sandboxAttrs = prevSandboxAttrs;
  if (prevAllowFeatures !== undefined) next.allowFeatures = prevAllowFeatures;
  return next;
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
  // strips `sandbox` defensively because we own sandbox separately; we then
  // hoist the spec-shaped sandbox view into the same object below.
  const effectiveCaps = resolveEffectiveHostCapabilities({
    hostStyle: draft.hostStyle,
    hostCapabilitiesOverride: draft.hostCapabilitiesOverride,
  }) as Record<string, unknown>;

  // Nest sandbox inside hostCapabilities per SEP-1865, using the spec
  // shape (allowlist arrays + permission presence-flags). Our richer
  // policy fields (mode/extensions) are intentionally NOT surfaced
  // here — they're inspector knobs, not in the SEP, so a developer
  // reading this JSON against the spec sees only spec primitives.
  const specSandbox = specSandboxFromPolicy(draft.mcpProfile?.apps?.sandbox);
  if (specSandbox) {
    effectiveCaps.sandbox = specSandbox;
  }

  if (Object.keys(effectiveCaps).length > 0) {
    doc.hostCapabilities = effectiveCaps;
  }

  // mcpProfile.apps.uiInitialize.hostInfo
  const hostInfo = draft.mcpProfile?.apps?.uiInitialize?.hostInfo;
  if (isPlainObject(hostInfo) && Object.keys(hostInfo).length > 0) {
    doc.uiInitialize = { hostInfo };
  }

  return doc;
}

export function applyJsonToDraft(
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
  // `sandbox` is peeled off here and routed to mcpProfile.apps.sandbox
  // storage below; the override-diff compares only the static cap fields
  // so adding/changing sandbox doesn't spuriously create a host-caps
  // override.
  const presetEffective = resolveEffectiveHostCapabilities({
    hostStyle: prev.hostStyle,
    hostCapabilitiesOverride: undefined,
  }) as Record<string, unknown>;
  let nextOverride: Record<string, unknown> | undefined = undefined;
  let incomingHostCapsSandbox: SpecHostCapabilitiesSandbox | undefined;
  let hostCapsSandboxPresent = false;
  if ("hostCapabilities" in parsed) {
    if (isPlainObject(parsed.hostCapabilities)) {
      const { sandbox, ...incoming } = parsed.hostCapabilities;
      hostCapsSandboxPresent = "sandbox" in parsed.hostCapabilities;
      if (isPlainObject(sandbox)) {
        incomingHostCapsSandbox = sandbox as SpecHostCapabilitiesSandbox;
      }
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
  // so cross-tab edits don't trample each other. `apps.uiInitialize`
  // round-trips through this tab's JSON doc; `apps.sandbox` is lifted
  // from `hostCapabilities.sandbox` (spec-shape) back into the inspector's
  // richer policy shape, preserving prev's mode/extensions.
  const prevProfile = prev.mcpProfile;
  const prevSandbox = prevProfile?.apps?.sandbox;
  const incomingUiInit = isPlainObject(parsed.uiInitialize)
    ? parsed.uiInitialize
    : undefined;

  const newAppsHostInfo =
    incomingUiInit && isPlainObject(incomingUiInit.hostInfo)
      ? incomingUiInit.hostInfo
      : undefined;

  // Lift spec-shaped hostCapabilities.sandbox back into policy storage.
  // - hostCaps had no `sandbox` key → use prev sandbox verbatim (no edit)
  // - hostCaps had `sandbox` (even empty) → user is asserting intent, so
  //   overwrite restrictTo / permissions.allow with the parsed spec
  //   values; preserve mode / extensions from prev because those
  //   are inspector-only and the JSON view never exposed them.
  const nextSandbox = liftSpecSandboxIntoPolicy({
    incomingPresent: hostCapsSandboxPresent,
    incoming: incomingHostCapsSandbox,
    prev: prevSandbox,
  });

  const appsBlock: NonNullable<HostConfigMcpProfileV1["apps"]> = {};
  if (nextSandbox) appsBlock.sandbox = nextSandbox;
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
  const [jsonMode, setJsonMode] = useState<JsonEditorMode>("edit");
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
        mode={jsonMode}
        onModeChange={setJsonMode}
        showModeToggle
        showToolbar
        showLineNumbers
        autoFormatOnEdit={false}
        height="100%"
      />
    </div>
  );
}
