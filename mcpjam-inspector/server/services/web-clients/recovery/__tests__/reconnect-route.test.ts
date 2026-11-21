/**
 * The handback route over HTTP, with the sign-in middleware stubbed to name
 * the caller, a stubbed backend service client, and an environment whose
 * browser shows whichever seat the test signs in.
 */
import { Hono } from "hono";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../middleware/bearer-auth.js", () => ({
  bearerAuthMiddleware: async (
    c: {
      req: { header(name: string): string | undefined };
      set(key: string, value: string): void;
    },
    next: () => Promise<void>,
  ) => {
    const user = c.req.header("x-test-user");
    if (user) c.set("workosUserId", user);
    if (c.req.header("x-test-guest")) c.set("guestId", "guest-1");
    await next();
  },
}));
vi.mock("../../../../middleware/require-verified-auth.js", () => ({
  requireVerifiedAuth: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}));
const reported = vi.hoisted(() => vi.fn());
vi.mock("../../../../utils/route-error-report.js", () => ({
  reportRouteFailure: reported,
}));
vi.mock("../../../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { needsSignIn } from "../../../../utils/harness/real-ui/page-module.js";
import { createFixtureWebPageModule } from "../../../../utils/harness/real-ui/fixture-web.js";
import type { PageDriver } from "../../../../utils/harness/real-ui/page-driver.js";
import type { WebClientService } from "../../backend-connector-resolver.js";
import type { WebClientEnvironment } from "../../web-client-environment.js";
import {
  createWebReconnectRoutes,
  type WebReconnectRouteDeps,
} from "../reconnect-route.js";

const SEAT = { email: "seat@example.com", workspace: "Test workspace" };
const ACCOUNT_VIEW = {
  webAccountId: "web-account-1",
  projectId: "project-1",
  vendor: "claude",
  status: "needs_sign_in",
  accountEmail: SEAT.email,
  workspaceName: SEAT.workspace,
  profileVersion: 3,
};
const request = (status: string) => ({
  requestId: "request-1",
  webAccountId: "web-account-1",
  status,
  reason: "signed_out",
  openedAt: 1,
  notificationCount: 1,
  waitingRunCount: 1,
});

const fakeDriver: PageDriver = {
  kind: "playwright",
  canEvaluate: false,
  navigate: async () => {},
  url: async () => "https://claude.ai/new",
  evaluate: async () => {
    throw new Error("unused");
  },
  waitFor: async () => {},
  click: async () => {},
  type: async () => {},
  press: async () => {},
  readText: async () => undefined,
};

let commands: Array<Record<string, unknown>>;
let signedInAs: typeof SEAT | undefined;
let closed: number;

function deps(answers: Record<string, unknown>) {
  const answer = async (command: Record<string, unknown>) => {
    commands.push(command);
    const value = answers[String(command.action)];
    if (value instanceof Error) throw value;
    return value ?? null;
  };
  const service: WebClientService = { read: answer, apply: answer };
  const environment: WebClientEnvironment = {
    publicBaseUrl: "https://inspector.example.test",
    journal: { read: async () => undefined, write: async () => {} },
    pageModule: {
      ...createFixtureWebPageModule("https://claude.ai"),
      async signedIn() {
        if (!signedInAs)
          throw needsSignIn("signed_out", "sign_in_check", "Signed out.");
        return signedInAs;
      },
    },
    resolveAccount: async () => ({ webAccountId: "web-account-1" }),
    ensureConnector: async () => ({ connectorId: "connector-1" }),
    async openBrowser() {
      const handle = {
        driver: fakeDriver,
        close: async () => {
          closed += 1;
        },
        captureProfile: async () => new TextEncoder().encode("fixture-profile"),
      };
      return handle;
    },
  };
  const fetchImpl: typeof fetch = async (input) =>
    String(input).endsWith("/profile-key")
      ? Response.json({
          expectedProfileVersion: 3,
          dataKey: Buffer.alloc(32, 7).toString("base64"),
          wrappedKey: "sealed-key",
          uploadUrl: "https://storage.example.test/upload",
        })
      : Response.json({ storageId: "storage-1" });
  return {
    service,
    profileKeyRoute: {
      convexHttpUrl: "https://routes.example.test",
      serviceToken: "fixture-service-token",
      fetchImpl,
    },
    environmentFor: async () => environment,
    enabledFor: async (userId: string) => userId !== "user_flag_off",
  };
}

const OPEN = {
  listWebReconnectRequests: [request("open")],
  listWebAccounts: [ACCOUNT_VIEW],
  saveWebAccountProfile: { ok: true, profileVersion: 4 },
  handbackWebReconnect: { resumableRunIds: ["run-1"] },
  claimResumableWebRuns: [
    {
      runId: "run-1",
      requestId: "request-1",
      pendingStep: JSON.stringify({
        stepId: "reply",
        startedAt: "2026-11-20T10:00:00.000Z",
      }),
    },
  ],
};

async function post(
  answers: Record<string, unknown>,
  headers: Record<string, string> = { "x-test-user": "user_admin" },
  body: unknown = { projectId: "project-1" },
  override: Partial<WebReconnectRouteDeps> = {},
) {
  const app = new Hono().route(
    "/api/web-clients/reconnect",
    createWebReconnectRoutes({ ...deps(answers), ...override }),
  );
  const response = await app.request(
    "/api/web-clients/reconnect/request-1/handback",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

beforeEach(() => {
  commands = [];
  signedInAs = SEAT;
  closed = 0;
  reported.mockClear();
});

describe("POST /api/web-clients/reconnect/:requestId/handback", () => {
  it("hands the account back as the signed-in person and resumes its runs", async () => {
    expect(await post(OPEN)).toEqual({
      status: 200,
      body: { status: "resumed", resumedRuns: 1 },
    });
    expect(commands.map((command) => command.action)).toEqual([
      "listWebReconnectRequests",
      "listWebAccounts",
      "saveWebAccountProfile",
      "handbackWebReconnect",
      "claimResumableWebRuns",
    ]);
    for (const command of commands) {
      expect(command).toMatchObject({ actorExternalId: "user_admin" });
    }
    expect(commands[3]).toMatchObject({
      requestId: "request-1",
      verifiedAccountEmail: SEAT.email,
      verifiedWorkspace: SEAT.workspace,
    });
    expect(closed).toBe(1);
  });

  it.each([
    [
      "wrong_identity",
      OPEN,
      { email: "other@example.com", workspace: SEAT.workspace },
    ],
    ["not_signed_in", OPEN, undefined],
    ["not_found", { ...OPEN, listWebReconnectRequests: [] }, SEAT],
    [
      "cancelled",
      { ...OPEN, listWebReconnectRequests: [request("cancelled")] },
      SEAT,
    ],
    [
      "not_found",
      { ...OPEN, handbackWebReconnect: new ConvexError({ code: "NOT_FOUND" }) },
      SEAT,
    ],
  ] as const)("answers %s", async (status, answers, seat) => {
    signedInAs = seat;
    expect(await post(answers)).toEqual({ status: 200, body: { status } });
    expect(commands.map((command) => command.action)).not.toContain(
      "claimResumableWebRuns",
    );
  });

  it("refuses a caller who isn't signed in, a guest, and an account without the flag", async () => {
    expect((await post(OPEN, {})).status).toBe(401);
    expect(
      (await post(OPEN, { "x-test-user": "user_admin", "x-test-guest": "1" }))
        .status,
    ).toBe(401);
    expect((await post(OPEN, { "x-test-user": "user_flag_off" })).status).toBe(
      404,
    );
    expect((await post(OPEN, undefined, { project: "project-1" })).status).toBe(
      400,
    );
    expect(commands).toEqual([]);
  });

  it("says to sign in again when this server holds no browser to hand the account back from", async () => {
    const environmentFor = vi.fn(async () => undefined);
    const answered = await post(OPEN, undefined, undefined, { environmentFor });
    expect(answered.status).toBe(409);
    expect(answered.body.error).toMatch(/Take over the browser again/);
    expect(environmentFor).toHaveBeenCalledWith({
      actor: { actorExternalId: "user_admin" },
      projectId: "project-1",
    });
    expect(commands).toEqual([]);
  });

  it("looks for the sign-in browser the request names", async () => {
    const environmentFor = vi.fn(async () => undefined);
    await post(
      OPEN,
      undefined,
      { projectId: "project-1", browserSessionId: "browser-1" },
      { environmentFor },
    );
    expect(environmentFor).toHaveBeenCalledWith({
      actor: { actorExternalId: "user_admin" },
      projectId: "project-1",
      browserSessionId: "browser-1",
    });
  });

  it("reports a backend failure and says the runs are still paused", async () => {
    const offline = new Error("socket hang up");
    const answered = await post({ ...OPEN, listWebReconnectRequests: offline });
    expect(answered.status).toBe(502);
    expect(answered.body.error).toMatch(/the runs are still paused/);
    expect(reported).toHaveBeenCalledWith(
      "A web account could not be handed back",
      offline,
      expect.objectContaining({ hop: "mcpjam_internal" }),
    );
  });
});
