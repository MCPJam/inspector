/**
 * The reviewer sign-in rehearsal, driven through fake seams: a fake desktop
 * whose browser walks a script of page states, a fake connection and a fake
 * attempt record. Every case also checks the desktop was released, because a
 * rehearsal that leaked one would bill MCPJam for an awake machine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../utils/logger.js";
import type { SignInPage } from "../reviewer-sign-in-pages.js";
import {
  APPROXIMATED_PREFIX,
  rehearseReviewerSignIn,
  type ReviewerAttemptWrite,
  type ReviewerSignInDeps,
  type SignInBrowser,
} from "../reviewer-sign-in.js";
import { ReadinessLeaseLostError } from "../runner.js";

const AUTHKIT = "https://acme.authkit.app";
const OTHER = "https://login.acme.example";
const CALLBACK = "https://app.mcpjam.com/oauth/callback";
const EMAIL_SECRET = "MCPJAM_REVIEWER_ACME_EMAIL";
const PASSWORD_SECRET = "MCPJAM_REVIEWER_ACME_PASSWORD";
const EMAIL = "review@example.com";
const PASSWORD = "correct-horse-battery-staple";
const ATTEMPT = {
  projectId: "proj_1",
  usernameSecretName: EMAIL_SECRET,
  passwordSecretName: PASSWORD_SECRET,
};

const control = (ref: string, role: string, name: string) => ({
  ref,
  role,
  name,
});
const emailPage = (origin = AUTHKIT): SignInPage => ({
  url: `${origin}/sign-in`,
  text: "Sign in to Acme\nForgot password?",
  controls: [
    control("e1", "textbox", "Email"),
    control("e2", "button", "Continue"),
  ],
});
const passwordPage = (
  origin = AUTHKIT,
  text = "Enter your password",
): SignInPage => ({
  url: `${origin}/sign-in/password`,
  text,
  controls: [
    control("e3", "textbox", "Password"),
    control("e4", "button", "Sign in"),
  ],
});
const consentPage = (
  origin = AUTHKIT,
  buttons = ["Allow access", "Deny"],
): SignInPage => ({
  url: `${origin}/oauth/consent`,
  text: "MCPJam - Acme wants to access your Acme account",
  controls: buttons.map((name, index) => control(`c${index}`, "button", name)),
});
const callbackPage = (query: string): SignInPage => ({
  url: `${CALLBACK}?${query}`,
  text: "Signing you in",
  controls: [],
});

/**
 * A browser that walks `pages`: a submitted field or a click moves it on,
 * as a real page does once the daemon has let it settle.
 */
function makeDeps(
  pages: SignInPage[],
  options: { origin?: string; features?: string[] } = {},
) {
  let index = 0;
  const writes: ReviewerAttemptWrite[] = [];
  const browser = {
    features: options.features ?? ["secret-origins"],
    open: vi.fn(async (_url: string) => {}),
    read: vi.fn(async () => pages[Math.min(index, pages.length - 1)]!),
    type: vi.fn(
      async (_ref: string, _text: string, typing: { submit: boolean }) => {
        if (typing.submit) index += 1;
      },
    ),
    click: vi.fn(async (_ref: string) => {
      index += 1;
    }),
    screenshot: vi.fn(async () => `res_1#t=${index}.0`),
  } satisfies SignInBrowser;
  const link = {
    authorizationUrl: `${options.origin ?? AUTHKIT}/oauth2/authorize?client_id=c1`,
    authorizationServerOrigin: options.origin ?? AUTHKIT,
    callbackUrl: CALLBACK,
  };
  const deps = {
    record: vi.fn(async (write: ReviewerAttemptWrite) => {
      writes.push(write);
    }),
    secrets: vi.fn(async (names: string[]) => ({
      values: names.map((name) => ({
        name,
        value: name === PASSWORD_SECRET ? PASSWORD : EMAIL,
      })),
    })),
    desktop: {
      reserve: vi.fn(async (_signal: AbortSignal) => ({
        browser,
        recordingArtifactId: "res_1",
      })),
      release: vi.fn(async () => {}),
    },
    connect: {
      prepare: vi.fn(async (_signal: AbortSignal) => link),
      complete: vi.fn(async () => ({ accountId: "acct_1" }) as const),
    },
    sleep: async () => {},
  } satisfies ReviewerSignInDeps;
  return { deps, browser, writes, link };
}

const run = (deps: ReviewerSignInDeps, timeoutMs?: number) =>
  rehearseReviewerSignIn(deps, ATTEMPT, {
    signal: new AbortController().signal,
    ...(timeoutMs ? { timeoutMs } : {}),
  });

const stagesOf = (writes: ReviewerAttemptWrite[]) =>
  writes.map((write) => `${write.stage?.stage}:${write.stage?.status}`);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rehearseReviewerSignIn", () => {
  it("signs in on AuthKit, approves consent and connects, recording each stage", async () => {
    const { deps, browser, writes, link } = makeDeps([
      emailPage(),
      passwordPage(),
      consentPage(),
      callbackPage("code=abc123&state=st_1&iss=https%3A%2F%2Facme.authkit.app"),
    ]);

    const outcome = await run(deps);

    expect(outcome).toEqual({ kind: "connected", reviewerAccountId: "acct_1" });
    expect(stagesOf(writes)).toEqual([
      "connect-link:passed",
      "sign-in:passed",
      "consent:passed",
      "connected:passed",
    ]);
    // Only the authorization server's page is ever opened.
    expect(browser.open.mock.calls).toEqual([[link.authorizationUrl]]);
    // Typed as placeholders, each value limited to the authorization server.
    expect(browser.type.mock.calls).toEqual([
      [
        "e1",
        `{{secret:${EMAIL_SECRET}}}`,
        {
          secrets: [{ name: EMAIL_SECRET, value: EMAIL, origins: [AUTHKIT] }],
          submit: true,
        },
      ],
      [
        "e3",
        `{{secret:${PASSWORD_SECRET}}}`,
        {
          secrets: [
            { name: PASSWORD_SECRET, value: PASSWORD, origins: [AUTHKIT] },
          ],
          submit: true,
        },
      ],
    ]);
    expect(browser.click.mock.calls).toEqual([["c0"]]);
    expect(deps.connect.complete).toHaveBeenCalledWith(
      expect.objectContaining({ state: "st_1", code: "abc123", iss: AUTHKIT }),
      expect.any(AbortSignal),
    );
    expect(writes.at(-1)).toMatchObject({ reviewerAccountId: "acct_1" });
    // The attempt stays open for the checks that use the account.
    expect(writes.some((write) => write.outcome || write.waitingFor)).toBe(
      false,
    );
    expect(writes[1]!.stage!.evidence).toEqual({
      screenshotArtifactId: "res_1#t=2.0",
      recordingArtifactId: "res_1",
    });
    expect(writes.at(-1)!.stage!.evidence).toEqual({
      recordingArtifactId: "res_1",
    });
    expect(
      writes.every(
        (write) => !write.stage?.detail?.startsWith(APPROXIMATED_PREFIX),
      ),
    ).toBe(true);
    expect(deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("types a plain username as text, and both fields of a one-page form", async () => {
    const onePage: SignInPage = {
      url: `${AUTHKIT}/sign-in`,
      text: "Sign in",
      controls: [
        control("u", "textbox", "Email address"),
        control("p", "textbox", "Password"),
      ],
    };
    const { deps, browser } = makeDeps([
      onePage,
      consentPage(),
      callbackPage("code=c&state=s"),
    ]);
    const outcome = await rehearseReviewerSignIn(
      deps,
      {
        projectId: "proj_1",
        passwordSecretName: PASSWORD_SECRET,
        username: EMAIL,
      },
      { signal: new AbortController().signal },
    );
    expect(outcome.kind).toBe("connected");
    expect(
      browser.type.mock.calls.map(([ref, text, typing]) => [
        ref,
        text,
        typing.submit,
      ]),
    ).toEqual([
      ["u", EMAIL, false],
      ["p", `{{secret:${PASSWORD_SECRET}}}`, true],
    ]);
    expect(deps.secrets).toHaveBeenCalledWith([PASSWORD_SECRET]);
  });

  it("reports a refused password with the page's words, ends the attempt failed, and releases", async () => {
    const { deps, writes } = makeDeps([
      emailPage(),
      passwordPage(),
      passwordPage(AUTHKIT, "Incorrect email or password.\nTry again"),
    ]);

    const outcome = await run(deps);

    expect(outcome.kind).toBe("failed");
    expect(stagesOf(writes)).toEqual(["connect-link:passed", "sign-in:failed"]);
    const last = writes.at(-1)!;
    expect(last.outcome).toBe("failed");
    expect(last.stage!.detail).toContain(
      'credentials: "Incorrect email or password". Check',
    );
    expect(last.stage!.detail).toContain(
      "Check the saved username and password",
    );
    expect(last.stage!.evidence?.screenshotArtifactId).toBeDefined();
    expect(deps.connect.complete).not.toHaveBeenCalled();
    expect(deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("treats a form that asks for the password again as a refusal", async () => {
    const { deps, writes } = makeDeps([
      emailPage(),
      passwordPage(),
      passwordPage(),
    ]);
    expect((await run(deps)).kind).toBe("failed");
    expect(writes.at(-1)!.stage!.detail).toContain(
      "asked for the password again",
    );
  });

  it("stops at a verification code for a person, with what the page asked", async () => {
    const { deps, writes } = makeDeps([
      emailPage(),
      passwordPage(),
      {
        url: `${AUTHKIT}/sign-in/verify`,
        text: "Check your email\nEnter the code we sent to review@example.com",
        controls: [
          control("v1", "textbox", "Code"),
          control("v2", "button", "Verify"),
        ],
      },
    ]);

    const outcome = await run(deps);

    expect(outcome).toMatchObject({ kind: "waiting-for-person" });
    expect(stagesOf(writes)).toEqual([
      "connect-link:passed",
      "sign-in:passed",
      "verification:blocked",
    ]);
    const last = writes.at(-1)!;
    expect(last.outcome).toBeUndefined();
    expect(last.waitingFor?.reason).toContain("Check your email");
    expect(last.waitingFor?.action).toContain("resume this attempt");
    // The email the page echoed back is the reviewer's secret: never written.
    expect(JSON.stringify(writes)).not.toContain(EMAIL);
    expect(deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("labels every page stage approximated off AuthKit, and approves only a clear choice", async () => {
    const { deps, browser, writes } = makeDeps(
      [
        emailPage(OTHER),
        passwordPage(OTHER),
        consentPage(OTHER, ["Allow", "Cancel"]),
        callbackPage("code=c&state=s"),
      ],
      { origin: OTHER },
    );

    expect((await run(deps)).kind).toBe("connected");
    const details = Object.fromEntries(
      writes.map((write) => [write.stage!.stage, write.stage!.detail!]),
    );
    expect(details["sign-in"]).toMatch(/^Approximated: /);
    expect(details.consent).toMatch(/^Approximated: /);
    expect(details["connect-link"]).not.toMatch(/^Approximated/);
    expect(details.connected).not.toMatch(/^Approximated/);
    expect(browser.click.mock.calls).toEqual([["c0"]]);
  });

  it.each([
    ["two ways to approve", ["Allow", "Continue", "Cancel"]],
    ["no way to refuse", ["Allow"]],
  ])(
    "stops an unknown consent page with %s for a person, clicking nothing",
    async (_label, buttons) => {
      const { deps, browser, writes } = makeDeps(
        [emailPage(OTHER), passwordPage(OTHER), consentPage(OTHER, buttons)],
        { origin: OTHER },
      );
      expect(await run(deps)).toMatchObject({ kind: "waiting-for-person" });
      expect(stagesOf(writes).at(-1)).toBe("consent:blocked");
      expect(writes.at(-1)!.stage!.detail).toMatch(/^Approximated: /);
      expect(browser.click).not.toHaveBeenCalled();
      expect(deps.desktop.release).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses to type on a daemon that cannot limit secrets by origin, and says why", async () => {
    const { deps, browser, writes } = makeDeps([emailPage()], {
      features: ["secret-placeholders"],
    });

    const outcome = await run(deps);

    expect(outcome.kind).toBe("failed");
    expect(browser.type).not.toHaveBeenCalled();
    expect(browser.open).not.toHaveBeenCalled();
    expect(deps.connect.prepare).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      stage: { stage: "sign-in", status: "blocked" },
      outcome: "failed",
    });
    expect(writes[0]!.detail).toContain(
      "cannot limit the reviewer's credentials",
    );
    expect(deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("records why it could not read the credentials, and reserves nothing", async () => {
    const { deps, writes } = makeDeps([emailPage()]);
    deps.secrets.mockResolvedValue({
      unavailable: "The secrets route is not there yet.",
    } as never);
    expect((await run(deps)).kind).toBe("failed");
    expect(writes).toEqual([
      expect.objectContaining({
        stage: {
          stage: "credentials",
          status: "blocked",
          detail: "The secrets route is not there yet.",
        },
        outcome: "failed",
      }),
    ]);
    expect(deps.desktop.reserve).not.toHaveBeenCalled();
    expect(deps.desktop.release).not.toHaveBeenCalled();
  });

  it("completes with the authorization server's refusal, and records the connection failed", async () => {
    const { deps, writes } = makeDeps([
      emailPage(),
      passwordPage(),
      consentPage(),
      callbackPage(
        "state=s&error=access_denied&error_description=The+user+denied+access",
      ),
    ]);
    deps.connect.complete.mockResolvedValue({
      failed: "The reviewer denied access",
    } as never);
    expect((await run(deps)).kind).toBe("failed");
    expect(deps.connect.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "s",
        error: "access_denied",
        errorDescription: "The user denied access",
      }),
      expect.any(AbortSignal),
    );
    expect(writes.at(-1)!.stage).toMatchObject({
      stage: "connected",
      status: "failed",
    });
    expect(writes.at(-1)!.stage!.detail).toContain(
      "The reviewer denied access. Start a new attempt.",
    );
  });

  it("completes nothing when the callback page holds no answer", async () => {
    const { deps, writes } = makeDeps([
      emailPage(),
      passwordPage(),
      consentPage(),
      callbackPage("oauth_pending=1"),
    ]);
    expect((await run(deps)).kind).toBe("failed");
    expect(deps.connect.complete).not.toHaveBeenCalled();
    expect(writes.at(-1)!.stage).toMatchObject({
      stage: "connected",
      status: "failed",
    });
  });

  it("stops for a person on a page it does not recognize", async () => {
    const { deps, writes } = makeDeps([
      { url: `${AUTHKIT}/interstitial`, text: "One moment", controls: [] },
    ]);
    expect(await run(deps)).toMatchObject({ kind: "waiting-for-person" });
    expect(stagesOf(writes).at(-1)).toBe("sign-in:blocked");
  });
});

describe("the desktop is released on every path", () => {
  it("when the desktop cannot be reserved", async () => {
    const { deps, writes } = makeDeps([emailPage()]);
    deps.desktop.reserve.mockRejectedValue(
      new Error(
        "This organization's readiness runs have used all 20 hosted browser sessions allowed in 24 hours",
      ),
    );
    expect((await run(deps)).kind).toBe("failed");
    expect(writes[0]!.stage).toMatchObject({
      stage: "sign-in",
      status: "blocked",
    });
    expect(writes[0]!.detail).toContain(
      "all 20 hosted browser sessions allowed in 24 hours. Start a new attempt.",
    );
    expect(deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("when the connection cannot be prepared", async () => {
    const { deps, writes } = makeDeps([emailPage()]);
    deps.connect.prepare.mockRejectedValue(
      new Error("discovery found no authorization server"),
    );
    expect((await run(deps)).kind).toBe("failed");
    expect(writes[0]!.stage).toMatchObject({
      stage: "connect-link",
      status: "failed",
    });
    expect(deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("when the browser throws mid-sign-in", async () => {
    const { deps, browser, writes } = makeDeps([emailPage()]);
    browser.read.mockRejectedValue(
      new Error("The hosted browser did not run the command (busy)"),
    );
    const outcome = await run(deps);
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(writes.at(-1)!.stage!.detail).toContain(
      "The sign-in stopped on an error",
    );
    expect(deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("when the lease is lost, which still throws", async () => {
    const { deps } = makeDeps([emailPage(), passwordPage()]);
    deps.record.mockRejectedValue(new ReadinessLeaseLostError());
    await expect(run(deps)).rejects.toBeInstanceOf(ReadinessLeaseLostError);
    expect(deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("when the run is cancelled mid-sign-in, which still throws", async () => {
    const { deps, browser } = makeDeps([emailPage()]);
    const controller = new AbortController();
    browser.read.mockImplementation(() => {
      controller.abort(new Error("cancelled"));
      return new Promise<never>(() => {});
    });
    await expect(
      rehearseReviewerSignIn(deps, ATTEMPT, { signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("when a page never answers, within its own deadline", async () => {
    const { deps, browser, writes } = makeDeps([emailPage()]);
    browser.read.mockImplementation(() => new Promise<never>(() => {}));
    expect((await run(deps, 20)).kind).toBe("failed");
    expect(writes.at(-1)!.stage!.detail).toMatch(/did not finish within/);
    expect(deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("and a failed release is logged without changing the outcome", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { deps } = makeDeps([
      emailPage(),
      passwordPage(),
      consentPage(),
      callbackPage("code=c&state=s"),
    ]);
    deps.desktop.release.mockRejectedValue(new Error("close refused"));
    expect((await run(deps)).kind).toBe("connected");
    expect(warn).toHaveBeenCalledWith(
      "[readiness] releasing the sign-in desktop failed",
      expect.objectContaining({ error: "close refused." }),
    );
  });
});

describe("no credential value is written down", () => {
  it("scrubs the values from recorded stages, the outcome and the logs, and keeps only origins of URLs", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    // A page and an error that echo the values back, as a daemon that missed
    // them would: everything recorded must still hold only the placeholders.
    const { deps, writes } = makeDeps([
      emailPage(),
      passwordPage(),
      passwordPage(AUTHKIT, `Incorrect password ${PASSWORD} for ${EMAIL}`),
    ]);
    deps.desktop.release.mockRejectedValue(
      new Error(
        `close failed at ${CALLBACK}?code=abc123&state=st_1 for ${PASSWORD}`,
      ),
    );
    deps.record.mockImplementation(async (write: ReviewerAttemptWrite) => {
      writes.push(write);
      if (write.outcome) throw new Error(`refused ${EMAIL}`);
    });

    const outcome = await run(deps);

    const written = JSON.stringify({ writes, outcome, logs: warn.mock.calls });
    for (const value of [PASSWORD, EMAIL, "abc123"]) {
      expect(written).not.toContain(value);
    }
    expect(written).toContain(`{{secret:${PASSWORD_SECRET}}}`);
    expect(written).toContain(`{{secret:${EMAIL_SECRET}}}`);
    expect(written).toContain("close failed at https://app.mcpjam.com for");
  });
});
