import { createRequire } from "module";
import { dirname, join } from "path";
import {
  getGuestPrivateKeyPem,
  getGuestPublicKeyPem,
  initGuestTokenSecret,
} from "../services/guest-token.js";
import { getGuestSessionSharedSecret } from "./guest-session-secret.js";
import { getGuestSessionHashPepper } from "./guest-session-pepper.js";
import { logger } from "./logger.js";

let provisioningPromise: Promise<void> | null = null;
let provisioningStarted = false;
let cachedConvexCliEntry: string | null = null;

// Resolve the Convex CLI's actual entry script instead of shelling out to
// `npx`. On Windows, `npx` resolves to the `npx.cmd` shim, which CreateProcess
// cannot execute without a shell — and routing through a shell to work around
// that (`shell: true`) breaks here because the PEM values we pass as argv
// contain embedded newlines, which cmd.exe splits into extra arguments.
// Invoking `node <cli-entry>` directly avoids both problems: it's a real
// executable, and Windows argv passing preserves embedded newlines in a
// single argument untouched.
function getConvexCliEntry(): string {
  if (cachedConvexCliEntry) return cachedConvexCliEntry;
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve("convex/package.json");
  cachedConvexCliEntry = join(dirname(pkgJsonPath), "bin", "main.js");
  return cachedConvexCliEntry;
}

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

// Convex's env-var mutation can transiently fail with
// `OptimisticConcurrencyControlFailure` when another writer (e.g., a parallel
// `convex dev` cycle, or another inspector instance) touches the deployment
// at the same time. The OCC error is safe to retry — the prior write didn't
// take effect, and our `env set` is idempotent on identical values.
function isOccFailureMessage(message: string): boolean {
  return /OptimisticConcurrencyControlFailure/i.test(message);
}

async function execConvexEnvSet(
  convexEnv: NodeJS.ProcessEnv,
  name: string,
  value: string,
): Promise<void> {
  const { execFile } = await import("child_process");

  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [getConvexCliEntry(), "env", "set", name, "--", value],
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

async function setConvexEnv(
  convexEnv: NodeJS.ProcessEnv,
  name: string,
  value: string,
): Promise<void> {
  const maxAttempts = 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await execConvexEnvSet(convexEnv, name, value);
      if (attempt > 1) {
        logger.info(
          `[guest-auth] convex env set ${name} succeeded after ${attempt} attempts`,
        );
      }
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isOccFailureMessage(message) || attempt === maxAttempts) {
        throw error;
      }
      // Exponential backoff with jitter: 100ms, 250ms, 500ms.
      const baseDelay = 100 * Math.pow(2.2, attempt - 1);
      const delay = Math.round(baseDelay + Math.random() * 100);
      logger.warn(
        `[guest-auth] convex env set ${name} hit OCC failure (attempt ${attempt}/${maxAttempts}); retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
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
      await setConvexEnv(
        convexEnv,
        "GUEST_SESSION_HASH_PEPPER",
        getGuestSessionHashPepper(),
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
