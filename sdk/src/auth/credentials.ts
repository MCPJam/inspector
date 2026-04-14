import { getProfile } from "./config-store.js";
import type { ApiKeyCredentials, Credentials } from "./types.js";

/**
 * Resolution order (highest to lowest):
 *   1. `MCPJAM_API_KEY` env var — returns a synthetic `apiKey` credential.
 *      Never persisted to disk. Useful for CI and ephemeral containers.
 *   2. Named profile in `~/.mcpjam/config.json` (or `$MCPJAM_CONFIG_DIR`).
 *   3. The default profile from the same file.
 *
 * Returns `null` if nothing matches.
 */
export async function getCredentials(options?: {
  profile?: string;
}): Promise<{ credentials: Credentials; source: "env" | "profile" } | null> {
  const envKey = process.env.MCPJAM_API_KEY;
  if (envKey && envKey.startsWith("mcpjam_")) {
    const creds: ApiKeyCredentials = {
      kind: "apiKey",
      apiKey: envKey,
      user: {
        userId: "",
        email: "",
        name: "",
        workspaceId: null,
        workspaceName: null,
      },
      createdAt: Date.now(),
    };
    return { credentials: creds, source: "env" };
  }

  const profile = await getProfile(options?.profile);
  if (!profile) return null;
  return { credentials: profile.credentials, source: "profile" };
}

/** Convenience: throws if no credentials are resolvable. */
export async function requireCredentials(options?: {
  profile?: string;
}): Promise<Credentials> {
  const result = await getCredentials(options);
  if (!result) {
    throw new Error(
      "No mcpjam credentials found. Run `mcpjam login` or set MCPJAM_API_KEY.",
    );
  }
  return result.credentials;
}
