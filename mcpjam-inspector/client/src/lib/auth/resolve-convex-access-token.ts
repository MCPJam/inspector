import { getGuestBearerToken } from "@/lib/guest-session";

/**
 * Resolve the Convex bearer token for a request the same way the chat-session
 * bootstrap does (see `use-chat-session.ts`): prefer the WorkOS access token
 * for signed-in users, and fall back to the guest bearer when there is no
 * WorkOS user.
 *
 * The fallback is keyed on guest-ness (`!hasWorkosUser`), NOT on
 * `isDirectGuest`. `isDirectGuest` is false whenever a guest owns a project
 * (e.g. the auto-created "Default" project) or in hosted mode, so the eval
 * paths that selected `isDirectGuest ? getGuestBearerToken : getAccessToken`
 * handed the WorkOS getter — which returns nothing for a guest — to the
 * runner. The empty token reached Convex as `setAuth("")`, and `requireActor`
 * threw "Authentication required". Falling back on guest-ness fixes
 * project-owning guests while never downgrading a signed-in user to a guest
 * bearer if their WorkOS token momentarily fails to resolve.
 */
export async function resolveConvexAccessToken(opts: {
  getWorkosAccessToken: () => Promise<string | null | undefined>;
  hasWorkosUser: boolean;
}): Promise<string | null> {
  try {
    const token = await opts.getWorkosAccessToken();
    if (token) return token;
  } catch {
    // WorkOS LoginRequiredError — not signed in; fall through to guest.
  }

  if (!opts.hasWorkosUser) {
    return await getGuestBearerToken();
  }

  return null;
}
