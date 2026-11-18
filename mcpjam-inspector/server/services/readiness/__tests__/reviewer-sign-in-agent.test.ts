/**
 * The sign-in agent with fake browser tools and a scripted turn: what it is
 * told, where its stages end and what each one pictures, the one password
 * try, and the three ways a turn ends. The model never decides the outcome.
 */
import { describe, expect, it, vi } from "vitest";
import { buildBrowserTools } from "../../../utils/built-in-tools/browser.js";
import {
  createSignInAgent,
  signInInstructions,
  type SignInAgentDeps,
} from "../reviewer-sign-in-agent.js";
import type { ReviewerStage } from "../reviewer-sign-in.js";

const AUTH = "https://login.acme.example";
const CALLBACK = "https://app.mcpjam.com/oauth/callback";
const PASSWORD = "reviewer-password-sample-1";
const ATTEMPT = {
  projectId: "proj_1",
  usernameSecretName: "MCPJAM_REVIEWER_EMAIL",
  passwordSecretName: "MCPJAM_REVIEWER_PASSWORD",
  tenant: "Acme",
};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7]).toString("base64");
const LINK = {
  authorizationUrl: `${AUTH}/authorize?state=s1`,
  authorizationServerOrigin: AUTH,
  callbackUrl: CALLBACK,
};

type Opts = Parameters<typeof buildBrowserTools>[0];
type Call = { toolCallId: string; messages: never[]; context: object };
const call: Call = { toolCallId: "t", messages: [], context: {} };

/** Browser tools that answer from a list of pages, calling the real gates. */
function fakeBrowser(
  pages: Record<string, unknown>[],
  callback = `${CALLBACK}?code=c1&state=s1`,
) {
  let opts: Opts | undefined;
  let commands = 0;
  const page = () => pages[Math.min(commands, pages.length - 1)]!;
  const deliver = async (value: string) => {
    const names = [
      ATTEMPT.usernameSecretName,
      ATTEMPT.passwordSecretName,
    ].filter((name) => value.includes(`{{secret:${name}}}`));
    if (names.length === 0) return undefined;
    const commandId = `cmd-${commands}`;
    const refusal = await opts!.secrets!.beforeDeliver?.(names, { commandId });
    if (refusal) return { error: refusal };
    await opts!.secrets!.afterDeliver?.(names, { commandId, outcome: "typed" });
    return undefined;
  };
  const step = async (result: Record<string, unknown>) => {
    commands += 1;
    if (result.url === CALLBACK) {
      opts!.navigationStop!.onStopped(callback);
      return { stopped: true };
    }
    return result;
  };
  const build = vi.fn((given: Opts) => {
    opts = given;
    return {
      tools: {
        browser_navigate: { execute: async () => step(page()) },
        browser_observe: { execute: async () => step(page()) },
        browser_act: {
          // As the real tools do: no picture comes back from typing a secret.
          execute: async (input: { value?: string }) => {
            const value = input.value ?? "";
            const refused = await deliver(value);
            if (refused) return refused;
            const { screenshot: _picture, ...rest } = page();
            return value.includes("{{secret:") ? step(rest) : step(page());
          },
        },
      },
    } as never;
  });
  return { build, options: () => opts! };
}

function agentWith(
  browser: ReturnType<typeof fakeBrowser>,
  script: (
    tools: Record<
      string,
      { execute: (input: object, call: Call) => Promise<unknown> }
    >,
  ) => Promise<void>,
  over: Partial<SignInAgentDeps> = {},
) {
  const runTurn = vi.fn(
    async (options: { tools: object; abortSignal: AbortSignal }) => {
      await script(options.tools as never);
      return {} as never;
    },
  );
  const deps: SignInAgentDeps = {
    handle: {} as never,
    features: ["secret-origins", "navigation-stop-persistent"],
    lease: { runId: "run_1", jobId: "job_1" },
    attemptId: "att_1",
    projectId: "proj_1",
    sandbox: { sandboxRowId: "row_1", sandboxId: "box_1" },
    password: {
      mark: vi.fn(async () => undefined),
      giveBack: vi.fn(async () => {}),
    },
    storeScreenshot: vi.fn(async () => "shot_1"),
    runTurn: runTurn as never,
    buildTools: browser.build as never,
    ...over,
  };
  const recorded: ReviewerStage[] = [];
  const run = () =>
    createSignInAgent(deps).run({
      link: LINK,
      attempt: ATTEMPT,
      values: [
        { name: ATTEMPT.usernameSecretName, value: "review@example.com" },
        { name: ATTEMPT.passwordSecretName, value: PASSWORD },
      ],
      signal: new AbortController().signal,
      record: async (stage) => {
        recorded.push(stage);
      },
    });
  return { deps, runTurn, recorded, run };
}

const shot = (url: string) => ({ url, screenshot: JPEG });

describe("a sign-in that reaches MCPJam's callback", () => {
  it("records each stage with its own picture and hands back the callback URL", async () => {
    const browser = fakeBrowser([
      shot(`${AUTH}/sign-in`),
      shot(`${AUTH}/sign-in`),
      shot(`${AUTH}/consent`),
      shot(`${AUTH}/consent`),
      shot(`${AUTH}/consent?org=acme`),
      { url: CALLBACK },
    ]);
    const { run, recorded, runTurn, deps } = agentWith(
      browser,
      async (tools) => {
        await tools.browser_act!.execute(
          {
            verb: "type",
            ref: "e1",
            value: "{{secret:MCPJAM_REVIEWER_EMAIL}}",
          },
          call,
        );
        await tools.browser_act!.execute(
          {
            verb: "type",
            ref: "e2",
            value: "{{secret:MCPJAM_REVIEWER_PASSWORD}}",
          },
          call,
        );
        await tools.browser_observe!.execute({}, call);
        await tools.browser_act!.execute(
          { verb: "select", ref: "e3", value: "Acme" },
          call,
        );
        await tools.browser_act!.execute({ verb: "click", ref: "e4" }, call);
      },
    );
    expect(await run()).toEqual({
      kind: "callback",
      url: `${CALLBACK}?code=c1&state=s1`,
    });
    expect(
      recorded.map((stage) => [
        stage.stage,
        stage.status,
        stage.evidence?.screenshotStatus,
      ]),
    ).toEqual([
      ["connect-link", "passed", "captured"],
      ["sign-in", "passed", "captured"],
      ["consent", "passed", "captured"],
    ]);
    expect(deps.password.mark).toHaveBeenCalledTimes(1);
    const turn = runTurn.mock.calls[0]![0] as Record<string, any>;
    expect(turn).toMatchObject({
      runtime: {
        kind: "hosted",
        endpointPath: "/stream/platform",
        extraBodyFields: {
          billingFeature: "readiness_sign_in",
          reviewerAttemptId: "att_1",
        },
        extraHeaders: {
          "x-mcpjam-readiness-run-id": "run_1",
          "x-mcpjam-readiness-job-id": "job_1",
        },
      },
      sourceType: "readiness",
      origin: "readiness",
      persistMode: "caller",
      approvalMode: "auto-deny",
      authContext: { kind: "user_bearer", token: "" },
    });
    expect(Object.keys(turn.tools).sort()).toEqual([
      "browser_act",
      "browser_navigate",
      "browser_observe",
      "stop_sign_in",
    ]);
    expect(JSON.stringify(turn)).not.toContain(PASSWORD);
    const opts = browser.options();
    expect(opts.approvalDelivery).toEqual({
      kind: "unattended",
      policy: {
        mode: "allowlist",
        toolAllowlist: ["browser_navigate", "browser_act", "browser_observe"],
      },
    });
    expect(
      opts.secrets!.available.every((secret) => secret.origins?.[0] === AUTH),
    ).toBe(true);
    expect(opts.navigationStop!.url).toBe(CALLBACK);
    expect(opts.sandboxTarget).toEqual({
      sandboxRowId: "row_1",
      sandboxId: "box_1",
      record: false,
    });
  });
});

describe("a page that moves on after the password", () => {
  const typePassword = (
    tools: Record<
      string,
      { execute: (input: object, call: Call) => Promise<unknown> }
    >,
  ) =>
    tools.browser_act!.execute(
      { verb: "type", ref: "e2", value: "{{secret:MCPJAM_REVIEWER_PASSWORD}}" },
      call,
    );

  it("is progress, not a sign-in: a stop there records no passed sign-in", async () => {
    const browser = fakeBrowser([
      shot(`${AUTH}/sign-in`),
      shot(`${AUTH}/sign-in`),
      shot(`${AUTH}/mfa`),
    ]);
    const { run, recorded } = agentWith(browser, async (tools) => {
      await typePassword(tools);
      await tools.browser_observe!.execute({}, call);
      await (
        tools.stop_sign_in as never as {
          execute: (input: object) => Promise<unknown>;
        }
      ).execute({
        stage: "verification",
        reason: "The page asked for a code sent by email.",
        needsPerson: true,
      });
    });
    expect(await run()).toMatchObject({
      kind: "stopped",
      stage: "verification",
    });
    expect(recorded.map((stage) => [stage.stage, stage.status])).toEqual([
      ["connect-link", "passed"],
    ]);
  });

  it("keeps the first safe picture of it, not a suppressed one before it", async () => {
    const browser = fakeBrowser([
      shot(`${AUTH}/sign-in`),
      shot(`${AUTH}/sign-in`),
      { url: `${AUTH}/next`, screenshotSuppressed: true },
      shot(`${AUTH}/next`),
      shot(`${AUTH}/consent`),
      { url: CALLBACK },
    ]);
    const { run, recorded } = agentWith(browser, async (tools) => {
      await typePassword(tools);
      await tools.browser_act!.execute({ verb: "click", ref: "e3" }, call);
      await tools.browser_observe!.execute({}, call);
      await tools.browser_act!.execute({ verb: "click", ref: "e4" }, call);
      await tools.browser_act!.execute({ verb: "click", ref: "e5" }, call);
    });
    expect((await run()).kind).toBe("callback");
    expect(
      recorded.map((stage) => [
        stage.stage,
        stage.status,
        stage.evidence?.screenshotStatus,
      ]),
    ).toEqual([
      ["connect-link", "passed", "captured"],
      ["sign-in", "passed", "captured"],
      ["consent", "passed", "captured"],
    ]);
  });

  it("is not confirmed by a callback without a code", async () => {
    const browser = fakeBrowser(
      [
        shot(`${AUTH}/sign-in`),
        shot(`${AUTH}/sign-in`),
        shot(`${AUTH}/error`),
        { url: CALLBACK },
      ],
      `${CALLBACK}?error=access_denied&state=s1`,
    );
    const { run, recorded } = agentWith(browser, async (tools) => {
      await typePassword(tools);
      await tools.browser_observe!.execute({}, call);
      await tools.browser_act!.execute({ verb: "click", ref: "e5" }, call);
    });
    expect(await run()).toEqual({
      kind: "callback",
      url: `${CALLBACK}?error=access_denied&state=s1`,
    });
    expect(
      recorded.map((stage) => [
        stage.stage,
        stage.status,
        stage.evidence?.screenshotStatus,
      ]),
    ).toEqual([
      ["connect-link", "passed", "captured"],
      ["sign-in", "blocked", "captured"],
    ]);
    expect(recorded[1]!.detail).toContain("no code");
  });
});

describe("a sign-in that does not reach it", () => {
  it("stops where the agent stops, never showing the form as it was before the password", async () => {
    const browser = fakeBrowser([shot(`${AUTH}/sign-in`)]);
    const { run, recorded } = agentWith(browser, async (tools) => {
      await tools.browser_act!.execute(
        {
          verb: "type",
          ref: "e2",
          value: "{{secret:MCPJAM_REVIEWER_PASSWORD}}",
        },
        call,
      );
      await (
        tools.stop_sign_in as never as {
          execute: (input: object) => Promise<unknown>;
        }
      ).execute({
        stage: "sign-in",
        reason: "The page said the password is incorrect.",
        needsPerson: false,
      });
    });
    const outcome = await run();
    expect(outcome).toMatchObject({
      kind: "stopped",
      stage: "sign-in",
      needsPerson: false,
      evidence: { screenshotStatus: "suppressed" },
    });
    expect(recorded.map((stage) => stage.stage)).toEqual(["connect-link"]);
  });

  it("refuses a second password try, and gives back one the browser never typed", async () => {
    const browser = fakeBrowser([shot(`${AUTH}/sign-in`)]);
    const mark = vi.fn(
      async () => "password_already_submitted: already typed once.",
    );
    const giveBack = vi.fn(async () => {});
    let answer: unknown;
    const { run } = agentWith(
      browser,
      async (tools) => {
        answer = await tools.browser_act!.execute(
          {
            verb: "type",
            ref: "e2",
            value: "{{secret:MCPJAM_REVIEWER_PASSWORD}}",
          },
          call,
        );
        await browser.options().secrets!.afterDeliver!(
          ["MCPJAM_REVIEWER_PASSWORD"],
          { commandId: "cmd-9", outcome: "not_typed" },
        );
      },
      { password: { mark, giveBack } },
    );
    expect(await run()).toMatchObject({ kind: "ended" });
    expect(answer).toEqual({
      error: "password_already_submitted: already typed once.",
    });
    expect(giveBack).toHaveBeenCalledWith("cmd-9");
  });

  it("ends with the engine's reason when the turn stops on its own", async () => {
    const browser = fakeBrowser([shot(`${AUTH}/sign-in`)]);
    const { run } = agentWith(browser, async () => {}, {
      runTurn: (async (options: {
        onEngineError: (event: { message: string }) => void;
      }) => {
        options.onEngineError({
          message: "MCPJam's daily budget for this feature is spent.",
        });
        return {};
      }) as never,
    });
    expect(await run()).toMatchObject({
      kind: "ended",
      stage: "sign-in",
      reason: "MCPJam's daily budget for this feature is spent.",
      evidence: { screenshotStatus: "unavailable" },
    });
  });
});

describe("what the agent is told", () => {
  it("names credentials, never their values, and the organization to choose", () => {
    const told = signInInstructions(ATTEMPT);
    expect(told).toContain("{{secret:MCPJAM_REVIEWER_PASSWORD}}");
    expect(told).toContain("{{secret:MCPJAM_REVIEWER_EMAIL}}");
    expect(told).toContain('choose "Acme"');
    expect(told).toMatch(/Never create an account/);
    const untold = signInInstructions({ ...ATTEMPT, tenant: undefined });
    expect(untold).toMatch(
      /more than one choice, call stop_sign_in with needsPerson true/,
    );
  });
});
