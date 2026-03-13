import { getGuestPublicKeyPem } from "../services/guest-token.js";
import { shouldUseLocalGuestSigning } from "./guest-session-source.js";
import { logger } from "./logger.js";

let syncStarted = false;

/**
 * When local guest signing is enabled in dev, push the guest public key and
 * Convex guest JWKS override so Convex can verify JWTs signed by this local
 * inspector process.
 */
export function syncGuestAuthConfigToConvex(): void {
  if (
    process.env.NODE_ENV === "production" ||
    !shouldUseLocalGuestSigning() ||
    syncStarted
  ) {
    return;
  }

  syncStarted = true;

  void (async () => {
    try {
      const pem = getGuestPublicKeyPem();
      const convexUrl = process.env.CONVEX_URL;
      if (!convexUrl) return;

      const match = convexUrl.match(/https:\/\/([^.]+)\.convex\.cloud/);
      if (!match) return;

      const deploymentName = match[1];
      const guestJwksUrl = new URL(
        "/guest/jwks",
        process.env.CONVEX_HTTP_URL ?? `https://${deploymentName}.convex.site`,
      ).toString();

      const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
      const convexEnv = {
        ...process.env,
        CONVEX_DEPLOYMENT: `dev:${deploymentName}`,
      };

      const { execFile } = await import("child_process");

      const setConvexEnv = async (name: string, value: string) => {
        await new Promise<void>((resolve, reject) => {
          execFile(
            npxCommand,
            ["convex", "env", "set", name, "--", value],
            {
              env: convexEnv,
              timeout: 15_000,
              maxBuffer: 1024 * 1024,
              windowsHide: true,
            },
            (error, stdout, stderr) => {
              if (!error) {
                resolve();
                return;
              }

              reject(
                new Error(
                  stderr?.trim() ||
                    stdout?.trim() ||
                    error.message ||
                    `convex env set ${name} failed`,
                ),
              );
            },
          );
        });
      };

      await setConvexEnv("GUEST_JWT_PUBLIC_KEY", pem);
      await setConvexEnv("GUEST_JWKS_URL", guestJwksUrl);
      logger.info(
        `[guest-auth] Pushed guest key + JWKS URL to Convex (${deploymentName})`,
      );
    } catch (err) {
      logger.warn(
        `[guest-auth] Failed to push guest auth config to Convex: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  })();
}
