/**
 * The hosted mount: what a replica does with a request that is not, and cannot
 * be, backed by a browser on this machine.
 *
 * A separate file from `webmcp-inspector.test.ts` because `HOSTED_MODE` is a
 * module constant read at import, so the two modes cannot share a suite.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const configState = vi.hoisted(() => ({
  enabled: true,
  hostedBrowser: false,
  webmcpHosted: true,
}));
vi.mock("../../../config", () => ({
  get WEBMCP_INSPECTOR_ENABLED() {
    return configState.enabled;
  },
  hostedBrowserEnabled: () => configState.hostedBrowser,
  webmcpInspectorHostedEnabled: () => configState.webmcpHosted,
  HOSTED_MODE: true,
}));

const gateState = vi.hoisted(() => ({ provisionable: true as boolean | null }));
vi.mock("../../../utils/computers/runtime-config.js", () => ({
  isHostedDesktopProvisionable: () => gateState.provisionable,
}));

const hostedState = vi.hoisted(() => ({
  ensureCalls: [] as Array<Record<string, unknown>>,
  /** Thrown by `ensureLiveBrowserSession` when set. */
  failWith: null as unknown,
}));
vi.mock("../../../services/browserd/live-session-deps.js", () => ({
  ensureLiveBrowserSession: (args: Record<string, unknown>) => {
    hostedState.ensureCalls.push(args);
    return Promise.reject(
      hostedState.failWith ?? new Error("not reached in this test"),
    );
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-bearer",
}));

import { Hono } from "hono";
import webmcpInspector from "../webmcp-inspector";
import { HostedReserveError } from "../../../services/browserd/hosted-reserve-error";
import {
  hostedSessionId,
  startWebMcpSession,
  webMcpSessions,
} from "../../../services/webmcp-inspector/session-registry";
import {
  FakeProvider,
  fakeTool,
  type FakeBrowserSession,
} from "../../../services/webmcp-inspector/__tests__/fake-provider";
import { WEBMCP_RESULT_CAP_BYTES } from "@/shared/webmcp-inspector-protocol";

/**
 * Stands in for `bearerAuthMiddleware` + `requireVerifiedAuth`, which the web
 * router mounts in front of this one. `verified` is what those establish and
 * what an `unverified_passthrough` request pointedly lacks.
 */
function appWith(vars: Record<string, string> = {}) {
  return new Hono()
    .use("*", async (c, next) => {
      for (const [key, value] of Object.entries(vars))
        c.set(key as never, value as never);
      await next();
    })
    .route("/api/web/webmcp", webmcpInspector);
}

const VERIFIED = { workosUserId: "user-1" };

async function post(
  app: Hono,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request(`http://hosted${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const START = { url: "https://a.test", projectId: "p1" };

describe("hosted WebMCP inspector — reachability", () => {
  beforeEach(() => {
    configState.enabled = true;
    configState.webmcpHosted = true;
    configState.hostedBrowser = false;
    gateState.provisionable = true;
    hostedState.ensureCalls.length = 0;
    hostedState.failWith = null;
  });

  it("is 404 — not 403 — when the hosted gate is off", async () => {
    // Off means undiscoverable. A 403 tells a prober the route is there.
    configState.webmcpHosted = false;
    const { status, body } = await post(
      appWith(VERIFIED),
      "/api/web/webmcp/sessions",
      START,
    );
    expect(status).toBe(404);
    expect(body.code).toBe("webmcp-inspector-disabled");
  });

  it("is 404 when the global kill switch is off, hosted gate or not", async () => {
    configState.enabled = false;
    const { status } = await post(
      appWith(VERIFIED),
      "/api/web/webmcp/sessions",
      START,
    );
    expect(status).toBe(404);
  });
});

describe("hosted WebMCP inspector — who may drive a browser", () => {
  beforeEach(() => {
    configState.enabled = true;
    configState.webmcpHosted = true;
    gateState.provisionable = true;
    hostedState.ensureCalls.length = 0;
    hostedState.failWith = null;
  });

  it("refuses a bearer nothing verified, and reserves nothing", async () => {
    // THE hole this closes. `bearerAuthMiddleware` lets an unrecognized JWT
    // through labelled `unverified_passthrough`; a route that then serves
    // sessions out of an in-process map has nothing downstream to catch it.
    const { status, body } = await post(
      appWith({ authMethod: "unverified_passthrough" }),
      "/api/web/webmcp/sessions",
      START,
    );
    expect(status).toBe(401);
    expect(body.code).toBe("hosted-auth-required");
    expect(hostedState.ensureCalls).toHaveLength(0);
  });

  it("refuses a guest — there is no computer to bill", async () => {
    const { status, body } = await post(
      appWith({ guestId: "guest-9", workosUserId: "user-1" }),
      "/api/web/webmcp/sessions",
      START,
    );
    expect(status).toBe(403);
    expect(body.code).toBe("hosted-guest-unsupported");
    expect(hostedState.ensureCalls).toHaveLength(0);
  });

  it("accepts an API-key caller, whose identity the bearer middleware resolved", async () => {
    const { body } = await post(
      appWith({ authMethod: "workos_api_key", mcpjamUserId: "user-7" }),
      "/api/web/webmcp/sessions",
      START,
    );
    // Reached the reserve, which is as far as this suite's fake goes.
    expect(hostedState.ensureCalls).toHaveLength(1);
    expect(body.code).not.toBe("hosted-auth-required");
  });
});

describe("hosted WebMCP inspector — a local browser is not on offer", () => {
  beforeEach(() => {
    configState.enabled = true;
    configState.webmcpHosted = true;
    gateState.provisionable = true;
    hostedState.ensureCalls.length = 0;
  });

  for (const [label, payload] of [
    ["an explicit local transport", { ...START, transport: "local" }],
    ["an in-app viewport", { ...START, display: "in-app" }],
    ["a window viewport", { ...START, display: "window" }],
    ["an embedded surface id", { ...START, webContentsId: 12 }],
  ] as const) {
    it(`refuses ${label} with a code the UI can explain`, async () => {
      const { status, body } = await post(
        appWith(VERIFIED),
        "/api/web/webmcp/sessions",
        payload,
      );
      expect(status).toBe(400);
      expect(body.code).toBe("hosted-local-unsupported");
      expect(hostedState.ensureCalls).toHaveLength(0);
    });
  }

  it("needs no transport field at all — hosted is forced, not defaulted", async () => {
    await post(appWith(VERIFIED), "/api/web/webmcp/sessions", START);
    expect(hostedState.ensureCalls).toHaveLength(1);
    expect(hostedState.ensureCalls[0]).toMatchObject({
      projectId: "p1",
      contextMode: "persistent",
      bearer: "convex-bearer",
    });
  });

  it("still needs a project — that is whose computer it runs on", async () => {
    const { status, body } = await post(
      appWith(VERIFIED),
      "/api/web/webmcp/sessions",
      { url: "https://a.test" },
    );
    expect(status).toBe(400);
    expect(body.code).toBe("hosted-project-required");
  });
});

describe("hosted WebMCP inspector — the backend's desktop verdict", () => {
  beforeEach(() => {
    configState.enabled = true;
    configState.webmcpHosted = true;
    hostedState.ensureCalls.length = 0;
  });

  it("refuses when the backend says a desktop would not boot", async () => {
    // An unset credit rate is the case worth refusing on: the machine boots
    // and meters at the terminal price, and nobody notices until the bill.
    gateState.provisionable = false;
    const { status, body } = await post(
      appWith(VERIFIED),
      "/api/web/webmcp/sessions",
      START,
    );
    expect(status).toBe(503);
    expect(body.code).toBe("hosted-desktop-unconfigured");
    expect(hostedState.ensureCalls).toHaveLength(0);
  });

  it("proceeds on silence — an older backend is not a refusal", async () => {
    gateState.provisionable = null;
    await post(appWith(VERIFIED), "/api/web/webmcp/sessions", START);
    expect(hostedState.ensureCalls).toHaveLength(1);
  });
});

describe("hosted WebMCP inspector — control-plane refusals are answers, not crashes", () => {
  beforeEach(() => {
    configState.enabled = true;
    configState.webmcpHosted = true;
    gateState.provisionable = true;
    hostedState.ensureCalls.length = 0;
  });

  for (const [status, code] of [
    [401, "hosted-auth-required"],
    [403, "hosted-forbidden"],
    [429, "hosted-at-capacity"],
    [503, "hosted-at-capacity"],
    [504, "hosted-reserve-timeout"],
    [502, "hosted-provision-failed"],
    // The one remap: the control plane says 410, the caller hears 409, so a
    // regression here is invisible unless it is pinned.
    [410, "hosted-desktop-deleted"],
    [0, "hosted-unconfigured"],
  ] as const) {
    it(`maps a ${status} from the control plane to ${code}`, async () => {
      hostedState.failWith = new HostedReserveError("nope", status);
      const res = await post(
        appWith(VERIFIED),
        "/api/web/webmcp/sessions",
        START,
      );
      // Never a 500: every one of these is a condition, not a bug, and a 500
      // additionally means a Sentry event for someone hitting their own quota.
      expect(res.status).not.toBe(500);
      expect(res.body.code).toBe(code);
    });
  }

  it("keeps the 500 path for a reserve STATUS it has no mapping for", async () => {
    hostedState.failWith = new HostedReserveError("teapot", 418);
    const { status } = await post(
      appWith(VERIFIED),
      "/api/web/webmcp/sessions",
      START,
    );
    expect(status).toBe(500);
  });

  it("keeps the 500-and-report path for a failure it does not recognize", async () => {
    hostedState.failWith = new Error("something genuinely broke");
    const { status } = await post(
      appWith(VERIFIED),
      "/api/web/webmcp/sessions",
      START,
    );
    expect(status).toBe(500);
  });
});

/**
 * What a hosted invocation ANSWERS with.
 *
 * Hosted does not point the caller at the activity stream for the settle: the
 * subscriber watching it may be attached to a different replica than the one
 * that ran the tool, so the invoke response IS the settle. That makes its shape
 * load-bearing in a way the local 202 never was — chat fulfils a model's
 * page-tool call straight from this value.
 */
describe("hosted WebMCP inspector — the invocation's answer", () => {
  const SESSION_ID = hostedSessionId("p1", "c1");

  /** A live hosted runtime in the registry, as a prior `POST` would leave. */
  async function liveSession(): Promise<FakeBrowserSession> {
    const provider = new FakeProvider();
    await startWebMcpSession({
      url: "https://a.test",
      provider,
      sessionId: SESSION_ID,
      ownerId: VERIFIED.workosUserId,
    });
    const session = provider.sessions.at(-1)!;
    session.emitTools([fakeTool({ name: "echo" })]);
    return session;
  }

  const invoke = (input: Record<string, unknown> = {}) =>
    post(appWith(VERIFIED), `/api/web/webmcp/sessions/${SESSION_ID}/command`, {
      type: "invoke_tool",
      toolKey: "https://example.test::echo",
      input,
      source: "chat",
    });

  beforeEach(async () => {
    await webMcpSessions.disposeAll("test");
  });

  it("carries the tool's OUTPUT, not just that it succeeded", async () => {
    // The regression this exists for: an outcome of `{state:"succeeded"}` with
    // nothing in it reaches the model as `null`, so every hosted page tool
    // answers a question with nothing while reporting that it worked.
    await liveSession();
    const { status, body } = await invoke({ a: 1 });
    expect(status).toBe(200);
    expect(body.outcome).toMatchObject({
      state: "succeeded",
      output: { echoed: { a: 1 } },
    });
    expect(body.outcome.outputTruncated).toBeUndefined();
  });

  it("says how much it cut when the result did not fit", async () => {
    await liveSession();
    const { body } = await invoke({ big: "x".repeat(WEBMCP_RESULT_CAP_BYTES) });
    expect(body.outcome.state).toBe("succeeded");
    expect(body.outcome.outputTruncated).toBe(true);
    // The size BEFORE the cut — the figure is only useful as the whole.
    expect(body.outcome.outputBytes).toBeGreaterThan(WEBMCP_RESULT_CAP_BYTES);
    expect(String(body.outcome.output)).toContain("truncated");
  });

  it("names a failure in the field the client actually reads", async () => {
    // `errorMessage`, as `invocation_settled` carries it — not `error`. The
    // two shipped differing, and the client, typed against the stream's shape,
    // read `undefined` and told the model the tool had failed for no reason.
    const session = await liveSession();
    session.failNextInvokeWith = "the page said no";
    const { body } = await invoke();
    expect(body.outcome).toMatchObject({
      state: "failed",
      errorMessage: "the page said no",
    });
  });
});
