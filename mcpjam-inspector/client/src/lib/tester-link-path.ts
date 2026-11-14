/**
 * The one place that knows what a tester link's path looks like.
 *
 * `scenario` is the internal name for the row, but a tester never sees code
 * names: the link they are handed is minted at `/user-testing/<slug>/<token>`,
 * the name the product uses for itself everywhere else on the page.
 *
 * There is exactly ONE shape now. The old `/chatbox/<slug>/<token>` alternative
 * is gone, along with the last thing that minted it — the Convex public API
 * (`link.url`) and the invite email were still handing out the old shape while
 * this app minted the new one, and both now agree on `/user-testing`. Links
 * issued before that are dead; the surface is pre-GA and behind a flag, so
 * re-sharing is the cost.
 *
 * The shape is load-bearing past link building: the misrouted-pushState guard
 * in `main.tsx` and `isEmbeddedPreview()` both match on it to exempt the
 * Preview pane's same-origin self-embed, and `ScenarioPreviewPane` matches on
 * it to notice the frame navigating away. They all read from here so a shape
 * change cannot land in one matcher and miss another.
 */

import {
  CREDENTIAL_PLACEHOLDER,
  credentialRoute,
  escapeRegex,
} from "@/shared/credential-urls";

/**
 * The tester-link route as the credential registry
 * (`shared/credential-urls.ts`) declares it: `/user-testing/:slug/:token`,
 * with `edit` reserved. Read from there so the runtime's matchers and every
 * telemetry scrubber agree on which segment is the secret — a shape change
 * made there lands here too, instead of in one of two lists.
 */
const TESTER_LINK_ROUTE = credentialRoute("tester-link");

/** Segment new tester links are minted with. */
export const TESTER_LINK_PATH_SEGMENT =
  TESTER_LINK_ROUTE.pattern.split("/")[1] ?? "user-testing";

/**
 * Third segments that belong to the SIGNED-IN app, not to a tester link.
 *
 * `/user-testing/<scenarioId>/edit` is the scenario's setup screen, and it has
 * the same three-segment shape as a tester link — so without this exclusion the
 * token matcher below reads `edit` as a share token, `App` mounts the public
 * runtime instead of the app shell, and redeeming fails with "Link
 * Unavailable". That is what made the header's Edit button look dead.
 *
 * Reserving the word costs nothing: tokens are minted random ids, never `edit`.
 * The registry's `reserved` list is the source; only its first entry is
 * reserved here, as before.
 */
const RESERVED_APP_SUBPATH = TESTER_LINK_ROUTE.reserved?.[0] ?? "edit";

const SEGMENT = escapeRegex(TESTER_LINK_PATH_SEGMENT);
const RESERVED = escapeRegex(RESERVED_APP_SUBPATH);

/**
 * Exactly `<segment>/<slug>/<token>`, trailing slash tolerated and nothing
 * else. Deliberately not a `startsWith` — a generic prefix test would let an
 * unrelated future subpath past the iframe guard. (Stricter than the
 * registry's own matcher, which matches a prefix because a scrubber must catch
 * a secret wherever it sits.)
 *
 * `/user-testing/<scenarioId>` (the in-app scenario screen) has two segments,
 * so it cannot match: the third segment is required and cannot be empty. Its
 * `/edit` sibling DOES have three, so it is excluded by name.
 */
export const TESTER_LINK_RUNTIME_PATH_PATTERN = new RegExp(
  `^/${SEGMENT}/[^/]+/(?!${RESERVED}/?$)[^/]+/?$`,
);

/**
 * Same shape, token captured. Looser than the pattern above on purpose: a
 * pathname carrying `?surface=preview` or a `#slug` bookmark still yields its
 * token — while still refusing the reserved app sub-path.
 */
const TESTER_LINK_TOKEN_PATTERN = new RegExp(
  `^/${SEGMENT}/[^/?#]+/(?!${RESERVED}(?:[/?#]|$))([^/?#]+)`,
);

/**
 * Whether a token read from the path is the registry's placeholder rather
 * than a credential — what `redactTesterLinkPath` leaves behind after a
 * redeem fails.
 */
export function isRedactedTesterLinkToken(
  token: string | null | undefined,
): boolean {
  return token === CREDENTIAL_PLACEHOLDER;
}

/**
 * The tester-link pathname with its token replaced by the registry's
 * placeholder (`/user-testing/<slug>/[redacted]`), or `null` when the
 * pathname is not a tester link.
 *
 * WHY A PLACEHOLDER AND NOT A REAL PATH. A redeem that fails leaves the error
 * screen up, and `App` decides to keep rendering the public runtime from the
 * address bar alone (a token in the path, or a redeemed session — and a
 * failed redeem has none). Every real path drops that: `/user-testing/<slug>`
 * is the signed-in scenario screen, `/` is the app shell. The placeholder keeps
 * the link's SHAPE, so `App`, the iframe guard and `isEmbeddedPreview()` all
 * still see a tester link, while the registry's matchers treat the placeholder
 * as no secret at all. The runtime reads it as "the token this page already
 * holds in memory" (`ScenarioChatPage`).
 */
export function redactTesterLinkPath(pathname: string): string | null {
  const match = TESTER_LINK_TOKEN_PATTERN.exec(pathname);
  if (!match || !match[1]) return null;
  const tokenEnd = match.index + match[0].length;
  const tokenStart = tokenEnd - match[1].length;
  return `${pathname.slice(0, tokenStart)}${CREDENTIAL_PLACEHOLDER}${pathname.slice(tokenEnd)}`;
}

export function extractTesterLinkToken(pathname: string): string | null {
  const match = pathname.match(TESTER_LINK_TOKEN_PATTERN);
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return match[1].trim() || null;
  }
}
