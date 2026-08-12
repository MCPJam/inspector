/**
 * The one place that knows what a tester link's path looks like.
 *
 * `chatbox` stays the internal code name, but a tester never sees code names:
 * the link they are handed is minted at `/user-testing/<slug>/<token>`, the
 * name the product uses for itself everywhere else on the page.
 *
 * `/chatbox/<slug>/<token>` keeps resolving, and must: links already sent to
 * testers use it, and the Convex public API (`link.url`) plus the invite email
 * still mint it — those live in MCPJam/mcpjam-backend. Both shapes reach the
 * same runtime here, so an old link resolves outright instead of bouncing
 * through a redirect that would drop the token on a stricter referrer policy.
 *
 * The shape is load-bearing past link building: the misrouted-pushState guard
 * in `main.tsx` and `isEmbeddedPreview()` both match on it to exempt the
 * Preview pane's same-origin self-embed, and `ChatboxPreviewPane` matches on
 * it to notice the frame navigating away. They all read from here so a shape
 * change cannot land in one matcher and miss another.
 */

/** Segment new tester links are minted with. */
export const TESTER_LINK_PATH_SEGMENT = "user-testing";

/**
 * Exactly `<segment>/<slug>/<token>`, trailing slash tolerated and nothing
 * else. Deliberately not a `startsWith` — a generic prefix test would let an
 * unrelated future subpath past the iframe guard.
 *
 * `/user-testing/<scenarioId>` (the in-app scenario screen) has two segments,
 * so it cannot match: the third segment is required and cannot be empty.
 */
export const TESTER_LINK_RUNTIME_PATH_PATTERN =
  /^\/(?:user-testing|chatbox)\/[^/]+\/[^/]+\/?$/;

/**
 * Same shape, token captured. Looser than the pattern above on purpose: a
 * pathname carrying `?surface=preview` or a `#slug` bookmark still yields its
 * token.
 */
const TESTER_LINK_TOKEN_PATTERN =
  /^\/(?:user-testing|chatbox)\/[^/?#]+\/([^/?#]+)/;

export function extractTesterLinkToken(pathname: string): string | null {
  const match = pathname.match(TESTER_LINK_TOKEN_PATTERN);
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return match[1].trim() || null;
  }
}
