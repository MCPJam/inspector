/**
 * Pure resolver for the host-side sandbox policy applied to UI resources
 * (MCP Apps per SEP-1865, plus any ChatGPT-Apps surface that mounts
 * untrusted UI in a sandbox iframe).
 *
 * Lives in `@mcpjam/sdk` rather than the inspector client so the same
 * resolver is consumed by both:
 *   - `mcp-apps-renderer.tsx` (client-side MCP Apps rendering)
 *   - any ChatGPT-Apps renderer / server-side route that builds CSP
 *     headers for untrusted UI
 *
 * No DOM, no React, no Convex — pure JSON in / JSON out. Trivially unit-
 * testable. If the resolution lives in two places it can be bypassed by
 * mounting through the path that didn't get updated, which is exactly
 * the failure mode this single source of truth prevents.
 *
 * Precedence (mirror SEP-1865 + agreed plan):
 *
 *   1. `mode` picks the starting BASELINE:
 *      - `"declared"`:    baseline = resource's `_meta.ui.csp` declaration
 *      - `"host-default"`: baseline = inspector's default CSP shape
 *      - `"relaxed"`:     baseline = permissive (local/dev). Hosted clamp
 *                         (step 4) still strips dangerous values.
 *   2. `restrictTo` INTERSECTS with the baseline. Never unions —
 *      hosts MAY further restrict but MUST NOT allow undeclared domains.
 *      Applies in EVERY mode, including `"declared"`.
 *   3. `deny` SUBTRACTS from the current effective set. Wins over
 *      `restrictTo`, the baseline, and the resource declaration.
 *      Applies in EVERY mode.
 *   4. HOSTED-MODE HARD CLAMP — strips dangerous values regardless of
 *      profile (wildcards, localhost/private networks, unsafe schemes,
 *      MCPJam same-origin API access). NOT configurable from `mcpProfile`.
 *
 * Result is a typed `EffectiveSandboxCsp` carrying the four directive
 * lists ready for header-string construction by a downstream helper
 * (e.g. `buildCspHeader` in `widget-helpers.ts`).
 */

/**
 * Host-config sandbox CSP mode. Mirrors
 * `mcpProfile.apps.sandbox.csp.mode` from the backend's
 * `HostConfigMcpProfileV1`.
 */
export type SandboxCspMode = "host-default" | "declared" | "relaxed";

/**
 * Host-config permissions mode. Mirrors
 * `mcpProfile.apps.sandbox.permissions.mode`.
 */
export type SandboxPermissionsMode =
  | "resource-declared"
  | "deny-all"
  | "custom";

/**
 * Four parallel allow/deny lists keyed by CSP directive family.
 * Mirrors `CspDomainSet` in the backend's
 * `convex/lib/hostConfigV2.ts:46`.
 */
export interface SandboxCspDomainSet {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/**
 * The `apps.sandbox.csp` slice of the host-config mcpProfile envelope.
 * Optional everywhere: undefined fields mean "no host-level override at
 * this layer." Mirrors
 * `mcpProfile.apps.sandbox.csp` in the backend schema.
 */
export interface SandboxCspPolicy {
  mode?: SandboxCspMode;
  restrictTo?: SandboxCspDomainSet;
  deny?: SandboxCspDomainSet;
}

/**
 * The `apps.sandbox.permissions` slice. Mirrors
 * `mcpProfile.apps.sandbox.permissions`.
 */
export interface SandboxPermissionsPolicy {
  mode?: SandboxPermissionsMode;
  allow?: Record<string, boolean>;
  deny?: string[];
}

/**
 * What the resource declared in its `_meta.ui.csp`. Same four directive
 * families. Undefined = the resource declared nothing (the SEP-1865
 * "secure default" applies, which the baseline picker fabricates from
 * mode).
 */
export interface ResourceDeclaredCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/**
 * Result of the resolver. Caller turns this into a real CSP header
 * string with whatever builder it uses (e.g. `buildCspHeader` for
 * inspector renderers).
 */
export interface EffectiveSandboxCsp {
  /** Final effective CSP-directive lists after all 4 precedence steps. */
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
  /** Trace of how the resolver arrived at the result — for debug UI. */
  trace: {
    /** Step 1 — baseline picked by `mode`. */
    baseline: ResourceDeclaredCsp;
    /** Step 2 — after `restrictTo ∩ baseline`. */
    afterRestrictTo: ResourceDeclaredCsp;
    /** Step 3 — after subtracting `deny`. */
    afterDeny: ResourceDeclaredCsp;
    /** Step 4 — values the hosted-mode clamp stripped. Empty when not hosted. */
    hostedClamp: { stripped: SandboxCspDomainSet };
    /** Which mode was applied (after default substitution). */
    effectiveMode: SandboxCspMode;
  };
}

/**
 * Sandbox permissions set after resolution. Boolean map keyed by
 * permission name — `true` means granted to the iframe (`allow=`
 * attribute), `false` (or absent) means not granted.
 */
export interface EffectiveSandboxPermissions {
  granted: Record<string, boolean>;
  trace: {
    declared: Record<string, boolean>;
    afterMode: Record<string, boolean>;
    deniedByProfile: string[];
    deniedByHostedClamp: string[];
    effectiveMode: SandboxPermissionsMode;
  };
}

export interface ResolveSandboxCspArgs {
  /** What the UI resource declared in `_meta.ui.csp`. */
  resourceCsp?: ResourceDeclaredCsp;
  /** Host-config policy from `mcpProfile.apps.sandbox.csp`. */
  policy?: SandboxCspPolicy;
  /**
   * Inspector's renderer default baseline for `mode: "host-default"`. The
   * resolver doesn't fabricate this — the caller supplies it because
   * "what counts as the inspector's default" is a UI concern. Today the
   * inspector uses `buildCspHeader` in `widget-helpers.ts` to compute
   * permissive vs widget-declared baselines; callers can synthesize
   * the resource-list shape from there or pass any shape they want.
   */
  hostDefaultBaseline?: ResourceDeclaredCsp;
  /**
   * SEP-1865 "secure default" applied when the resource omits its CSP
   * declaration AND mode is `"declared"`. Defaults to the empty
   * record (no domains allowed) per the spec. Callers may override if
   * they need to allow specific protocol-mandated sources.
   */
  secureDefault?: ResourceDeclaredCsp;
  /**
   * Whether the inspector is running in hosted mode. Drives the hosted
   * clamp (step 4). Callers detect this however they currently do —
   * the resolver doesn't sniff env or origin.
   */
  hostedMode: boolean;
}

export interface ResolveSandboxPermissionsArgs {
  /**
   * Permissions the resource requested in its `_meta.ui.permissions`.
   * Boolean map keyed by permission name (`camera`, `microphone`,
   * `geolocation`, `clipboard-write`, ...). The resource declaration is
   * the CEILING — host can't grant a permission the resource didn't
   * request.
   */
  resourcePermissions?: Record<string, boolean>;
  policy?: SandboxPermissionsPolicy;
  /**
   * Whether the inspector is running in hosted mode. Drives the hosted
   * clamp for sensitive permissions.
   */
  hostedMode: boolean;
  /**
   * Permission names the hosted-mode clamp must strip regardless of
   * profile. Defaults to the SEP-1865-sensitive set
   * (`camera`, `microphone`, `geolocation`). Callers may pass a
   * different list if their hosted-mode policy diverges.
   */
  hostedClampDeny?: string[];
}

const DEFAULT_HOSTED_PERMISSION_CLAMP_DENY: ReadonlyArray<string> = [
  "camera",
  "microphone",
  "geolocation",
];

const EMPTY_DOMAIN_SET: ResourceDeclaredCsp = {
  connectDomains: [],
  resourceDomains: [],
  frameDomains: [],
  baseUriDomains: [],
};

const CSP_DIRECTIVE_KEYS: ReadonlyArray<keyof ResourceDeclaredCsp> = [
  "connectDomains",
  "resourceDomains",
  "frameDomains",
  "baseUriDomains",
];

/**
 * Resolve the effective sandbox CSP for a UI resource given the host's
 * profile and hosted-mode flag. See module docstring for precedence.
 *
 * @example
 * const csp = resolveSandboxCsp({
 *   resourceCsp: { connectDomains: ["api.example.com", "evil.com"] },
 *   policy: { mode: "declared", deny: { connectDomains: ["evil.com"] } },
 *   hostedMode: false,
 * });
 * // csp.connectDomains === ["api.example.com"]
 */
export function resolveSandboxCsp(
  args: ResolveSandboxCspArgs,
): EffectiveSandboxCsp {
  const effectiveMode: SandboxCspMode = args.policy?.mode ?? "declared";
  const secureDefault = args.secureDefault ?? EMPTY_DOMAIN_SET;

  // Step 1 — baseline from mode.
  let baseline: ResourceDeclaredCsp;
  switch (effectiveMode) {
    case "declared":
      // Resource declaration is the baseline. Missing → secure default.
      baseline = args.resourceCsp ?? secureDefault;
      break;
    case "host-default":
      // Inspector's renderer default. Caller supplies the shape; we
      // intentionally don't fabricate one so this stays decoupled from
      // the legacy `buildCspHeader` modes.
      baseline = args.hostDefaultBaseline ?? secureDefault;
      break;
    case "relaxed":
      // Permissive in local/dev. Hosted clamp (step 4) still applies.
      // We can't open `*` here because then `restrictTo` becomes
      // unmodeled — instead, a relaxed baseline pulls from
      // hostDefaultBaseline if provided; the caller's `buildCspHeader`
      // "permissive" mode will compute the actual broad CSP at header
      // assembly time. The resolver focuses on the per-domain set
      // semantics.
      baseline = args.hostDefaultBaseline ?? secureDefault;
      break;
  }

  const baselineLists = normalizeDomainSet(baseline);

  // Step 2 — intersect with restrictTo (when set). Never unions; never
  // adds undeclared domains. Applies in every mode.
  const afterRestrictTo: ResourceDeclaredCsp = {};
  for (const key of CSP_DIRECTIVE_KEYS) {
    const baselineList = baselineLists[key] ?? [];
    const restrictList = args.policy?.restrictTo?.[key];
    if (restrictList === undefined) {
      // No restriction declared for this directive — pass baseline through.
      afterRestrictTo[key] = [...baselineList];
    } else {
      // Intersect: keep only baseline entries that the restrictTo list
      // also contains. Order from the baseline is preserved.
      const restrictSet = new Set(restrictList);
      afterRestrictTo[key] = baselineList.filter((d) => restrictSet.has(d));
    }
  }

  // Step 3 — subtract deny. deny wins over restrictTo and baseline.
  // Wildcard prefix matching: `https://*.evil.com` matches
  // `https://api.evil.com`.
  const afterDeny: ResourceDeclaredCsp = {};
  for (const key of CSP_DIRECTIVE_KEYS) {
    const list = afterRestrictTo[key] ?? [];
    const denyList = args.policy?.deny?.[key];
    if (!denyList || denyList.length === 0) {
      afterDeny[key] = list;
      continue;
    }
    afterDeny[key] = list.filter((d) => !matchesAnyDeny(d, denyList));
  }

  // Step 4 — hosted-mode clamp.
  const hostedStripped: SandboxCspDomainSet = {};
  let final: ResourceDeclaredCsp;
  if (args.hostedMode) {
    final = {};
    for (const key of CSP_DIRECTIVE_KEYS) {
      const before = afterDeny[key] ?? [];
      const stripped: string[] = [];
      const kept: string[] = [];
      for (const d of before) {
        if (isHostedDangerousDomain(d)) {
          stripped.push(d);
        } else {
          kept.push(d);
        }
      }
      if (stripped.length > 0) hostedStripped[key] = stripped;
      final[key] = kept;
    }
  } else {
    final = afterDeny;
  }

  return {
    connectDomains: final.connectDomains ?? [],
    resourceDomains: final.resourceDomains ?? [],
    frameDomains: final.frameDomains ?? [],
    baseUriDomains: final.baseUriDomains ?? [],
    trace: {
      baseline,
      afterRestrictTo,
      afterDeny,
      hostedClamp: { stripped: hostedStripped },
      effectiveMode,
    },
  };
}

/**
 * Resolve sandbox permissions for a UI resource. Resource declaration is
 * the ceiling; `mode` chooses posture; `deny` wins; hosted clamp strips
 * sensitive permissions regardless.
 */
export function resolveSandboxPermissions(
  args: ResolveSandboxPermissionsArgs,
): EffectiveSandboxPermissions {
  const declared = args.resourcePermissions ?? {};
  const effectiveMode: SandboxPermissionsMode =
    args.policy?.mode ?? "resource-declared";

  // Step 1 — start from the resource declaration as candidate.
  // Step 2 — apply mode. Each stage produces an IMMUTABLE snapshot so the
  // trace fields below capture the value at that stage (the prior shape
  // aliased `afterMode` and `granted` to the same object reference, so
  // `trace.afterMode` always equaled the final granted set — useless for
  // debugging "which step dropped this permission?").
  let afterModeSnapshot: Record<string, boolean>;
  switch (effectiveMode) {
    case "resource-declared":
      afterModeSnapshot = { ...declared };
      break;
    case "deny-all":
      afterModeSnapshot = {};
      break;
    case "custom": {
      // `allow` is the candidate set; resource declaration acts as the
      // ceiling (host can never grant a permission the resource didn't
      // request).
      afterModeSnapshot = {};
      const allow = args.policy?.allow ?? {};
      for (const [name, granted] of Object.entries(allow)) {
        if (granted && declared[name]) {
          afterModeSnapshot[name] = true;
        }
      }
      break;
    }
  }

  // Working copy for Steps 3+4 so the snapshots above remain unchanged.
  const working: Record<string, boolean> = { ...afterModeSnapshot };

  // Step 3 — subtract profile deny.
  const deniedByProfile: string[] = [];
  if (args.policy?.deny && args.policy.deny.length > 0) {
    for (const name of args.policy.deny) {
      if (working[name]) {
        deniedByProfile.push(name);
        delete working[name];
      }
    }
  }

  // Step 4 — hosted-mode clamp.
  const hostedClampDeny = args.hostedClampDeny ?? DEFAULT_HOSTED_PERMISSION_CLAMP_DENY;
  const deniedByHostedClamp: string[] = [];
  if (args.hostedMode) {
    for (const name of hostedClampDeny) {
      if (working[name]) {
        deniedByHostedClamp.push(name);
        delete working[name];
      }
    }
  }

  return {
    granted: working,
    trace: {
      declared,
      // afterMode is the post-step-2 snapshot — NOT the final granted set.
      // This is the stage immediately after `mode` picks the candidate
      // surface and before deny/clamp subtract from it.
      afterMode: afterModeSnapshot,
      deniedByProfile,
      deniedByHostedClamp,
      effectiveMode,
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function normalizeDomainSet(value: ResourceDeclaredCsp): {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
} {
  return {
    connectDomains: [...(value.connectDomains ?? [])],
    resourceDomains: [...(value.resourceDomains ?? [])],
    frameDomains: [...(value.frameDomains ?? [])],
    baseUriDomains: [...(value.baseUriDomains ?? [])],
  };
}

/**
 * True iff `domain` matches any pattern in `denyList`. Supports wildcard
 * subdomain matching: `https://*.example.com` matches
 * `https://api.example.com` and `https://other.example.com`, but NOT
 * `https://example.com` itself (the wildcard requires a subdomain).
 * Exact match also wins.
 */
function matchesAnyDeny(domain: string, denyList: string[]): boolean {
  for (const pattern of denyList) {
    if (pattern === domain) return true;
    if (pattern.includes("*")) {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      const regexPattern = "^" + escaped.replace(/\*/g, "[^/]+") + "$";
      if (new RegExp(regexPattern).test(domain)) return true;
    }
  }
  return false;
}

/**
 * Hosted-mode clamp predicate. Strips:
 *   - Bare wildcards (`*`, bare-scheme tokens like `https:`).
 *   - Localhost / loopback / private-network / link-local hostnames,
 *     regardless of scheme (http/https/ws/wss) and IP form (decimal,
 *     zero-padded, hex, IPv4-mapped IPv6).
 *   - Unsafe schemes (`javascript:`, `vbscript:`, `data:`, `file:`, etc.),
 *     matched case-insensitively because CSP source expressions are
 *     case-insensitive on the scheme.
 *
 * NOT a replacement for CSP-level enforcement — this is defense in depth.
 * The browser enforces CSP regardless; this prevents a profile from
 * SAYING it allows these in the first place.
 *
 * Same-origin MCPJam API blocking is the caller's responsibility (the
 * resolver doesn't know what "MCPJam same-origin" is — the caller passes
 * additional clamp entries via `denyList` if it has app-specific
 * origins to strip).
 */
function isHostedDangerousDomain(domain: string): boolean {
  if (typeof domain !== "string") return true;
  const trimmed = domain.trim();
  if (trimmed === "") return true;
  const lower = trimmed.toLowerCase();

  // Bare CSP wildcards / scheme-only tokens.
  if (trimmed === "*") return true;
  if (
    lower === "https:" ||
    lower === "http:" ||
    lower === "ws:" ||
    lower === "wss:" ||
    lower === "data:" ||
    lower === "blob:"
  ) {
    return true;
  }

  // Unsafe schemes. Case-insensitive — `JavaScript:` was a known bypass.
  const UNSAFE_SCHEME_PREFIXES = [
    "javascript:",
    "vbscript:",
    "file:",
    "data:",
    "blob:",
    "filesystem:",
    "view-source:",
  ];
  for (const prefix of UNSAFE_SCHEME_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }

  // Protocol-relative form `//localhost:3000` — strip these too.
  if (trimmed.startsWith("//")) {
    return isDangerousHostname(extractHostname("https:" + trimmed));
  }

  // Parse anything that looks like a URL. Covers all four schemes the spec
  // expects (http, https, ws, wss) and any case variation thereof. Use the
  // URL parser to normalize the host — that's how we catch zero-padded
  // IPv4 (`127.000.000.001` → `127.0.0.1`), IPv4-mapped IPv6
  // (`[::ffff:127.0.0.1]` → `::ffff:127.0.0.1`), and other forms a regex
  // would silently miss.
  if (/^(https?|wss?):\/\//i.test(trimmed)) {
    return isDangerousHostname(extractHostname(trimmed));
  }

  // CSP supports bare host expressions too (`localhost:3000`,
  // `*.example.com`). Treat them as hostnames if they don't look like a
  // URL above.
  if (trimmed.includes("*")) {
    // `https://*` style wildcards without a domain part.
    if (
      lower === "https://*" ||
      lower === "http://*" ||
      lower === "ws://*" ||
      lower === "wss://*"
    ) {
      return true;
    }
    return false;
  }

  return isDangerousHostname(trimmed.toLowerCase());
}

/**
 * Try to extract the hostname from an arbitrary URL-like string using the
 * native parser. Returns the raw input lower-cased on parse failure so the
 * caller can still apply hostname-pattern checks defensively.
 */
function extractHostname(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase();
  } catch {
    return input.toLowerCase();
  }
}

/**
 * True if `hostname` (already lower-cased) refers to a loopback /
 * private-network / link-local / disallowed target. Operates on
 * URL-normalized strings, so zero-padded IPv4 and IPv4-mapped IPv6 already
 * resolve to their canonical form.
 */
function isDangerousHostname(hostname: string): boolean {
  if (!hostname) return true;

  // Strip enclosing brackets from IPv6 literals so we can pattern-match.
  let host = hostname;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }

  if (host === "localhost") return true;
  if (host.endsWith(".localhost")) return true;

  // IPv4 loopback / unspecified.
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host === "0.0.0.0") return true;

  // RFC1918 private ranges.
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(host)) return true;

  // Link-local (RFC3927) and shared address space (RFC6598).
  if (/^169\.254(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}$/.test(host)) {
    return true;
  }

  // IPv6 loopback / link-local / IPv4-mapped loopback. The URL parser
  // canonicalizes these to lower case + collapses zeros, so direct prefix
  // checks suffice.
  if (host === "::1") return true;
  if (host.startsWith("fe80:")) return true;
  // IPv4-mapped IPv6 loopback. The URL parser canonicalizes
  // `::ffff:127.0.0.1` to its hex form `::ffff:7f00:1` (and similar for
  // other addresses in 127.0.0.0/8), so check both the canonical hex
  // shape (`::ffff:7fXX:XXXX`) AND the dotted form (preserved when the
  // string never round-tripped through `new URL`, e.g. bare host
  // expressions). `7f00` is `127.0` in hex; the full prefix `::ffff:7f`
  // covers every IPv4-mapped address in 127.0.0.0/8.
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)) return true;
  if (/^::ffff:127(?:\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6 unique local addresses (fc00::/7).
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;

  return false;
}
