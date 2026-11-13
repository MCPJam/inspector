/**
 * A Claude run that could not use the server asks no model to read it.
 *
 * The SDK's gather marks that on the evidence as `serverFailure`, and the
 * grader already drops observations from such a run, so asking for them
 * would spend for nothing. The gather is wrapped here to set or clear the mark,
 * so this holds whether or not the SDK's own gather sets it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mark = vi.hoisted(() => ({ serverFailure: undefined as unknown }));

vi.mock("@mcpjam/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mcpjam/sdk")>();
  return {
    ...actual,
    gatherClaudeReadinessEvidence: async (
      ...args: Parameters<typeof actual.gatherClaudeReadinessEvidence>
    ) => {
      // The SDK's gather marks an unreachable server itself; the test's mark
      // decides here instead.
      const evidence: { serverFailure?: unknown } = {
        ...(await actual.gatherClaudeReadinessEvidence(...args)),
      };
      delete evidence.serverFailure;
      return mark.serverFailure
        ? { ...evidence, serverFailure: mark.serverFailure }
        : evidence;
    },
  };
});

const { runDirectoryReadiness } = await import("../runner.js");

const TARGET = "https://connector.example.com/mcp";

const dead = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

describe("a Claude run whose gather could not use the server", () => {
  beforeEach(() => {
    mark.serverFailure = undefined;
  });

  it("does not ask for observations, and says why", async () => {
    mark.serverFailure = { kind: "unreachable", detail: "ECONNREFUSED" };
    const requestObservations = vi.fn();
    const { result, observations } = await runDirectoryReadiness({
      publisher: "claude",
      target: TARGET,
      fetchFn: dead,
      requestObservations,
    });

    expect(requestObservations).not.toHaveBeenCalled();
    expect(observations).toMatchObject({
      status: "not-requested",
      reason: "no_evidence",
    });
    expect(observations.detail).toMatch(/nothing was charged/);
    // The grade still happens; only the paid pass is skipped.
    expect(result.llmObservations).toEqual(observations);
  });

  it("still asks when the gather recorded no failure", async () => {
    const requestObservations = vi.fn(async () => ({
      status: "billing-blocked" as const,
      reason: "billing_limit_reached",
    }));
    await runDirectoryReadiness({
      publisher: "claude",
      target: TARGET,
      fetchFn: dead,
      requestObservations,
    });
    expect(requestObservations).toHaveBeenCalledTimes(1);
  });
});
