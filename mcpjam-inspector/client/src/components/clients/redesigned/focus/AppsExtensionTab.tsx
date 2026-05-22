import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { JsonEditor, type JsonEditorMode } from "@/components/ui/json-editor";
import {
  hostCapabilitiesOverrideToMatrix,
  resolveEffectiveHostCapabilities,
  resolveEffectiveMcpAppsCapabilities,
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
} from "@/lib/client-config-v2";
import { stableStringifyJson } from "@/lib/client-config";
import {
  getCompatRuntimeForStyle,
  OPENAI_APPS_FULL_SURFACE,
} from "@/lib/client-styles";
import type {
  McpAppsCapabilities,
  OpenAiAppsCapabilities,
  ResolvedMcpAppsCapabilities,
  ResolvedOpenAiAppsCapabilities,
} from "@/lib/client-styles";
import { Switch } from "@mcpjam/design-system/switch";
import type { HostAttentionIssue, SandboxConfigSubKey } from "../types";
import { useJsonDraftBuffer } from "./useJsonDraftBuffer";

interface AppsExtensionTabProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  attention: ReadonlyArray<HostAttentionIssue>;
  /**
   * Sandbox-config row to focus when this tab opens from a
   * `sandbox-cfg:<subKey>` matrix click (e.g. the Sandbox debug panel's
   * deep-link).
   *
   * TODO: ignored today. `JsonEditor` exposes no programmatic
   * scroll-to-key / highlight-key API; a future PR should add one (and
   * the matching CSS for a brief flash on focused regions). Threading
   * is in place end-to-end so that landing is a one-file change.
   */
  focusSubKey?: SandboxConfigSubKey;
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
  /**
   * User override for vendor compat-runtime shims the inspector
   * injects into widget HTML. Defaults inherit from the active host
   * style's preset (Apps SDK hosts → true; SEP-1865 hosts → false).
   * Surface only the fields the inspector currently honors; new shims
   * land here under additional booleans as they're added.
   *
   * `openaiAppsOverrides` is a SPARSE per-method overlay applied on
   * top of the preset when the shim is injected — present fields
   * replace the preset value, absent fields fall back to the preset.
   * Disabled methods become `typeof window.openai.X === "undefined"`
   * in the widget (the SDK runtime omits them), so feature detection
   * works correctly.
   */
  compatRuntime?: {
    openaiApps?: boolean;
    openaiAppsOverrides?: OpenAiAppsCapabilities;
  };
  /**
   * Sparse SEP-1865 `app.*` spec-bridge per-dimension override. Sibling
   * to `compatRuntime` — `compatRuntime` covers vendor compat shims
   * (`window.openai`), this covers the primary protocol surface. The
   * two matrices are independent (toggling one never affects the other).
   *
   * Round-trips with `mcpProfile.apps.mcpAppsOverrides`. Present here
   * only when non-empty so absent in the JSON means "use the host
   * style preset". Booleans / mode-array soft-validated on parse; the
   * backend canonicalizer is strict, but the editor accepts hand-typed
   * JSON that may be one rev behind.
   */
  mcpAppsOverrides?: McpAppsCapabilities;
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

  // Inspector-only knobs round-trip with their full undefined-vs-empty
  // semantics so the JSON faithfully represents what's in storage.
  // `[]` / `{}` are the user's explicit "model the strict host" intent;
  // dropping them on serialize would silently flip the JSON back to the
  // legacy permissive default on a copy/paste import.
  if (policy.sandboxAttrs !== undefined) {
    out.iframeSandboxAttrs = [...policy.sandboxAttrs];
  }
  if (policy.allowFeatures !== undefined) {
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
    profile: draft.mcpProfile,
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

  // mcpProfile.apps.compatRuntime — only render when the user has set
  // an explicit override (not the host style preset). Absent in the
  // JSON means "use the preset"; present means "user has opinions".
  const compatRuntime = draft.mcpProfile?.apps?.compatRuntime;
  if (compatRuntime) {
    const compatOut: NonNullable<AppsDoc["compatRuntime"]> = {};
    if (typeof compatRuntime.openaiApps === "boolean") {
      compatOut.openaiApps = compatRuntime.openaiApps;
    }
    // Per-method overrides — emit verbatim when present so the JSON
    // reflects exactly what's persisted. Empty `{}` is preserved
    // (treated as "no overrides" but signals intent — matches backend
    // canonicalizer behavior). The matrix UI keeps the override sparse
    // so editing back to preset values cleanly clears the block.
    if (
      compatRuntime.openaiAppsOverrides !== undefined &&
      Object.keys(compatRuntime.openaiAppsOverrides).length > 0
    ) {
      compatOut.openaiAppsOverrides = { ...compatRuntime.openaiAppsOverrides };
    }
    if (Object.keys(compatOut).length > 0) doc.compatRuntime = compatOut;
  }

  // mcpProfile.apps.mcpAppsOverrides — sparse override on the SEP-1865
  // `app.*` spec-bridge matrix. Sibling to `compatRuntime` so the JSON
  // reflects what's persisted; absent here means "use the host style
  // preset". Surfaced only when non-empty (matches `openaiAppsOverrides`'
  // sparsity convention).
  const mcpAppsOverrides = draft.mcpProfile?.apps?.mcpAppsOverrides;
  if (
    mcpAppsOverrides !== undefined &&
    Object.keys(mcpAppsOverrides).length > 0
  ) {
    doc.mcpAppsOverrides = { ...mcpAppsOverrides };
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

  // mcpAppsOverrides — parsed FIRST so the `hostCapabilities` diff
  // target below knows what wire shape the matrix would produce. Sparse
  // spec-bridge override; soft-validated per field (booleans for
  // boolean rows; mode-array filtered to known members). Empty /
  // fully-invalid input collapses to undefined so the resolver falls
  // back cleanly to the host style preset.
  let nextMcpAppsOverrides: McpAppsCapabilities | undefined = undefined;
  if (isPlainObject(parsed.mcpAppsOverrides)) {
    const incoming = parsed.mcpAppsOverrides as Record<string, unknown>;
    const out: McpAppsCapabilities = {};
    const booleanKeys: Array<keyof McpAppsCapabilities> = [
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
    ];
    for (const key of booleanKeys) {
      const value = incoming[key];
      if (typeof value === "boolean") {
        (out as Record<string, unknown>)[key] = value;
      }
    }
    const modes = incoming.availableDisplayModes;
    if (Array.isArray(modes)) {
      const filtered = modes.filter(
        (m): m is "inline" | "fullscreen" | "pip" =>
          m === "inline" || m === "fullscreen" || m === "pip",
      );
      // Soft-validate: only emit the array when at least one valid
      // member survived. An empty filter result reads as "user typed
      // garbage" — fall through to the preset rather than persisting an
      // empty allowlist the resolver would have to coerce to ["inline"].
      if (filtered.length > 0) out.availableDisplayModes = filtered;
    }
    if (Object.keys(out).length > 0) nextMcpAppsOverrides = out;
  }

  // hostCapabilities — the user sees the EFFECTIVE merged value, so on
  // parse-back we decide whether the parsed value is a legacy override
  // or just a stale serialization of the matrix. A legacy
  // `hostCapabilitiesOverride` is only persisted when the user typed
  // something the matrix cannot produce.
  //
  // We compare `parsed.hostCapabilities` against BOTH:
  //   1. `matrixResolvedNext` — the wire shape the matrix WILL produce
  //      after this save (preset + post-parse `mcpAppsOverrides`).
  //   2. `matrixResolvedPrev` — the wire shape the matrix WAS
  //      producing before this save (prev's `mcpAppsOverrides`).
  //
  // Match either → undefined legacy override:
  //   - Matches (1): user is looking at a faithful serialization of
  //     the matrix they're saving. No extra opinion expressed.
  //   - Matches (2): user removed/changed `mcpAppsOverrides` but the
  //     JSON's `hostCapabilities` still shows the pre-change matrix
  //     shape — that's a stale artifact of `appsToJson` re-emitting
  //     effective caps on every render, NOT a deliberate legacy
  //     override. Removing only `mcpAppsOverrides` must actually revert
  //     to preset; persisting the stale shape would keep the override
  //     behavior alive through the legacy path.
  //
  // Match neither → the user typed something the matrix can't produce;
  // persist as legacy `hostCapabilitiesOverride` so it survives the
  // round-trip.
  //
  // Sandbox is its own top-level block now; if a `sandbox` key sneaks
  // into hostCapabilities (paste from an older export, hand-edit),
  // strip it so it doesn't pollute the override diff.
  const matrixResolvedNext = resolveEffectiveHostCapabilities({
    hostStyle: prev.hostStyle,
    profile:
      nextMcpAppsOverrides !== undefined
        ? {
            profileVersion: 1,
            apps: { mcpAppsOverrides: nextMcpAppsOverrides },
          }
        : undefined,
    hostCapabilitiesOverride: undefined,
  }) as Record<string, unknown>;
  const matrixResolvedPrev = resolveEffectiveHostCapabilities({
    hostStyle: prev.hostStyle,
    profile: prev.mcpProfile,
    hostCapabilitiesOverride: undefined,
  }) as Record<string, unknown>;
  let nextOverride: Record<string, unknown> | undefined = undefined;
  if ("hostCapabilities" in parsed) {
    if (isPlainObject(parsed.hostCapabilities)) {
      const { sandbox: _ignored, ...incoming } = parsed.hostCapabilities;
      const incomingStr = stableStringifyJson(incoming);
      if (
        incomingStr === stableStringifyJson(matrixResolvedNext) ||
        incomingStr === stableStringifyJson(matrixResolvedPrev)
      ) {
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

  // compatRuntime — only present when the user explicitly typed a
  // boolean. Absent (or non-boolean) → no override; the resolver falls
  // back to the host style preset.
  const incomingCompatRuntime = isPlainObject(parsed.compatRuntime)
    ? parsed.compatRuntime
    : undefined;
  const newCompatRuntime: {
    openaiApps?: boolean;
    openaiAppsOverrides?: OpenAiAppsCapabilities;
  } = {};
  if (
    incomingCompatRuntime &&
    typeof incomingCompatRuntime.openaiApps === "boolean"
  ) {
    newCompatRuntime.openaiApps = incomingCompatRuntime.openaiApps;
  }
  // Parse per-method overrides. Soft-validate each field (boolean for
  // most, tri-state for requestDisplayMode); silently drop unknown
  // keys at this layer — the backend canonicalizer is strict, but the
  // editor accepts hand-typed JSON that may be one rev behind. Drop
  // the whole block when no valid entries remain so editing back to
  // the preset cleanly clears the override.
  if (incomingCompatRuntime && isPlainObject(incomingCompatRuntime.openaiAppsOverrides)) {
    const incomingOverrides = incomingCompatRuntime.openaiAppsOverrides as Record<
      string,
      unknown
    >;
    const parsedOverrides: OpenAiAppsCapabilities = {};
    const booleanKeys: Array<keyof OpenAiAppsCapabilities> = [
      "callTool",
      "sendFollowUpMessage",
      "setWidgetState",
      "notifyIntrinsicHeight",
      "openExternal",
      "setOpenInAppUrl",
      "requestModal",
      "uploadFile",
      "selectFiles",
      "getFileDownloadUrl",
      "requestCheckout",
      "requestClose",
    ];
    for (const key of booleanKeys) {
      const value = incomingOverrides[key];
      if (typeof value === "boolean") {
        (parsedOverrides as Record<string, unknown>)[key] = value;
      }
    }
    const requestDisplayMode = incomingOverrides.requestDisplayMode;
    if (
      requestDisplayMode === "all" ||
      requestDisplayMode === "fullscreen-only" ||
      requestDisplayMode === "none"
    ) {
      parsedOverrides.requestDisplayMode = requestDisplayMode;
    }
    if (Object.keys(parsedOverrides).length > 0) {
      newCompatRuntime.openaiAppsOverrides = parsedOverrides;
    }
  }

  const appsBlock: NonNullable<HostConfigMcpProfileV1["apps"]> = {};
  if (nextSandbox) appsBlock.sandbox = nextSandbox;
  if (newAppsHostInfo) {
    appsBlock.uiInitialize = { hostInfo: newAppsHostInfo };
  }
  if (Object.keys(newCompatRuntime).length > 0) {
    appsBlock.compatRuntime = newCompatRuntime;
  }
  if (nextMcpAppsOverrides !== undefined) {
    appsBlock.mcpAppsOverrides = nextMcpAppsOverrides;
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

/**
 * Update the draft's `compatRuntime` block, preserving sibling fields
 * and the parent envelope. Pass `undefined` for a field to clear that
 * field; pass an object to replace it. Empty `compatRuntime` blocks
 * collapse to undefined so editing back to preset values cleanly clears
 * the override.
 */
function setCompatRuntimeOnDraft(
  prev: HostConfigInputV2,
  next: {
    openaiApps?: boolean;
    openaiAppsOverrides?: OpenAiAppsCapabilities;
  },
): HostConfigInputV2 {
  const prevProfile: HostConfigMcpProfileV1 =
    prev.mcpProfile ?? { profileVersion: 1 };
  const prevApps = prevProfile.apps ?? {};
  const compatBlock: NonNullable<
    NonNullable<HostConfigMcpProfileV1["apps"]>["compatRuntime"]
  > = {};
  if (typeof next.openaiApps === "boolean") {
    compatBlock.openaiApps = next.openaiApps;
  }
  if (
    next.openaiAppsOverrides !== undefined &&
    Object.keys(next.openaiAppsOverrides).length > 0
  ) {
    compatBlock.openaiAppsOverrides = next.openaiAppsOverrides;
  }
  const nextApps: NonNullable<HostConfigMcpProfileV1["apps"]> = {
    ...prevApps,
    compatRuntime:
      Object.keys(compatBlock).length > 0 ? compatBlock : undefined,
  };
  return {
    ...prev,
    mcpProfile: { ...prevProfile, apps: nextApps },
  };
}

/** Field labels rendered in the matrix. Order matches Copilot's published table. */
const OPENAI_APPS_METHOD_LABELS: Array<{
  key: keyof OpenAiAppsCapabilities;
  label: string;
}> = [
  { key: "callTool", label: "callTool" },
  { key: "sendFollowUpMessage", label: "sendFollowUpMessage" },
  { key: "setWidgetState", label: "setWidgetState" },
  { key: "requestDisplayMode", label: "requestDisplayMode" },
  { key: "notifyIntrinsicHeight", label: "notifyIntrinsicHeight" },
  { key: "openExternal", label: "openExternal" },
  { key: "setOpenInAppUrl", label: "setOpenInAppUrl" },
  { key: "requestModal", label: "requestModal" },
  { key: "uploadFile", label: "uploadFile" },
  { key: "selectFiles", label: "selectFiles" },
  { key: "getFileDownloadUrl", label: "getFileDownloadUrl" },
  { key: "requestCheckout", label: "requestCheckout" },
  { key: "requestClose", label: "requestClose" },
];

/**
 * Per-method capability matrix for `window.openai.*`. Replaces the
 * single "Enable window.openai" toggle with one row per method so users
 * can match a specific host's published subset (e.g. Copilot's
 * "fullscreen-only displayMode, no requestModal / uploadFile").
 *
 * Layout:
 * - Master row at the top mirrors the old behavior: inject the shim
 *   or don't. When off, the per-method disclosure hides.
 * - A collapsed disclosure summarizes "N of 13 enabled" and expands to
 *   the full per-method list. Defaults inherit from the active host
 *   template (`client-templates.ts`), so picking ChatGPT / Copilot /
 *   etc. is already the "preset" — no second affordance needed.
 * - Method rows show the effective value with an "Overridden" badge
 *   when the user has diverged from the preset.
 *
 * The matrix round-trips through `appsToJson` / `applyJsonToDraft`,
 * so the JSON editor below stays in sync.
 */
function OpenaiAppsCapabilityMatrix({
  draft,
  onDraftChange,
}: {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
}) {
  const [methodsOpen, setMethodsOpen] = useState(false);
  const override = draft.mcpProfile?.apps?.compatRuntime?.openaiApps;
  const overridesRecord =
    draft.mcpProfile?.apps?.compatRuntime?.openaiAppsOverrides;
  const presetEffective = getCompatRuntimeForStyle(draft.hostStyle);
  const presetInjected = presetEffective.injected;
  const presetCapabilities: ResolvedOpenAiAppsCapabilities = presetEffective.injected
    ? presetEffective.capabilities
    : OPENAI_APPS_FULL_SURFACE;
  const injected = typeof override === "boolean" ? override : presetInjected;

  // Effective per-method capabilities — preset merged with sparse overrides.
  // Mirrors `mergeOpenAiAppsCapabilities` in client-config-v2.ts but with
  // a local merge so the matrix doesn't pull in the resolver (which we
  // already use via `getCompatRuntimeForStyle` for the preset).
  const effectiveCapabilities: ResolvedOpenAiAppsCapabilities = {
    ...presetCapabilities,
    ...(overridesRecord ?? {}),
  };

  const setInjected = (next: boolean) => {
    onDraftChange((prev) =>
      setCompatRuntimeOnDraft(prev, {
        openaiApps: next,
        // Clear per-method overrides on master toggle off — they're
        // meaningless without injection.
        openaiAppsOverrides: next ? overridesRecord : undefined,
      }),
    );
  };

  const setMethodOverride = (
    key: keyof OpenAiAppsCapabilities,
    value: boolean | "all" | "fullscreen-only" | "none" | undefined,
  ) => {
    onDraftChange((prev) => {
      const prevOverrides =
        prev.mcpProfile?.apps?.compatRuntime?.openaiAppsOverrides ?? {};
      const nextOverrides: OpenAiAppsCapabilities = { ...prevOverrides };
      // value === undefined removes the field — "revert this method
      // to preset". Lets users build up sparse overrides incrementally.
      if (value === undefined) {
        delete (nextOverrides as Record<string, unknown>)[key];
      } else {
        (nextOverrides as Record<string, unknown>)[key] = value;
      }
      const prevInjection = prev.mcpProfile?.apps?.compatRuntime?.openaiApps;
      return setCompatRuntimeOnDraft(prev, {
        openaiApps: prevInjection,
        openaiAppsOverrides: nextOverrides,
      });
    });
  };

  // Summary line for the collapsed disclosure. Count methods whose
  // effective value is "on" — booleans true, requestDisplayMode anything
  // other than "none".
  let enabledCount = 0;
  for (const { key } of OPENAI_APPS_METHOD_LABELS) {
    const value = { ...presetCapabilities, ...(overridesRecord ?? {}) }[key];
    if (key === "requestDisplayMode") {
      if (value !== "none") enabledCount += 1;
    } else if (value === true) {
      enabledCount += 1;
    }
  }
  const overrideCount = overridesRecord
    ? Object.keys(overridesRecord).length
    : 0;

  // Subline shows the live method count + any override count. Omitted when
  // injection is off — the master Switch already communicates that state.
  const sublineParts: string[] = [];
  if (injected) {
    sublineParts.push(
      `${enabledCount} of ${OPENAI_APPS_METHOD_LABELS.length} methods`,
    );
    if (overrideCount > 0) {
      sublineParts.push(`${overrideCount} overridden`);
    }
  }
  const subline = sublineParts.join(" · ");

  return (
    <div className="rounded-[10px] border border-border bg-background">
      {/* Single header row: left half is the disclosure (label + subline +
          chevron), right half is the master Switch in its own hit zone.
          A hairline `border-l` between them telegraphs that they're
          distinct controls — clicking near the Switch can't open the
          disclosure because the Switch lives outside the disclosure
          button entirely. When injection is off the disclosure renders
          as static (chevron hidden, no hover) since the method list is
          meaningless without injection. */}
      <div className="flex items-stretch border-b border-border">
        {injected ? (
          <button
            type="button"
            onClick={() => setMethodsOpen((v) => !v)}
            aria-expanded={methodsOpen}
            aria-controls="apps-extension-openai-methods"
            className="flex flex-1 items-center justify-between gap-2 px-3.5 py-2.5 text-left hover:bg-muted/40"
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-[12px] font-medium">
                Inject <span className="font-mono">window.openai</span>
              </span>
              {subline ? (
                <span className="text-[11px] text-muted-foreground">
                  {subline}
                </span>
              ) : null}
            </div>
            <ChevronDown
              className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
                methodsOpen ? "rotate-180" : ""
              }`}
            />
          </button>
        ) : (
          <div className="flex flex-1 items-center px-3.5 py-2.5">
            <label
              htmlFor="apps-extension-openai-toggle"
              className="text-[12px] font-medium"
            >
              Inject <span className="font-mono">window.openai</span>
            </label>
          </div>
        )}
        <div className="flex items-center border-l border-border pl-3 pr-3.5">
          <Switch
            id="apps-extension-openai-toggle"
            checked={injected}
            onCheckedChange={setInjected}
            aria-label="Inject window.openai"
          />
        </div>
      </div>

      {/* Per-method matrix — expand to override individual methods on
          top of the host template's defaults. */}
      {injected ? (
        <>
          {methodsOpen ? (
            <>
              <div
                id="apps-extension-openai-methods"
                className="flex flex-col"
              >
                {OPENAI_APPS_METHOD_LABELS.map(({ key, label }) => {
                  const effective = effectiveCapabilities[key];
                  const presetValue = presetCapabilities[key];
                  const overridden =
                    overridesRecord !== undefined && key in overridesRecord;
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-3 border-b border-border/50 px-3.5 py-2 last:border-b-0"
                    >
                      <div className="flex flex-col gap-0.5">
                        <span className="font-mono text-[12px]">{label}</span>
                        {overridden ? (
                          <span className="w-fit rounded bg-orange-500/15 px-1 py-px text-[10px] text-orange-600 dark:text-orange-300">
                            Overridden
                          </span>
                        ) : null}
                      </div>
                      {key === "requestDisplayMode" ? (
                        <RequestDisplayModeControl
                          value={effective as "all" | "fullscreen-only" | "none"}
                          onChange={(next) =>
                            setMethodOverride(
                              key,
                              next === presetValue ? undefined : next,
                            )
                          }
                        />
                      ) : (
                        <Switch
                          checked={Boolean(effective)}
                          onCheckedChange={(checked) =>
                            setMethodOverride(
                              key,
                              checked === presetValue ? undefined : checked,
                            )
                          }
                          aria-label={label}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Tri-state segmented control for the requestDisplayMode capability. */
function RequestDisplayModeControl({
  value,
  onChange,
}: {
  value: "all" | "fullscreen-only" | "none";
  onChange: (next: "all" | "fullscreen-only" | "none") => void;
}) {
  const options: Array<{
    value: "all" | "fullscreen-only" | "none";
    label: string;
  }> = [
    { value: "all", label: "All" },
    { value: "fullscreen-only", label: "Fullscreen only" },
    { value: "none", label: "Off" },
  ];
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border text-[11px]">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={
            opt.value === value
              ? "bg-foreground/10 px-2 py-0.5 font-medium"
              : "px-2 py-0.5 text-muted-foreground hover:bg-muted"
          }
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Update `mcpProfile.apps.mcpAppsOverrides` while preserving sibling
 * fields (`sandbox`, `uiInitialize`, `compatRuntime`) and collapsing
 * empties on the way out:
 *
 *   - empty override object → omit `mcpAppsOverrides` from `apps`
 *   - empty `apps` block (no other siblings) → omit `apps` from profile
 *   - profile that's now content-less (only `profileVersion`) →
 *     `mcpProfile: undefined`
 *
 * Mirrors the collapse the bottom of `applyJsonToDraft` already does.
 * Without it, toggling a row and toggling it back leaves a dirty
 * `{ profileVersion: 1, apps: {} }` shell on the draft —
 * `optionalMcpProfileEq` treats that as distinct from `undefined`, so
 * the save button stays armed and the matrix says "Matches host style
 * preset" while the draft is silently dirty.
 *
 * Trade-off: a user who deliberately opted into a content-less
 * `{ profileVersion: 1 }` envelope (by hand-editing the JSON) will
 * see that stub dropped when they touch the matrix. We accept that:
 * the typed-in `{ profileVersion: 1 }` carries no semantic content
 * the resolver consumes, and the common case (user toggles via
 * matrix UI, expects clean revert) is overwhelmingly more frequent.
 * If we ever model the matrix and the openai shim's
 * `setCompatRuntimeOnDraft` consistently, we can revisit by tracking
 * "synthesized vs opted-in" provenance — but that's bigger than this
 * PR.
 */
function setMcpAppsOverridesOnDraft(
  prev: HostConfigInputV2,
  next: McpAppsCapabilities | undefined,
): HostConfigInputV2 {
  const hasKeys = next !== undefined && Object.keys(next).length > 0;
  const prevProfile = prev.mcpProfile;
  const prevApps = prevProfile?.apps ?? {};

  // Rebuild `apps` explicitly so the spread doesn't leak
  // `mcpAppsOverrides: undefined` into `Object.keys` when we're
  // clearing the override. Sibling fields (`sandbox`, `uiInitialize`,
  // `compatRuntime`, future additions) round-trip verbatim.
  const nextApps: NonNullable<HostConfigMcpProfileV1["apps"]> = {};
  for (const [key, value] of Object.entries(prevApps)) {
    if (key === "mcpAppsOverrides") continue;
    if (value !== undefined) {
      (nextApps as Record<string, unknown>)[key] = value;
    }
  }
  if (hasKeys) nextApps.mcpAppsOverrides = next;
  const appsEmpty = Object.keys(nextApps).length === 0;

  // Fast path: no envelope before, no content now → leave draft alone
  // (no envelope ever synthesized just to immediately collapse it).
  if (prevProfile === undefined && appsEmpty) {
    return prev;
  }

  const baseProfile: HostConfigMcpProfileV1 =
    prevProfile ?? { profileVersion: 1 };
  const hasInitialize =
    baseProfile.initialize !== undefined &&
    (baseProfile.initialize.clientInfo !== undefined ||
      (baseProfile.initialize.supportedProtocolVersions &&
        baseProfile.initialize.supportedProtocolVersions.length > 0));
  const hasExtensions = baseProfile.extensions !== undefined;
  const profileEmpty = appsEmpty && !hasInitialize && !hasExtensions;

  return {
    ...prev,
    mcpProfile: profileEmpty
      ? undefined
      : { ...baseProfile, apps: appsEmpty ? undefined : nextApps },
  };
}

type McpAppsDimensionKey = Exclude<
  keyof McpAppsCapabilities,
  "availableDisplayModes"
>;

/** Per-dimension matrix metadata. Description is shown on row hover. */
type McpAppsDimensionMeta = {
  key: McpAppsDimensionKey;
  description: string;
};

/** All boolean MCP Apps matrix dimensions in display order. */
const MCP_APPS_DIMENSIONS: McpAppsDimensionMeta[] = [
  {
    key: "toolInputPartial",
    description:
      "Send ui/notifications/tool-input-partial while the agent streams arguments",
  },
  {
    key: "toolCancelled",
    description:
      "Notify the app when tool execution is cancelled (ui/notifications/tool-cancelled)",
  },
  {
    key: "hostContextChanged",
    description:
      "Notify the app when theme, display mode, or other host context changes",
  },
  {
    key: "resourceTeardown",
    description:
      "Send ui/resource-teardown before destroying the app view",
  },
  {
    key: "serverResources",
    description: "Advertise resources/read proxy capability in ui/initialize",
  },
  {
    key: "logging",
    description: "Accept notifications/message log calls from the app",
  },
  {
    key: "toolInfo",
    description: "Include calling-tool metadata in HostContext.toolInfo",
  },
  {
    key: "openLinks",
    description: "Advertise ui/open-link capability",
  },
  {
    key: "serverTools",
    description: "Advertise tools/call proxy capability",
  },
  {
    key: "updateModelContext",
    description: "Accept ui/update-model-context requests from the app",
  },
  {
    key: "message",
    description: "Accept ui/message requests that add content to the conversation",
  },
  {
    key: "sandboxPermissions",
    description: "Honor _meta.ui.permissions when configuring the iframe",
  },
  {
    key: "cspFrameDomains",
    description: "Honor _meta.ui.csp.frameDomains for nested iframes",
  },
  {
    key: "cspBaseUriDomains",
    description: "Honor _meta.ui.csp.baseUriDomains in CSP",
  },
  {
    key: "resourcePrefersBorder",
    description: "Honor _meta.ui.prefersBorder when rendering app chrome",
  },
];

const ALL_DISPLAY_MODES = ["inline", "fullscreen", "pip"] as const;
type DisplayMode = (typeof ALL_DISPLAY_MODES)[number];

const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  inline: "Inline",
  fullscreen: "Fullscreen",
  pip: "PiP",
};

/**
 * Per-dimension capability matrix for the SEP-1865 `app.*` spec bridge.
 * Sibling to {@link OpenaiAppsCapabilityMatrix} but represents a
 * different surface — the spec bridge is the primary MCP Apps protocol,
 * not a vendor compat shim, so there's no "inject" master toggle and
 * no tri-state (the matrix is always advertised).
 *
 * Layout:
 * - `availableDisplayModes` cluster at the top.
 * - Flat list of all boolean matrix dimensions below.
 * - Per-row "Overridden" badge when the user has diverged from the
 *   host style preset; rows show the preset value for context.
 * - "Reset" button clears the entire matrix override (shown only when
 *   overrides are active).
 *
 * The matrix round-trips through `appsToJson` / `applyJsonToDraft` so
 * the JSON editor below stays in sync.
 *
 * INDEPENDENT from the OpenAI shim matrix. Toggling a row here never
 * affects `window.openai.*` and vice versa — see the two-matrix
 * architecture notes in #2226 / #2230 / #2232.
 */
function McpAppsCapabilityMatrix({
  draft,
  onDraftChange,
}: {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
}) {
  const rawOverridesRecord = draft.mcpProfile?.apps?.mcpAppsOverrides;
  const legacyOverride = draft.hostCapabilitiesOverride;
  // Legacy `hostCapabilitiesOverride` is the pre-matrix way of
  // narrowing the advertised host capabilities. When the matrix is
  // absent but the legacy is present, the resolver advertises the
  // legacy shape; the matrix UI must reflect that, not the bare
  // preset. Otherwise a user with a legacy override sees the matrix
  // show preset values, toggles a single row, and the resolver
  // switches precedence to the (mostly-empty) matrix path —
  // silently flipping every other legacy-overridden dimension back
  // to the preset.
  //
  // The display fix: virtually migrate the legacy into matrix shape
  // so the per-row effective values + "Overridden" badges reflect
  // what the resolver actually advertises today. The matching write
  // fix is in `migrateLegacyIfNeeded` below — the first edit
  // commits the migration to persisted state so subsequent edits
  // build on top.
  const effectiveOverridesForDisplay: McpAppsCapabilities | undefined =
    rawOverridesRecord !== undefined
      ? rawOverridesRecord
      : legacyOverride !== undefined
        ? (hostCapabilitiesOverrideToMatrix(legacyOverride) ?? undefined)
        : undefined;
  // Effective values shown in the matrix UI. Uses the virtually-
  // migrated legacy when the matrix is absent so the UI shows what
  // the resolver advertises today (legacy path) — not what it would
  // advertise after the first edit silently strips the legacy.
  const effectiveCapabilities: ResolvedMcpAppsCapabilities =
    effectiveOverridesForDisplay !== undefined
      ? resolveEffectiveMcpAppsCapabilities({
          profile: {
            profileVersion: 1,
            apps: { mcpAppsOverrides: effectiveOverridesForDisplay },
          },
          hostStyle: draft.hostStyle,
        })
      : resolveEffectiveMcpAppsCapabilities({
          profile: undefined,
          hostStyle: draft.hostStyle,
        });

  const hasAnyOverride =
    effectiveOverridesForDisplay !== undefined &&
    Object.keys(effectiveOverridesForDisplay).length > 0;

  /**
   * On first matrix edit applied to a draft that still uses legacy
   * `hostCapabilitiesOverride` (matrix absent, legacy present),
   * convert the legacy into matrix shape so the user's single-row
   * edit can be applied on top without silently dropping all the
   * other legacy-overridden dimensions. Also clears the legacy
   * field — the matrix becomes the new source of truth.
   *
   * Returns `{ overrides, prevWithLegacyCleared }`. Callers apply
   * their edit to `overrides`, then pipe through
   * `setMcpAppsOverridesOnDraft(prevWithLegacyCleared, edited)`.
   */
  const migrateLegacyIfNeeded = (
    prev: HostConfigInputV2,
  ): {
    overrides: McpAppsCapabilities;
    prevWithLegacyCleared: HostConfigInputV2;
  } => {
    const matrix = prev.mcpProfile?.apps?.mcpAppsOverrides;
    if (matrix !== undefined) {
      // Matrix already owns the state; no migration needed.
      return { overrides: { ...matrix }, prevWithLegacyCleared: prev };
    }
    const legacy = prev.hostCapabilitiesOverride;
    if (legacy === undefined) {
      // Neither override present — start from empty.
      return { overrides: {}, prevWithLegacyCleared: prev };
    }
    // Legacy → matrix; clear the legacy so future reads use the
    // matrix path consistently. Precedence-conflict between the two
    // fields was the original motivation for the migration helper
    // landing alongside the foundation PR.
    const migrated = hostCapabilitiesOverrideToMatrix(legacy) ?? {};
    return {
      overrides: { ...migrated },
      prevWithLegacyCleared: { ...prev, hostCapabilitiesOverride: undefined },
    };
  };

  const clearOverride = () => {
    // "Match host preset" clears BOTH paths — the matrix override
    // and the legacy `hostCapabilitiesOverride` — so the resolver
    // falls back cleanly to the host style preset. Leaving the
    // legacy alive would silently keep the override active through
    // the legacy path even after the matrix shows "Matches host
    // style preset".
    onDraftChange((prev) => {
      const withMatrixCleared = setMcpAppsOverridesOnDraft(prev, undefined);
      if (withMatrixCleared.hostCapabilitiesOverride === undefined) {
        return withMatrixCleared;
      }
      return { ...withMatrixCleared, hostCapabilitiesOverride: undefined };
    });
  };

  /** Set or clear a boolean dimension override. Pass `undefined` to revert to preset. */
  const setBooleanOverride = (
    key: Exclude<keyof McpAppsCapabilities, "availableDisplayModes">,
    nextEffective: boolean,
  ) => {
    onDraftChange((prev) => {
      const { overrides: prevOverrides, prevWithLegacyCleared } =
        migrateLegacyIfNeeded(prev);
      const prevPreset = resolveEffectiveMcpAppsCapabilities({
        profile: undefined,
        hostStyle: prev.hostStyle,
      });
      const nextOverrides: McpAppsCapabilities = { ...prevOverrides };
      if (nextEffective === prevPreset[key]) {
        // Toggle matches preset → drop the override (revert to preset
        // semantics; sparse on save).
        delete (nextOverrides as Record<string, unknown>)[key];
      } else {
        (nextOverrides as Record<string, unknown>)[key] = nextEffective;
      }
      return setMcpAppsOverridesOnDraft(prevWithLegacyCleared, nextOverrides);
    });
  };

  /**
   * Toggle a display mode in the allowlist. The matrix invariant is
   * `availableDisplayModes.length >= 1` — if the user unchecks the
   * last mode, force-enable `"inline"` (the spec default; an empty
   * allowlist would be unrenderable). The resolver enforces this same
   * invariant as a backstop, but doing it here keeps the UI honest.
   *
   * If the resulting allowlist equals the preset's array, drop the
   * override key so the matrix reverts cleanly.
   */
  const toggleDisplayMode = (mode: DisplayMode) => {
    onDraftChange((prev) => {
      const { overrides: prevOverrides, prevWithLegacyCleared } =
        migrateLegacyIfNeeded(prev);
      const prevPreset = resolveEffectiveMcpAppsCapabilities({
        profile: undefined,
        hostStyle: prev.hostStyle,
      });
      // Use displayed effective modes as the starting point so the
      // user's click toggles relative to what they saw (legacy-
      // migrated when applicable), not relative to the bare preset.
      const currentModes =
        prevOverrides.availableDisplayModes ??
        prevPreset.availableDisplayModes;
      let nextModesList = currentModes.includes(mode)
        ? currentModes.filter((m) => m !== mode)
        : [...currentModes, mode];
      if (nextModesList.length === 0) {
        // Backstop: never persist an empty allowlist.
        nextModesList = ["inline"];
      }
      // Preserve the canonical inline→fullscreen→pip order so equality
      // checks against the preset don't false-negative on permutation.
      nextModesList = ALL_DISPLAY_MODES.filter((m) =>
        nextModesList.includes(m),
      );
      const nextOverrides: McpAppsCapabilities = { ...prevOverrides };
      if (
        stableStringifyJson(nextModesList) ===
        stableStringifyJson(prevPreset.availableDisplayModes)
      ) {
        delete nextOverrides.availableDisplayModes;
      } else {
        nextOverrides.availableDisplayModes = nextModesList as DisplayMode[];
      }
      return setMcpAppsOverridesOnDraft(prevWithLegacyCleared, nextOverrides);
    });
  };

  const overrideCount = hasAnyOverride
    ? Object.keys(effectiveOverridesForDisplay!).length
    : 0;
  const enabledCount = MCP_APPS_DIMENSIONS.filter(({ key }) =>
    Boolean(effectiveCapabilities[key]),
  ).length;
  const subline = hasAnyOverride
    ? `${overrideCount} ${overrideCount === 1 ? "override" : "overrides"} active${
        rawOverridesRecord === undefined && legacyOverride !== undefined
          ? " (legacy)"
          : ""
      }`
    : `${enabledCount} of ${MCP_APPS_DIMENSIONS.length} enabled`;

  return (
    <div className="rounded-[10px] border border-border bg-background">
      {/* Header strip: title + status; reset only when the user has overrides. */}
      <div className="flex items-stretch border-b border-border">
        <div className="flex flex-1 flex-col gap-0.5 px-3.5 py-2.5">
          <span className="text-[12px] font-medium">MCP Apps</span>
          <span className="text-[11px] text-muted-foreground">{subline}</span>
        </div>
        {hasAnyOverride ? (
          <div className="flex items-center border-l border-border pr-3.5 pl-3">
            <button
              type="button"
              onClick={clearOverride}
              className="rounded border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted"
              title="Revert all overrides to the host style preset"
            >
              Reset
            </button>
          </div>
        ) : null}
      </div>

      {/* availableDisplayModes — multi-checkbox cluster. Always visible
          (it's the most-edited dimension and the one published host
          tables most prominently differ on, e.g. Copilot is fullscreen-
          only). */}
      <div
        data-testid="mcp-apps-dimension-availableDisplayModes"
        className="flex items-center justify-between gap-3 border-b border-border/50 px-3.5 py-2"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="font-mono text-[12px]">availableDisplayModes</span>
            {effectiveOverridesForDisplay?.availableDisplayModes !==
            undefined ? (
              <span className="rounded bg-orange-500/15 px-1 py-px text-[10px] text-orange-600 dark:text-orange-300">
                Overridden
              </span>
            ) : null}
          </div>
        </div>
        <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-border text-[11px]">
          {ALL_DISPLAY_MODES.map((mode) => {
            const enabled =
              effectiveCapabilities.availableDisplayModes.includes(mode);
            return (
              <button
                key={mode}
                type="button"
                aria-label={mode}
                title={mode}
                className={
                  enabled
                    ? "bg-foreground/10 px-2.5 py-0.5 font-medium"
                    : "px-2.5 py-0.5 text-muted-foreground hover:bg-muted"
                }
                onClick={() => toggleDisplayMode(mode)}
              >
                {DISPLAY_MODE_LABELS[mode]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col">
        {MCP_APPS_DIMENSIONS.map(({ key, description }) => (
          <McpAppsDimensionRow
            key={key}
            dimensionKey={key}
            description={description}
            effective={Boolean(effectiveCapabilities[key])}
            overridden={
              effectiveOverridesForDisplay !== undefined &&
              key in effectiveOverridesForDisplay
            }
            onToggle={(next) => setBooleanOverride(key, next)}
          />
        ))}
      </div>
    </div>
  );
}

/** Single boolean dimension row — technical key + optional overridden badge. */
function McpAppsDimensionRow({
  dimensionKey,
  description,
  effective,
  overridden,
  onToggle,
}: {
  dimensionKey: McpAppsDimensionKey;
  description: string;
  effective: boolean;
  overridden: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div
      data-testid={`mcp-apps-dimension-${dimensionKey}`}
      className="flex items-center justify-between gap-3 border-b border-border/50 px-3.5 py-2 last:border-b-0"
      title={description}
    >
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="font-mono text-[12px]">{dimensionKey}</span>
        {overridden ? (
          <span className="w-fit rounded bg-orange-500/15 px-1 py-px text-[10px] text-orange-600 dark:text-orange-300">
            Overridden
          </span>
        ) : null}
      </div>
      <Switch
        checked={effective}
        onCheckedChange={onToggle}
        aria-label={dimensionKey}
      />
    </div>
  );
}

export function AppsExtensionTab({
  draft,
  onDraftChange,
  focusSubKey: _focusSubKey,
}: AppsExtensionTabProps) {
  // _focusSubKey is intentionally unused — see prop doc. Destructured so
  // the prop appears in TS signature checks and the linter doesn't warn
  // about an undeclared prop on the call site.
  void _focusSubKey;
  const [jsonMode, setJsonMode] = useState<JsonEditorMode>("edit");
  const { content, onRawChange } = useJsonDraftBuffer({
    draft,
    serialize: appsToJson,
    applyParsedToDraft: applyJsonToDraft,
    onDraftChange,
  });

  return (
    <div className="flex h-full min-h-[480px] flex-col gap-3">
      <OpenaiAppsCapabilityMatrix
        draft={draft}
        onDraftChange={onDraftChange}
      />
      {/* Two-matrix architecture: window.openai (shim) and app.* (spec
          bridge) are independent surfaces and never cross-gate. The
          subtitle on each section makes this explicit so users don't
          confuse them. */}
      <McpAppsCapabilityMatrix
        draft={draft}
        onDraftChange={onDraftChange}
      />
      <div className="min-h-0 flex-1">
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
    </div>
  );
}
