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
let convexProvisioningUnavailable = false;

// True once we've determined that this machine can't provision guest-auth env
// on the target Convex deployment — i.e. the Convex CLI isn't authenticated,
// or the logged-in account can't administer the deployment. This is the normal
// state for open-source / local contributors: the committed `.env.local`
// points at MCPJam's shared dev deployment, which they don't own. When true,
// the guest-session helpers fall back to MCPJam's hosted mint instead of
// trying (and failing) to talk to a deployment we can't write to.
export function isConvexProvisioningUnavailable(): boolean {
  return convexProvisioningUnavailable;
}

// A `convex env set` failure that means "we can't administer this deployment"
// rather than "the write itself failed". Covers the unauthenticated case
// (`MissingAccessToken` — the CLI has never run `npx convex dev`) and the
// authenticated-but-not-a-member case (403 / not authorized for this team or
// project). These are expected for OSS/local dev and must degrade to the
// hosted guest mint, not surface as a hard error.
function isConvexAuthUnavailableMessage(message: string): boolean {
  return /MissingAccessToken|access token is required|Authenticate with|Not logged in|401\b|\b403\b|Forbidden|Unauthorized|not authorized|not a member/i.test(
    message,
  );
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

let convexCliPath: string | null = null;

// Resolve the convex CLI's entry script on disk and invoke it directly with
// `node`, rather than shelling out through `npx`/`npx.cmd`. On Windows,
// execFile-ing `npx.cmd` without a shell hits a Node bug (EINVAL) when args
// contain newlines (e.g. our PEM-formatted keys), and routing through a shell
// instead would require fragile re-quoting of those same multi-line values.
async function getConvexCliPath(): Promise<string> {
  if (!convexCliPath) {
    const { createRequire } = await import("module");
    const { dirname, join } = await import("path");
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve("convex/package.json");
    convexCliPath = join(dirname(packageJsonPath), "bin", "main.js");
  }
  return convexCliPath;
}

async function execConvexEnvSet(
  convexEnv: NodeJS.ProcessEnv,
  name: string,
  value: string,
): Promise<void> {
  const { execFile } = await import("child_process");
  const cliPath = await getConvexCliPath();

  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, "env", "set", name, "--", value],
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
      const message = error instanceof Error ? error.message : String(error);

      // Can't administer the deployment (no Convex login, or logged in as an
      // account without access). This is expected for OSS/local dev against
      // MCPJam's shared deployment — mark provisioning unavailable so the
      // guest-session helpers fall back to the hosted mint, and resolve
      // successfully so callers don't 503. Memoized: we won't retry per-request.
      if (isConvexAuthUnavailableMessage(message)) {
        convexProvisioningUnavailable = true;
        logger.info(
          "[guest-auth] Convex CLI can't provision guest auth env " +
            "(not authenticated for this deployment); using MCPJam's hosted " +
            "guest auth instead. This is expected for open-source/local dev. " +
            "To provision your own Convex deployment, run `npx convex dev` first.",
        );
        return;
      }

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
