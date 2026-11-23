/**
 * `POST /api/web-clients/reconnect/:requestId/handback { projectId }`: a
 * signed-in person finished signing a web account in again, in the browser
 * this server holds for it. Acting as them, recovery checks the browser shows
 * the account's own seat and workspace, saves its profile, and resumes the
 * runs that waited. The backend decides who may hand an account back.
 *
 * Answers `{ status: "resumed", resumedRuns }`, or `{ status }` with
 * `not_signed_in`, `wrong_identity`, `not_found` or `cancelled`.
 */
import { Hono } from "hono";
import { z } from "zod";
import { bearerAuthMiddleware } from "../../../middleware/bearer-auth.js";
import { requireVerifiedAuth } from "../../../middleware/require-verified-auth.js";
import { reportRouteFailure } from "../../../utils/route-error-report.js";
import { getServiceCredential } from "../../service-credential.js";
import {
  webClientService,
  type WebClientService,
} from "../backend-connector-resolver.js";
import { webClientsEnabledFor } from "../endpoint-auth.js";
import type { WebClientEnvironment } from "../web-client-environment.js";
import { accountBrowserOver } from "./account-browser.js";
import {
  createConvexLedgerReader,
  createConvexWebReconnectBackend,
  type ProfileKeyRoute,
  type WebActor,
} from "./convex-backend.js";
import { createWebRecoveryCoordinator } from "./coordinator.js";
import { resumeWebRun } from "./paused-runs.js";
import { webRecovery } from "./turn-recovery.js";

export type WebReconnectRouteDeps = {
  service: WebClientService;
  profileKeyRoute: ProfileKeyRoute;
  /** Where the person's signed-in browser is: the recovery setup's, by default. */
  environmentFor(handback: {
    actor: WebActor;
    projectId: string;
  }): Promise<WebClientEnvironment | undefined>;
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

const handbackBody = z.object({ projectId: z.string().min(1).max(512) });

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
    if (!deps || !(await deps.enabledFor(userId))) {
      return c.json(
        { error: "Web accounts aren't available on this server." },
        404,
      );
    }
    const environment = await deps.environmentFor({
      actor,
      projectId: body.data.projectId,
    });
    if (!environment) {
      return c.json(
        {
          error:
            "This server can't open a signed-in browser for web accounts yet.",
        },
        503,
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
      reportRouteFailure("A web account could not be handed back", error, {
        source: "web-clients.reconnect.handback",
        hop: "mcpjam_internal",
      });
      return c.json(
        {
          error:
            "The account wasn't handed back. Try again in a minute; the runs are still paused.",
        },
        502,
      );
    } finally {
      await browser?.close();
    }
  });
  return routes;
}
