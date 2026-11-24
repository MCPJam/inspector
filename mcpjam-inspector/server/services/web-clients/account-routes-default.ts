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
type KeptSignInBrowser = {
  browser: WebClientHostedBrowser;
  actor: WebActor;
  projectId: string;
  webAccountId: string;
  expiry: NodeJS.Timeout;
};
const signInBrowsers = new Map<string, KeptSignInBrowser>();
/** Long past any sign-in: a browser nobody saved by then is closed. */
const SIGN_IN_BROWSER_KEEP_MS = 2 * 60 * 60_000;

function keepSignInBrowser(entry: Omit<KeptSignInBrowser, "expiry">): void {
  const id = entry.browser.browserSessionId;
  clearTimeout(signInBrowsers.get(id)?.expiry);
  const expiry = setTimeout(() => void releaseSignInBrowser(id), SIGN_IN_BROWSER_KEEP_MS);
  expiry.unref();
  signInBrowsers.set(id, { ...entry, expiry });
}

/** Forgets the browser and closes it, which never throws. */
async function releaseSignInBrowser(browserSessionId: string): Promise<void> {
  const kept = signInBrowsers.get(browserSessionId);
  if (!kept) return;
  signInBrowsers.delete(browserSessionId);
  clearTimeout(kept.expiry);
  await kept.browser.close();
}

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
        keepSignInBrowser({ browser, actor, projectId, webAccountId });
        return { browserSessionId: browser.browserSessionId, chatSessionId: browser.chatSessionId };
      },
      async driver(args) {
        return signInBrowserOf(args).driver;
      },
      async captureProfile(args) {
        return signInBrowserOf(args).exportProfile();
      },
      async release(args) {
        if (heldSignInBrowser(args)) await releaseSignInBrowser(args.browserSessionId);
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

type SignInBrowserArgs = {
  browserSessionId: string;
  actor: WebActor;
  projectId: string;
  webAccountId: string;
};

/** The person's own sign-in browser for this account, if this replica holds it. */
function heldSignInBrowser(args: SignInBrowserArgs): WebClientHostedBrowser | undefined {
  const kept = signInBrowsers.get(args.browserSessionId);
  if (
    !kept ||
    !sameActor(kept.actor, args.actor) ||
    kept.projectId !== args.projectId ||
    kept.webAccountId !== args.webAccountId
  ) {
    return undefined;
  }
  return kept.browser;
}

function signInBrowserOf(args: SignInBrowserArgs): WebClientHostedBrowser {
  const browser = heldSignInBrowser(args);
  if (!browser) throw new SignInBrowserNotFoundError();
  return browser;
}

function sameActor(a: WebActor, b: WebActor): boolean {
  if ("actorExternalId" in a) {
    return "actorExternalId" in b && a.actorExternalId === b.actorExternalId;
  }
  return "actorUserId" in b && a.actorUserId === b.actorUserId;
}
