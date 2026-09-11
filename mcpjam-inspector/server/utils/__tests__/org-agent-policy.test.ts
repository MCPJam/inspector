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
 *
 * Both readers also union in what the DEPLOYMENT disables. The cases above
 * are about the ORG's answer, so the deployment switch is ON for them (empty
 * union) and the union has its own describe block at the bottom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configState = vi.hoisted(() => ({ scheduledEvalsWrite: true }));
vi.mock("../../config.js", () => ({
  get SCHEDULED_EVALS_WRITE_ENABLED() {
    return configState.scheduledEvalsWrite;
  },
}));

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
    // The entry really did expire and a refresh really is in flight —
    // otherwise the assertion below would pass on a cache that never lapsed.
    expect(getOrgAgentPolicyMock).toHaveBeenCalledTimes(2);
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
    expect(getOrgAgentPolicyMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await first;

    // The deadline wrote the fallback under a short backoff, so this one is a
    // cache hit — it resolves without any timer being advanced at all.
    await expect(getOrgAgentPolicyCached("org_1")).resolves.toEqual(
      new Set(["run_eval_suite"])
    );
  });

  it("does NOT let a cold fail-open fallback answer the execute route", async () => {
    // The whole point of the two modes. A cold deadline writes the empty set
    // so the next TURN is not held up — but that entry says "we could not
    // ask", not "the org disabled nothing", and a click must never be allowed
    // to spend on the difference.
    let fail: ((error: Error) => void) | null = null;
    getOrgAgentPolicyMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        })
    );

    const turn = getOrgAgentPolicyCached("org_cold");
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    // The turn is served the empty set and that answer is now in the cache.
    await expect(turn).resolves.toEqual(new Set());

    // Let the underlying read finish failing so nothing is left in flight.
    (fail as ((error: Error) => void) | null)?.(
      new SlackBackendUnavailable("down")
    );
    await vi.advanceTimersByTimeAsync(0);

    // Same org, fresh cache entry, empty set — and the execute route still
    // refuses, because that entry is a fallback rather than a policy.
    getOrgAgentPolicyMock.mockRejectedValue(
      new SlackBackendUnavailable("down")
    );
    await expect(getOrgAgentPolicyStrict("org_cold")).rejects.toBeInstanceOf(
      SlackBackendUnavailable
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

  it("fails closed in strict mode when an expired policy cannot be refreshed", async () => {
    getOrgAgentPolicyMock.mockResolvedValueOnce({
      disabledOperations: ["run_eval_suite"],
    });
    await getOrgAgentPolicyCached("org_1");

    vi.advanceTimersByTime(TTL_MS + 1_000);
    getOrgAgentPolicyMock.mockRejectedValueOnce(
      new SlackBackendUnavailable("down")
    );
    await expect(getOrgAgentPolicyStrict("org_1")).rejects.toBeInstanceOf(
      SlackBackendUnavailable
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

/**
 * The deployment union — what `MCPJAM_SCHEDULED_EVALS_WRITE_ENABLED` off adds
 * on top of the org's own answer.
 *
 * It rides the org policy because that is already the tighten-only channel
 * both enforcement seams read: tool assembly (so the op is never offered) and
 * the execute route (so a proposal minted before the flip is refused with the
 * existing message rather than reaching the route and 404-ing). These cases
 * pin that it survives every path the org's own answer can take — cached,
 * stale-served, no-org, and the strict reader's throw.
 */
describe("org agent policy — deployment-disabled operations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearOrgAgentPolicyCache();
    getOrgAgentPolicyMock.mockReset();
    configState.scheduledEvalsWrite = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    configState.scheduledEvalsWrite = true;
  });

  it("disables set_eval_suite_schedule for an org that disabled nothing", async () => {
    getOrgAgentPolicyMock.mockResolvedValue({ disabledOperations: [] });

    await expect(getOrgAgentPolicyCached("org_1")).resolves.toEqual(
      new Set(["set_eval_suite_schedule"])
    );
  });

  it("unions with the org's own set rather than replacing it", async () => {
    getOrgAgentPolicyMock.mockResolvedValue({
      disabledOperations: ["run_eval_suite"],
    });

    await expect(getOrgAgentPolicyStrict("org_1")).resolves.toEqual(
      new Set(["run_eval_suite", "set_eval_suite_schedule"])
    );
  });

  // An `sk_` caller whose request never carried an org still gets it: the
  // switch is the DEPLOYMENT's, and there is no org for it to depend on.
  it("disables it for a caller with no org, still without a round trip", async () => {
    await expect(getOrgAgentPolicyCached(undefined)).resolves.toEqual(
      new Set(["set_eval_suite_schedule"])
    );
    await expect(getOrgAgentPolicyStrict(null)).resolves.toEqual(
      new Set(["set_eval_suite_schedule"])
    );
    expect(getOrgAgentPolicyMock).not.toHaveBeenCalled();
  });

  // The union sits OUTSIDE the cache, so a flip takes effect on the next call
  // instead of waiting out the 60s TTL — and what is cached stays the org's
  // own answer.
  it("takes effect on a cache hit, without waiting out the TTL", async () => {
    configState.scheduledEvalsWrite = true;
    getOrgAgentPolicyMock.mockResolvedValue({ disabledOperations: [] });
    await expect(getOrgAgentPolicyCached("org_1")).resolves.toEqual(new Set());

    configState.scheduledEvalsWrite = false;
    await expect(getOrgAgentPolicyCached("org_1")).resolves.toEqual(
      new Set(["set_eval_suite_schedule"])
    );
    expect(getOrgAgentPolicyMock).toHaveBeenCalledTimes(1);
  });

  // Applied to the STALE entry too. A backend outage must not re-offer an
  // operation this deployment has switched off.
  it("holds when a stale policy is served during an outage", async () => {
    getOrgAgentPolicyMock.mockResolvedValueOnce({
      disabledOperations: ["run_eval_suite"],
    });
    await getOrgAgentPolicyCached("org_1");

    vi.advanceTimersByTime(TTL_MS + 1_000);
    getOrgAgentPolicyMock.mockRejectedValueOnce(
      new SlackBackendUnavailable("down")
    );
    await expect(getOrgAgentPolicyCached("org_1")).resolves.toEqual(
      new Set(["run_eval_suite", "set_eval_suite_schedule"])
    );
  });

  // The strict reader still THROWS on an unreadable policy — the union is
  // applied past the throw, and must not launder a failed read into an answer.
  it("does not turn the strict reader's failure into an answer", async () => {
    getOrgAgentPolicyMock.mockRejectedValue(new SlackBackendUnavailable("down"));

    await expect(getOrgAgentPolicyStrict("org_1")).rejects.toBeInstanceOf(
      SlackBackendUnavailable
    );
  });
});
