/** Canonical MCP App sandbox policy, shared by the HTTP host and proxy bundle. */
export interface SandboxCspMeta {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}
export interface SandboxCspSubtypePolicy {
  cspConnectDomains?: { fetch?: boolean; xhr?: boolean; websocket?: boolean };
  cspResourceDomains?: {
    script?: boolean;
    stylesheet?: boolean;
    image?: boolean;
    font?: boolean;
    media?: boolean;
  };
}

/** Serialize internationalized hosts and paths as ASCII before signing or serving CSP. */
export function normalizeSandboxDomainSource(value: string): string {
  const source = value.trim();
  if (!/[^\x20-\x7e]/.test(source)) return source;
  if (/[\s\x00-\x1f\x7f,;'"<>\\]/.test(source)) return source;
  try {
    const scheme = source.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//)?.[0] ?? "";
    const rest = source.slice(scheme.length);
    const end = rest.search(/[/?#]/);
    const authority = end < 0 ? rest : rest.slice(0, end);
    const suffix = end < 0 ? "" : rest.slice(end);
    const port = authority.match(/:(?:\*|[0-9]+)$/)?.[0] ?? "";
    const hostname = port ? authority.slice(0, -port.length) : authority;
    if (hostname.includes(":") && !(hostname.startsWith("[") && hostname.endsWith("]"))) return source;
    const url = new URL(`${scheme || "https://"}${hostname}${port === ":*" ? "" : port}`);
    if (url.username || url.password) return source;
    // Preserve explicit ports and literal dot segments: URL normalization
    // must not change the scope of a declared CSP host or path source.
    return `${scheme}${url.hostname}${port}${suffix.replace(/[^\x00-\x7f]+/g, encodeURIComponent)}`;
  } catch {
    // Invalid declarations remain invalid for the admission validator.
    return source;
  }
}

export function sanitizeDomain(domain: unknown): string {
  if (typeof domain !== "string") return "";
  // Remove characters that could break out of CSP or HTML attributes
  // Valid CSP sources shouldn't contain these characters
  return normalizeSandboxDomainSource(domain.replace(/['"<>;]/g, ""));
}

/**
 * Build CSP string from metadata (SEP-1865)
 *
 * CSP merge rule per directive:
 *   tokens = unique(domain-derived tokens ++ cspDirectives[directive])
 *   if tokens contains anything other than 'none', drop 'none'
 *   emit `<directive> ${tokens.join(" ")}` (or `<directive> 'none'` if
 *   tokens === ['none'])
 *
 * Rationale: `'none' 'self'` is invalid CSP. The domain-derived branch
 * emits 'none' for empty allowlists (frameDomains: [] → frame-src 'none'),
 * and cspDirectives can add real tokens on top. Union-and-drop-'none' is
 * the only sound merge.
 *
 * @param {Object} csp - CSP metadata with connectDomains, resourceDomains, frameDomains, and baseUriDomains
 * @param {Object} cspDirectives - Per-directive source-expression overrides
 *   (inspector-only). Keys are CSP directive names (`script-src`, …);
 *   values are token arrays.
 * @returns {string} CSP policy string
 */
export function buildCSP(
  csp?: SandboxCspMeta | null,
  cspDirectives?: Record<string, string[]>,
  cspSubtypePolicy?: SandboxCspSubtypePolicy,
): string {
  // Merge a single directive's domain-derived tokens with any extra
  // tokens supplied by cspDirectives. See merge rule above the function.
  function mergeDirective(name: string, baseTokens: string[]): string {
    const extras =
      cspDirectives && Array.isArray(cspDirectives[name])
        ? cspDirectives[name]
        : [];
    const merged = new Set<string>();
    for (const t of baseTokens) {
      if (typeof t === "string" && t.length > 0) merged.add(t);
    }
    for (const t of extras) {
      if (typeof t !== "string") continue;
      const trimmed = t.trim();
      if (trimmed.length === 0) continue;
      // Reject CSP directive separators (`;`) and structural chars
      // (`,`, newlines, quote-wrapping whitespace) in extras. The
      // backend canonicalizer is the primary defense, but a crafted
      // cspDirectives value like `"'self'; script-src *"` would
      // otherwise break out of the intended directive and inject
      // an attacker-controlled one when joined with " " below.
      // Same defense-in-depth as the allowFeatures filter applied
      // in sandboxed-iframe.tsx.
      //
      // Also reject HTML-attribute breakouts (`"`, `<`, `>`). The
      // merged CSP string is concatenated into
      // `<meta http-equiv="Content-Security-Policy" content="...">`
      // by injectCSP without escaping, so a token like
      // `'self"><script>...` would close the content attribute and
      // inject markup into the srcdoc before the intended CSP is
      // established. CSP source expressions never legitimately
      // contain these characters.
      if (/[;,\n\r"<>]/.test(trimmed)) continue;
      merged.add(trimmed);
    }
    if (merged.size > 1 && merged.has("'none'")) {
      merged.delete("'none'");
    }
    if (merged.size === 0) return name + " 'none'";
    return name + " " + Array.from(merged).join(" ");
  }

  // Per SEP-1865: If no CSP declared, use restrictive defaults
  // Note: 'self' names this proxy's origin (the view is written into a
  // same-origin frame, see mountInner), which is never where widget
  // assets live — so 'unsafe-inline' carries scripts/styles, since all
  // widget code is inline.
  let directives: string[];
  if (!csp) {
    // Two baselines for the no-csp branch:
    //   - When cspDirectives is set, the profile is modeling a host
    //     whose emitted CSP is unconstrained EXCEPT for the
    //     directives it explicitly lists. For directives IN
    //     cspDirectives, the profile is authoritative (REPLACE the
    //     baseline — otherwise a permissive base like `https:` would
    //     dilute a restrictive entry like
    //     `frame-src "https://widgets.example.com"` back to "any
    //     HTTPS frame"). For directives NOT in cspDirectives, use
    //     specific permissive baselines (no `*`) so widgets without
    //     their own `_meta.ui.csp` can still execute inline scripts,
    //     load images, fetch over HTTPS, etc.
    //   - Otherwise (pure no-csp, no overrides), restrictive
    //     defaults for SEP-1865 secure-default behavior.
    // A cspDirectives entry only counts as "configured" if it
    // contributes at least one token that would survive
    // mergeDirective's trim/filter pass — otherwise the no-op
    // entry (empty array, whitespace-only string, or a token
    // rejected by the `;,\n\r` injection guard) flips every
    // OTHER directive's baseline from secure-default to broad
    // permissive while the named directive contributes nothing.
    // Mirrors the filter applied below at the actual emit site.
    const cspDirectiveTokenSurvives = (t: unknown) => {
      if (typeof t !== "string") return false;
      const trimmed = t.trim();
      if (trimmed.length === 0) return false;
      // Keep this in lockstep with mergeDirective's filter above.
      // Any character class it rejects must be rejected here too,
      // or the predicate flips hasCspOverrides for an entry that
      // ultimately contributes zero tokens — widening every
      // unrelated directive's baseline for nothing.
      if (/[;,\n\r"<>]/.test(trimmed)) return false;
      return true;
    };
    const hasCspOverrides =
      cspDirectives &&
      typeof cspDirectives === "object" &&
      Object.values(cspDirectives).some(
        (tokens) =>
          Array.isArray(tokens) && tokens.some(cspDirectiveTokenSurvives),
      );
    if (hasCspOverrides) {
      // Helper: if cspDirectives names this directive, emit ONLY
      // the profile's tokens (REPLACE). Otherwise emit the
      // permissive default tokens (browser-default-like for an
      // unconstrained host).
      const emitOverridable = (name: string, permissiveBase: string[]) => {
        const hasOverride =
          Array.isArray(cspDirectives?.[name]) &&
          cspDirectives[name].length > 0;
        return mergeDirective(name, hasOverride ? [] : permissiveBase);
      };
      directives = [
        emitOverridable("default-src", [
          "'unsafe-inline'",
          "'unsafe-eval'",
          "data:",
          "blob:",
          "https:",
        ]),
        emitOverridable("script-src", [
          "'unsafe-inline'",
          "'unsafe-eval'",
          "data:",
          "blob:",
          "https:",
        ]),
        emitOverridable("style-src", [
          "'unsafe-inline'",
          "data:",
          "blob:",
          "https:",
        ]),
        emitOverridable("img-src", ["data:", "blob:", "https:"]),
        emitOverridable("font-src", ["data:", "blob:", "https:"]),
        emitOverridable("media-src", ["data:", "blob:", "https:"]),
        emitOverridable("connect-src", [
          "data:",
          "blob:",
          "https:",
          "wss:",
        ]),
        emitOverridable("frame-src", ["data:", "blob:", "https:"]),
        emitOverridable("object-src", ["'none'"]),
        emitOverridable("base-uri", ["'self'"]),
      ];
    } else {
      directives = [
        mergeDirective("default-src", ["'none'"]),
        mergeDirective("script-src", ["'unsafe-inline'"]),
        mergeDirective("style-src", ["'unsafe-inline'"]),
        mergeDirective("img-src", ["data:"]),
        mergeDirective("font-src", ["data:"]),
        mergeDirective("media-src", ["data:"]),
        mergeDirective("connect-src", ["'none'"]),
        mergeDirective("frame-src", ["'none'"]),
        mergeDirective("object-src", ["'none'"]),
        mergeDirective("base-uri", ["'none'"]),
      ];
    }
  } else {
    // Build CSP from declared domains (SEP-1865)
    // Per spec: "Host MAY further restrict but MUST NOT allow undeclared domains"
    const connectDomains = (csp.connectDomains || [])
      .map(sanitizeDomain)
      .filter(Boolean);
    const resourceDomains = (csp.resourceDomains || [])
      .map(sanitizeDomain)
      .filter(Boolean);
    const frameDomains = (csp.frameDomains || [])
      .map(sanitizeDomain)
      .filter(Boolean);
    const baseUriDomains = (csp.baseUriDomains || [])
      .map(sanitizeDomain)
      .filter(Boolean);

    const connectSubtypePolicy =
      cspSubtypePolicy && cspSubtypePolicy.cspConnectDomains;
    const keepDeclaredConnectDomains =
      !connectSubtypePolicy ||
      (["fetch", "xhr", "websocket"] as const).some(
        (subtype) => connectSubtypePolicy[subtype] !== false,
      );

    // Keep the shared connect-src declaration whenever at least one API
    // is supported or unknown. API-specific false values are enforced by
    // the early guards below because CSP cannot split these APIs.
    const connectTokens =
      keepDeclaredConnectDomains && connectDomains.length > 0
        ? connectDomains.slice()
        : ["'none'"];

    // Resource sources: data: and blob: are always allowed for inline content
    // Only add declared resourceDomains - no forced CDNs per SEP-1865
    const resourceTokens = (subtype: keyof NonNullable<SandboxCspSubtypePolicy["cspResourceDomains"]>) =>
      cspSubtypePolicy &&
      cspSubtypePolicy.cspResourceDomains &&
      cspSubtypePolicy.cspResourceDomains[subtype] === false
        ? ["data:", "blob:"]
        : resourceDomains.length > 0
        ? ["data:", "blob:", ...resourceDomains]
        : ["data:", "blob:"];

    // frame-src: Only allow declared frame domains, or 'none' if empty
    const frameTokens =
      frameDomains.length > 0 ? frameDomains.slice() : ["'none'"];

    // base-uri: Only allow declared base URI domains, or 'none' if empty
    const baseUriTokens =
      baseUriDomains.length > 0 ? baseUriDomains.slice() : ["'none'"];

    directives = [
      mergeDirective("default-src", ["'none'"]),
      mergeDirective("script-src", [
        "'unsafe-inline'",
        ...resourceTokens("script"),
      ]),
      mergeDirective("style-src", [
        "'unsafe-inline'",
        ...resourceTokens("stylesheet"),
      ]),
      mergeDirective("img-src", resourceTokens("image")),
      mergeDirective("font-src", resourceTokens("font")),
      mergeDirective("media-src", resourceTokens("media")),
      mergeDirective("connect-src", connectTokens),
      mergeDirective("frame-src", frameTokens),
      mergeDirective("object-src", ["'none'"]),
      mergeDirective("base-uri", baseUriTokens),
    ];
  }

  // If cspDirectives names a directive we didn't emit above (e.g.
  // `form-action`, `worker-src`), append it verbatim so inspector
  // probes that capture additional directives round-trip end-to-end.
  // Runs in both the !csp and truthy-csp branches: a host that
  // declares no CSP metadata but supplies inspector-only directive
  // overrides (the documented `form-action` round-trip case) still
  // gets them appended.
  if (cspDirectives && typeof cspDirectives === "object") {
    const known = new Set([
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "font-src",
      "media-src",
      "connect-src",
      "frame-src",
      "object-src",
      "base-uri",
    ]);
    for (const k of Object.keys(cspDirectives).sort()) {
      if (known.has(k)) continue;
      // Reject CSP separators in the directive NAME too — `k` is
      // concatenated into the output via `name + " " + tokens`, so
      // a crafted key like `worker-src *; script-src` would inject
      // a second directive even if every value token is clean.
      // Also reject HTML-attribute breakouts (`"`, `<`, `>`) for
      // the same reason as in mergeDirective: the directive name
      // flows into the unescaped `content="..."` attribute of the
      // injected <meta> tag, and a crafted key like `x"><script>`
      // would otherwise close the attribute and inject markup.
      if (/[;,\n\r\s"<>]/.test(k)) continue;
      const tokens = cspDirectives[k];
      if (!Array.isArray(tokens) || tokens.length === 0) continue;
      directives.push(mergeDirective(k, []));
    }
  }

  return directives.join("; ");
}

export const PERMISSIVE_SANDBOX_CSP = [
  "default-src * 'unsafe-inline' 'unsafe-eval' data: blob: filesystem: about:",
  "script-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src * 'unsafe-inline' data: blob:", "img-src * data: blob: https: http:",
  "media-src * data: blob: https: http:", "font-src * data: blob: https: http:",
  "connect-src * data: blob: https: http: ws: wss: about:",
  "frame-src * data: blob: https: http: about:", "object-src * data: blob:",
  "base-uri *", "form-action *",
].join("; ");
