import { removeProfile } from "./config-store.js";

/**
 * Removes a stored profile. Returns `true` if a profile was deleted,
 * `false` if none existed under that name (or the default profile was empty).
 */
export async function logout(
  options: { profile?: string } = {},
): Promise<boolean> {
  return await removeProfile(options.profile);
}
