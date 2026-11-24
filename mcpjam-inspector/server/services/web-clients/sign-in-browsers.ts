/**
 * The sign-in browsers this process opened: the hosted browser a person signs
 * a web account in with, from a client's Browser settings or the reconnect
 * page. Save-profile and handback find it here by the id the sign-in route
 * answered with, and only for the person, project and account it was opened
 * for, so one person's id never drives another's browser.
 *
 * One process's: a request on another replica finds none, and the person
 * starts the sign-in again. A browser is let go, and its hosted session
 * closed, once save-profile is done with it, when its sign-in page fails to
 * open, or two hours after it opened, so an old id saves nothing.
 */
import type { WebClientHostedBrowser } from "./hosted-browser.js";
import type { WebActor } from "./hosted-web-client-environment.js";
import { logger } from "../../utils/logger.js";

type SignInBrowserEntry = {
  browser: WebClientHostedBrowser;
  actor: WebActor;
  projectId: string;
  webAccountId: string;
  /**
   * Ends the hosted session behind the browser, as the person: with the
   * bearer of the request that lets it go, or else the one that opened it.
   */
  close(bearer?: string): Promise<void>;
};

type KeptBrowser = SignInBrowserEntry & {
  openedAt: number;
  expiry: ReturnType<typeof setTimeout>;
};

/** Long past any sign-in; the hosted session behind it is gone by then. */
const KEEP_MS = 2 * 60 * 60_000;
const kept = new Map<string, KeptBrowser>();

export function keepSignInBrowser(entry: SignInBrowserEntry): void {
  const id = entry.browser.browserSessionId;
  const previous = kept.get(id);
  if (previous) clearTimeout(previous.expiry);
  // Nothing may read the entry again, so a timer lets it go on a quiet replica.
  const expiry = setTimeout(() => letGo(id), KEEP_MS);
  expiry.unref();
  kept.set(id, { ...entry, openedAt: Date.now(), expiry });
}

/** The person's own sign-in browser for this account, if this process holds it. */
export function findSignInBrowser(args: {
  browserSessionId: string;
  actor: WebActor;
  projectId: string;
  webAccountId: string;
}): WebClientHostedBrowser | undefined {
  const entry = heldFor(args);
  return entry?.webAccountId === args.webAccountId ? entry.browser : undefined;
}

/** The account a person's sign-in browser was opened for, if this process holds it. */
export function signInBrowserAccount(args: {
  browserSessionId: string;
  actor: WebActor;
  projectId: string;
}): string | undefined {
  return heldFor(args)?.webAccountId;
}

/**
 * Lets the person's sign-in browser for this account go once its sign-in is
 * over, and closes it as `bearer` names them.
 */
export function releaseSignInBrowser(args: {
  browserSessionId: string;
  actor: WebActor;
  projectId: string;
  webAccountId: string;
  bearer: string;
}): void {
  if (findSignInBrowser(args)) letGo(args.browserSessionId, args.bearer);
}

/** The person's browser in this project, unless it has outlived `KEEP_MS`. */
function heldFor(args: {
  browserSessionId: string;
  actor: WebActor;
  projectId: string;
}): KeptBrowser | undefined {
  const entry = kept.get(args.browserSessionId);
  if (!entry) return undefined;
  // The timer can run late on a busy process, so every read checks the age too.
  if (Date.now() - entry.openedAt > KEEP_MS) {
    letGo(args.browserSessionId);
    return undefined;
  }
  return sameActor(entry.actor, args.actor) &&
    entry.projectId === args.projectId
    ? entry
    : undefined;
}

/**
 * Forgets the browser and closes its hosted session. Nothing waits on the
 * close: the request that let it go has its answer either way, and the
 * backend pauses a browser nobody uses.
 */
function letGo(browserSessionId: string, bearer?: string): void {
  const entry = kept.get(browserSessionId);
  if (!entry) return;
  kept.delete(browserSessionId);
  clearTimeout(entry.expiry);
  entry.close(bearer).catch((error: unknown) => {
    logger.warn("[web-clients] a sign-in browser did not close", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/** Lets every browser go, closing each. For tests. */
export function forgetSignInBrowsers(): void {
  for (const id of [...kept.keys()]) letGo(id);
}

function sameActor(a: WebActor, b: WebActor): boolean {
  if ("actorExternalId" in a) {
    return "actorExternalId" in b && a.actorExternalId === b.actorExternalId;
  }
  return "actorUserId" in b && a.actorUserId === b.actorUserId;
}
