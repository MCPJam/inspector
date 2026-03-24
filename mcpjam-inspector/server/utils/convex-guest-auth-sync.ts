import {
  getGuestPrivateKeyPem,
  getGuestPublicKeyPem,
  initGuestTokenSecret,
} from "../services/guest-token.js";
import { getGuestSessionSharedSecret } from "./guest-session-secret.js";
import { logger } from "./logger.js";

let provisioningPromise: Promise<void> | null = null;
let provisioningStarted = false;

function getConvexDeploymentForProvisioning(): string {
  if (process.env.CONVEX_DEPLOYMENT) {
    return process.env.CONVEX_DEPLOYMENT;
  }

  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL is required for guest auth provisioning");
  }

  const match = convexUrl.match(/https:\/\/([^.]+)\.convex\.cloud/);
  if (!match) {
    throw new Error(`Unsupported CONVEX_URL: ${convexUrl}`);
  }

  return `dev:${match[1]}`;
}

async function setConvexEnv(
  convexEnv: NodeJS.ProcessEnv,
  name: string,
  value: string,
): Promise<void> {
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const { execFile } = await import("child_process");

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
}

function shouldProvisionGuestAuthToConvex(): boolean {
  return (
    process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test"
  );
}

export async function provisionGuestAuthConfigToConvex(): Promise<void> {
  if (!shouldProvisionGuestAuthToConvex()) {
    return;
  }

  if (!provisioningPromise) {
    provisioningPromise = (async () => {
      if (!process.env.CONVEX_HTTP_URL) {
        throw new Error(
          "CONVEX_HTTP_URL is required for guest auth provisioning",
        );
      }

      initGuestTokenSecret();

      const convexEnv = {
        ...process.env,
        CONVEX_DEPLOYMENT: getConvexDeploymentForProvisioning(),
      };
      const guestJwksUrl = new URL(
        "/guest/jwks",
        process.env.CONVEX_HTTP_URL,
      ).toString();

      await setConvexEnv(
        convexEnv,
        "GUEST_JWT_PRIVATE_KEY",
        getGuestPrivateKeyPem(),
      );
      await setConvexEnv(
        convexEnv,
        "GUEST_JWT_PUBLIC_KEY",
        getGuestPublicKeyPem(),
      );
      await setConvexEnv(convexEnv, "GUEST_JWKS_URL", guestJwksUrl);
      await setConvexEnv(
        convexEnv,
        "GUEST_SESSION_SHARED_SECRET",
        getGuestSessionSharedSecret(),
      );

      logger.info(
        `[guest-auth] Provisioned Convex guest auth env (${convexEnv.CONVEX_DEPLOYMENT})`,
      );
    })().catch((error) => {
      provisioningPromise = null;
      throw error;
    });
  }

  await provisioningPromise;
}

export function startGuestAuthProvisioningInBackground(): void {
  if (!shouldProvisionGuestAuthToConvex() || provisioningStarted) {
    return;
  }

  provisioningStarted = true;
  void provisionGuestAuthConfigToConvex().catch((error) => {
    provisioningStarted = false;
    logger.warn(
      `[guest-auth] Failed to provision Convex guest auth env in background: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}
