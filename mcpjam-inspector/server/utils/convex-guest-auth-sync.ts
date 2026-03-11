import { getGuestPublicKeyPem } from "../services/guest-token.js";
import { logger } from "./logger.js";

let syncStarted = false;

/**
 * In local dev runtimes, push the guest public key and Convex guest JWKS
 * override so Convex can verify JWTs signed by this local inspector process.
 */
export function syncGuestAuthConfigToConvex(): void {
  if (process.env.NODE_ENV === "production" || syncStarted) {
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

      const { spawnSync } = await import("child_process");
      const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
      const convexEnv = {
        ...process.env,
        CONVEX_DEPLOYMENT: `dev:${deploymentName}`,
      };

      const setConvexEnv = (name: string, value: string) => {
        const result = spawnSync(
          npxCommand,
          ["convex", "env", "set", name, "--", value],
          {
            env: convexEnv,
            stdio: "pipe",
            timeout: 15_000,
          },
        );

        if (result.status === 0) {
          return;
        }

        const stderr = result.stderr?.toString().trim();
        const stdout = result.stdout?.toString().trim();
        throw new Error(
          stderr ||
            stdout ||
            `convex env set ${name} failed with code ${result.status}`,
        );
      };

      setConvexEnv("GUEST_JWT_PUBLIC_KEY", pem);
      setConvexEnv("GUEST_JWKS_URL", guestJwksUrl);
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
