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

/** Segment new tester links are minted with. */
export const TESTER_LINK_PATH_SEGMENT = "user-testing";

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
 */
const RESERVED_APP_SUBPATH = "edit";

/**
 * Exactly `<segment>/<slug>/<token>`, trailing slash tolerated and nothing
 * else. Deliberately not a `startsWith` — a generic prefix test would let an
 * unrelated future subpath past the iframe guard.
 *
 * `/user-testing/<scenarioId>` (the in-app scenario screen) has two segments,
 * so it cannot match: the third segment is required and cannot be empty. Its
 * `/edit` sibling DOES have three, so it is excluded by name.
 */
export const TESTER_LINK_RUNTIME_PATH_PATTERN = new RegExp(
  `^/${TESTER_LINK_PATH_SEGMENT}/[^/]+/(?!${RESERVED_APP_SUBPATH}/?$)[^/]+/?$`
);

/**
 * Same shape, token captured. Looser than the pattern above on purpose: a
 * pathname carrying `?surface=preview` or a `#slug` bookmark still yields its
 * token — while still refusing the reserved app sub-path.
 */
const TESTER_LINK_TOKEN_PATTERN = new RegExp(
  `^/${TESTER_LINK_PATH_SEGMENT}/[^/?#]+/(?!${RESERVED_APP_SUBPATH}(?:[/?#]|$))([^/?#]+)`
);

export function extractTesterLinkToken(pathname: string): string | null {
  const match = pathname.match(TESTER_LINK_TOKEN_PATTERN);
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return match[1].trim() || null;
  }
}
