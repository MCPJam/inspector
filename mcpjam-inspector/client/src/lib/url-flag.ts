/**
 * Pulls a one-shot redirect flag out of the current URL and clears it, so a
 * reload doesn't replay whatever the flag triggered.
 *
 * The router strips `?...` before resolving the route, so these flags are
 * invisible to navigation and visible only to the page that reads them here.
 */
export function consumeUrlFlag(name: string, value: string): boolean {
  if (typeof window === "undefined") return false;

  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.get(name) !== value) return false;

  searchParams.delete(name);
  const remaining = searchParams.toString();
  // Only the flag comes off. Rebuilding from `pathname + search` alone would
  // also drop the `#hash` and blank the router's own history state, so reading
  // a flag would cost the reader their anchor and their Back button.
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${remaining ? `?${remaining}` : ""}${window.location.hash}`,
  );
  return true;
}
