/**
 * Signing a project's web account in, and saving the session, so hosted runs
 * have a browser profile to restore. Without these nobody can create the
 * first saved session.
 *
 *   POST /api/web-clients/accounts/:webAccountId/sign-in {projectId}
 *     A hosted browser on the account's saved profile, or a fresh one, open
 *     on the vendor's sign-in page and kept to the vendor's sites. Answers
 *     `{browserSessionId}`, the handle the Playground's hosted browser pane
 *     attaches to, so a person takes over and signs in. MCPJam types nothing.
 *
 *   POST /api/web-clients/accounts/:webAccountId/save-profile
 *       {projectId, browserSessionId}
 *     Reads who is signed in with the vendor's page module, then captures,
 *     seals, uploads and saves the profile (compare-and-set on its version)
 *     and marks the account verified. Answers `{ok:true, accountEmail,
 *     workspaceName?}` or `{ok:false, reason}` with `not_signed_in`,
 *     `wrong_account` or `version_conflict`. The browser stays open after
 *     the first two and failures before storage, so the admin can retry.
 *     A browser this replica doesn't hold for the person, project and
 *     account answers 409.
 *
 * Admins only, acting as the signed-in user: each route asks the backend
 * whether the actor manages the project's web accounts and goes on only on
 * a yes, and the backend checks the role again on every call these make.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import {
  WEB_CLIENT_SITES,
  WEB_CLIENT_VENDORS,
  type WebClientVendor,
} from "@/shared/web-clients";
import { chatgptWebPageModule } from "../../utils/harness/real-ui/chatgpt-web.js";
import { claudeWebPageModule } from "../../utils/harness/real-ui/claude-web.js";
import { PageDriverError, type PageDriver } from "../../utils/harness/real-ui/page-driver.js";
import { BrowserdClientError } from "../browserd/browserd-codec.js";
import { PROFILE_EXPORT_BROWSER_CLOSED } from "../browserd/profile-export-errors.js";
import {
  RealUiError,
  type RealUiPageModule,
} from "../../utils/harness/real-ui/page-module.js";
import type { WebClientService } from "./backend-connector-resolver.js";
import type { WebActor } from "./hosted-web-client-environment.js";
import type { SaveProfileResult } from "./recovery/backend.js";

/** Where each vendor's sign-in starts. */
export const WEB_CLIENT_SIGN_IN_URLS: Record<WebClientVendor, string> = {
  claude: "https://claude.ai/login",
  chatgpt: "https://chatgpt.com/auth/login",
};

const PAGE_MODULES: Record<WebClientVendor, RealUiPageModule> = {
  claude: claudeWebPageModule,
  chatgpt: chatgptWebPageModule,
};

/** The hosted browser a person signs in with. */
export interface SignInBrowser {
  start(args: {
    actor: WebActor;
    /** The request's MCPJam bearer: the hosted browser is the person's. */
    bearer: string;
    projectId: string;
    webAccountId: string;
    /** Restore the account's saved profile, when it has one. */
    restoreProfile: boolean;
    sites: readonly string[];
    startUrl: string;
  }): Promise<{ browserSessionId: string; chatSessionId?: string }>;
  /** The browser this person started for this account; refused otherwise. */
  driver(args: {
    actor: WebActor;
    projectId: string;
    webAccountId: string;
    browserSessionId: string;
  }): Promise<PageDriver>;
  /** The browser's profile as an archive. Never logged or kept. */
  captureProfile(args: {
    actor: WebActor;
    projectId: string;
    webAccountId: string;
    browserSessionId: string;
  }): Promise<Uint8Array>;
  /**
   * Closes and forgets the person's browser once its sign-in is over, as
   * `bearer` names them. One this replica doesn't hold for them is left as it is.
   */
  release(args: {
    actor: WebActor;
    projectId: string;
    webAccountId: string;
    browserSessionId: string;
    bearer: string;
  }): Promise<void>;
}

/**
 * No sign-in browser here for this person, project and account: it was
 * opened on another replica, it closed, or it was opened for someone else.
 * The same answer for each, so an id never says whose browser it is.
 */
export class SignInBrowserNotFoundError extends Error {
  constructor() {
    super("This sign-in browser was started elsewhere or has closed. Start the sign-in again.");
    this.name = "SignInBrowserNotFoundError";
  }
}

export type WebAccountRouteDeps = {
  /** The signed-in user the request's bearer names, verified. */
  actorOf(c: Context): Promise<WebActor | undefined>;
  isEnabled(c: Context): Promise<boolean>;
  /**
   * Whether the actor manages the project's web accounts, or undefined when
   * the backend can't say. Only a yes opens or saves a sign-in browser.
   */
  mayManage(args: { actor: WebActor; projectId: string; webAccountId: string }): Promise<boolean | undefined>;
  service: WebClientService;
  saveProfile(
    actor: WebActor,
    args: { webAccountId: string; expectedProfileVersion: number; profile: Uint8Array },
  ): Promise<SaveProfileResult>;
  browser: SignInBrowser;
};

const account = z.object({
  webAccountId: z.string(),
  // Any vendor parses: the backend can list one before this Inspector drives
  // it, and that account must not break the routes for every other one.
  vendor: z.string(),
  accountEmail: z.string().optional(),
  hasProfile: z.boolean().optional(),
  profileVersion: z.number().optional(),
});
const UNSUPPORTED_VENDOR = "This version of MCPJam can't sign in this kind of web account. Update MCPJam, then try again.";
const signInBody = z.object({ projectId: z.string().min(1) });
const saveBody = signInBody.extend({ browserSessionId: z.string().min(1).max(256) });

/** Anything but a yes refuses, a backend that can't say who manages included. */
const notManager = (c: Context, manages: false | undefined) =>
  manages === false
    ? c.json({ error: "Only a project admin can sign in a web account. Ask an admin to sign it in." }, 403)
    : c.json({ error: "MCPJam couldn't confirm you manage this project's web accounts. Try again later." }, 503);

/** The request's JSON, or undefined when it sent none or not JSON. */
async function jsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

const SIGN_IN_ENDED =
  "The browser closed while saving, so the account wasn't saved. Start signing in again, then save.";

const PERSON_HAS_BROWSER =
  "You have control of the browser, so the account couldn't be checked. Leave the browser alone for a moment, then save again.";

/**
 * What a failure can say without page text: its class, a driver code, the
 * daemon's status and its snake_case reason. Browser messages can quote the
 * vendor page, so they stay out; the original rides along as `cause`.
 */
function safeFailure(stage: string, error: unknown): Error {
  const parts: string[] = [stage, error instanceof Error ? error.name : typeof error];
  if (error instanceof RealUiError) parts.push(error.failure.kind);
  if (error instanceof PageDriverError) parts.push(error.code);
  if (error instanceof BrowserdClientError) {
    parts.push(String(error.httpStatus));
    const token = /"error":"([a-z][a-z0-9_]*)/.exec(error.message)?.[1];
    if (token) parts.push(token);
  }
  const safe = new Error(parts.join(": "), { cause: error });
  if (error instanceof Error && error.stack) {
    safe.stack = [safe.message, ...error.stack.split("\n").slice(1)].join("\n");
  }
  return safe;
}

/** The export closed the browser before it failed: nothing is left to retry on. */
function browserClosedByExport(error: unknown): boolean {
  return error instanceof BrowserdClientError && error.message.includes(PROFILE_EXPORT_BROWSER_CLOSED);
}

function personHasBrowser(error: unknown): boolean {
  return (
    (error instanceof PageDriverError && error.code === "person_has_browser") ||
    (error instanceof BrowserdClientError && error.httpStatus === 423)
  );
}

export function createWebAccountRoutes(deps: WebAccountRouteDeps): Hono {
  const app = new Hono();

  /** The account, with no vendor when it is one this Inspector can't drive. */
  const accountOf = async (actor: WebActor, projectId: string, webAccountId: string) => {
    const row = z
      .array(account.passthrough())
      .parse(await deps.service.read({ action: "listWebAccounts", projectId, ...actor }))
      .find((listed) => listed.webAccountId === webAccountId);
    return row && { ...row, vendor: WEB_CLIENT_VENDORS.find((vendor) => vendor === row.vendor) };
  };

  const guard = async (c: Context) => {
    if (!(await deps.isEnabled(c))) {
      return { error: c.json({ error: "Claude web and ChatGPT web are off for this account." }, 404) };
    }
    const actor = await deps.actorOf(c);
    if (!actor) return { error: c.json({ error: "Sign in to MCPJam, then try again." }, 401) };
    return { actor };
  };

  app.post("/accounts/:webAccountId/sign-in", async (c) => {
    const checked = await guard(c);
    if ("error" in checked) return checked.error;
    const parsed = signInBody.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: "Send the project id with the request." }, 400);
    const { projectId } = parsed.data;
    const webAccountId = c.req.param("webAccountId");
    const manages = await deps.mayManage({ actor: checked.actor, projectId, webAccountId });
    if (manages !== true) return notManager(c, manages);
    const row = await accountOf(checked.actor, projectId, webAccountId);
    if (!row) return c.json({ error: "This web account is not in the project. Refresh the list, then try again." }, 404);
    if (!row.vendor) return c.json({ error: UNSUPPORTED_VENDOR }, 404);
    const started = await deps.browser.start({
      actor: checked.actor,
      bearer: c.req.header("authorization") ?? "",
      projectId,
      webAccountId,
      restoreProfile: row.hasProfile === true,
      sites: WEB_CLIENT_SITES[row.vendor],
      startUrl: WEB_CLIENT_SIGN_IN_URLS[row.vendor],
    });
    return c.json({
      browserSessionId: started.browserSessionId,
      ...(started.chatSessionId ? { chatSessionId: started.chatSessionId } : {}),
    });
  });

  app.post("/accounts/:webAccountId/save-profile", async (c) => {
    const checked = await guard(c);
    if ("error" in checked) return checked.error;
    const parsed = saveBody.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "Send the project id and the browser session with the request." }, 400);
    }
    const { projectId, browserSessionId } = parsed.data;
    const actor = checked.actor;
    const webAccountId = c.req.param("webAccountId");
    const manages = await deps.mayManage({ actor, projectId, webAccountId });
    if (manages !== true) return notManager(c, manages);
    const row = await accountOf(actor, projectId, webAccountId);
    if (!row) return c.json({ error: "This web account is not in the project. Refresh the list, then try again." }, 404);
    if (!row.vendor) return c.json({ error: UNSUPPORTED_VENDOR }, 404);
    const browser = { actor, projectId, webAccountId, browserSessionId };
    let driver: PageDriver;
    try {
      driver = await deps.browser.driver(browser);
    } catch (error) {
      if (error instanceof SignInBrowserNotFoundError) return c.json({ error: error.message }, 409);
      throw error;
    }
    // Reading the vendor page and capturing a profile are safe to retry on
    // the same browser. Once storage starts, its outcome may be ambiguous.
    const release = () => deps.browser.release({ ...browser, bearer: c.req.header("authorization") ?? "" });
    const retryBeforeStorage = (stage: "identity" | "capture", error: unknown) => {
      // The person still holds the browser (the save's check, or the daemon's
      // export lease): their sign-in stays open for another save.
      if (personHasBrowser(error)) return c.json({ error: PERSON_HAS_BROWSER }, 409);
      reportRouteFailure("Web account profile save interrupted", safeFailure(stage, error), {
        source: `web-clients.save-profile.${stage}`, hop: "mcpjam_internal",
      });
      const message = stage === "identity"
        ? "Couldn’t check which account is signed in. Return to the chat in this browser, then save again."
        : "Couldn’t capture this browser profile. Keep the browser open and save again.";
      return c.json({ code: "WEB_ACCOUNT_PROFILE_RETRY", message }, 503);
    };
    let identity;
    try {
      identity = await PAGE_MODULES[row.vendor].signedIn(driver, { timeoutMs: 30_000 });
    } catch (error) {
      if (error instanceof RealUiError && error.failure.kind === "needs_sign_in") {
        return c.json({ ok: false, reason: "not_signed_in" });
      }
      return retryBeforeStorage("identity", error);
    }
    if (!identity.email) return c.json({ ok: false, reason: "not_signed_in" });
    if (row.accountEmail && row.accountEmail.toLowerCase() !== identity.email.toLowerCase()) {
      return c.json({ ok: false, reason: "wrong_account" });
    }
    let profile: Uint8Array;
    try {
      profile = await deps.browser.captureProfile(browser);
    } catch (error) {
      if (browserClosedByExport(error)) {
        reportRouteFailure("Web account profile save interrupted", safeFailure("capture", error), {
          source: "web-clients.save-profile.capture", hop: "mcpjam_internal",
        });
        await release();
        return c.json({ code: "WEB_ACCOUNT_SIGN_IN_ENDED", message: SIGN_IN_ENDED }, 503);
      }
      return retryBeforeStorage("capture", error);
    }
    try {
      const saved = await deps.saveProfile(actor, {
        webAccountId,
        expectedProfileVersion: row.profileVersion ?? 0,
        profile,
      });
      if (!saved.ok) return c.json({ ok: false, reason: saved.reason });
      await deps.service.apply({
        action: "markWebAccountVerified",
        webAccountId,
        accountEmail: identity.email,
        ...(identity.workspace ? { workspaceName: identity.workspace } : {}),
        ...actor,
      });
      return c.json({
        ok: true,
        accountEmail: identity.email,
        ...(identity.workspace ? { workspaceName: identity.workspace } : {}),
      });
    } finally {
      await release();
    }
  });

  return app;
}
