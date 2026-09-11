/**
 * "Sign up, then open the invite dialog when I land back."
 *
 * A hosted guest can click "Invite team members" in the sidebar. The click
 * cannot open ShareProjectDialog — a guest has no WorkOS user, no
 * organization, and no shared project for it to manage — so it opens a
 * sign-up nudge instead. That nudge's buttons start WorkOS sign-in/sign-up,
 * which is a FULL-PAGE navigation: the app reloads, React state is gone, and
 * the dialog the guest asked for would stay closed.
 *
 * This marker is how the request survives the round trip. The nudge writes it
 * immediately before `signIn()`/`signUp()` (anything scheduled instead of
 * executed is lost with the page); the sidebar consumes it once Convex auth,
 * the WorkOS user, and an active project have all resolved, then opens the
 * invite dialog — the modal the guest was reaching for when they left.
 *
 * The marker never crosses the network (only the sign-in return path decides
 * WHERE they land; this decides what OPENS there), so it needs no nonce and
 * no origin check — but it still follows the stored-redirect defenses:
 *   - it carries no payload beyond "an invite dialog was requested";
 *   - it is consumed exactly once — read and clear together;
 *   - it expires, so a tab where the guest abandoned sign-up cannot have a
 *     later, unrelated sign-in pop the invite dialog under them.
 */
const PENDING_INVITE_DIALOG_STORAGE_KEY = "mcpjam:pending-invite-dialog-v1";

/**
 * As long as the sign-in return paths give a WorkOS round trip (30 minutes —
 * an SSO hop, MFA, a password-reset detour all fit). sessionStorage already
 * bounds it to the tab the flow started in, which is the only tab that can
 * complete it.
 */
export const PENDING_INVITE_DIALOG_TTL_MS = 30 * 60 * 1000;

interface StoredPendingInvite {
  storedAt: number;
}

function readPendingInviteDialog(
  now: number = Date.now(),
): StoredPendingInvite | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(PENDING_INVITE_DIALOG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPendingInvite> | null;
    if (!parsed || typeof parsed.storedAt !== "number") return null;
    if (
      now - parsed.storedAt > PENDING_INVITE_DIALOG_TTL_MS ||
      // A clock that moved backwards is not a reason to trust a stale marker.
      now < parsed.storedAt - PENDING_INVITE_DIALOG_TTL_MS
    ) {
      return null;
    }
    return { storedAt: parsed.storedAt };
  } catch {
    return null;
  }
}

/**
 * Record that the invite dialog should open after this sign-in completes.
 *
 * Call IMMEDIATELY before `signIn()`/`signUp()`: WorkOS navigates away, so a
 * write deferred past that call never happens.
 */
export function markPendingInviteDialog(now: number = Date.now()): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    const payload: StoredPendingInvite = { storedAt: now };
    sessionStorage.setItem(
      PENDING_INVITE_DIALOG_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // Ignore storage failures — the user lands back on the page they left,
    // the dialog just stays closed.
  }
}

export function clearPendingInviteDialog(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(PENDING_INVITE_DIALOG_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

/**
 * Read and clear in one step: the marker answers one opening at most.
 *
 * ALWAYS clears, including on an expired marker — a stale marker would
 * otherwise capture the NEXT sign-in in this tab and open the invite dialog
 * the user did not ask for. Callers should hold off consuming until they can
 * actually open the dialog (authed user + active project), since an
 * unconsumed marker simply waits for its conditions.
 */
export function consumePendingInviteDialog(now: number = Date.now()): boolean {
  const pending = readPendingInviteDialog(now);
  clearPendingInviteDialog();
  return pending !== null;
}
