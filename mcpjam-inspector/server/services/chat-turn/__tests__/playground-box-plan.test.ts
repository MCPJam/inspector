import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import { playgroundBoxPlan } from "../playground-box-plan.js";
import { TurnTiming } from "../../../utils/turn-timing.js";

type Setup = Parameters<typeof playgroundBoxPlan>[0]["setup"];
const c = { req: { raw: { signal: undefined } } } as unknown as Context;
const setup = (overrides: Partial<Record<keyof Setup, unknown>> = {}) =>
  ({
    hostedBody: { projectId: "project-1", chatSessionId: "chat-1" },
    turnMode: "interactive",
    resolvedExecution: { harness: "claude-code" },
    harnessExecutionTarget: undefined,
    pinsEnvironment: false,
    environmentSpec: { environmentRef: { environmentId: "env-1" } },
    ...overrides,
  }) as Setup;

describe("playgroundBoxPlan", () => {
  it("books a hosted harness turn's box with the conversation's arguments", () => {
    const timing = new TurnTiming();
    const plan = playgroundBoxPlan({ c, bearerToken: "bearer", timing, setup: setup() });
    expect(plan.reason).toBe("conversation");
    expect(plan.args).toMatchObject({
      bearer: "bearer",
      projectId: "project-1",
      chatSessionId: "chat-1",
      harness: "claude-code",
      timing,
    });
    expect(plan.args).not.toHaveProperty("projectEnvironmentId");
  });

  it("names the environment only for a pinned environment", () => {
    const plan = playgroundBoxPlan({
      c,
      bearerToken: "bearer",
      timing: new TurnTiming(),
      setup: setup({ pinsEnvironment: true }),
    });
    expect(plan.args).toMatchObject({ projectEnvironmentId: "env-1" });
  });

  it("books a compare column's box for the compare reason", () => {
    const plan = playgroundBoxPlan({
      c,
      bearerToken: "bearer",
      timing: new TurnTiming(),
      setup: setup({
        hostedBody: { projectId: "p", chatSessionId: "c", comparePane: true },
      }),
    });
    expect(plan.reason).toBe("compare");
  });

  it("takes no Playground box for a local run or a recorded scenario", () => {
    for (const overrides of [
      { harnessExecutionTarget: { kind: "host", hostId: "host-1" } },
      { turnMode: "recorded" },
    ]) {
      const plan = playgroundBoxPlan({
        c,
        bearerToken: "bearer",
        timing: new TurnTiming(),
        setup: setup(overrides),
      });
      expect(plan.reason).toBeNull();
    }
  });
});
