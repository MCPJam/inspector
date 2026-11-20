/**
 * The sign-in browsers this process opened: the hosted browser a person signs
 * a web account in with, from a client's Browser settings or the reconnect
 * page. Save-profile and handback find it here by the id the sign-in route
 * answered with, and only for the person, project and account it was opened
 * for, so one person's id never drives another's browser.
 *
 * One process's: a request on another replica finds none, and the person
 * starts the sign-in again.
 */
import type { WebClientHostedBrowser } from "./hosted-browser.js";
import type { WebActor } from "./hosted-web-client-environment.js";

type KeptBrowser = {
  browser: WebClientHostedBrowser;
  actor: WebActor;
  projectId: string;
  webAccountId: string;
  openedAt: number;
};

/** Long past any sign-in; the hosted session behind it is gone by then. */
const KEEP_MS = 2 * 60 * 60_000;
const kept = new Map<string, KeptBrowser>();

export function keepSignInBrowser(
  entry: Omit<KeptBrowser, "openedAt">,
  now: number = Date.now(),
): void {
  for (const [id, old] of kept) {
    if (now - old.openedAt > KEEP_MS) kept.delete(id);
  }
  kept.set(entry.browser.browserSessionId, { ...entry, openedAt: now });
}

/** The person's own sign-in browser for this account, if this process holds it. */
export function findSignInBrowser(args: {
  browserSessionId: string;
  actor: WebActor;
  projectId: string;
  webAccountId: string;
}): WebClientHostedBrowser | undefined {
  const entry = kept.get(args.browserSessionId);
  if (
    !entry ||
    !sameActor(entry.actor, args.actor) ||
    entry.projectId !== args.projectId ||
    entry.webAccountId !== args.webAccountId
  ) {
    return undefined;
  }
  return entry.browser;
}

/** The account a person's sign-in browser was opened for, if this process holds it. */
export function signInBrowserAccount(args: {
  browserSessionId: string;
  actor: WebActor;
  projectId: string;
}): string | undefined {
  const entry = kept.get(args.browserSessionId);
  if (
    !entry ||
    !sameActor(entry.actor, args.actor) ||
    entry.projectId !== args.projectId
  ) {
    return undefined;
  }
  return entry.webAccountId;
}

/** For tests. */
export function forgetSignInBrowsers(): void {
  kept.clear();
}

function sameActor(a: WebActor, b: WebActor): boolean {
  if ("actorExternalId" in a) {
    return "actorExternalId" in b && a.actorExternalId === b.actorExternalId;
  }
  return "actorUserId" in b && a.actorUserId === b.actorUserId;
}
