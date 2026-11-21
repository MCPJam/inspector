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
import { webClientService } from "./backend-connector-resolver.js";
import { webClientsEnabledFor } from "./endpoint-auth.js";
import { openWebClientHostedBrowser, type WebClientHostedBrowser } from "./hosted-browser.js";
import { createProfileForRunClient, type WebActor } from "./hosted-web-client-environment.js";
import { actorFromBearer, restoreWebProfile } from "./hosted-web-client-runtime.js";
import { createConvexWebReconnectBackend } from "./recovery/convex-backend.js";

const bearerOf = (c: Context) => c.req.header("authorization") ?? "";

/**
 * Sign-in browsers this replica opened, each with the person, project and
 * account it was opened for, so one person's id never drives another's
 * browser. Only this replica holds them: save-profile on another one finds
 * none, and the person starts the sign-in again.
 */
const signInBrowsers = new Map<
  string,
  { browser: WebClientHostedBrowser; actor: WebActor; projectId: string; webAccountId: string }
>();

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
      // The backend has no manage check to ask yet (`mayManageWebAccounts`
      // is the read it needs). Until it does, the answer is unknown: the
      // route restores no saved session, and every save checks manage itself.
      try {
        const answer = (await service.read({
          action: "mayManageWebAccounts",
          projectId,
          webAccountId,
          ...actor,
        })) as { allowed?: unknown } | null;
        return typeof answer?.allowed === "boolean" ? answer.allowed : undefined;
      } catch (error) {
        if (refusedAsUnknown(error)) return undefined;
        throw error;
      }
    },
    service,
    saveProfile: (actor, args) => createConvexWebReconnectBackend(actor).saveWebAccountProfile(args),
    browser: {
      async start({ actor, bearer, projectId, webAccountId, restoreProfile }) {
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
        signInBrowsers.set(browser.browserSessionId, { browser, actor, projectId, webAccountId });
        return { browserSessionId: browser.browserSessionId, chatSessionId: browser.chatSessionId };
      },
      async driver(args) {
        return signInBrowserOf(args).driver;
      },
      async captureProfile(args) {
        return signInBrowserOf(args).exportProfile();
      },
    },
  });

  async function vendorOf(actor: WebActor, projectId: string, webAccountId: string) {
    const rows = (await service!.read({ action: "listWebAccounts", projectId, ...actor })) as Array<{
      webAccountId?: unknown;
      vendor?: unknown;
    }>;
    const vendor = rows.find((row) => row.webAccountId === webAccountId)?.vendor;
    const known = WEB_CLIENT_VENDORS.find((candidate) => candidate === vendor);
    if (!known) throw new Error("This web account is not in the project.");
    return known;
  }
}

/** The person's own sign-in browser for this account, if this replica holds it. */
function signInBrowserOf(args: {
  browserSessionId: string;
  actor: WebActor;
  projectId: string;
  webAccountId: string;
}): WebClientHostedBrowser {
  const kept = signInBrowsers.get(args.browserSessionId);
  if (
    !kept ||
    !sameActor(kept.actor, args.actor) ||
    kept.projectId !== args.projectId ||
    kept.webAccountId !== args.webAccountId
  ) {
    throw new SignInBrowserNotFoundError();
  }
  return kept.browser;
}

function sameActor(a: WebActor, b: WebActor): boolean {
  if ("actorExternalId" in a) {
    return "actorExternalId" in b && a.actorExternalId === b.actorExternalId;
  }
  return "actorUserId" in b && a.actorUserId === b.actorUserId;
}

/** An older backend answers an action it does not know with this code. */
function refusedAsUnknown(error: unknown): boolean {
  const data = (error as { data?: { code?: unknown } } | null)?.data;
  return data?.code === "INVALID_WEB_CLIENT_REQUEST";
}
