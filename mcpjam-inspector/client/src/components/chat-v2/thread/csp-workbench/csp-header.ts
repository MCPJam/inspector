/**
 * csp-header.ts — parse the policy the proxy actually applied.
 *
 * The host learns the real policy exactly once per mount, as the opaque string
 * carried by `mcpjam:csp-applied`. Everything downstream (the classifier, the
 * Policy Diff columns) wants structure, so the string is parsed HERE, once, and
 * the resulting map is passed around. Re-parsing per directive would invite the
 * two consumers to disagree about what the same header says.
 *
 * Why the map travels alongside the four flattened arrays: `default-src` is a
 * real fallback. Flattening to `connectDomains` / `resourceDomains` /
 * `frameDomains` / `baseUriDomains` cannot express "this directive is absent,
 * so `default-src` governs it" — and in permissive mode, where `default-src *`
 * is doing real work, that lost fallback would reproduce the very
 * effective-says-blocked / browser-says-allowed mismatch this panel was built
 * to explain, just from the other direction.
 */

export type CspDirectiveMap = Record<string, string[]>;

export interface CspPolicyComparison {
  status: "matching" | "different" | "unavailable";
  differingDirectives: string[];
}

/** Directives whose sources the workbench folds into one "resource" column. */
const RESOURCE_DIRECTIVES = [
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "media-src",
] as const;

/**
 * Parse a `Content-Security-Policy` value into `{ directive: sources[] }`.
 *
 * Per CSP Level 3 §2.2, a directive repeated within one policy is honoured on
 * its FIRST occurrence and every later copy is ignored; we mirror that so the
 * map says what the browser does. Directive names are lower-cased (they are
 * ASCII case-insensitive); source expressions keep their original case, since
 * host matching is case-folded downstream but nonces and hashes are not.
 */
export function parseCspHeader(header: string): CspDirectiveMap {
  const map: CspDirectiveMap = {};
  if (typeof header !== "string") return map;

  for (const segment of header.split(";")) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const name = tokens[0].toLowerCase();
    // First occurrence wins.
    if (Object.hasOwn(map, name)) continue;
    map[name] = tokens.slice(1);
  }
  return map;
}

/**
 * Compare policy semantics rather than serialization. Directive order,
 * whitespace, duplicate sources, and source order do not change a policy.
 */
export function compareCspPolicies(
  appliedPolicy: string | undefined,
  violationPolicy: string | undefined,
): CspPolicyComparison {
  if (!appliedPolicy || !violationPolicy) {
    return { status: "unavailable", differingDirectives: [] };
  }

  const applied = parseCspHeader(appliedPolicy);
  const violation = parseCspHeader(violationPolicy);
  const directives = Array.from(
    new Set([...Object.keys(applied), ...Object.keys(violation)]),
  ).sort();
  const differingDirectives = directives.filter((directive) => {
    const left = Array.from(new Set(applied[directive] ?? [])).sort();
    const right = Array.from(new Set(violation[directive] ?? [])).sort();
    return (
      left.length !== right.length ||
      left.some((value, i) => value !== right[i])
    );
  });

  return {
    status: differingDirectives.length === 0 ? "matching" : "different",
    differingDirectives,
  };
}

/**
 * Sources governing `directive`, falling back to `default-src` when the
 * directive is absent — the fetch-directive fallback of CSP Level 3 §6.1.
 *
 * Returns `undefined` when neither is present, which the classifier reads as
 * "no opinion" rather than "empty allowlist".
 */
export function resolveDirective(
  map: CspDirectiveMap,
  directive: string,
): string[] | undefined {
  const own = map[directive.toLowerCase()];
  if (own) return own;
  return map["default-src"];
}

/**
 * Flatten a parsed policy into the four arrays `ClassifierInput.effective`
 * exposes. Lossy by construction (see the module note) — always carried
 * together with the map it came from.
 */
export function effectiveFromCspHeader(map: CspDirectiveMap): {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
} {
  const resource: string[] = [];
  for (const directive of RESOURCE_DIRECTIVES) {
    for (const source of resolveDirective(map, directive) ?? []) {
      if (!resource.includes(source)) resource.push(source);
    }
  }

  return {
    connectDomains: resolveDirective(map, "connect-src") ?? [],
    resourceDomains: resource,
    frameDomains: resolveDirective(map, "frame-src") ?? [],
    baseUriDomains: resolveDirective(map, "base-uri") ?? [],
  };
}
