/**
 * The live seams against a fake backend: every call is a lease-guarded
 * service route, the desktop is the reservation's own box, the recording is
 * read off it before `close`, and the authorization is prepared here with the
 * verifier sent only to the backend. The browser session, the recording
 * collector and the authorization preparation are mocked at their modules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureLiveBrowserSession = vi.fn();
const prepareAuthorization = vi.fn();
const runConnectionJob = vi.fn();
vi.mock("../../server-connection-worker.js", () => ({
  runConnectionJob: (id: string) => runConnectionJob(id),
}));
/** What the live seams handed the agent, and how the fake agent answers. */
let agentDeps:
  | import("../reviewer-sign-in-agent.js").SignInAgentDeps
  | undefined;
let agentRun = vi.fn();

vi.mock("../../browserd/live-session-deps.js", () => ({
  ensureLiveBrowserSession: (...args: unknown[]) =>
    ensureLiveBrowserSession(...args),
}));
vi.mock("../reviewer-sign-in-agent.js", () => ({
  createSignInAgent: (
    given: import("../reviewer-sign-in-agent.js").SignInAgentDeps,
  ) => {
    agentDeps = given;
    return {
      features: given.features,
      run: (input: unknown) => agentRun(input),
    };
  },
}));
// The polls wait for nothing here; what they ask for is what is tested.
vi.mock("node:timers/promises", () => ({ setTimeout: async () => undefined }));
vi.mock("../../server-connection-authorize.js", () => ({
  prepareAuthorization: (...args: unknown[]) => prepareAuthorization(...args),
}));

const { liveReviewerSignInDeps, rehearseReviewerSignInLive } =
  await import("../reviewer-sign-in-live.js");
const { ReadinessLeaseLostError } = await import("../runner.js");
const { logger } = await import("../../../utils/logger.js");

const LEASE = { runId: "run_1", jobId: "job_1" };
const ATTEMPT = {
  projectId: "proj_1",
  passwordSecretName: "MCPJAM_REVIEWER_ACME_PASSWORD",
  usernameSecretName: "MCPJAM_REVIEWER_ACME_EMAIL",
};
const RUNS = "/internal/v1/claude-readiness/runs";
const CONNECTIONS = "/internal/v1/claude-readiness/reviewer-connections";

type Answer = [status: number, body: unknown];
let routes: Record<string, (body: Record<string, unknown>) => Answer>;
let posted: Array<{ path: string; body: Record<string, unknown> }>;

function stubBackend() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      posted.push({ path: url.pathname, body });
      const route = routes[url.pathname];
      if (!route)
        return new Response("No matching routes found", { status: 404 });
      const [status, answer] = route(body);
      return new Response(JSON.stringify(answer), { status });
    }),
  );
}

const deps = () =>
  liveReviewerSignInDeps({
    lease: LEASE,
    attemptId: "att_1",
    attempt: ATTEMPT,
  });
const paths = () => posted.map((call) => call.path);

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://backend.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
  posted = [];
  routes = {};
  stubBackend();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete process.env.CONVEX_HTTP_URL;
  delete process.env.INSPECTOR_SERVICE_TOKEN;
});

describe("the desktop", () => {
  function handle() {
    const sendCommand = vi.fn(
      async (command: { action: Record<string, unknown> }) => {
        const output =
          command.action.mode === "a11y"
            ? {
                url: "https://acme.authkit.app/sign-in",
                refs: { e1: { role: "textbox", name: "Email" } },
              }
            : command.action.mode === "text"
              ? { url: "https://acme.authkit.app/sign-in", text: "Sign in" }
              : {};
        return { status: "ok", bootId: "boot_1", result: { ok: true, output } };
      },
    );
    return {
      bootId: "boot_1",
      client: {
        status: vi.fn(async () => ({
          kind: "ok",
          bootId: "boot_1",
          features: ["secret-origins"],
        })),
        sendCommand,
      },
    };
  }

  beforeEach(() => {
    let desktopAsks = 0;
    routes = {
      [`${RUNS}/browser-session`]: () => [
        200,
        { ok: true, reservation: { id: "res_1" }, session: {} },
      ],
      // The box is still starting on the first ask.
      [`${RUNS}/browser-session/desktop`]: () =>
        desktopAsks++ === 0
          ? [
              409,
              {
                ok: false,
                error: "desktop_starting",
                message: "The desktop is still starting.",
              },
            ]
          : [200, { ok: true, sandboxRowId: "row_1", sandboxId: "sbx_1" }],
      [`${RUNS}/browser-session/bind`]: () => [200, { ok: true, session: {} }],
      [`${RUNS}/browser-session/boot`]: () => [200, { ok: true }],
      [`${RUNS}/browser-session/close`]: () => [200, { ok: true, released: 1 }],
      [`${RUNS}/browser-session/recording/upload-url`]: () => [
        200,
        {
          ok: true,
          uploadUrl: "https://storage.test/upload",
          uploadGrantId: "grant_1",
        },
      ],
      "/upload": () => [200, { storageId: "store_1" }],
      [`${RUNS}/browser-session/recording`]: () => [
        200,
        { ok: true, attached: true },
      ],
    };
  });

  it("reserves a blank, unrecorded browser, boots the reservation's own box and hands it to the agent", async () => {
    const live = handle();
    ensureLiveBrowserSession.mockResolvedValue(live);
    const { agent } = await deps().desktop.reserve(
      new AbortController().signal,
    );

    expect(posted[0]).toEqual({
      path: `${RUNS}/browser-session`,
      body: { ...LEASE, profile: "blank" },
    });
    expect(posted.find((call) => call.path.endsWith("/bind"))!.body).toEqual({
      ...LEASE,
      reservationId: "res_1",
      sandboxRowId: "row_1",
    });
    // Not recorded: credentials are typed on this desktop. Public addresses
    // only: the submitter's pages steer this browser.
    expect(ensureLiveBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        contextMode: "ephemeral",
        networkPolicy: "public",
        target: {
          kind: "sandbox",
          sandboxRowId: "row_1",
          sandboxId: "sbx_1",
          record: false,
        },
      }),
    );
    expect(
      posted.find((call) => call.path.endsWith("/boot"))!.body,
    ).toMatchObject({
      reservationId: "res_1",
      bootId: "boot_1",
    });
    expect(agent.features).toEqual(["secret-origins"]);
    expect(agentDeps).toMatchObject({
      handle: live,
      lease: LEASE,
      attemptId: "att_1",
      projectId: "proj_1",
      sandbox: { sandboxRowId: "row_1", sandboxId: "sbx_1" },
    });
  });

  it("keeps the one password try on the attempt, and gives back only a try that typed nothing", async () => {
    ensureLiveBrowserSession.mockResolvedValue(handle());
    let spent: string | undefined;
    routes[`${RUNS}/reviewer-attempt`] = (body) => {
      const submission = body.passwordSubmission as {
        commandId: string;
        outcome: string;
      };
      if (submission.outcome === "not_typed") {
        if (spent === submission.commandId) spent = undefined;
        return [200, { ok: true, attempt: {} }];
      }
      if (spent && spent !== submission.commandId) {
        return [
          409,
          {
            ok: false,
            error: "password_already_submitted",
            message:
              "MCPJam already typed the reviewer password once in this attempt.",
          },
        ];
      }
      spent = submission.commandId;
      return [200, { ok: true, attempt: {} }];
    };
    await deps().desktop.reserve(new AbortController().signal);
    const password = agentDeps!.password;
    expect(await password.mark("c1")).toBeUndefined();
    expect(await password.mark("c2")).toMatch(
      /^password_already_submitted: .*stop_sign_in/,
    );
    await password.giveBack("c1");
    expect(await password.mark("c2")).toBeUndefined();
    expect(
      posted.filter((call) => call.path === `${RUNS}/reviewer-attempt`)[0]!
        .body,
    ).toEqual({
      ...LEASE,
      attemptId: "att_1",
      passwordSubmission: { commandId: "c1", outcome: "intent" },
    });
  });

  it("stores a stage screenshot as the image itself, with the lease in the query", async () => {
    ensureLiveBrowserSession.mockResolvedValue(handle());
    const sent: { url: string; type?: string; bytes?: number }[] = [];
    const backend = vi.mocked(fetch);
    backend.mockImplementation((async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/browser-session/screenshot")) {
        sent.push({
          url,
          type: (init?.headers as Record<string, string>)["content-type"],
          bytes: (init?.body as Uint8Array).length,
        });
        return new Response(
          JSON.stringify({ ok: true, screenshotId: "shot_1" }),
        );
      }
      const path = new URL(url).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      posted.push({ path, body });
      const [status, answer] = routes[path]!(body);
      return new Response(JSON.stringify(answer), { status });
    }) as never);
    await deps().desktop.reserve(new AbortController().signal);
    const id = await agentDeps!.storeScreenshot({
      base64: Buffer.from([0xff, 0xd8, 0xff, 1]).toString("base64"),
      mediaType: "image/jpeg",
      bytes: 4,
    });
    expect(id).toBe("shot_1");
    expect(sent).toEqual([
      {
        url: `https://backend.test${RUNS}/browser-session/screenshot?runId=run_1&jobId=job_1`,
        type: "image/jpeg",
        bytes: 4,
      },
    ]);
  });

  it("closes the desktop once on release, with nothing to collect", async () => {
    ensureLiveBrowserSession.mockResolvedValue(handle());
    const live = deps();
    await live.desktop.reserve(new AbortController().signal);
    await live.desktop.release();
    await live.desktop.release();
    expect(paths().filter((path) => path.endsWith("/close"))).toHaveLength(1);
    expect(paths().some((path) => path.includes("/recording"))).toBe(false);
  });

  it("only closes when the reservation never got a box", async () => {
    routes[`${RUNS}/browser-session/desktop`] = () => [
      503,
      {
        ok: false,
        error: "at_capacity",
        message: "Desktops are at capacity. Try again in a few minutes.",
      },
    ];
    const live = deps();
    await expect(
      live.desktop.reserve(new AbortController().signal),
    ).rejects.toThrow("Desktops are at capacity");
    await live.desktop.release();
    expect(paths().at(-1)).toBe(`${RUNS}/browser-session/close`);
  });
});

describe("the connection", () => {
  beforeEach(() => {
    let claims = 0;
    routes = {
      [CONNECTIONS]: () => [
        200,
        { ok: true, requestId: "req_1", status: "discovering", created: true },
      ],
      // Discovery has not finished on the first claim.
      [`${CONNECTIONS}/claim`]: () =>
        claims++ === 0
          ? [
              409,
              {
                ok: false,
                code: "INVALID_STATE",
                error: "Discovery is still running.",
              },
            ]
          : [
              200,
              {
                ok: true,
                requestId: "req_1",
                serverUrl: "https://connector.example.com/mcp",
                authorizationServerUrl: null,
                callbackUrl: "https://preview.example.org/oauth/callback",
                registrationMode: "dynamic",
                requestedName: "Acme",
                account: { name: "reviewer-sub_1" },
              },
            ],
      [`${CONNECTIONS}/start`]: () => [
        200,
        { ok: true, requestId: "req_1", status: "authorizing" },
      ],
      [`${CONNECTIONS}/complete`]: () => [
        200,
        { ok: true, requestId: "req_1", status: "validating" },
      ],
      [`${CONNECTIONS}/status`]: () => [
        200,
        {
          ok: true,
          requestId: "req_1",
          stage: "completed",
          account: { name: "reviewer-sub_1", id: "acct_1" },
        },
      ],
    };
    prepareAuthorization.mockResolvedValue({
      authorizationUrl: "https://acme.authkit.app/oauth2/authorize?state=st_1",
      codeVerifier: "verifier-1",
      state: "st_1",
      clientId: "client_1",
      issuer: "https://acme.authkit.app",
    });
  });

  it("claims once discovery is done, prepares here, and sends the verifier only to the backend", async () => {
    const link = await deps().connect.prepare(new AbortController().signal);

    expect(prepareAuthorization).toHaveBeenCalledWith({
      serverUrl: "https://connector.example.com/mcp",
      redirectUri: "https://preview.example.org/oauth/callback",
      requestedName: "Acme",
    });
    expect(
      posted.find((call) => call.path === `${CONNECTIONS}/start`)!.body,
    ).toEqual({
      ...LEASE,
      requestId: "req_1",
      clientId: "client_1",
      codeVerifier: "verifier-1",
      redirectUri: "https://preview.example.org/oauth/callback",
      state: "st_1",
      issuer: "https://acme.authkit.app",
    });
    expect(link).toEqual({
      authorizationUrl: "https://acme.authkit.app/oauth2/authorize?state=st_1",
      authorizationServerOrigin: "https://acme.authkit.app",
      callbackUrl: "https://preview.example.org/oauth/callback",
    });
    expect(JSON.stringify(link)).not.toContain("verifier-1");
  });

  it("completes with what the redirect carried and answers with the reviewer account", async () => {
    const live = deps();
    routes[`${CONNECTIONS}/claim`] = () => [
      200,
      {
        ok: true,
        serverUrl: "https://connector.example.com/mcp",
        authorizationServerUrl: "https://acme.authkit.app",
      },
    ];
    await live.connect.prepare(new AbortController().signal);
    const answer = await live.connect.complete(
      { state: "st_1", code: "code_1" },
      new AbortController().signal,
    );
    expect(answer).toEqual({ accountId: "acct_1" });
    expect(
      posted.find((call) => call.path === `${CONNECTIONS}/complete`)!.body,
    ).toEqual({
      ...LEASE,
      requestId: "req_1",
      state: "st_1",
      code: "code_1",
    });
  });

  it("drives discovery and validation for its own request on a local Inspector", async () => {
    vi.stubEnv("MCPJAM_LOCAL_DOORBELL_MS", "2000");
    try {
      const live = deps().connect;
      const signal = new AbortController().signal;
      await live.prepare(signal);
      await live.complete({ state: "st_1", code: "code_1" }, signal);
      expect(runConnectionJob.mock.calls).toEqual([["req_1"], ["req_1"]]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("answers a refused completion and a failed request with the backend's words", async () => {
    const live = deps();
    routes[`${CONNECTIONS}/complete`] = () => [
      410,
      {
        ok: false,
        code: "REQUEST_EXPIRED",
        error: "This connection request expired. Start a new one.",
      },
    ];
    expect(
      await live.connect.complete({ state: "s" }, new AbortController().signal),
    ).toEqual({
      failed: "This connection request expired. Start a new one.",
    });
    routes[`${CONNECTIONS}/complete`] = () => [200, { ok: true }];
    routes[`${CONNECTIONS}/status`] = () => [
      200,
      {
        ok: true,
        stage: "failed",
        error: {
          code: "TOKEN_EXCHANGE_FAILED",
          message: "The token exchange failed.",
        },
      },
    ];
    expect(
      await live.connect.complete({ state: "s" }, new AbortController().signal),
    ).toEqual({
      failed: "The token exchange failed.",
    });
  });

  it("stops on a lost lease, in either envelope", async () => {
    routes[CONNECTIONS] = () => [
      409,
      { ok: false, code: "LEASE_MISMATCH", error: "Not this run's lease." },
    ];
    await expect(
      deps().connect.prepare(new AbortController().signal),
    ).rejects.toBeInstanceOf(ReadinessLeaseLostError);
    routes[`${RUNS}/browser-session`] = () => [
      409,
      { ok: false, error: "lease_lost" },
    ];
    await expect(
      deps().desktop.reserve(new AbortController().signal),
    ).rejects.toBeInstanceOf(ReadinessLeaseLostError);
  });
});

describe("the credentials", () => {
  const names = [ATTEMPT.usernameSecretName, ATTEMPT.passwordSecretName];

  it("takes the named values the backend releases for this attempt", async () => {
    routes[`${RUNS}/reviewer-attempt/secrets`] = () => [
      200,
      {
        ok: true,
        secrets: [
          { name: ATTEMPT.usernameSecretName, value: "review@example.com" },
          {
            name: ATTEMPT.passwordSecretName,
            value: "correct-horse-battery-staple",
          },
          { name: "MCPJAM_REVIEWER_OTHER", value: "not-this-attempts" },
        ],
      },
    ];
    expect(await deps().secrets(names)).toEqual({
      values: [
        { name: ATTEMPT.usernameSecretName, value: "review@example.com" },
        {
          name: ATTEMPT.passwordSecretName,
          value: "correct-horse-battery-staple",
        },
      ],
    });
    expect(posted[0]).toEqual({
      path: `${RUNS}/reviewer-attempt/secrets`,
      body: { ...LEASE, attemptId: "att_1" },
    });
  });

  it("says it cannot read them on a backend without the route, or with one missing", async () => {
    expect(await deps().secrets(names)).toEqual({
      unavailable: expect.stringContaining(
        "could not read the reviewer's saved credentials",
      ),
    });
    routes[`${RUNS}/reviewer-attempt/secrets`] = () => [
      200,
      {
        ok: true,
        secrets: [
          {
            name: ATTEMPT.passwordSecretName,
            value: "correct-horse-battery-staple",
          },
        ],
      },
    ];
    expect(await deps().secrets(names)).toMatchObject({
      unavailable: expect.any(String),
    });
  });

  it("passes the backend's own refusal on", async () => {
    routes[`${RUNS}/reviewer-attempt/secrets`] = () => [
      400,
      {
        ok: false,
        error: "secret_not_found",
        message:
          "No project secret named MCPJAM_REVIEWER_ACME_EMAIL is available to you.",
      },
    ];
    expect(await deps().secrets(names)).toEqual({
      unavailable:
        "No project secret named MCPJAM_REVIEWER_ACME_EMAIL is available to you.",
    });
  });
});

describe("a sign-in that reaches MCPJam's callback", () => {
  const CALLBACK = "https://app.mcpjam.com/oauth/callback";
  const CODE = "code-sample-123";
  const STATE = "state-sample-456";
  const AUTH = "https://login.acme.example";

  beforeEach(() => {
    routes = {
      [`${RUNS}/reviewer-attempt/secrets`]: () => [
        200,
        {
          ok: true,
          secrets: [
            { name: ATTEMPT.passwordSecretName, value: "reviewer-password-1" },
            { name: ATTEMPT.usernameSecretName, value: "review@example.com" },
          ],
        },
      ],
      [`${RUNS}/reviewer-attempt`]: () => [200, { ok: true, attempt: {} }],
      [`${RUNS}/browser-session`]: () => [
        200,
        { ok: true, reservation: { id: "res_1" } },
      ],
      [`${RUNS}/browser-session/desktop`]: () => [
        200,
        { ok: true, sandboxRowId: "row_1", sandboxId: "sbx_1" },
      ],
      [`${RUNS}/browser-session/bind`]: () => [200, { ok: true }],
      [`${RUNS}/browser-session/boot`]: () => [200, { ok: true }],
      [`${RUNS}/browser-session/close`]: () => [200, { ok: true, released: 1 }],
      [CONNECTIONS]: () => [200, { ok: true, requestId: "req_1" }],
      [`${CONNECTIONS}/claim`]: () => [
        200,
        { ok: true, serverUrl: "https://connector.example.com/mcp" },
      ],
      [`${CONNECTIONS}/start`]: () => [200, { ok: true }],
      [`${CONNECTIONS}/complete`]: () => [200, { ok: true }],
      [`${CONNECTIONS}/status`]: () => [
        200,
        { ok: true, stage: "completed", account: { id: "acct_1" } },
      ],
    };
    prepareAuthorization.mockResolvedValue({
      authorizationUrl: `${AUTH}/oauth2/authorize?state=${STATE}`,
      codeVerifier: "verifier-1",
      state: STATE,
      clientId: "client_1",
    });
    ensureLiveBrowserSession.mockResolvedValue({
      bootId: "boot_1",
      client: {
        status: vi.fn(async () => ({
          kind: "ok",
          features: [
            "network-public-only",
            "secret-origins",
            "navigation-stop-persistent",
          ],
        })),
        sendCommand: vi.fn(),
      },
    });
  });

  it("completes with the captured code and state, and records and logs neither", async () => {
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    agentRun = vi.fn(
      async (input: {
        link: { callbackUrl: string; authorizationServerOrigin: string };
      }) => {
        expect(input.link).toMatchObject({
          callbackUrl: CALLBACK,
          authorizationServerOrigin: AUTH,
        });
        return {
          kind: "callback",
          url: `${CALLBACK}?code=${CODE}&state=${STATE}`,
        };
      },
    );

    const outcome = await rehearseReviewerSignInLive({
      lease: LEASE,
      attemptId: "att_1",
      attempt: ATTEMPT,
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({ kind: "connected", reviewerAccountId: "acct_1" });
    expect(
      posted.find((call) => call.path === `${CONNECTIONS}/complete`)!.body,
    ).toEqual({
      ...LEASE,
      requestId: "req_1",
      state: STATE,
      code: CODE,
    });
    const writes = posted.filter(
      (call) => call.path === `${RUNS}/reviewer-attempt`,
    );
    const kept = JSON.stringify({
      writes,
      logs: [...warn.mock.calls, ...info.mock.calls],
    });
    expect(kept).not.toContain(CODE);
    expect(kept).not.toContain(STATE);
    warn.mockRestore();
    info.mockRestore();
  });
});
