import { validateGuestTokenDetailedAsync } from "../../services/guest-token-verifier.js";
import {
  bearerFromAuthorizationHeader,
  resolveLocalHarnessActor,
  type LocalHarnessActor,
  type LocalHarnessActorDeps,
} from "../harness/local/acting-user.js";

/**
 * WHO is asking, for local-engine eligibility.
 *
 * The local computer engine runs bash on the machine as the user, with NO
 * backend reserve gate (unlike the cloud path, which the backend rejects for
 * guests) — so this classification IS the security boundary.
 *
 * The previous check was "is this a guest token signed by the in-process key?"
 * and treated every other bearer as a member. The running server never had an
 * in-process key, and guests are minted by the backend anyway, so EVERY bearer
 * — a backend-issued guest token, an expired token, `Bearer anything` — came
 * out a member. Membership is now positive:
 *
 *  - `anonymous`  — no bearer (the route mints a guest bearer later).
 *  - `guest`      — a bearer the SELECTED guest authority signed.
 *  - `member`     — a bearer that verified as a WorkOS AuthKit session, by the
 *                   same verifier and rules the local-harness consent route
 *                   binds with (`resolveLocalHarnessActor`).
 *  - `unverified` — anything else: expired, forged, foreign, a key/service
 *                   credential, or a deployment with no AuthKit to verify
 *                   against. Never a member.
 */
export type ChatRequestActor =
  | { kind: "anonymous" }
  | { kind: "guest"; guestId: string }
  | { kind: "member"; actor: LocalHarnessActor }
  | { kind: "unverified"; reason: string };

export interface ChatRequestActorDeps {
  validateGuest: typeof validateGuestTokenDetailedAsync;
  harnessActor?: LocalHarnessActorDeps;
}

const defaultDeps: ChatRequestActorDeps = {
  validateGuest: validateGuestTokenDetailedAsync,
};

export async function classifyChatRequestActor(
  authHeader: string | undefined | null,
  deps: ChatRequestActorDeps = defaultDeps,
): Promise<ChatRequestActor> {
  const bearer = bearerFromAuthorizationHeader(authHeader);
  if (bearer === null) {
    // A header that is present but is not a usable bearer is not an identity
    // either; it is treated exactly like no header.
    return { kind: "anonymous" };
  }

  try {
    const guest = await deps.validateGuest(bearer);
    if (guest.valid && guest.guestId) {
      return { kind: "guest", guestId: guest.guestId };
    }
  } catch {
    // Guest verification unavailable: fall through. The member check below is
    // positive, so failing here can only make the answer MORE restrictive.
  }

  let resolution: Awaited<ReturnType<typeof resolveLocalHarnessActor>>;
  try {
    resolution = await resolveLocalHarnessActor({
      authorizationHeader: authHeader,
      ...(deps.harnessActor ? { deps: deps.harnessActor } : {}),
    });
  } catch {
    // Fail closed: a verifier that could not answer has not verified anyone.
    return { kind: "unverified", reason: "verification_error" };
  }
  if (resolution.ok) {
    return { kind: "member", actor: resolution.actor };
  }
  return { kind: "unverified", reason: resolution.reason };
}

/** A verified WorkOS member — the only actor local bash may run for. */
export function isVerifiedMember(
  actor: ChatRequestActor,
): actor is Extract<ChatRequestActor, { kind: "member" }> {
  return actor.kind === "member";
}

/** Guests and anonymous callers, i.e. the old `isGuestChatRequest` population. */
export function isGuestOrAnonymous(actor: ChatRequestActor): boolean {
  return actor.kind === "guest" || actor.kind === "anonymous";
}

/**
 * The guest half of the classification only: no bearer, or a bearer the
 * selected guest authority signed.
 *
 * For gates whose downstream verifies membership itself — local harness
 * readiness (`verifyLocalHarnessMember`), or a bearer forwarded to Convex —
 * this keeps guests out without verifying the session twice. It is NOT a
 * membership answer: `false` means "not a guest", never "a member". The local
 * bash engine, which has no downstream check, uses `classifyChatRequestActor`.
 */
export async function isGuestOrAnonymousRequest(
  authHeader: string | undefined | null,
  deps: Pick<ChatRequestActorDeps, "validateGuest"> = defaultDeps,
): Promise<boolean> {
  const bearer = bearerFromAuthorizationHeader(authHeader);
  if (bearer === null) return true;
  try {
    const guest = await deps.validateGuest(bearer);
    return Boolean(guest.valid && guest.guestId);
  } catch {
    return false;
  }
}
