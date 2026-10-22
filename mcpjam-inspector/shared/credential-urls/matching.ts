/**
 * Route matching: the registry's templates compiled to anchored, case- and
 * escape-insensitive regexes, and the lookups built on them.
 */
import {
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_ROUTES,
  type CredentialRoute,
  type CredentialRouteId,
} from "./registry.ts";

export interface CompiledRoute {
  route: CredentialRoute;
  /** Anchored at the start of a pathname. */
  anchored: RegExp;
  /** 1-based group of the secret segment, for `path` routes. */
  segmentGroup: number;
  /** The literal path before the first parameter. */
  staticPrefix: string;
  /** Segment names, in order, for `path` routes. */
  paramNames: string[];
}

/**
 * A path segment. Never one that starts with `:` — that is a route template's
 * parameter (`/results/:runToken`), not a value, and templates are exactly
 * what the scrubbers replace secrets WITH.
 */
const SEGMENT = "((?!:)[^/?#]+)";

/** A string as a literal inside a regular expression. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** `r` → `%72`. Hex digits' case is covered by the regex's `i` flag. */
function percentEncoding(char: string): string {
  return `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
}

/**
 * A route's static segment as the router matches it: case-insensitively
 * (compiled with the `i` flag) and with any character percent-encoded
 * (`/%72esults/…` is `/results/…` to React Router, so it must be to the
 * scrubber too). The `i` flag folds a literal letter's case but not an
 * escape's: `%52` (`R`) and `%72` (`r`) are different text, so a letter
 * accepts the escape of either case (`/%52esults/…`).
 */
export function literalSegment(segment: string): string {
  return [...segment]
    .map((char) => {
      const escapes = new Set(
        [char.toLowerCase(), char.toUpperCase()].map(percentEncoding),
      );
      return `(?:${[escapeRegex(char), ...escapes].join("|")})`;
    })
    .join("");
}

function compileRoute(route: CredentialRoute): CompiledRoute {
  const splat = route.pattern.endsWith("*");
  const body = splat ? route.pattern.slice(0, -1) : route.pattern;
  const paramNames: string[] = [];
  const source = body
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return SEGMENT;
      }
      return literalSegment(segment);
    })
    .join("/");
  const tail = splat ? "" : "(?=/|$)";
  const firstParam = body.indexOf(":");
  return {
    route,
    anchored: new RegExp(`^${source}${tail}`, "i"),
    segmentGroup:
      route.secretIn === "path" ? paramNames.indexOf(route.secretParam) + 1 : 0,
    staticPrefix: firstParam === -1 ? body : body.slice(0, firstParam),
    paramNames,
  };
}

const COMPILED_ROUTES: readonly CompiledRoute[] = (
  CREDENTIAL_ROUTES as readonly CredentialRoute[]
).map(compileRoute);

export const PATH_ROUTES = COMPILED_ROUTES.filter(
  (compiled) => compiled.route.secretIn === "path",
);

/** Query-secret routes with a concrete path: the callbacks. */
export const CALLBACK_ROUTES = COMPILED_ROUTES.filter(
  (compiled) =>
    compiled.route.secretIn === "query" &&
    compiled.route.scope === "page" &&
    compiled.route.pattern !== "/*",
);

export interface CredentialRouteMatch {
  route: CredentialRoute;
  /** Every `:param` in the template, decoded where possible. */
  params: Record<string, string>;
  /**
   * The raw (undecoded) text of the segment that holds the secret, for `path`
   * routes. Named for what it is — a segment of the URL — not what it guards.
   */
  segment?: string;
  /** Index range of that segment within the pathname. */
  segmentStart?: number;
  segmentEnd?: number;
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The path-secret route a pathname belongs to, if any. A reserved value in
 * the secret segment (`edit`, `request`) is not a match.
 */
export function matchCredentialPath(
  pathname: string,
): CredentialRouteMatch | null {
  for (const compiled of PATH_ROUTES) {
    const match = compiled.anchored.exec(pathname);
    if (!match) continue;
    const segment = match[compiled.segmentGroup];
    if (segment === undefined) continue;
    const reserved = compiled.route.reserved;
    if (reserved?.includes(safeDecode(segment).toLowerCase())) continue;
    if (safeDecode(segment) === CREDENTIAL_PLACEHOLDER) continue;
    const params: Record<string, string> = {};
    compiled.paramNames.forEach((name, index) => {
      params[name] = safeDecode(match[index + 1] ?? "");
    });
    // The secret segment is the template's last, so it ends where the match
    // ends.
    const segmentEnd = match[0].length;
    return {
      route: compiled.route,
      params,
      segment,
      segmentStart: segmentEnd - segment.length,
      segmentEnd,
    };
  }
  return null;
}

export function matchCallbackPath(pathname: string): CredentialRoute | null {
  for (const compiled of CALLBACK_ROUTES) {
    if (compiled.anchored.test(pathname)) return compiled.route;
  }
  return null;
}

/** A registered route by id. */
export function credentialRoute(id: CredentialRouteId): CredentialRoute {
  const route = (CREDENTIAL_ROUTES as readonly CredentialRoute[]).find(
    (entry) => entry.id === id,
  );
  if (!route) throw new Error(`unknown credential route ${id}`);
  return route;
}

/**
 * The template a credential pathname belongs to (`/results/:runToken`), or
 * `null` when the pathname carries no path secret. Sentry transaction names
 * and log lines use it so the secret never becomes a name.
 */
export function credentialRouteTemplate(pathname: string): string | null {
  const match = matchCredentialPath(pathname);
  if (match) return match.route.pattern;
  return null;
}
