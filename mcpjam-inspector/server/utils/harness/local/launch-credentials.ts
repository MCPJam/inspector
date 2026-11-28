/**
 * The instance registration and consent grant a chat turn's readiness check
 * minted, reused by the member's next turns while the grant is still good.
 *
 * Every attended turn used to POST its instance registration and mint a new
 * 15-minute grant. Neither has to be new each turn. The backend answers a
 * re-registration of the same key with the same key id and checks that key
 * on every lease start and every proxied request, and the availability gate
 * verifies the grant again on every turn. So a turn reuses both for exactly
 * the terms the grant was minted for (its binding: user, machine, project,
 * workspace, harness, runtime, profile, policy and scope) and the same
 * instance key, while the grant has more than a margin left to run.
 *
 * Expiry and revocation are unchanged. A grant is never extended: inside the
 * margin a new one is minted. One that no longer verifies (revoked, removed
 * with its workspace, or bound to terms that changed) is replaced rather
 * than handed to a turn. Readiness reads the member's durable authorization
 * before it gets here, on every turn, so a forgotten authorization still
 * refuses the next turn.
 *
 * In process memory only, like the target a turn already carries; never
 * written anywhere.
 */
import {
  hashGrantBinding,
  verifyLocalHarnessGrant,
  type HarnessGrantBinding,
  type MintedHarnessGrant,
} from "./grants.js";

/** Reuse stops this long before a grant expires, so a turn never starts on a
 *  grant that lapses before its availability check. */
export const LAUNCH_REUSE_MARGIN_MS = 5 * 60_000;

export interface LaunchCredentials {
  /** The key id the backend registered this instance key under. */
  keyId: string;
  grant: MintedHarnessGrant;
}

const kept = new Map<string, LaunchCredentials>();

function keyFor(binding: HarnessGrantBinding, publicKey: string): string {
  return `${hashGrantBinding(binding)}:${publicKey}`;
}

/** Test seam: forget every kept registration and grant. */
export function resetLaunchCredentialsForTests(): void {
  kept.clear();
}

/** The credentials kept for these terms and key, if they are still good. */
export async function reusableLaunchCredentials(
  binding: HarnessGrantBinding,
  publicKey: string,
): Promise<LaunchCredentials | null> {
  const key = keyFor(binding, publicKey);
  const credentials = kept.get(key);
  if (credentials === undefined) return null;
  const now = Date.now();
  if (
    Date.parse(credentials.grant.expiresAt) - now > LAUNCH_REUSE_MARGIN_MS &&
    (await verifyLocalHarnessGrant(credentials.grant.token, binding, { now })).ok
  ) {
    return credentials;
  }
  if (kept.get(key) === credentials) kept.delete(key);
  return null;
}

/** Keep what a turn just minted, for the member's next turns. */
export function rememberLaunchCredentials(
  binding: HarnessGrantBinding,
  publicKey: string,
  credentials: LaunchCredentials,
): void {
  const now = Date.now();
  for (const [key, entry] of kept) {
    if (Date.parse(entry.grant.expiresAt) <= now) kept.delete(key);
  }
  kept.set(keyFor(binding, publicKey), credentials);
}
