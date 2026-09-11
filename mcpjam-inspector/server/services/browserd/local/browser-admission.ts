import { LOCAL_BROWSER_ENABLED } from "../../../config.js";
import { rolloutEnabled } from "../../../utils/computers/browser-rollout.js";
import { validateGuestTokenDetailedAsync } from "../../guest-token.js";
import { verifyAuthKitToken } from "../../authkit-jwt.js";
/** Actor is verified once; the rollout is refreshed on its bounded cache. */
export function localBrowserAdmission(actorId: string): () => Promise<boolean> {
  return async () =>
    LOCAL_BROWSER_ENABLED && (await rolloutEnabled(true, actorId));
}
export async function admissionForBearer(
  header: string,
): Promise<() => Promise<boolean>> {
  const token = header.replace(/^Bearer\s+/i, "");
  const guest = await validateGuestTokenDetailedAsync(token);
  const actorId =
    guest.valid && guest.guestId
      ? guest.guestId
      : (await verifyAuthKitToken(token)).sub;
  return localBrowserAdmission(actorId);
}
