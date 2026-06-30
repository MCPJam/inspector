// When a brand-new user signs up from an organization invite email, that email
// links to `/?invite_org={orgId}`. We capture the id at boot — before the WorkOS
// auth redirect can drop the URL — stash it, and apply it as the active org once
// the user is authenticated and actually a member of it (see use-app-state).

const INVITE_ORG_PARAM = "invite_org";
const PENDING_INVITE_ORG_STORAGE_KEY = "mcpjam:pending-invite-org";

// Read `?invite_org=` from the current URL, stash it, and strip it from the URL
// so it does not linger or get re-applied. Safe to call once at app boot.
export function capturePendingInviteOrgFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    const inviteOrgId = url.searchParams.get(INVITE_ORG_PARAM);
    if (!inviteOrgId) return;
    localStorage.setItem(PENDING_INVITE_ORG_STORAGE_KEY, inviteOrgId);
    url.searchParams.delete(INVITE_ORG_PARAM);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  } catch {
    // Malformed URL or unavailable storage — nothing to capture.
  }
}

export function readPendingInviteOrgId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(PENDING_INVITE_ORG_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearPendingInviteOrgId(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(PENDING_INVITE_ORG_STORAGE_KEY);
  } catch {
    // Storage unavailable — leave it; the apply step is idempotent.
  }
}
