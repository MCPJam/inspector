/**
 * The account routes as this deployment runs them: the signed-in user from
 * the request's AuthKit bearer, the `web-clients-enabled` flag for them, the
 * process's `webClientService()`, recovery's sealed profile save, and the
 * Playground's hosted browser.
 *
 * Without the backend service (a local Inspector) every route answers that
 * web accounts need the hosted backend.
 */
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { WEB_CLIENT_VENDORS } from "@/shared/web-clients";
import { verifiedFlagSubject } from "../../utils/flag-identity.js";
import { getInternalBackendConfig } from "../internal-backend.js";
import { createWebAccountRoutes, SignInBrowserNotFoundError } from "./account-routes.js";
import { refusalCode, webClientService } from "./backend-connector-resolver.js";
import { webClientsEnabledFor } from "./endpoint-auth.js";
import { openWebClientHostedBrowser } from "./hosted-browser.js";
import { createProfileForRunClient, type WebActor } from "./hosted-web-client-environment.js";
import { actorFromBearer, restoreWebProfile } from "./hosted-web-client-runtime.js";
import { createConvexWebReconnectBackend } from "./recovery/convex-backend.js";
import { findSignInBrowser, keepSignInBrowser, releaseSignInBrowser } from "./sign-in-browsers.js";
import { PageDriverError } from "../../utils/harness/real-ui/page-driver.js";
import { logger } from "../../utils/logger.js";

const bearerOf = (c: Context) => c.req.header("authorization") ?? "";

export function createDefaultWebAccountRoutes(): Hono {
  const service = webClientService();
  if (!service) {
    const off = new Hono();
    off.all("/accounts/*", (c) =>
      c.json({ error: "Web accounts need MCPJam's hosted backend. Open the project in the hosted app." }, 503),
    );
    return off;
  }
  return createWebAccountRoutes({
    actorOf: async (c) => {
      const bearer = bearerOf(c);
      return /^Bearer\s+\S/i.test(bearer) ? actorFromBearer(bearer) : undefined;
    },
    isEnabled: async (c) => {
      const token = /^Bearer\s+(\S+)/i.exec(bearerOf(c))?.[1];
      const identity = token ? await verifiedFlagSubject(token) : undefined;
      return webClientsEnabledFor(identity?.kind === "id" ? identity.distinctId : undefined);
    },
    async mayManage({ actor, projectId, webAccountId }) {
      let answer: unknown;
      try {
        answer = await service.read({ action: "mayManageWebAccounts", projectId, webAccountId, ...actor });
      } catch (error) {
        if (refusalCode(error) !== "INVALID_WEB_CLIENT_REQUEST") throw error;
        // A backend without this check refuses it with the code it also gives
        // a field it can't read. The account list, read for the same person
        // and project, tells them apart: when it names the account, the
        // fields were fine and only the check is missing, so the answer is
        // unknown, which the routes refuse. An account it doesn't name is a
        // no, as the check answers for an account outside the project.
        return (await listedAccount(actor, projectId, webAccountId)) ? undefined : false;
      }
      const allowed = (answer as { allowed?: unknown } | null)?.allowed;
      if (typeof allowed !== "boolean") throw new Error("The backend's manage check answered without a yes or no.");
      return allowed;
    },
    service,
    saveProfile: (actor, args) => createConvexWebReconnectBackend(actor).saveWebAccountProfile(args),
    browser: {
      async start({ actor, bearer, projectId, webAccountId, restoreProfile, startUrl }) {
        const vendor = await vendorOf(actor, projectId, webAccountId);
        let profileArchive: Uint8Array | undefined;
        if (restoreProfile) {
          const { convexUrl, serviceToken } = getInternalBackendConfig("Claude web and ChatGPT web");
          const profile = await createProfileForRunClient({ convexHttpUrl: convexUrl, serviceToken })({
            actor,
            webAccountId,
            runId: `sign-in:${randomUUID()}`,
            venue: "hosted",
          });
          profileArchive = await restoreWebProfile(profile);
        }
        const browser = await openWebClientHostedBrowser({
          bearer,
          projectId,
          vendor,
          ...(profileArchive ? { profileArchive } : {}),
        });
        const { browserSessionId } = browser;
        keepSignInBrowser({
          browser,
          actor,
          projectId,
          webAccountId,
          close: (closer) => browser.close(closer),
        });
        try {
          await browser.driver.navigate(startUrl);
        } catch (error) {
          if (!(error instanceof PageDriverError)) {
            // The person never gets this browser's id, so nothing else would let it go.
            releaseSignInBrowser({ browserSessionId, actor, projectId, webAccountId, bearer });
            throw error;
          }
          // The browser is open either way; the person can open the page there.
          logger.warn("[web-clients] the sign-in browser did not open the vendor's sign-in page", {
            code: error.code,
          });
        }
        return { browserSessionId: browser.browserSessionId, chatSessionId: browser.chatSessionId };
      },
      async driver(args) {
        return signInBrowserOf(args).driver;
      },
      async captureProfile(args) {
        return signInBrowserOf(args).exportProfile();
      },
      async release(args) {
        releaseSignInBrowser(args);
      },
    },
  });

  /** The account's row in the project's list, as the backend lists it for the person. */
  async function listedAccount(actor: WebActor, projectId: string, webAccountId: string) {
    const rows = (await service!.read({ action: "listWebAccounts", projectId, ...actor })) as Array<{
      webAccountId?: unknown;
      vendor?: unknown;
    }>;
    return rows.find((row) => row.webAccountId === webAccountId);
  }

  async function vendorOf(actor: WebActor, projectId: string, webAccountId: string) {
    const vendor = (await listedAccount(actor, projectId, webAccountId))?.vendor;
    const known = WEB_CLIENT_VENDORS.find((candidate) => candidate === vendor);
    if (!known) throw new Error("This web account is not in the project.");
    return known;
  }
}

/**
 * The person's own sign-in browser for this account. One this replica doesn't
 * hold answers 409, so the person starts the sign-in again.
 */
function signInBrowserOf(args: Parameters<typeof findSignInBrowser>[0]) {
  const browser = findSignInBrowser(args);
  if (!browser) throw new SignInBrowserNotFoundError();
  return browser;
}
