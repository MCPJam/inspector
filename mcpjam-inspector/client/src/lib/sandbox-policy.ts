/**
 * Pure resolution functions for the MCP Apps + ChatGPT Apps sandbox
 * policy. Inputs are the resource-declared CSP/permissions and the
 * user-saved `mcpProfile.apps.sandbox.*`; outputs are the
 * effective per-directive allow-lists the renderer should emit.
 *
 * **Single source of truth.** Both the MCP Apps renderer and the
 * ChatGPT Apps runtime MUST resolve policy through this module. If a
 * renderer constructs its own CSP without going through here, the
 * hosted-mode hard clamp (step 4 of resolve) can be bypassed by
 * mounting through that path — which is exactly the failure mode we
 * are trying to prevent. Verified by grep in the integration tests.
 *
 * Precedence (mirror of SEP-1865, applied in this order):
 *   1. `mode` picks the baseline per-directive set.
 *   2. `restrictTo` intersects with the baseline. Applies in ALL modes,
 *      not just `host-default` — picking `declared` does not skip this.
 *   3. `deny` subtracts. Wins over `restrictTo` and over the baseline.
 *   4. Hosted-mode hard clamp strips wildcards, localhost/RFC-1918,
 *      unsafe schemes, and MCPJam same-origin even when the user
 *      explicitly opted into `relaxed` mode.
 *
 * Permissions follow the same shape: resource declaration is the
 * ceiling (host can never grant a permission the resource didn't
 * request), `mode` picks the candidate set, `deny` subtracts, hosted
 * clamp strips sensitive permissions regardless.
 */

import type { CspDomainSet, HostConfigMcpProfileV1 } from "@/lib/host-config-v2";

/**
 * The four CSP directive families this resolver canonicalizes. Aligned
 * with `CspDomainSet` from `host-config-v2.ts` — kept in lockstep with
 * the backend canonicalizer so a domain stored here round-trips into
 * the same canonical hash on save.
 */
export type CspDirectiveKey =
  | "connectDomains"
  | "resourceDomains"
  | "frameDomains"
  | "baseUriDomains";

const CSP_DIRECTIVE_KEYS: readonly CspDirectiveKey[] = [
  "connectDomains",
  "resourceDomains",
  "frameDomains",
  "baseUriDomains",
] as const;

export type SandboxCspMode = "host-default" | "declared" | "relaxed";
export type SandboxPermissionsMode =
  | "resource-declared"
  | "deny-all"
  | "custom";

/**
 * Per-directive resolved sets, in five "layers" so the CSP debug
 * overlay can render the resolution as a one-screen answer to "why
 * is this directive what it is."
 *
 * - `baseline` — the set picked by `mode`.
 * - `afterRestrictTo` — after intersection with `restrictTo`.
 * - `afterDeny` — after subtraction of `deny`.
 * - `afterHostedClamp` — after the hosted-mode hard clamp.
 * - `effective` — same as `afterHostedClamp`; the field emitted into
 *   the actual CSP header. Duplicated so consumers can render the
 *   final value without conditionalizing on which step ran last.
 */
export type SandboxCspLayers = {
  mode: SandboxCspMode;
  baseline: CspDomainSet;
  afterRestrictTo: CspDomainSet;
  afterDeny: CspDomainSet;
  afterHostedClamp: CspDomainSet;
  effective: CspDomainSet;
};

export type SandboxPermissionsLayers = {
  mode: SandboxPermissionsMode;
  /** Resource-declared permissions — the ceiling. */
  resourceCeiling: Record<string, boolean>;
  /** Candidate set after `mode` selection (before deny/clamp). */
  candidate: Record<string, boolean>;
  /** Candidate after `deny` subtraction. */
  afterDeny: Record<string, boolean>;
  /** Final value after hosted-mode clamp. */
  effective: Record<string, boolean>;
};

export type ResolveSandboxArgs = {
  /**
   * The CSP the *resource* declared in its `_meta.ui.csp` block. This
   * is the upper bound when `mode === "declared"` and the "ceiling"
   * intent in general — the backend stores intent, the renderer
   * enforces it on top of the resource's declaration.
   */
  resourceCsp?: CspDomainSet;
  /**
   * The CSP the *renderer* would use today when no profile is set.
   * Picked when `mode === "host-default"`. Pass whatever the renderer
   * currently emits as its preset baseline (e.g. inspector's
   * production CSP for the chat embed iframe).
   */
  hostDefaultCsp?: CspDomainSet;
  /**
   * Permissive baseline applied when `mode === "relaxed"`. Local-dev
   * convenience; hosted-mode clamp still strips dangerous values.
   * Should be a finite set the renderer accepts in dev, not a wildcard.
   */
  relaxedCsp?: CspDomainSet;

  /** Permissions the resource declared it needs (the ceiling). */
  resourcePermissions?: Record<string, boolean>;
  /**
   * Default permission posture when `mode` is absent / unrecognized
   * (e.g. profile written by a v2 envelope in the future). Default:
   * `"resource-declared"` — safest fallback per spec.
   */
  defaultPermissionsMode?: SandboxPermissionsMode;

  /** Whether the inspector is currently in hosted (multi-tenant) mode. */
  isHostedMode: boolean;

  /** The user-saved profile envelope from the active hostConfig. */
  profile?: HostConfigMcpProfileV1;
};

export type ResolveSandboxResult = {
  csp: SandboxCspLayers;
  permissions: SandboxPermissionsLayers;
};

// -----------------------------------------------------------------------------
// CSP resolution
// -----------------------------------------------------------------------------

/**
 * Resolve the per-directive CSP for the active resource × profile.
 * Pure — no DOM, no React, no network. Safe to call from both the
 * MCP Apps renderer (client-side) and the ChatGPT Apps runtime
 * (server-side, if needed).
 */
export function resolveSandboxCsp(
  args: ResolveSandboxArgs,
): SandboxCspLayers {
  const mode = (args.profile?.apps?.sandbox?.csp?.mode ??
    "declared") as SandboxCspMode;

  // Step 1 — baseline picked by `mode`. Per spec:
  //   - "declared": resource declaration is the upper bound. The
  //     safest mode and the default when omitted.
  //   - "host-default": today's renderer preset (whatever the
  //     inspector currently emits without a profile). Useful when the
  //     resource declared nothing and we want a known floor.
  //   - "relaxed": permissive baseline. Hosted-mode clamp (step 4)
  //     still strips dangerous values.
  let baseline: CspDomainSet;
  switch (mode) {
    case "host-default":
      baseline = cloneCspDomainSet(args.hostDefaultCsp);
      break;
    case "relaxed":
      baseline = cloneCspDomainSet(args.relaxedCsp);
      break;
    case "declared":
    default:
      baseline = cloneCspDomainSet(args.resourceCsp);
      break;
  }

  // Step 2 — restrictTo INTERSECTION. Applies regardless of `mode` —
  // picking "declared" does not skip this. Per SEP-1865: host MAY
  // further restrict but MUST NOT add undeclared domains. An omitted
  // `restrictTo` passes the baseline through unchanged.
  const restrictTo = args.profile?.apps?.sandbox?.csp?.restrictTo;
  const afterRestrictTo: CspDomainSet = {};
  for (const key of CSP_DIRECTIVE_KEYS) {
    const baselineList = baseline[key];
    const restrictList = restrictTo?.[key];
    if (baselineList === undefined) continue;
    if (restrictList === undefined) {
      afterRestrictTo[key] = [...baselineList];
      continue;
    }
    afterRestrictTo[key] = intersectDomainLists(baselineList, restrictList);
  }

  // Step 3 — deny SUBTRACTION. Always wins over restrictTo and the
  // baseline. Wildcards (`https://*.evil.com`) match by suffix —
  // `https://api.evil.com` is blocked by `https://*.evil.com`.
  const deny = args.profile?.apps?.sandbox?.csp?.deny;
  const afterDeny: CspDomainSet = {};
  for (const key of CSP_DIRECTIVE_KEYS) {
    const current = afterRestrictTo[key];
    if (current === undefined) continue;
    const denyList = deny?.[key] ?? [];
    afterDeny[key] = current.filter(
      (domain) => !denyList.some((pattern) => matchesDomain(pattern, domain)),
    );
  }

  // Step 4 — hosted-mode hard clamp. SDK-side hardcoded guard, NOT
  // configurable through `mcpProfile`. Even if the user explicitly
  // opted into `mode: "relaxed"`, hosted mode strips:
  //   - Wildcards (`*`, `https://*`, anything resolving to "everywhere")
  //   - localhost / 127.0.0.1 / RFC-1918 / link-local
  //   - Unsafe schemes (`javascript:`, `data:` outside img/media)
  //   - MCPJam same-origin (the inspector's own auth/API endpoints)
  // Defense-in-depth: a profile editor mistake can't open a hole the
  // platform clamp would otherwise close.
  const afterHostedClamp: CspDomainSet = {};
  for (const key of CSP_DIRECTIVE_KEYS) {
    const current = afterDeny[key];
    if (current === undefined) continue;
    if (!args.isHostedMode) {
      afterHostedClamp[key] = [...current];
      continue;
    }
    afterHostedClamp[key] = current.filter(
      (domain) => !isHostedClampBlocked(domain, key),
    );
  }

  // `effective` is the final, post-clamp value the renderer emits.
  // Duplicated as a field so the CSP debug overlay can render
  // "effective" without conditionalizing on which step ran last.
  const effective: CspDomainSet = {};
  for (const key of CSP_DIRECTIVE_KEYS) {
    if (afterHostedClamp[key] !== undefined) {
      effective[key] = [...afterHostedClamp[key]!];
    }
  }

  return {
    mode,
    baseline,
    afterRestrictTo,
    afterDeny,
    afterHostedClamp,
    effective,
  };
}

// -----------------------------------------------------------------------------
// Permissions resolution
// -----------------------------------------------------------------------------

export function resolveSandboxPermissions(
  args: ResolveSandboxArgs,
): SandboxPermissionsLayers {
  const resourceCeiling = args.resourcePermissions ?? {};
  const profilePerms = args.profile?.apps?.sandbox?.permissions;
  const mode = (profilePerms?.mode ??
    args.defaultPermissionsMode ??
    "resource-declared") as SandboxPermissionsMode;

  // Step 1 — pick candidate set per `mode`.
  let candidate: Record<string, boolean> = {};
  switch (mode) {
    case "resource-declared":
      candidate = { ...resourceCeiling };
      break;
    case "deny-all":
      // Block everything. Even resource-requested permissions return
      // false here so the renderer emits an empty `allow=` attribute.
      candidate = Object.fromEntries(
        Object.keys(resourceCeiling).map((k) => [k, false]),
      );
      break;
    case "custom":
      // Use the user-declared allow map as the candidate set; the
      // ceiling step (next) prevents granting permissions the resource
      // didn't request.
      candidate = { ...(profilePerms?.allow ?? {}) };
      break;
  }

  // Step 2 — intersect with resource ceiling. Host can never grant a
  // permission the resource didn't request. A permission not present
  // in the ceiling is treated as denied regardless of `candidate`.
  const afterCeiling: Record<string, boolean> = {};
  for (const [key, candidateValue] of Object.entries(candidate)) {
    const ceilingValue = resourceCeiling[key];
    afterCeiling[key] = candidateValue && ceilingValue === true;
  }
  // Fill in ceiling permissions that the candidate didn't mention
  // (default: not granted).
  for (const key of Object.keys(resourceCeiling)) {
    if (!(key in afterCeiling)) afterCeiling[key] = false;
  }

  // Step 3 — `deny` always wins, even over ceiling-true values.
  const denyList = profilePerms?.deny ?? [];
  const afterDeny: Record<string, boolean> = { ...afterCeiling };
  for (const key of denyList) {
    if (key in afterDeny) afterDeny[key] = false;
  }

  // Step 4 — hosted-mode clamp. Strip sensitive permissions
  // (camera/microphone/geolocation) regardless of profile. Matches
  // the same defense-in-depth pattern as the CSP clamp.
  const SENSITIVE = new Set([
    "camera",
    "microphone",
    "geolocation",
    "clipboard-read",
    // clipboard-write deliberately NOT in the strip-list — most apps
    // need it for "copy to clipboard" buttons and read-side leakage
    // is the real exfil risk.
  ]);
  const effective: Record<string, boolean> = { ...afterDeny };
  if (args.isHostedMode) {
    for (const key of Object.keys(effective)) {
      if (SENSITIVE.has(key)) effective[key] = false;
    }
  }

  return {
    mode,
    resourceCeiling,
    candidate,
    afterDeny,
    effective,
  };
}

/**
 * Convenience wrapper that resolves both CSP and permissions in one
 * call. Mostly for the renderer's "give me everything" path; tests
 * exercise each resolver independently.
 */
export function resolveSandboxPolicy(
  args: ResolveSandboxArgs,
): ResolveSandboxResult {
  return {
    csp: resolveSandboxCsp(args),
    permissions: resolveSandboxPermissions(args),
  };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function cloneCspDomainSet(set: CspDomainSet | undefined): CspDomainSet {
  if (!set) return {};
  const out: CspDomainSet = {};
  for (const key of CSP_DIRECTIVE_KEYS) {
    const list = set[key];
    if (list !== undefined) out[key] = [...list];
  }
  return out;
}

/**
 * Intersect two domain lists with wildcard awareness. A wildcard in
 * `b` (e.g. `https://*.example.com`) matches any concrete domain in
 * `a` that fits the suffix pattern. A concrete-vs-concrete entry
 * matches by string equality.
 */
function intersectDomainLists(a: string[], b: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of a) {
    if (b.some((pattern) => matchesDomain(pattern, entry))) {
      if (!seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
    }
  }
  return out;
}

/**
 * Match a single domain against a (possibly wildcarded) pattern.
 *
 * Supports two wildcard forms:
 *   - `https://*.example.com` — any subdomain of example.com (also
 *     matches example.com itself, per the CSP spec).
 *   - `https://*` — any host with https scheme.
 *
 * Exact match otherwise. This is intentionally narrow — we are NOT
 * implementing a general glob matcher because CSP source-expression
 * semantics are well-defined and don't include arbitrary patterns.
 */
export function matchesDomain(pattern: string, domain: string): boolean {
  if (pattern === domain) return true;
  if (pattern === "*") return true;

  // Strip schemes if both sides have them, so the comparison is
  // host-vs-host. Mixed schemes never match (https://* doesn't match
  // http://api.example.com).
  const patternParts = splitScheme(pattern);
  const domainParts = splitScheme(domain);
  if (
    patternParts.scheme !== undefined &&
    domainParts.scheme !== undefined &&
    patternParts.scheme !== domainParts.scheme
  ) {
    return false;
  }
  if (
    patternParts.scheme !== undefined &&
    domainParts.scheme === undefined
  ) {
    // Pattern has a scheme but domain doesn't — fail closed. CSP
    // source expressions don't match schemeless hosts against
    // schemed patterns.
    return false;
  }

  const patternHost = patternParts.host;
  const domainHost = domainParts.host;

  // `*` host alone matches any host (e.g. `https://*` matches
  // `https://api.example.com`).
  if (patternHost === "*") return true;

  // Suffix wildcard: `*.example.com` matches `api.example.com` and
  // also `example.com` (per CSP spec).
  if (patternHost.startsWith("*.")) {
    const suffix = patternHost.slice(2); // drop "*."
    return domainHost === suffix || domainHost.endsWith("." + suffix);
  }

  return patternHost === domainHost;
}

function splitScheme(value: string): {
  scheme: string | undefined;
  host: string;
} {
  const idx = value.indexOf("://");
  if (idx < 0) return { scheme: undefined, host: value };
  return { scheme: value.slice(0, idx), host: value.slice(idx + 3) };
}

/**
 * The hosted-mode hard clamp predicate. Returns `true` when the given
 * domain MUST be stripped because it's a known exfil/privesc risk
 * regardless of user intent.
 *
 * This is the bedrock guard — never relax it based on `mcpProfile`.
 * A profile editor that wants this list to grow goes through a
 * platform-clamp change, not a CSP allow-list edit.
 */
function isHostedClampBlocked(domain: string, _key: CspDirectiveKey): boolean {
  // Wildcards always blocked.
  if (domain === "*") return true;
  const { scheme, host } = splitScheme(domain);
  if (host === "*") return true;
  if (host.startsWith("*.")) {
    // A user-declared `*.com` or `*.io` is too broad even though it's
    // not a literal `*`. Block any wildcard at a TLD-only level.
    const suffix = host.slice(2);
    if (!suffix.includes(".")) return true;
  }

  // Unsafe schemes.
  if (scheme === "javascript") return true;
  // `data:` is OK in img-src/media-src (the renderer would only emit
  // it there). For other directive families it's blocked here so a
  // misuse can't slip through. The directive key would let us refine
  // this further if needed; for now: blanket block to keep the
  // clamp's behavior easy to audit.
  if (scheme === "data") return true;
  if (scheme === "blob") return true;

  // localhost / loopback / RFC-1918. Strip an optional port suffix —
  // CSP source expressions allow `host:port`, but the clamp matches
  // by hostname only ("localhost" should be blocked whether or not
  // it has a port).
  const hostnameOnly = host.includes(":")
    ? host.slice(0, host.indexOf(":"))
    : host;
  const lowerHost = hostnameOnly.toLowerCase();
  if (
    lowerHost === "localhost" ||
    lowerHost === "127.0.0.1" ||
    lowerHost.startsWith("127.") ||
    lowerHost === "0.0.0.0" ||
    lowerHost.startsWith("10.") ||
    lowerHost.startsWith("192.168.") ||
    lowerHost === "::1"
  ) {
    return true;
  }
  // 172.16.0.0/12 — match `172.16.` through `172.31.`
  const m172 = /^172\.(\d+)\./.exec(lowerHost);
  if (m172) {
    const n = Number(m172[1]);
    if (n >= 16 && n <= 31) return true;
  }
  // 169.254.0.0/16 — link-local
  if (lowerHost.startsWith("169.254.")) return true;

  // MCPJam same-origin. Strip any host ending in `mcpjam.com` /
  // `mcpjam.dev` / `mcpjam.ai` — the inspector's own API/auth
  // endpoints. An app should reach MCP servers, not the inspector's
  // auth surface.
  if (
    lowerHost === "mcpjam.com" ||
    lowerHost.endsWith(".mcpjam.com") ||
    lowerHost === "mcpjam.dev" ||
    lowerHost.endsWith(".mcpjam.dev") ||
    lowerHost === "mcpjam.ai" ||
    lowerHost.endsWith(".mcpjam.ai")
  ) {
    return true;
  }

  return false;
}
