/**
 * The live seams against a fake backend: every call is a lease-guarded
 * service route, the desktop is the reservation's own box, the recording is
 * read off it before `close`, and the authorization is prepared here with the
 * verifier sent only to the backend. The browser session, the recording
 * collector and the authorization preparation are mocked at their modules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureLiveBrowserSession = vi.fn();
const collectHostedRecordingThenRelease = vi.fn();
const prepareAuthorization = vi.fn();

vi.mock("../../browserd/live-session-deps.js", () => ({
  ensureLiveBrowserSession: (...args: unknown[]) =>
    ensureLiveBrowserSession(...args),
}));
vi.mock("../../browserd/hosted-recording.js", () => ({
  collectHostedRecordingThenRelease: (...args: unknown[]) =>
    collectHostedRecordingThenRelease(...args),
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

  it("reserves a blank browser, boots the reservation's own box and records the boot", async () => {
    const live = handle();
    ensureLiveBrowserSession.mockResolvedValue(live);
    const { browser, recordingArtifactId } = await deps().desktop.reserve(
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
    expect(ensureLiveBrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({
        contextMode: "ephemeral",
        target: {
          kind: "sandbox",
          sandboxRowId: "row_1",
          sandboxId: "sbx_1",
          record: true,
        },
      }),
    );
    expect(
      posted.find((call) => call.path.endsWith("/boot"))!.body,
    ).toMatchObject({
      reservationId: "res_1",
      bootId: "boot_1",
    });
    expect(browser.features).toEqual(["secret-origins"]);
    expect(recordingArtifactId).toBe("res_1");
    expect(await browser.screenshot()).toMatch(/^res_1#t=\d+\.\d$/);
  });

  it("drives the page by refs, sending a secret beside the command and never inside it", async () => {
    const live = handle();
    ensureLiveBrowserSession.mockResolvedValue(live);
    routes[`${RUNS}/browser-session/desktop`] = () => [
      200,
      { ok: true, sandboxRowId: "row_1", sandboxId: "sbx_1" },
    ];
    const { browser } = await deps().desktop.reserve(
      new AbortController().signal,
    );

    expect(await browser.read()).toEqual({
      url: "https://acme.authkit.app/sign-in",
      text: "Sign in",
      controls: [{ ref: "e1", role: "textbox", name: "Email" }],
    });
    const secret = {
      name: ATTEMPT.usernameSecretName,
      value: "review@example.com",
      origins: ["https://acme.authkit.app"],
    };
    await browser.type("e1", `{{secret:${secret.name}}}`, {
      secrets: [secret],
      submit: true,
    });
    const [command, bootId, options] = live.client.sendCommand.mock.calls.at(
      -1,
    )! as unknown as [
      { action: Record<string, unknown> },
      string,
      { secrets: unknown[] },
    ];
    expect(command.action).toEqual({
      kind: "act",
      verb: "type",
      target: { a11yRef: "e1" },
      value: `{{secret:${secret.name}}}`,
      submit: true,
      observe: "none",
    });
    expect(JSON.stringify(command)).not.toContain(secret.value);
    expect(bootId).toBe("boot_1");
    expect(options.secrets).toEqual([secret]);
  });

  it("reads the recording off the box before closing it, then keeps it with the reservation", async () => {
    ensureLiveBrowserSession.mockResolvedValue(handle());
    routes[`${RUNS}/browser-session/desktop`] = () => [
      200,
      { ok: true, sandboxRowId: "row_1", sandboxId: "sbx_1" },
    ];
    collectHostedRecordingThenRelease.mockImplementation(
      async ({ release }: { release: () => Promise<unknown> }) => {
        expect(paths()).not.toContain(`${RUNS}/browser-session/close`);
        await release();
        return {
          bytes: Buffer.from("mp4"),
          mime: "video/mp4",
          durationMs: 4000,
          distinctFrames: 12,
          fps: 15,
          truncated: false,
          startedAtMs: 1,
        };
      },
    );
    const live = deps();
    await live.desktop.reserve(new AbortController().signal);
    await live.desktop.release();
    await live.desktop.release();

    expect(collectHostedRecordingThenRelease).toHaveBeenCalledTimes(1);
    expect(collectHostedRecordingThenRelease.mock.calls[0]![0]).toMatchObject({
      sandboxRowId: "row_1",
    });
    expect(
      posted.find((call) => call.path.endsWith("/browser-session/recording"))!
        .body,
    ).toEqual({
      ...LEASE,
      uploadGrantId: "grant_1",
      storageId: "store_1",
      meta: {
        source: "hosted",
        fps: 15,
        durationMs: 4000,
        distinctFrames: 12,
        truncated: false,
      },
    });
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
    expect(collectHostedRecordingThenRelease).not.toHaveBeenCalled();
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
                authorizationServerUrl: "https://acme.authkit.app",
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
      redirectUri: "https://app.mcpjam.com/oauth/callback",
      requestedName: "Acme",
    });
    expect(
      posted.find((call) => call.path === `${CONNECTIONS}/start`)!.body,
    ).toEqual({
      ...LEASE,
      requestId: "req_1",
      clientId: "client_1",
      codeVerifier: "verifier-1",
      redirectUri: "https://app.mcpjam.com/oauth/callback",
      state: "st_1",
      issuer: "https://acme.authkit.app",
    });
    expect(link).toEqual({
      authorizationUrl: "https://acme.authkit.app/oauth2/authorize?state=st_1",
      authorizationServerOrigin: "https://acme.authkit.app",
      callbackUrl: "https://app.mcpjam.com/oauth/callback",
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

describe("the stop at MCPJam's callback", () => {
  const CALLBACK = "https://app.mcpjam.com/oauth/callback";
  const CODE = "code-sample-123";
  const STATE = "state-sample-456";
  const AUTHKIT = "https://acme.authkit.app";
  const PAGES = [
    {
      url: `${AUTHKIT}/sign-in`,
      text: "Sign in",
      refs: { e1: { role: "textbox", name: "Email" } },
    },
    {
      url: `${AUTHKIT}/password`,
      text: "Enter your password",
      refs: { e2: { role: "textbox", name: "Password" } },
    },
    {
      url: `${AUTHKIT}/consent`,
      text: "MCPJam wants to access your account",
      refs: {
        e3: { role: "button", name: "Allow access" },
        e4: { role: "button", name: "Deny" },
      },
    },
  ];

  /** A daemon that walks the pages; the consent click is stopped at the callback. */
  function daemon() {
    let index = 0;
    const commands: Array<
      Record<string, unknown> & { action: Record<string, unknown> }
    > = [];
    const sendCommand = vi.fn(async (command: (typeof commands)[number]) => {
      commands.push(command);
      const page = PAGES[index]!;
      const { action } = command;
      if (action.kind === "act" && action.verb === "click") {
        return {
          status: "ok",
          bootId: "boot_1",
          result: {
            ok: true,
            stoppedAt: `${CALLBACK}?code=${CODE}&state=${STATE}`,
          },
        };
      }
      if (action.kind === "act" && action.submit) index += 1;
      const output =
        action.mode === "a11y"
          ? { url: page.url, refs: page.refs }
          : action.mode === "text"
            ? { url: page.url, text: page.text }
            : {};
      return { status: "ok", bootId: "boot_1", result: { ok: true, output } };
    });
    const handle = {
      bootId: "boot_1",
      client: {
        status: vi.fn(async () => ({
          kind: "ok",
          bootId: "boot_1",
          features: ["secret-origins", "navigation-stop"],
        })),
        sendCommand,
      },
    };
    return { handle, commands };
  }

  beforeEach(() => {
    routes = {
      [`${RUNS}/reviewer-attempt/secrets`]: () => [
        200,
        {
          ok: true,
          secrets: [
            { name: ATTEMPT.usernameSecretName, value: "review@example.com" },
            {
              name: ATTEMPT.passwordSecretName,
              value: "correct-horse-battery-staple",
            },
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
        {
          ok: true,
          serverUrl: "https://connector.example.com/mcp",
          authorizationServerUrl: AUTHKIT,
        },
      ],
      [`${CONNECTIONS}/start`]: () => [200, { ok: true }],
      [`${CONNECTIONS}/complete`]: () => [200, { ok: true }],
      [`${CONNECTIONS}/status`]: () => [
        200,
        { ok: true, stage: "completed", account: { id: "acct_1" } },
      ],
    };
    prepareAuthorization.mockResolvedValue({
      authorizationUrl: `${AUTHKIT}/oauth2/authorize?state=${STATE}`,
      codeVerifier: "verifier-1",
      state: STATE,
      clientId: "client_1",
    });
    collectHostedRecordingThenRelease.mockImplementation(
      async ({ release }: { release: () => Promise<unknown> }) => {
        await release();
        return null;
      },
    );
  });

  it("asks every command that can navigate to stop there, and reads the stopped URL as the page", async () => {
    const { handle, commands } = daemon();
    ensureLiveBrowserSession.mockResolvedValue(handle);
    const { browser } = await deps().desktop.reserve(
      new AbortController().signal,
    );

    await browser.open(`${AUTHKIT}/oauth2/authorize`);
    await browser.read();
    await browser.click("e3");
    const daemonReads = commands.length;
    const page = await browser.read();

    expect(page.url).toBe(`${CALLBACK}?code=${CODE}&state=${STATE}`);
    expect(commands).toHaveLength(daemonReads);
    for (const command of commands) {
      const navigates =
        command.action.kind === "navigate" || command.action.kind === "act";
      expect(command.stopAt).toBe(navigates ? CALLBACK : undefined);
    }
  });

  it("completes with the captured code and state, and records and logs neither", async () => {
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    const { handle } = daemon();
    ensureLiveBrowserSession.mockResolvedValue(handle);

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
    expect(
      writes.map((call) => (call.body.stage as { stage: string }).stage),
    ).toEqual(["connect-link", "sign-in", "consent", "connected"]);
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
