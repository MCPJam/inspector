import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchResponse } from "@/test";

const authFetchMock = vi.fn();

vi.mock("@/lib/config", () => ({ HOSTED_MODE: false }));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import { runEvals } from "../evals-api";
import { launchReasonOf, runsOnMcpjamInstead } from "@/lib/eval-launch-reason";

const REFUSAL = "Required code evaluators can't run in a local run.";

async function refusedLaunch(details: Record<string, unknown>): Promise<unknown> {
  authFetchMock.mockResolvedValue(
    createFetchResponse({ code: "VALIDATION_ERROR", error: REFUSAL, details }, 400),
  );
  try {
    await runEvals({ projectId: "project-1", serverIds: ["srv_a"], tests: [] });
  } catch (error) {
    return error;
  }
  throw new Error("The launch was expected to be refused.");
}

describe("a refused eval launch", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
  });

  it("keeps the refusal's reason and rule on the thrown error", async () => {
    const failure = await refusedLaunch({
      code: "EVAL_CODE_EVALUATORS_UNAVAILABLE",
      reason: "EVAL_CODE_EVALUATORS_UNAVAILABLE",
      rule: "local_run",
    });

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(REFUSAL);
    expect(launchReasonOf(failure)).toEqual({
      reason: "EVAL_CODE_EVALUATORS_UNAVAILABLE",
      rule: "local_run",
    });
    expect(runsOnMcpjamInstead(failure)).toBe(true);
  });

  it("adds neither when the refusal names no reason", async () => {
    const failure = await refusedLaunch({ field: "tests" });

    expect(launchReasonOf(failure)).toEqual({});
    expect(runsOnMcpjamInstead(failure)).toBe(false);
  });
});
