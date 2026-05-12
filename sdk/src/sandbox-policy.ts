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
  // Step 2 — apply mode.
  let afterMode: Record<string, boolean>;
  switch (effectiveMode) {
    case "resource-declared":
      afterMode = { ...declared };
      break;
    case "deny-all":
      afterMode = {};
      break;
    case "custom": {
      // `allow` is the candidate set; resource declaration acts as the
      // ceiling (host can never grant a permission the resource didn't
      // request).
      afterMode = {};
      const allow = args.policy?.allow ?? {};
      for (const [name, granted] of Object.entries(allow)) {
        if (granted && declared[name]) {
          afterMode[name] = true;
        }
      }
      break;
    }
  }

  // Step 3 — subtract profile deny.
  const deniedByProfile: string[] = [];
  if (args.policy?.deny && args.policy.deny.length > 0) {
    for (const name of args.policy.deny) {
      if (afterMode[name]) {
        deniedByProfile.push(name);
        delete afterMode[name];
      }
    }
  }

  // Step 4 — hosted-mode clamp.
  const hostedClampDeny = args.hostedClampDeny ?? DEFAULT_HOSTED_PERMISSION_CLAMP_DENY;
  const deniedByHostedClamp: string[] = [];
  if (args.hostedMode) {
    for (const name of hostedClampDeny) {
      if (afterMode[name]) {
        deniedByHostedClamp.push(name);
        delete afterMode[name];
      }
    }
  }

  return {
    granted: afterMode,
    trace: {
      declared,
      afterMode,
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
 *   - Bare wildcards (`*`, `https:`, `http:`).
 *   - Localhost / loopback / private-network domains.
 *   - Unsafe schemes (`javascript:`, `vbscript:`).
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
  // Bare wildcards.
  if (domain === "*") return true;
  if (domain === "https:" || domain === "http:" || domain === "ws:" || domain === "wss:") return true;
  if (domain.startsWith("https://*") && !domain.includes(".")) return true;

  // Unsafe schemes (CSP source expressions).
  if (
    domain.startsWith("javascript:") ||
    domain.startsWith("vbscript:") ||
    domain.startsWith("file:")
  ) {
    return true;
  }

  // Localhost / loopback / private-network ranges.
  if (
    /^https?:\/\/localhost(:|$|\/)/i.test(domain) ||
    /^https?:\/\/127\./i.test(domain) ||
    /^https?:\/\/10\./i.test(domain) ||
    /^https?:\/\/192\.168\./i.test(domain) ||
    /^https?:\/\/172\.(1[6-9]|2[0-9]|3[01])\./i.test(domain) ||
    /^https?:\/\/0\.0\.0\.0/i.test(domain) ||
    /^https?:\/\/\[::1\]/i.test(domain) ||
    /^https?:\/\/\[fe80::/i.test(domain)
  ) {
    return true;
  }

  return false;
}
