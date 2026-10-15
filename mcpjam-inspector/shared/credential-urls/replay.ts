/**
 * Replay gating: whether a page may be recorded at all, and the selectors
 * that block an element whose URL attribute carries a credential.
 */
import { SECRET_PARAM_KEYS } from "./registry.ts";
import {
  CALLBACK_ROUTES,
  matchCallbackPath,
  matchCredentialPath,
  PATH_ROUTES,
} from "./matching.ts";
import { hasSecretKey, scrubCredentialsInText, splitUrl } from "./scrub.ts";

export interface LocationLike {
  pathname: string;
  search?: string;
  hash?: string;
}

/**
 * Whether a page must not be recorded at all, by any recorder, at any
 * privacy level: a registered credential path, a callback route, or any
 * secret query or fragment key on any path. A recorder snapshots the address
 * bar, the DOM that renders the secret, and the network requests that send
 * it; scrubbing those afterwards is not a guarantee, not recording is.
 */
export function isReplayBlockedLocation(location: LocationLike): boolean {
  try {
    const pathname = location.pathname ?? "";
    if (matchCredentialPath(pathname)) return true;
    if (matchCallbackPath(pathname)) return true;
    if (location.search && hasSecretKey(location.search)) return true;
    // A credential nested in a parameter's value (`?redirect=<callback url>`).
    const tail = `${location.search ?? ""}${location.hash ?? ""}`;
    if (tail && scrubCredentialsInText(tail) !== tail) return true;
    const hash = location.hash ?? "";
    if (hash.length > 1) {
      const body = hash.slice(1);
      if (body.startsWith("/")) {
        const end = body.search(/[?#]/);
        const path = end === -1 ? body : body.slice(0, end);
        if (matchCredentialPath(path) || matchCallbackPath(path)) return true;
        if (end !== -1 && hasSecretKey(body.slice(end))) return true;
      } else if (body.includes("=") && hasSecretKey(body)) {
        return true;
      }
    }
    return false;
  } catch {
    // Cannot tell: do not record.
    return true;
  }
}

/**
 * A value for a quoted CSS attribute selector. Anything outside a safe set is
 * written as a hex escape (`&` → `\26 `): `"` and `\` must be, and some
 * selector engines (jsdom's, at least) mis-parse a literal `&` inside the
 * quotes as the nesting selector.
 */
function cssStringEscape(value: string): string {
  return value.replace(
    /[^A-Za-z0-9_\-/.?=#;:]/g,
    (char) => `\\${char.charCodeAt(0).toString(16)} `,
  );
}

/**
 * CSS selectors for elements whose URL attributes carry a credential: a link
 * to a share page, an iframe on a tester link, a form posting a code. For a
 * recorder that offers no attribute hook for URL attributes (Sentry Replay's
 * rrweb serializes `href`/`src` without consulting its masking), blocking the
 * element is the only way to keep the value out. Case-insensitive, and
 * deliberately broad: blocking a harmless link costs a grey box in a replay.
 */
export function credentialAttributeSelectors(
  attributes: readonly string[] = ["href", "src", "srcset", "action", "data"],
): string[] {
  const needles = new Set<string>();
  for (const compiled of PATH_ROUTES) {
    if (compiled.staticPrefix.length > 1) needles.add(compiled.staticPrefix);
  }
  for (const compiled of CALLBACK_ROUTES) {
    const path = compiled.route.pattern.replace(/\*$/, "");
    needles.add(`${path}?`);
  }
  for (const key of SECRET_PARAM_KEYS) {
    for (const lead of ["?", "&", "#", ";"]) needles.add(`${lead}${key}=`);
  }
  for (const family of ["x-amz-", "x-goog-"]) {
    for (const lead of ["?", "&"]) needles.add(`${lead}${family}`);
  }
  const selectors: string[] = [];
  for (const attribute of attributes) {
    for (const needle of needles) {
      selectors.push(`[${attribute}*="${cssStringEscape(needle)}" i]`);
    }
  }
  return selectors;
}

/** `isReplayBlockedLocation` for a full or relative URL string. */
export function isReplayBlockedUrl(url: string): boolean {
  try {
    const { path, query, fragment } = splitUrl(url);
    return isReplayBlockedLocation({
      pathname: path || "/",
      search: query ? `?${query}` : "",
      hash: fragment ? `#${fragment}` : "",
    });
  } catch {
    return true;
  }
}
