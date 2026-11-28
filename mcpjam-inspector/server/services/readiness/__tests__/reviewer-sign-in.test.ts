/**
 * The reviewer sign-in rehearsal, driven through fake seams: a fake desktop
 * whose agent answers as told, a fake connection and a fake attempt record.
 * Every case also checks the desktop was released, because a rehearsal that
 * leaked one would bill MCPJam for an awake machine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../utils/logger.js";
import type {
  SignInAgent,
  SignInAgentOutcome,
  SignInAgentRun,
} from "../reviewer-sign-in-agent.js";
import {
  rehearseReviewerSignIn,
  type ReviewerAttemptWrite,
  type ReviewerSignInDeps,
} from "../reviewer-sign-in.js";
import { ReadinessLeaseLostError } from "../runner.js";

const AUTH = "https://login.acme.example";
const CALLBACK = "https://app.mcpjam.com/oauth/callback";
const PASSWORD_SECRET = "MCPJAM_REVIEWER_ACME_PASSWORD";
const PASSWORD = "correct-horse-battery-staple";
const ATTEMPT = {
  projectId: "proj_1",
  username: "review@example.com",
  passwordSecretName: PASSWORD_SECRET,
  tenant: "Acme",
};
const FEATURES = [
  "network-public-only",
  "secret-origins",
  "navigation-stop-persistent",
];
const SHOT = {
  screenshotArtifactId: "shot_1",
  screenshotStatus: "captured" as const,
};

function fakes(
  play: (run: SignInAgentRun) => Promise<SignInAgentOutcome>,
  over: { features?: string[] } = {},
) {
  const writes: ReviewerAttemptWrite[] = [];
  const run = vi.fn(play);
  const agent: SignInAgent = { features: over.features ?? FEATURES, run };
  const deps = {
    record: vi.fn(async (write: ReviewerAttemptWrite) => {
      writes.push(write);
    }),
    secrets: vi.fn(async () => ({
      values: [{ name: PASSWORD_SECRET, value: PASSWORD }],
    })),
    desktop: {
      reserve: vi.fn(async () => ({ agent })),
      release: vi.fn(async () => {}),
    },
    connect: {
      prepare: vi.fn(async () => ({
        authorizationUrl: `${AUTH}/authorize?client_id=c`,
        authorizationServerOrigin: AUTH,
        callbackUrl: CALLBACK,
      })),
      complete: vi.fn(async () => ({ accountId: "acct_1" }) as const),
    },
  } satisfies ReviewerSignInDeps;
  return { deps, writes, run };
}

const sign = (deps: ReviewerSignInDeps, timeoutMs?: number) =>
  rehearseReviewerSignIn(deps, ATTEMPT, {
    signal: new AbortController().signal,
    ...(timeoutMs ? { timeoutMs } : {}),
  });

const stages = (writes: ReviewerAttemptWrite[]) =>
  writes.flatMap((write) => (write.stage ? [write.stage.stage] : []));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rehearseReviewerSignIn", () => {
  it("connects only through MCPJam's callback, recording the agent's stages", async () => {
    const { deps, writes, run } = fakes(async (input) => {
      await input.record({
        stage: "connect-link",
        status: "passed",
        detail: "Opened.",
        evidence: SHOT,
      });
      await input.record({
        stage: "sign-in",
        status: "passed",
        detail: "Signed in.",
        evidence: SHOT,
      });
      return {
        kind: "callback",
        url: `${CALLBACK}?code=c1&state=s1&iss=${encodeURIComponent(AUTH)}`,
      };
    });
    expect(await sign(deps)).toEqual({
      kind: "connected",
      reviewerAccountId: "acct_1",
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: ATTEMPT,
        values: [{ name: PASSWORD_SECRET, value: PASSWORD }],
        link: expect.objectContaining({
          authorizationServerOrigin: AUTH,
          callbackUrl: CALLBACK,
        }),
      }),
    );
    expect(deps.connect.complete).toHaveBeenCalledWith(
      {
        state: "s1",
        code: "c1",
        iss: AUTH,
        error: undefined,
        errorDescription: undefined,
      },
      expect.any(AbortSignal),
    );
    expect(stages(writes)).toEqual(["connect-link", "sign-in", "connected"]);
    expect(writes.at(-1)).toMatchObject({ reviewerAccountId: "acct_1" });
    expect(writes[1].stage?.evidence).toEqual(SHOT);
    expect(deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("stops for a person where the agent could not finish, with its picture", async () => {
    const { deps, writes } = fakes(async () => ({
      kind: "stopped",
      stage: "verification",
      reason: "The page asked for a code sent by email.",
      needsPerson: true,
      evidence: {
        screenshotStatus: "suppressed",
        screenshotNote: "A credential was typed on this page.",
      },
    }));
    const outcome = await sign(deps);
    expect(outcome).toMatchObject({
      kind: "waiting-for-person",
      action: expect.stringContaining("complete the verification"),
    });
    expect(writes.at(-1)).toMatchObject({
      stage: {
        stage: "verification",
        status: "blocked",
        evidence: { screenshotStatus: "suppressed" },
      },
      waitingFor: { reason: expect.stringContaining("code sent by email") },
    });
    expect(deps.connect.complete).not.toHaveBeenCalled();
    expect(deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("fails on a refusal the agent reports, and never passes on its word alone", async () => {
    const { deps, writes } = fakes(async () => ({
      kind: "stopped",
      stage: "sign-in",
      reason: "The page said the password is incorrect",
      needsPerson: false,
    }));
    const outcome = await sign(deps);
    expect(outcome).toEqual({
      kind: "failed",
      detail: expect.stringContaining("password is incorrect."),
    });
    expect(writes.at(-1)).toMatchObject({
      outcome: "failed",
      stage: { stage: "sign-in", status: "failed" },
    });
  });

  it("stops for a person when the agent ends without the callback, saying why", async () => {
    const { deps, writes } = fakes(async () => ({
      kind: "ended",
      stage: "consent",
      reason: "MCPJam's daily budget for this feature is spent",
    }));
    expect(await sign(deps)).toMatchObject({ kind: "waiting-for-person" });
    expect(writes.at(-1)).toMatchObject({
      stage: {
        stage: "consent",
        status: "blocked",
        detail: expect.stringContaining("daily budget"),
      },
      waitingFor: { action: expect.stringContaining("approve access") },
    });
  });

  it("refuses a daemon that cannot keep to public addresses, limit credentials or stop at the callback", async () => {
    for (const [features, stage] of [
      [["secret-origins", "navigation-stop-persistent"], "connect-link"],
      [["network-public-only", "navigation-stop-persistent"], "sign-in"],
      [["network-public-only", "secret-origins"], "connected"],
    ] as const) {
      const { deps, writes, run } = fakes(
        async () => ({ kind: "callback", url: CALLBACK }),
        {
          features: [...features],
        },
      );
      expect((await sign(deps)).kind).toBe("waiting-for-person");
      expect(deps.connect.prepare).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
      expect(writes.at(-1)?.stage?.stage).toBe(stage);
      expect(deps.desktop.release).toHaveBeenCalledTimes(1);
    }
  });

  it("records why it could not read the credentials, and reserves nothing", async () => {
    const { deps, writes } = fakes(async () => ({
      kind: "callback",
      url: CALLBACK,
    }));
    deps.secrets.mockResolvedValueOnce({
      unavailable: "No saved password.",
    } as never);
    expect(await sign(deps)).toEqual({
      kind: "failed",
      detail: "No saved password.",
    });
    expect(writes).toEqual([
      expect.objectContaining({
        stage: expect.objectContaining({
          stage: "credentials",
          status: "blocked",
        }),
      }),
    ]);
    expect(deps.desktop.reserve).not.toHaveBeenCalled();
  });

  it("records a callback with the server's refusal, or with no answer, as not connected", async () => {
    for (const url of [`${CALLBACK}?state=s1&error=access_denied`, CALLBACK]) {
      const { deps, writes } = fakes(async () => ({ kind: "callback", url }));
      deps.connect.complete.mockResolvedValueOnce({
        failed: "The server refused: access_denied.",
      } as never);
      expect(await sign(deps)).toMatchObject({ kind: "failed" });
      expect(writes.at(-1)).toMatchObject({
        stage: { stage: "connected", status: "failed" },
        outcome: "failed",
      });
    }
  });
});

describe("the desktop is released on every path", () => {
  it("when the desktop or the connection cannot be prepared", async () => {
    const first = fakes(async () => ({ kind: "callback", url: CALLBACK }));
    first.deps.desktop.reserve.mockRejectedValueOnce(new Error("no box"));
    expect(await sign(first.deps)).toMatchObject({
      kind: "waiting-for-person",
      reason: expect.stringContaining("No password was entered by this run"),
      action: expect.stringContaining("Finish reviewer sign-in"),
    });
    expect(first.deps.connect.prepare).toHaveBeenCalledTimes(1);
    expect(first.run).not.toHaveBeenCalled();
    expect(first.deps.desktop.release).toHaveBeenCalledTimes(1);
    const second = fakes(async () => ({ kind: "callback", url: CALLBACK }));
    second.deps.connect.prepare.mockRejectedValueOnce(
      new Error("discovery failed"),
    );
    expect(await sign(second.deps)).toMatchObject({ kind: "failed" });
    expect(second.writes.at(-1)?.stage?.stage).toBe("connect-link");
    expect(second.deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("when the agent throws, a lost lease still throwing", async () => {
    const broken = fakes(async () => {
      throw new Error("model went away");
    });
    expect(await sign(broken.deps)).toMatchObject({
      kind: "failed",
      detail: expect.stringContaining("model went away"),
    });
    expect(broken.deps.desktop.release).toHaveBeenCalledTimes(1);
    const lost = fakes(async () => {
      throw new ReadinessLeaseLostError();
    });
    await expect(sign(lost.deps)).rejects.toBeInstanceOf(
      ReadinessLeaseLostError,
    );
    expect(lost.deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("when the agent never answers, within the sign-in's own deadline", async () => {
    const { deps } = fakes(
      (input) =>
        new Promise((_resolve, reject) =>
          input.signal.addEventListener("abort", () =>
            reject(input.signal.reason),
          ),
        ),
    );
    expect(await sign(deps, 20)).toMatchObject({
      kind: "failed",
      detail: expect.stringContaining("did not finish within"),
    });
    expect(deps.desktop.release).toHaveBeenCalledTimes(1);
  });

  it("and a failed release is logged without changing the outcome", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { deps } = fakes(async () => ({
      kind: "callback",
      url: `${CALLBACK}?code=c&state=s`,
    }));
    deps.desktop.release.mockRejectedValueOnce(new Error("close failed"));
    expect(await sign(deps)).toMatchObject({ kind: "connected" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("releasing the sign-in desktop failed"),
      expect.anything(),
    );
  });
});

describe("no credential value is written down", () => {
  it("scrubs the values from recorded stages and the outcome, and keeps only origins of URLs", async () => {
    const { deps, writes } = fakes(async (input) => {
      await input.record({
        stage: "connect-link",
        status: "passed",
        detail: `Opened ${AUTH}/login?token=${PASSWORD}`,
      });
      return {
        kind: "stopped",
        stage: "sign-in",
        reason: `The page echoed ${PASSWORD} back`,
        needsPerson: false,
      };
    });
    const outcome = await sign(deps);
    const written = JSON.stringify([writes, outcome]);
    expect(written).not.toContain(PASSWORD);
    expect(written).toContain(`{{secret:${PASSWORD_SECRET}}}`);
    expect(written).not.toContain("/login?token");
    expect(written).toContain(AUTH);
  });
});
