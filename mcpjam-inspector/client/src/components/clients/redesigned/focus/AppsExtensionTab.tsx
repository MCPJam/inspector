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
 * User-facing JSON document. The `sandbox` block configures the proxy
 * iframe the inspector renders MCP App views in — one place to edit
 * everything the inspector enforces at the iframe boundary, matching the
 * "Sandbox proxy iframe" card in the matrix.
 *
 * Spec-portable fields (will be advertised as `HostCapabilities.sandbox`
 * to real MCP App views) keep their SEP-1865 names and positions verbatim:
 *
 *   sandbox.csp.connectDomains   ⟷ SEP-1865 HostCapabilities.sandbox.csp.connectDomains
 *   sandbox.csp.resourceDomains  ⟷ SEP-1865 HostCapabilities.sandbox.csp.resourceDomains
 *   sandbox.csp.frameDomains     ⟷ SEP-1865 HostCapabilities.sandbox.csp.frameDomains
 *   sandbox.csp.baseUriDomains   ⟷ SEP-1865 HostCapabilities.sandbox.csp.baseUriDomains
 *   sandbox.permissions          ⟷ SEP-1865 HostCapabilities.sandbox.permissions
 *
 * Inspector-only knobs (NOT in SEP-1865 — won't survive a host swap) are
 * named after the HTML mechanism they drive on the proxy iframe:
 *
 *   sandbox.csp.directiveOverrides   per-directive CSP source-expression
 *                                    overrides on the proxy iframe CSP
 *   sandbox.iframeSandboxAttrs       extra tokens for the iframe `sandbox=`
 *                                    attribute beyond the spec-required
 *                                    `allow-scripts allow-same-origin`
 *   sandbox.permissionsPolicy        Permissions Policy entries on the
 *                                    iframe `allow=` attribute beyond the
 *                                    4 SEP-blessed features
 *
 * Inspector-internal resolver fields (`mode`, `extensions`) stay out of
 * the JSON entirely — they're owned by the structured editor and preserved
 * across JSON edits.
 *
 * `hostCapabilities` is the EFFECTIVE merged value (preset + override).
 * On parse-back we diff against the preset to decide whether to store an
 * override, so editing back to the preset's exact shape cleanly reverts to
 * "no override" — the backend hashes that distinctly from an explicit `{}`.
 *
 * Permissions use the spec presence-flag shape (`{ clipboardWrite: {} }`
 * means granted; absence means not granted). Stored internally as a
 * boolean map; converted at the JSON boundary.
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

type SandboxDocCsp = SpecSandboxCsp & {
  /**
   * Inspector-only: per-directive source-expression overrides on the
   * proxy iframe CSP (e.g. `script-src: ["'unsafe-eval'"]`). NOT in
   * SEP-1865. Sits under `csp` because that's the directive family it
   * affects, but a real MCP App host won't see this.
   */
  directiveOverrides?: Record<string, string[]>;
};

type SandboxDoc = {
  csp?: SandboxDocCsp;
  permissions?: SpecSandboxPermissions;
  /**
   * Inspector-only: extra tokens for the proxy iframe's HTML `sandbox=`
   * attribute, on top of the spec-required `allow-scripts allow-same-origin`.
   * NOT in SEP-1865.
   */
  iframeSandboxAttrs?: string[];
  /**
   * Inspector-only: Permissions Policy entries written to the proxy
   * iframe's HTML `allow=` attribute, beyond the 4 SEP-blessed features in
   * `permissions`. NOT in SEP-1865. May not survive a host swap.
   */
  permissionsPolicy?: Record<string, string>;
};

type AppsDoc = {
  extensions?: Record<string, unknown>;
  hostCapabilities?: Record<string, unknown>;
  hostContext: Record<string, unknown>;
  sandbox?: SandboxDoc;
  uiInitialize?: {
    hostInfo?: Record<string, unknown>;
  };
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Build the JSON `sandbox` block from internal policy storage. The four
 * CSP allowlists are hoisted out of internal `csp.restrictTo` into spec
 * position directly under `csp.{connectDomains, ...}` so a reader can map
 * them straight to SEP-1865; inspector-only knobs are nested with names
 * that telegraph their non-spec status.
 */
function sandboxFromPolicy(
  policy: NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"] | undefined,
): SandboxDoc | undefined {
  if (!policy) return undefined;
  const out: SandboxDoc = {};

  const cspBlock: SandboxDocCsp = {};
  // Hoist restrictTo's allowlists into spec position. Semantically these
  // ARE the spec's `HostCapabilities.sandbox.csp.{connectDomains, ...}` —
  // "host MAY further restrict but MUST NOT allow undeclared domains."
  const restrict = policy.csp?.restrictTo;
  if (restrict) {
    if (restrict.connectDomains && restrict.connectDomains.length > 0)
      cspBlock.connectDomains = [...restrict.connectDomains];
    if (restrict.resourceDomains && restrict.resourceDomains.length > 0)
      cspBlock.resourceDomains = [...restrict.resourceDomains];
    if (restrict.frameDomains && restrict.frameDomains.length > 0)
      cspBlock.frameDomains = [...restrict.frameDomains];
    if (restrict.baseUriDomains && restrict.baseUriDomains.length > 0)
      cspBlock.baseUriDomains = [...restrict.baseUriDomains];
  }
  const directiveOverrides = policy.csp?.cspDirectives;
  if (directiveOverrides && Object.keys(directiveOverrides).length > 0) {
    const cd: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(directiveOverrides)) cd[k] = [...v];
    cspBlock.directiveOverrides = cd;
  }
  if (Object.keys(cspBlock).length > 0) out.csp = cspBlock;

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

  if (policy.sandboxAttrs && policy.sandboxAttrs.length > 0) {
    out.iframeSandboxAttrs = [...policy.sandboxAttrs];
  }
  if (policy.allowFeatures && Object.keys(policy.allowFeatures).length > 0) {
    out.permissionsPolicy = { ...policy.allowFeatures };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

type SandboxPolicy = NonNullable<
  NonNullable<HostConfigMcpProfileV1["apps"]>["sandbox"]
>;
type SandboxPolicyCsp = NonNullable<SandboxPolicy["csp"]>;
type SandboxPolicyPerms = NonNullable<SandboxPolicy["permissions"]>;

/**
 * Inverse of `sandboxFromPolicy`. Reads the unified `sandbox` block from
 * the JSON editor and folds it into the inspector's richer policy shape,
 * preserving prev's inspector-internal knobs (`mode`, `extensions`) which
 * aren't surfaced in the JSON.
 *
 * `incomingPresent: false` means the `sandbox` key wasn't in the JSON at
 * all → don't touch the stored policy. A present (even empty) block means
 * the user is asserting intent; we replace each surfaced field with the
 * parsed value (or clear it when absent under the present block).
 */
function liftSandboxIntoPolicy(args: {
  incomingPresent: boolean;
  incoming: SandboxDoc | undefined;
  prev: SandboxPolicy | undefined;
}): SandboxPolicy | undefined {
  const { incomingPresent, incoming, prev } = args;

  if (!incomingPresent) return prev;

  const prevCsp = prev?.csp;
  const prevPerms = prev?.permissions;
  const incomingCspBlock = incoming?.csp;

  // CSP: the four spec allowlists live directly under `csp` (spec
  // position); `directiveOverrides` is the inspector-only sibling. Replace
  // each with the parsed value when its key is present; when the parent
  // `csp` block is absent, all clear. Preserve internal mode / extensions
  // from prev — those aren't in the JSON.
  const newRestrict: SpecSandboxCsp = {};
  if (incomingCspBlock?.connectDomains && incomingCspBlock.connectDomains.length > 0) {
    newRestrict.connectDomains = [...incomingCspBlock.connectDomains];
  }
  if (incomingCspBlock?.resourceDomains && incomingCspBlock.resourceDomains.length > 0) {
    newRestrict.resourceDomains = [...incomingCspBlock.resourceDomains];
  }
  if (incomingCspBlock?.frameDomains && incomingCspBlock.frameDomains.length > 0) {
    newRestrict.frameDomains = [...incomingCspBlock.frameDomains];
  }
  if (incomingCspBlock?.baseUriDomains && incomingCspBlock.baseUriDomains.length > 0) {
    newRestrict.baseUriDomains = [...incomingCspBlock.baseUriDomains];
  }

  const nextCsp: SandboxPolicyCsp = {};
  if (prevCsp?.mode !== undefined) nextCsp.mode = prevCsp.mode;
  if (prevCsp?.extensions !== undefined) nextCsp.extensions = prevCsp.extensions;
  if (incomingCspBlock?.directiveOverrides !== undefined) {
    nextCsp.cspDirectives = incomingCspBlock.directiveOverrides;
  }
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

  // iframeSandboxAttrs / permissionsPolicy: parsed value wins when the
  // block is present (absent under a present block = user cleared it).
  const nextSandboxAttrs = incoming?.iframeSandboxAttrs;
  const nextAllowFeatures = incoming?.permissionsPolicy;

  if (
    !cspNonEmpty &&
    !permsNonEmpty &&
    nextSandboxAttrs === undefined &&
    nextAllowFeatures === undefined
  ) {
    return undefined;
  }
  const next: SandboxPolicy = {};
  if (cspNonEmpty) next.csp = nextCsp;
  if (permsNonEmpty) next.permissions = nextPerms;
  if (nextSandboxAttrs !== undefined) next.sandboxAttrs = nextSandboxAttrs;
  if (nextAllowFeatures !== undefined) next.allowFeatures = nextAllowFeatures;
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
  // so the JSON matches what the host actually advertises. Sandbox lives
  // in its own top-level block below; resolveEffective strips it from this
  // object defensively so the two views don't desync.
  const effectiveCaps = resolveEffectiveHostCapabilities({
    hostStyle: draft.hostStyle,
    hostCapabilitiesOverride: draft.hostCapabilitiesOverride,
  }) as Record<string, unknown>;

  if (Object.keys(effectiveCaps).length > 0) {
    doc.hostCapabilities = effectiveCaps;
  }

  // sandbox — proxy iframe configuration. Maps to `mcpProfile.apps.sandbox`
  // in storage and the "Sandbox proxy iframe" card in the matrix. Spec
  // fields use SEP-1865 names/positions verbatim (csp.{connectDomains,...},
  // permissions); inspector-only knobs are named after the HTML mechanism
  // they drive (csp.directiveOverrides, iframeSandboxAttrs,
  // permissionsPolicy) and clearly do not survive a host swap.
  const sandboxDoc = sandboxFromPolicy(draft.mcpProfile?.apps?.sandbox);
  if (sandboxDoc) {
    doc.sandbox = sandboxDoc;
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
  // Sandbox is its own top-level block now; if a `sandbox` key sneaks into
  // hostCapabilities (paste from an older export, hand-edit), strip it so
  // it doesn't pollute the override diff.
  const presetEffective = resolveEffectiveHostCapabilities({
    hostStyle: prev.hostStyle,
    hostCapabilitiesOverride: undefined,
  }) as Record<string, unknown>;
  let nextOverride: Record<string, unknown> | undefined = undefined;
  if ("hostCapabilities" in parsed) {
    if (isPlainObject(parsed.hostCapabilities)) {
      const { sandbox: _ignored, ...incoming } = parsed.hostCapabilities;
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
  // from the unified top-level `sandbox` block back into the inspector's
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

  // Parse the `sandbox` block. Values are validated shape-wise here; the
  // canonicalizer enforces deeper constraints (no `;` or `,` in CSP
  // directive override values, spec-feature filtering, etc.) at storage
  // time. The four spec allowlists are read from spec position directly
  // under `csp`; inspector-only knobs use the new names.
  let incomingSandbox: SandboxDoc | undefined;
  let sandboxPresent = false;
  if ("sandbox" in parsed) {
    sandboxPresent = true;
    const sandboxBlock = parsed.sandbox;
    if (isPlainObject(sandboxBlock)) {
      const parsedSandbox: SandboxDoc = {};
      if (isPlainObject(sandboxBlock.csp)) {
        const c = sandboxBlock.csp;
        const cspOut: SandboxDocCsp = {};
        if (Array.isArray(c.connectDomains))
          cspOut.connectDomains = c.connectDomains.filter(
            (t): t is string => typeof t === "string",
          );
        if (Array.isArray(c.resourceDomains))
          cspOut.resourceDomains = c.resourceDomains.filter(
            (t): t is string => typeof t === "string",
          );
        if (Array.isArray(c.frameDomains))
          cspOut.frameDomains = c.frameDomains.filter(
            (t): t is string => typeof t === "string",
          );
        if (Array.isArray(c.baseUriDomains))
          cspOut.baseUriDomains = c.baseUriDomains.filter(
            (t): t is string => typeof t === "string",
          );
        if (isPlainObject(c.directiveOverrides)) {
          const cd: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(c.directiveOverrides)) {
            if (Array.isArray(v)) {
              cd[k] = v.filter((t): t is string => typeof t === "string");
            }
          }
          cspOut.directiveOverrides = cd;
        }
        // Always assign the csp block when present in JSON — empty
        // signals "user asserted intent to clear", which liftSandboxIntoPolicy
        // honors by dropping restrictTo / directiveOverrides while
        // preserving inspector-internal mode / extensions.
        parsedSandbox.csp = cspOut;
      }
      if (isPlainObject(sandboxBlock.permissions)) {
        parsedSandbox.permissions = sandboxBlock.permissions as SpecSandboxPermissions;
      }
      if (Array.isArray(sandboxBlock.iframeSandboxAttrs)) {
        parsedSandbox.iframeSandboxAttrs = sandboxBlock.iframeSandboxAttrs.filter(
          (t): t is string => typeof t === "string",
        );
      }
      if (isPlainObject(sandboxBlock.permissionsPolicy)) {
        const pp: Record<string, string> = {};
        for (const [k, v] of Object.entries(sandboxBlock.permissionsPolicy)) {
          if (typeof v === "string") pp[k] = v;
        }
        parsedSandbox.permissionsPolicy = pp;
      }
      incomingSandbox = parsedSandbox;
    }
  }

  // Lift the parsed `sandbox` block back into policy storage. Inspector-
  // internal fields not surfaced in the JSON (mode, extensions) are
  // preserved from prev across edits regardless.
  const nextSandbox = liftSandboxIntoPolicy({
    incomingPresent: sandboxPresent,
    incoming: incomingSandbox,
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
