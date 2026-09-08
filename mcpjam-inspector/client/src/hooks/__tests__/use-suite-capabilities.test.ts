/**
 * The capabilities read is allowed to FAIL, and failing must cost nothing.
 *
 * Two ordinary failures reach this hook: a deployment that predates the query
 * (the inspector and the backend release independently), and a caller the
 * backend answers `null` for — its 404-never-403 shape for a suite this person
 * cannot see. Neither is a fault, and neither may take a page down.
 *
 * `useQuery` would: it re-throws during render, which is why this hook reads
 * through `useConvex().query` inside an effect instead. That choice is the
 * thing these tests pin — a refactor back to `useQuery` fails here rather than
 * in production, where it has already once taken `/evals` down for every user
 * a gate refused.
 */

import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const queryMock = vi.fn();
// ONE stable client, as `useConvex` really returns. A fresh object per render
// would make the hook's effect dependency change every render — which is not
// what the app does, and would test a loop nobody has.
const convexClient = { query: queryMock };
vi.mock("convex/react", () => ({
  useConvex: () => convexClient,
}));

import {
  hasJudgeSeverityCapability,
  useSuiteCapabilities,
  type SuiteCapabilitiesState,
} from "../use-suite-capabilities";

describe("useSuiteCapabilities", () => {
  it("reports `unavailable` when the backend answers null", async () => {
    queryMock.mockResolvedValue(null);
    const { result } = renderHook(() => useSuiteCapabilities("suite-1"));
    await waitFor(() => expect(result.current.state).toBe("unavailable"));
    expect(result.current.capabilities).toBeNull();
  });

  it("reports `unavailable` when the query throws, without re-throwing", async () => {
    queryMock.mockRejectedValue(
      new Error(
        "Could not find public function for 'testSuites:getSuiteCapabilities'",
      ),
    );
    const { result } = renderHook(() => useSuiteCapabilities("suite-1"));
    await waitFor(() => expect(result.current.state).toBe("unavailable"));
    expect(result.current.capabilities).toBeNull();
  });

  it("passes a resolved answer through unchanged", async () => {
    const capabilities = {
      suiteId: "suite-1",
      organizationId: "org-1",
      permissions: { "suite.delete": false },
      features: { computers: { enabled: false, reason: "flag_false" } },
      verdictPolicyV2: {
        deploymentMode: "enforce",
        suiteMode: null,
        canUpgrade: true,
      },
      judge: {
        gating: { enabled: false, reason: "not_enabled_on_deployment" },
        role: "advisory",
        hasRubric: false,
        agreement: { reviews: 0, agreements: 0, rate: null },
        acknowledgement: null,
      },
      revisionNumber: 4,
    };
    queryMock.mockResolvedValue(capabilities);
    const { result } = renderHook(() => useSuiteCapabilities("suite-1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    // Passed through, not reshaped. Anything this hook computed would be a
    // second opinion about a question the backend already answered.
    expect(result.current.capabilities).toEqual(capabilities);
  });

  it("does not ask at all without a suite", async () => {
    queryMock.mockClear();
    const { result } = renderHook(() => useSuiteCapabilities(null));
    await waitFor(() => expect(result.current.state).toBe("unavailable"));
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("re-asks when the refresh key moves", async () => {
    queryMock.mockClear();
    queryMock.mockResolvedValue(null);
    const { rerender } = renderHook(
      ({ key }: { key: number }) => useSuiteCapabilities("suite-1", key),
      { initialProps: { key: 1 } },
    );
    await waitFor(() => expect(queryMock).toHaveBeenCalledTimes(1));
    rerender({ key: 2 });
    // A save that changes what someone may do next has to change the rows,
    // not leave them describing the suite as it was when the page loaded.
    await waitFor(() => expect(queryMock).toHaveBeenCalledTimes(2));
  });
});

describe("hasJudgeSeverityCapability", () => {
  it("is false without C1 judges, even when today's judge fields exist", () => {
    expect(hasJudgeSeverityCapability(null)).toBe(false);
    expect(hasJudgeSeverityCapability(undefined)).toBe(false);
    expect(
      hasJudgeSeverityCapability({
        judge: { role: "gating" },
      } as never),
    ).toBe(false);
  });

  it("is true only when goal-completion identity is advertised", () => {
    expect(
      hasJudgeSeverityCapability({
        judges: {
          goalCompletion: {
            role: "advisory",
            template: { version: 1, hash: "h" },
            execution: "wired",
            calibration: { reviews: 0 },
          },
          groundedness: {
            role: "advisory",
            template: null,
            execution: "not_wired",
            calibration: "unavailable",
          },
        },
      } as never),
    ).toBe(true);
  });
});

/**
 * Ownership arrives beside the role matrix, and an absent `ownership` block
 * must NOT be read as "this suite is editable".
 *
 * The two repos release independently, so a client can talk to a backend that
 * predates the CI-owned lock — one that still REFUSES the write. A client that
 * treated the missing field as permission would offer an Edit button whose only
 * possible outcome is an error, which is the exact failure mode the lock's UI
 * exists to replace.
 */
describe("useSuiteCapabilities — suite ownership", () => {
  it("passes the ownership block through when the backend sends one", async () => {
    queryMock.mockResolvedValue({
      suiteId: "suite-1",
      permissions: { "suite.edit": true },
      ownership: {
        ciOwned: true,
        declaredSuiteId: "s_from_file",
        lockedActions: ["suite.edit", "case.create"],
      },
    });
    const { result } = renderHook(() => useSuiteCapabilities("suite-1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    expect(result.current.capabilities?.ownership?.ciOwned).toBe(true);
    expect(result.current.capabilities?.ownership?.declaredSuiteId).toBe(
      "s_from_file",
    );
    // `permissions` still answers by ROLE — an org owner holds `suite.edit` on
    // a CI-owned suite and still cannot use it. Folding ownership in would make
    // the matrix report something other than roles.
    expect(result.current.capabilities?.permissions["suite.edit"]).toBe(true);
  });

  it("leaves ownership undefined on a backend that predates the lock", async () => {
    queryMock.mockResolvedValue({
      suiteId: "suite-1",
      permissions: { "suite.edit": true },
    });
    const { result } = renderHook(() => useSuiteCapabilities("suite-1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    // Undefined, NOT `{ ciOwned: false }`: callers must fall back to
    // `isCiOwnedSuite(suite)` over the suite row rather than reading absence as
    // permission. The suite row carries both `declaredSuiteId` and `source`, so
    // that fallback is complete on its own.
    expect(result.current.capabilities?.ownership).toBeUndefined();
  });

  /*
   * SWITCHING SUITES MUST NOT CARRY THE OLD SUITE'S OWNERSHIP ACROSS.
   *
   * None of the three `SuiteIterationsView` call sites passes a `key`, so
   * picking another suite swaps the prop on a mounted view. The state only
   * resets inside the effect, and effects run after the commit — so without
   * the answer being keyed to its suite there is one committed render of the
   * new suite holding the old suite's `ownership`, which is one render of a
   * normal suite with its case-authoring controls withheld.
   *
   * Asserting after `rerender` would prove nothing: it wraps in `act`, which
   * flushes the effect that clears the stale value. So record what every
   * render actually returned and look at the ones after the switch.
   */
  it("never reports the previous suite's answer as the new suite's", async () => {
    queryMock.mockClear();
    queryMock.mockImplementation(
      async (_name: unknown, args: { suiteId: string }) =>
        args.suiteId === "suite-1"
          ? {
              suiteId: "suite-1",
              permissions: { "suite.edit": true },
              ownership: {
                ciOwned: true,
                declaredSuiteId: "s_from_file",
                lockedActions: ["suite.edit", "case.create"],
              },
            }
          : {
              suiteId: "suite-2",
              permissions: { "suite.edit": true },
              ownership: {
                ciOwned: false,
                declaredSuiteId: null,
                lockedActions: [],
              },
            },
    );

    const seen: SuiteCapabilitiesState[] = [];
    const { rerender } = renderHook(
      ({ suiteId }: { suiteId: string }) => {
        const answer = useSuiteCapabilities(suiteId);
        seen.push(answer);
        return answer;
      },
      { initialProps: { suiteId: "suite-1" } },
    );
    await waitFor(() =>
      expect(seen.at(-1)?.capabilities?.ownership?.ciOwned).toBe(true),
    );

    const beforeSwitch = seen.length;
    rerender({ suiteId: "suite-2" });

    const stale = seen
      .slice(beforeSwitch)
      .filter((answer) => answer.capabilities?.suiteId === "suite-1");
    expect(stale).toEqual([]);

    // And the new suite's own answer still arrives — reporting `loading`
    // across the switch must not mean reporting it forever.
    await waitFor(() =>
      expect(seen.at(-1)?.capabilities?.ownership?.ciOwned).toBe(false),
    );
  });
});
