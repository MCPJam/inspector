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
 *      profile (wildcards, localhost/private networks, unsafe schemes).
 *      Built-in patterns are NOT configurable from `mcpProfile`. Callers
 *      may pass an additional `hostedClampExtraDeny` set for app-specific
 *      origins they want stripped (e.g. the inspector's own API origin —
 *      this is the only place that protects against a hosted widget
 *      declaring same-origin exfiltration targets in `connectDomains`).
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
 *
 * **Key shape:** `allow` keys and `deny` entries MUST use the same
 * names as the MCP `_meta.ui.permissions` declaration (SEP-1865
 * §UIResourceMeta — camelCase: `camera`, `microphone`, `geolocation`,
 * `clipboardWrite`). The resolver does plain string-key matching
 * against `resourcePermissions`, so any kebab-case entries (`clipboard-
 * write`) will silently no-op — the spec's kebab form belongs at the
 * iframe `allow=` attribute layer, not here.
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
  /**
   * App-specific origins the hosted clamp MUST strip in addition to the
   * built-in `isHostedDangerousDomain` patterns. Only applied when
   * `hostedMode === true`. Supports the same wildcard-prefix matching as
   * `policy.deny` (`https://*.example.com` matches subdomains).
   *
   * Mirrors `ResolveSandboxPermissionsArgs.hostedClampDeny`. This is the
   * only place that protects against a hosted widget declaring app-
   * sensitive origins (e.g. the inspector's own API origin) in
   * `connectDomains` to exfiltrate data — `policy.deny` is profile-
   * configurable and therefore bypassable; this is not.
   */
  hostedClampExtraDeny?: SandboxCspDomainSet;
}

export interface ResolveSandboxPermissionsArgs {
  /**
   * Permissions the resource requested in its `_meta.ui.permissions`.
   * Boolean map keyed by permission name as declared in SEP-1865
   * (camelCase: `camera`, `microphone`, `geolocation`, `clipboardWrite`).
   * The kebab-case forms (`clipboard-write`) are the browser
   * Permission-Policy spelling and belong at the iframe `allow=`
   * attribute layer — not here. The resource declaration is the
   * CEILING: the host can't grant a permission the resource didn't
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
  //
  // Case-insensitive match: CSP source expressions are case-insensitive
  // on scheme and host per RFC 3986 / CSP3, and `matchesAnyDeny` (used
  // for step 3) already lower-cases both sides. Without parity here a
  // `restrictTo: ["Api.Example.COM"]` would silently drop a resource-
  // declared `api.example.com` while the same string in `deny` would
  // strip it — two inconsistent matching strategies in the same
  // resolver. The lowercase Set is the lookup index; we still emit the
  // baseline-cased original string so the resulting CSP header matches
  // what the widget declared.
  const afterRestrictTo: ResourceDeclaredCsp = {};
  for (const key of CSP_DIRECTIVE_KEYS) {
    const baselineList = baselineLists[key] ?? [];
    const restrictList = args.policy?.restrictTo?.[key];
    if (restrictList === undefined) {
      // No restriction declared for this directive — pass baseline through.
      afterRestrictTo[key] = [...baselineList];
    } else {
      const restrictSet = new Set(restrictList.map((d) => d.toLowerCase()));
      afterRestrictTo[key] = baselineList.filter((d) =>
        restrictSet.has(d.toLowerCase()),
      );
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
    const extraDenyByDirective = args.hostedClampExtraDeny;
    for (const key of CSP_DIRECTIVE_KEYS) {
      const before = afterDeny[key] ?? [];
      const extraDenyList = extraDenyByDirective?.[key];
      const stripped: string[] = [];
      const kept: string[] = [];
      for (const d of before) {
        // Two reasons to strip: the built-in dangerous-pattern predicate,
        // or a caller-supplied app-specific origin (e.g. MCPJam's own
        // API host). Either alone is sufficient — both run in this single
        // pass so the trace's `stripped` list captures everything.
        const isExtra =
          extraDenyList !== undefined &&
          extraDenyList.length > 0 &&
          matchesAnyDeny(d, extraDenyList);
        if (isHostedDangerousDomain(d) || isExtra) {
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
 *
 * Matching is case-insensitive on the whole source expression: CSP
 * source expressions normalize scheme + host per the URL spec, DNS
 * hostnames are case-insensitive, and the deny rules in this codebase
 * don't carry case-significant paths. Comparing raw strings let
 * `deny: ["Evil.com"]` slip past a widget declaring `"evil.com"` — that
 * inversion is exactly what deny rules exist to prevent.
 */
function matchesAnyDeny(domain: string, denyList: string[]): boolean {
  const domainLower = domain.toLowerCase();
  for (const pattern of denyList) {
    const patternLower = pattern.toLowerCase();
    if (patternLower === domainLower) return true;
    if (patternLower.includes("*")) {
      const escaped = patternLower.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      const regexPattern = "^" + escaped.replace(/\*/g, "[^/]+") + "$";
      if (new RegExp(regexPattern).test(domainLower)) return true;
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

  // Bare host source expressions may include a port (`localhost:3000`,
  // `[::1]:9000`) or a path. The hostname-pattern checks below don't
  // accept either suffix — `host === "localhost"` would miss
  // `"localhost:3000"`, letting a hosted widget declare a loopback
  // origin and bypass the clamp. Synthesize a scheme so the URL parser
  // strips port/path uniformly (same trick used for protocol-relative
  // forms above).
  return isDangerousHostname(extractHostname("https://" + trimmed));
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

  // IPv6 loopback / link-local. The URL parser canonicalizes these to
  // lower case + collapses zeros, so direct prefix checks suffice.
  if (host === "::1") return true;
  if (host.startsWith("fe80:")) return true;

  // IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`). The URL parser
  // canonicalizes the dotted form to hex pairs (`::ffff:7f00:1` for
  // `::ffff:127.0.0.1`, `::ffff:c0a8:101` for `::ffff:192.168.1.1`), so
  // we MUST unpack the hex form and re-run the full IPv4 ruleset, not
  // just the 127/8 prefix — otherwise a hosted widget could declare a
  // RFC1918 origin via the mapped form and bypass the clamp entirely
  // (the codex P1 finding). The dotted form is also accepted for
  // strings that never round-tripped through `new URL`.
  const mappedDotted = unpackIPv4MappedIPv6(host);
  if (mappedDotted) {
    // Recurse with the unpacked IPv4 — this hits every loopback /
    // RFC1918 / link-local / shared rule above.
    if (isDangerousHostname(mappedDotted)) return true;
  }
  // IPv6 unique local addresses (fc00::/7).
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;

  return false;
}

/**
 * Unpack an IPv4-mapped IPv6 address into its dotted IPv4 form, or
 * return `null` if the input isn't a mapped address. Accepts both:
 *
 *   - The canonical hex form the URL parser produces:
 *     `::ffff:7f00:1` → `127.0.0.1`, `::ffff:c0a8:101` → `192.168.1.1`.
 *   - The dotted form callers may pass directly (rare, but possible if
 *     a string never went through `new URL`):
 *     `::ffff:127.0.0.1` → `127.0.0.1`.
 *
 * The leading `::ffff:` prefix MUST be present; we don't accept
 * compatibility-style mapped addresses (`::a.b.c.d`) — those are a
 * deprecated form per RFC 4291 and the URL parser doesn't produce them.
 */
function unpackIPv4MappedIPv6(host: string): string | null {
  // Dotted form: `::ffff:a.b.c.d`.
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (dotted) return dotted[1];

  // Hex form: `::ffff:HHHH:HHHH` where each HHHH is one 16-bit group.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return [
    (hi >> 8) & 0xff,
    hi & 0xff,
    (lo >> 8) & 0xff,
    lo & 0xff,
  ].join(".");
}
