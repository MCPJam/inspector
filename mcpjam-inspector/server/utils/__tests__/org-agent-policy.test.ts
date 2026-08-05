/**
 * The policy cache's FAILURE behaviour, which is the only part of it that is
 * hard to see in production and expensive to get wrong.
 *
 * Two properties carry the weight:
 *
 *   1. WHAT THE FALLBACK IS. Falling back to the empty set re-enables every
 *      operation the org switched off. At tool assembly that hands the model a
 *      disabled DIRECT tool, which never reaches the execute route's check —
 *      so the fallback has to be the org's last known decision, and empty is
 *      only for an org we have never read.
 *   2. THAT A SLOW BACKEND COSTS ONE TURN, NOT EVERY TURN. The backend client
 *      waits 10s before it errors, so the failure backoff alone leaves a
 *      window in which each turn pays the 2s deadline again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getOrgAgentPolicyMock = vi.fn();

vi.mock("../../services/slack-backend.js", () => ({
  getOrgAgentPolicy: getOrgAgentPolicyMock,
  // Carries `status`: `isRouteMissing` reads it to tell an old deployment
  // apart from an outage.
  SlackBackendUnavailable: class SlackBackendUnavailable extends Error {
    readonly status?: number;
    constructor(message: string, options?: { status?: number }) {
      super(message);
      this.name = "SlackBackendUnavailable";
      this.status = options?.status;
    }
  },
}));

const { SlackBackendUnavailable } = await import(
  "../../services/slack-backend.js"
);
const {
  clearOrgAgentPolicyCache,
  getOrgAgentPolicyCached,
  getOrgAgentPolicyStrict,
} = await import("../org-agent-policy.js");

const TTL_MS = 60_000;
const DEADLINE_MS = 2_000;

describe("org agent policy cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearOrgAgentPolicyCache();
    getOrgAgentPolicyMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads once and serves the rest of the TTL from cache", async () => {
    getOrgAgentPolicyMock.mockResolvedValue({
      disabledOperations: ["run_eval_suite"],
    });

    await expect(getOrgAgentPolicyCached("org_1")).resolves.toEqual(
      new Set(["run_eval_suite"])
    );
    await expect(getOrgAgentPolicyCached("org_1")).resolves.toEqual(
      new Set(["run_eval_suite"])
    );
    expect(getOrgAgentPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("serves the STALE policy when a refresh blows the turn deadline", async () => {
    getOrgAgentPolicyMock.mockResolvedValueOnce({
      disabledOperations: ["run_eval_suite"],
    });
    await getOrgAgentPolicyCached("org_1");

    // The entry expires, and the refresh hangs — a slow backend, not a failed
    // one, so nothing has thrown yet.
    vi.advanceTimersByTime(TTL_MS + 1_000);
    getOrgAgentPolicyMock.mockImplementationOnce(
      () => new Promise(() => undefined)
    );

    const pending = getOrgAgentPolicyCached("org_1");
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    // NOT the empty set: `run_eval_suite` stays disabled.
    await expect(pending).resolves.toEqual(new Set(["run_eval_suite"]));
  });

  it("does not make the NEXT turn wait out the deadline as well", async () => {
    getOrgAgentPolicyMock.mockResolvedValueOnce({
      disabledOperations: ["run_eval_suite"],
    });
    await getOrgAgentPolicyCached("org_1");

    vi.advanceTimersByTime(TTL_MS + 1_000);
    getOrgAgentPolicyMock.mockImplementation(
      () => new Promise(() => undefined)
    );

    const first = getOrgAgentPolicyCached("org_1");
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await first;

    // The deadline wrote the fallback under a short backoff, so this one is a
    // cache hit — it resolves without any timer being advanced at all.
    await expect(getOrgAgentPolicyCached("org_1")).resolves.toEqual(
      new Set(["run_eval_suite"])
    );
  });

  it("treats a 404 as an empty policy and stops asking", async () => {
    getOrgAgentPolicyMock.mockRejectedValue(
      new SlackBackendUnavailable("no route", { status: 404 })
    );

    await expect(getOrgAgentPolicyCached("org_1")).resolves.toEqual(new Set());
    await expect(getOrgAgentPolicyCached("org_1")).resolves.toEqual(new Set());
    expect(getOrgAgentPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("fails CLOSED in strict mode when there is nothing cached", async () => {
    getOrgAgentPolicyMock.mockRejectedValue(
      new SlackBackendUnavailable("down")
    );
    await expect(getOrgAgentPolicyStrict("org_1")).rejects.toBeInstanceOf(
      SlackBackendUnavailable
    );
  });

  it("serves a stale policy in strict mode rather than refusing a click", async () => {
    getOrgAgentPolicyMock.mockResolvedValueOnce({
      disabledOperations: ["run_eval_suite"],
    });
    await getOrgAgentPolicyCached("org_1");

    vi.advanceTimersByTime(TTL_MS + 1_000);
    getOrgAgentPolicyMock.mockRejectedValueOnce(
      new SlackBackendUnavailable("down")
    );
    await expect(getOrgAgentPolicyStrict("org_1")).resolves.toEqual(
      new Set(["run_eval_suite"])
    );
  });

  it("returns the empty set for a caller with no org, without a round trip", async () => {
    await expect(getOrgAgentPolicyCached(undefined)).resolves.toEqual(
      new Set()
    );
    await expect(getOrgAgentPolicyStrict(null)).resolves.toEqual(new Set());
    expect(getOrgAgentPolicyMock).not.toHaveBeenCalled();
  });
});
