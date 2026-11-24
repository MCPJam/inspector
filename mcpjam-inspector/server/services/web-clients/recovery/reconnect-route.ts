/**
 * `POST /api/web-clients/reconnect/:requestId/handback
 *   { projectId, browserSessionId? }`: a signed-in person finished signing a
 * web account in again. Hosted, they signed in in the sign-in browser this
 * server holds for the account, and `browserSessionId` names it; a local
 * Inspector reads this machine's own profile and sends none. Acting as them,
 * recovery checks the browser shows the account's own seat and workspace,
 * saves its profile, and resumes the runs that waited. The backend decides
 * who may hand an account back.
 *
 * Answers `{ status: "resumed", resumedRuns }`, or `{ status }` with
 * `not_signed_in`, `wrong_identity`, `not_found` or `cancelled`. A hosted
 * handback that names no sign-in browser answers 400. A sign-in browser this
 * server doesn't hold, or one opened for another account, answers 409 with
 * what the person does next.
 */
import { Hono } from "hono";
import { z } from "zod";
import { bearerAuthMiddleware } from "../../../middleware/bearer-auth.js";
import { requireVerifiedAuth } from "../../../middleware/require-verified-auth.js";
import { logger } from "../../../utils/logger.js";
import { reportRouteFailure } from "../../../utils/route-error-report.js";
import { getServiceCredential } from "../../service-credential.js";
import {
  webClientService,
  type WebClientService,
} from "../backend-connector-resolver.js";
import { webClientsEnabledFor } from "../endpoint-auth.js";
import { accountBrowserOver } from "./account-browser.js";
import {
  createConvexLedgerReader,
  createConvexWebReconnectBackend,
  type ProfileKeyRoute,
  type WebActor,
} from "./convex-backend.js";
import { createWebRecoveryCoordinator } from "./coordinator.js";
import { resumeWebRun } from "./paused-runs.js";
import {
  SignInBrowserAccountMismatchError,
  SignInBrowserNotNamedError,
  webRecovery,
  type HandbackBrowsers,
} from "./turn-recovery.js";

export type WebReconnectRouteDeps = {
  service: WebClientService;
  profileKeyRoute: ProfileKeyRoute;
  /** Where the person's signed-in browser is: the recovery setup's, by default. */
  environmentFor(handback: {
    actor: WebActor;
    projectId: string;
    browserSessionId?: string;
  }): Promise<HandbackBrowsers | undefined>;
  enabledFor(userId: string): Promise<boolean>;
};

/** This process's backend client, or undefined without the service credential. */
function processDeps(): WebReconnectRouteDeps | undefined {
  const service = webClientService();
  const serviceToken = getServiceCredential();
  const convexHttpUrl = process.env.CONVEX_HTTP_URL?.trim();
  if (!service || !serviceToken || !convexHttpUrl) return undefined;
  return {
    service,
    profileKeyRoute: { convexHttpUrl, serviceToken },
    environmentFor: async (handback) =>
      webRecovery()?.handbackEnvironment?.(handback),
    enabledFor: webClientsEnabledFor,
  };
}

const handbackBody = z.object({
  projectId: z.string().min(1).max(512),
  /** The sign-in browser the person signed in with, from the sign-in route. */
  browserSessionId: z.string().min(1).max(256).optional(),
});

export function createWebReconnectRoutes(
  deps: WebReconnectRouteDeps | undefined = processDeps(),
): Hono {
  const routes = new Hono();
  routes.use("*", bearerAuthMiddleware, requireVerifiedAuth());
  routes.post("/:requestId/handback", async (c) => {
    const userId = c.get("workosUserId");
    if (typeof userId !== "string" || !userId || c.get("guestId")) {
      return c.json({ error: "Sign in to hand this account back." }, 401);
    }
    // With the flag off the route answers as if it weren't there, whatever the body.
    if (!deps || !(await deps.enabledFor(userId))) {
      return c.json(
        { error: "Web accounts aren't available on this server." },
        404,
      );
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      // A body that isn't JSON names no project; the schema refuses it below.
      raw = undefined;
    }
    const body = handbackBody.safeParse(raw);
    if (!body.success) {
      return c.json(
        { error: "Say which project the account belongs to, then try again." },
        400,
      );
    }
    const actor = { actorExternalId: userId };
    let environment: HandbackBrowsers | undefined;
    try {
      environment = await deps.environmentFor({
        actor,
        projectId: body.data.projectId,
        ...(body.data.browserSessionId
          ? { browserSessionId: body.data.browserSessionId }
          : {}),
      });
    } catch (error) {
      if (error instanceof SignInBrowserNotNamedError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }
    if (!environment) {
      return c.json(
        {
          error:
            "The browser you signed in with isn't open here anymore. Take over the browser again, sign in, then finish.",
        },
        409,
      );
    }
    let browser: ReturnType<typeof accountBrowserOver> | undefined;
    try {
      const coordinator = createWebRecoveryCoordinator({
        backend: createConvexWebReconnectBackend(actor, {
          service: deps.service,
          route: deps.profileKeyRoute,
        }),
        ledger: createConvexLedgerReader(deps.service),
        resumeRun: resumeWebRun,
      });
      const outcome = await coordinator.handback({
        projectId: body.data.projectId,
        requestId: c.req.param("requestId"),
        browserFor: (account) => {
          if (!account.vendor)
            throw new Error("The web account names no vendor.");
          browser = accountBrowserOver(environment, {
            webAccountId: account.webAccountId,
            vendor: account.vendor,
          });
          return browser;
        },
      });
      if (outcome.status !== "resumed")
        return c.json({ status: outcome.status });
      // Only turns woken here count. One paused on another replica resumes
      // when it next reads its request; a run no turn waits for is sent again.
      const resumedRuns = outcome.runs.filter(
        (run) => run.status === "resumed",
      ).length;
      return c.json({ status: "resumed", resumedRuns });
    } catch (error) {
      // Not an outage: trying again with the same browser can't succeed.
      if (error instanceof SignInBrowserAccountMismatchError) {
        return c.json({ error: error.message }, 409);
      }
      reportRouteFailure("A web account could not be handed back", error, {
        source: "web-clients.reconnect.handback",
        hop: "mcpjam_internal",
      });
      return c.json(
        {
          error:
            "The handback didn't finish. Check whether your runs resumed before you try again.",
        },
        502,
      );
    } finally {
      // The handback's answer stands even when its browser won't close.
      await browser?.close().catch((error: unknown) => {
        logger.warn("[web-recovery] The handback browser did not close", {
          requestId: c.req.param("requestId"),
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });
  return routes;
}
