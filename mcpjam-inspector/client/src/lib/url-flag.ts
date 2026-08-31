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
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${remaining ? `?${remaining}` : ""}`,
  );
  return true;
}
