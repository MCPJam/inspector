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

/**
 * Permissions the hosted-mode clamp always strips, regardless of
 * profile intent. Camera/microphone/geolocation are sensitive
 * vendor-trait fields the platform refuses to delegate to a
 * widget-author profile. `clipboard-read` is included because
 * read-side clipboard access is a credible exfil channel —
 * `clipboard-write` is intentionally NOT clamped (most apps need
 * "copy to clipboard" buttons and the write-side risk is much
 * lower).
 *
 * Module-scoped const so the Set is allocated once (not per
 * `resolveSandboxPermissions` call, which the renderer hits on every
 * app render) and easy to grep for in security audits.
 */
const HOSTED_CLAMP_SENSITIVE_PERMISSIONS: ReadonlySet<string> = new Set([
  "camera",
  "microphone",
  "geolocation",
  "clipboard-read",
]);

export type SandboxCspMode = "host-default" | "declared" | "relaxed";
export type SandboxPermissionsMode =
  | "resource-declared"
  | "deny-all"
  | "custom";

/**
 * Validate / coerce an unknown mode value to the SandboxCspMode union.
 *
 * The resolver may be called with a profile written by a *future*
 * inspector version that introduces a new mode (or with corrupt
 * data). A naive `as SandboxCspMode` cast would let those values
 * leak out of the resolver and break consumers that exhaustive-match
 * on the union. Normalizing to `"declared"` (the spec-safest default)
 * keeps the type contract honest and fail-safe: an unknown mode
 * never widens the effective CSP.
 */
function normalizeCspMode(input: unknown): SandboxCspMode {
  return input === "host-default" || input === "declared" || input === "relaxed"
    ? input
    : "declared";
}

function normalizePermissionsMode(
  input: unknown,
  fallback: SandboxPermissionsMode,
): SandboxPermissionsMode {
  return input === "resource-declared" ||
    input === "deny-all" ||
    input === "custom"
    ? input
    : fallback;
}

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
  const mode = normalizeCspMode(args.profile?.apps?.sandbox?.csp?.mode);

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
  const mode = normalizePermissionsMode(
    profilePerms?.mode,
    args.defaultPermissionsMode ?? "resource-declared",
  );

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
  // (camera/microphone/geolocation/clipboard-read) regardless of
  // profile. See HOSTED_CLAMP_SENSITIVE_PERMISSIONS (module scope)
  // for the rationale per entry; the set lives at module scope so
  // it's allocated once and audit-greppable.
  const effective: Record<string, boolean> = { ...afterDeny };
  if (args.isHostedMode) {
    for (const key of Object.keys(effective)) {
      if (HOSTED_CLAMP_SENSITIVE_PERMISSIONS.has(key)) effective[key] = false;
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

// `resolveSandboxPolicy` (a wrapper returning { csp, permissions }) was
// intentionally removed: the renderer and tests both call the two
// resolvers independently, and exporting an unused convenience wrapper
// would add to the module's surface area without a consumer. Callers
// that want both resolved sets can call the two functions directly.

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
 * Intersect a baseline domain list (`a`) with a restrictTo list (`b`),
 * with wildcard awareness in BOTH directions.
 *
 * Two cases the resolver must handle:
 *
 * 1. **Concrete baseline, wildcard restrictTo** — keep the baseline
 *    entry if any restrictTo pattern matches it. Example:
 *      baseline:    ["https://api.example.com", "https://api.other.com"]
 *      restrictTo:  ["https://*.example.com"]
 *      effective:   ["https://api.example.com"]
 *
 * 2. **Wildcard baseline, concrete restrictTo** — keep the restrictTo
 *    entry if any baseline pattern covers it. Without this case,
 *    a relaxed-mode baseline of `["*"]` intersected with
 *    `["https://api.example.com"]` would resolve to `[]` and break
 *    the widget — exactly opposite of "host MAY restrict." Per
 *    SEP-1865 the host restricting a wildcard MUST yield the
 *    narrower concrete entries, not the wildcard nor an empty set.
 *
 * Concrete-vs-concrete falls out of either branch via string
 * equality (matchesDomain returns true for equal strings).
 *
 * Output is deduped by string identity. Wildcard baseline entries
 * that aren't narrowed by any restrictTo entry are dropped — the
 * narrowing IS the point of restrictTo. A wildcard with no narrower
 * restrictTo entry would be wider than what the user asked for, so
 * the spec-safe choice is to drop it.
 */
function intersectDomainLists(
  baseline: string[],
  restrictTo: string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (entry: string) => {
    if (seen.has(entry)) return;
    seen.add(entry);
    out.push(entry);
  };

  // Case 1: keep baseline entries the restrictTo covers.
  for (const entry of baseline) {
    if (restrictTo.some((pattern) => matchesDomain(pattern, entry))) {
      add(entry);
    }
  }

  // Case 2: keep restrictTo entries the baseline covers (the
  // narrower-than-wildcard case). Only adds entries the baseline
  // *itself* doesn't already match concretely — those were caught
  // by Case 1.
  for (const entry of restrictTo) {
    if (baseline.includes(entry)) continue; // already added in Case 1
    if (baseline.some((pattern) => matchesDomain(pattern, entry))) {
      add(entry);
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

  // Strip ports from BOTH sides before comparison. A CSP pattern like
  // `https://*.example.com` MUST match `https://api.example.com:8443` —
  // the port is part of the URL but not part of the host-suffix
  // matching rule. Without this, a deny like `https://*.evil.com`
  // would fail to match `https://api.evil.com:8443` and let it
  // through the clamp. Same disambiguation rule for IPv6.
  const patternHost = extractHostname(patternParts.host);
  const domainHost = extractHostname(domainParts.host);

  // `*` host alone matches any host (e.g. `https://*` matches
  // `https://api.example.com`).
  if (patternHost === "*") return true;

  // Suffix wildcard: `*.example.com` matches `api.example.com` and
  // (intentionally diverging from W3C CSP3) the bare apex
  // `example.com` itself.
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
  // CSP source expressions come in two forms:
  //   1. `scheme://host[...]` — the common case for http/https/ws/wss.
  //   2. `scheme:` (single colon, no host) — `javascript:`, `data:`,
  //      `blob:`, `filesystem:`. Scheme-source expressions per CSP
  //      grammar. Treating them as schemeless silently bypasses the
  //      hosted clamp's `javascript`/`data`/`blob` blocks.
  //
  // The split MUST anchor on the FIRST colon, not on `://`. Inputs
  // like `blob:https://example.com/foo` have BOTH a single-colon
  // scheme prefix AND a later `://`; matching the triple form first
  // would yield scheme="blob:https" which the clamp's
  // `scheme === "blob"` check won't recognize, slipping the entry
  // past defense-in-depth. Match the leading scheme token, then
  // peel `//` off the host if present to keep behavior parity with
  // the URL-shaped case.
  //
  // Grammar from RFC 3986
  // (scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )).
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(value);
  if (schemeMatch) {
    const rest = value.slice(schemeMatch[0].length);
    return {
      scheme: schemeMatch[1]!.toLowerCase(),
      // Strip a leading `//` so callers that compare `host` to e.g.
      // `"localhost"` or wildcards don't need to know whether the
      // caller wrote `http://localhost` vs `localhost-only` (rare).
      // The hierarchical form is the common case; the scheme-only
      // form falls through with `host` carrying whatever followed
      // the colon (e.g. `image/png;base64,...` for `data:`).
      host: rest.startsWith("//") ? rest.slice(2) : rest,
    };
  }
  return { scheme: undefined, host: value };
}

/**
 * Expand an IPv6 address string into 8 lowercase hex 16-bit groups,
 * or `null` when the input isn't a recognizable IPv6 form. Handles:
 *
 *   - Full canonical form: `0:0:0:0:0:0:0:1`
 *   - `::` zero-run compression at any position: `::1`, `1::`,
 *     `2001:db8::1`
 *   - IPv4-mapped low-32-bit form: `::ffff:a.b.c.d` and the hex form
 *     `::ffff:7f00:1` are both expanded to `0:0:0:0:0:ffff:7f00:0001`.
 *
 * Used by the hosted-mode clamp to canonicalize varied IPv6 inputs
 * before checking for loopback / IPv4-mapped private ranges. A
 * single regex can only catch one form at a time — `::1` is
 * different bytes from `0:0:0:0:0:0:0:1`, but both name the same
 * loopback address; an attacker can pick whichever form bypasses
 * the clamp. Routing all forms through one normalizer closes that
 * variant-shopping bypass.
 *
 * Deliberately permissive on group hex casing and leading zeros
 * (RFC 4291 allows either) but strict on syntax: rejects more than
 * one `::`, more than 8 groups, or non-hex groups.
 */
function expandIPv6(addr: string): string[] | null {
  // Reject obviously-invalid characters early so the split-and-fill
  // below doesn't have to defensively check each group's content.
  if (addr.length === 0) return null;
  if (addr.includes(":::")) return null;

  // Embedded dotted-quad in the low 32 bits (RFC 4291 §2.5.5).
  // Strip and replace with the two equivalent hex groups so the
  // rest of the parser only has to deal with hex.
  let work = addr;
  const dottedMatch = /^(.*:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(
    addr,
  );
  if (dottedMatch) {
    const a = Number(dottedMatch[2]);
    const b = Number(dottedMatch[3]);
    const c = Number(dottedMatch[4]);
    const d = Number(dottedMatch[5]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return null;
    const hi = ((a << 8) | b).toString(16);
    const lo = ((c << 8) | d).toString(16);
    work = `${dottedMatch[1] ?? ""}${hi}:${lo}`;
  }

  // Compression handling: `::` elides one or more all-zero groups.
  const parts = work.split("::");
  if (parts.length > 2) return null;

  const left = parts[0]!.length > 0 ? parts[0]!.split(":") : [];
  const right =
    parts.length === 2 && parts[1]!.length > 0
      ? parts[1]!.split(":")
      : [];

  if (parts.length === 1) {
    // No compression — must already have all 8 groups.
    if (left.length !== 8) return null;
  } else {
    // Compression — must elide at least 1 group, i.e. total < 8.
    if (left.length + right.length >= 8) return null;
  }

  const fillCount = 8 - left.length - right.length;
  const fill = Array<string>(parts.length === 2 ? fillCount : 0).fill("0");
  const groups = [...left, ...fill, ...right];
  if (groups.length !== 8) return null;

  const out: string[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(g.toLowerCase());
  }
  return out;
}

/**
 * Extract the bare hostname from a possibly-port-suffixed host string.
 *
 * Used by both `matchesDomain` (for wildcard suffix comparisons that
 * must be host-vs-host, not host-vs-host:port) and the hosted-mode
 * clamp's loopback checks (where `localhost:3000` must still match
 * the `localhost` literal). Centralized here so the two callers
 * agree on the IPv6 disambiguation rules:
 *   1. Bracketed IPv6 (`[hex...]`) — strip the brackets, then drop
 *      any `:port` that follows the closing bracket.
 *   2. Bare IPv6 (more than one `:`, no brackets) — entire host is
 *      the hostname (no port-stripping); a naive `slice(0,
 *      indexOf(':'))` would reduce `::1` to `""` and slip past
 *      every loopback check.
 *   3. Everything else (zero or one `:`) — port-strip on the
 *      single colon.
 */
function extractHostname(host: string): string {
  if (host.startsWith("[")) {
    const closeIdx = host.indexOf("]");
    return closeIdx >= 0 ? host.slice(1, closeIdx) : host.slice(1);
  }
  if ((host.match(/:/g)?.length ?? 0) > 1) {
    return host;
  }
  if (host.includes(":")) {
    return host.slice(0, host.indexOf(":"));
  }
  return host;
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

  // localhost / loopback / RFC-1918. Reuse `extractHostname` so the
  // clamp and `matchesDomain` agree on how to strip ports (and how
  // to handle bracketed / bare IPv6 forms — a naive
  // `slice(0, indexOf(':'))` would reduce `[::1]:3000` to `[` and
  // bare `::1` to `""`, slipping past every loopback check below).
  const lowerHost = extractHostname(host).toLowerCase();
  // IPv6 normalization. CSP entries can express the same address
  // in many forms — `::1` vs `0:0:0:0:0:0:0:1`, `::ffff:127.0.0.1`
  // vs `::ffff:7f00:1`, etc. Without canonicalization, an attacker
  // can pick whichever form bypasses the clamp's literal startsWith
  // checks. Route everything through one expander so the loopback
  // and IPv4-mapped checks see a stable shape.
  //
  // `effectiveHost` ends up holding the dotted-quad form when the
  // input was an IPv4-mapped IPv6 (so the downstream `startsWith
  // ("127.")` / `startsWith("10.")` / etc. checks fire); otherwise
  // it keeps the original lowerHost.
  const v6groups = expandIPv6(lowerHost);
  // Loopback in any IPv6 form: all groups 0 except last = 1.
  // Catches `::1`, `0:0:0:0:0:0:0:1`, `0::1`, `::0:1`, etc.
  const isIpv6Loopback =
    v6groups !== null &&
    v6groups.slice(0, 7).every((g) => g === "0") &&
    v6groups[7] === "1";
  // IPv4-mapped IPv6: first 5 groups 0, group 5 = "ffff", last 2
  // groups encode the v4 address (RFC 4291 §2.5.5.2). Catches both
  // dotted-quad form (`::ffff:127.0.0.1`) and hex form
  // (`::ffff:7f00:1`) — the dotted form is converted to hex during
  // expansion.
  let effectiveHost = lowerHost;
  if (
    v6groups !== null &&
    v6groups[5] === "ffff" &&
    v6groups.slice(0, 5).every((g) => g === "0")
  ) {
    const hi = parseInt(v6groups[6]!, 16);
    const lo = parseInt(v6groups[7]!, 16);
    effectiveHost = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  if (
    effectiveHost === "localhost" ||
    effectiveHost === "127.0.0.1" ||
    effectiveHost.startsWith("127.") ||
    effectiveHost === "0.0.0.0" ||
    effectiveHost.startsWith("10.") ||
    effectiveHost.startsWith("192.168.") ||
    isIpv6Loopback
  ) {
    return true;
  }
  // 172.16.0.0/12 — match `172.16.` through `172.31.`
  const m172 = /^172\.(\d+)\./.exec(effectiveHost);
  if (m172) {
    const n = Number(m172[1]);
    if (n >= 16 && n <= 31) return true;
  }
  // 169.254.0.0/16 — link-local
  if (effectiveHost.startsWith("169.254.")) return true;

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
