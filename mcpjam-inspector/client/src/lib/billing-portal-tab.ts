/**
 * Billing links open in a new tab so the app keeps its live state. The tab is
 * reserved during the click, before the portal URL request, so popup blockers
 * treat it as user initiated.
 */
export function reserveBillingTab(): Window | null {
  // Electron rejects blank popup reservations in its main-process window
  // handler. The eventual Stripe URL is opened through the desktop bridge
  // instead, after the async request returns.
  if (window.isElectron) return null;
  const reserved = window.open("", "_blank");
  if (reserved) reserved.opener = null;
  return reserved;
}

/** Returns false when the browser blocked the reserved tab. */
export async function openBillingUrlInNewTab(
  url: string,
  reservedTab: Window | null,
): Promise<boolean> {
  if (window.isElectron) {
    if (window.electronAPI?.app?.openExternal) {
      await window.electronAPI.app.openExternal(url);
    } else {
      // Older desktop builds do not expose the bridge, but their
      // main-process window handler still opens safe HTTP(S) URLs in the
      // system browser.
      window.open(url, "_blank", "noopener,noreferrer");
    }
    return true;
  }

  if (!reservedTab) return false;
  reservedTab.location.href = url;
  return true;
}
