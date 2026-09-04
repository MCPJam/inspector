/**
 * The suite failure-groups hook's "skip" contract.
 *
 * Convex's `useQuery` runs the query the moment it is given args; the only
 * way to not ask is the literal `"skip"`. A flag-off card and a suite-less
 * caller must both land there, or the flag gates the DOM and not the read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const convex = vi.hoisted(() => ({
  queryCalls: [] as Array<{ name: unknown; args: unknown }>,
  result: undefined as unknown,
}));

vi.mock("convex/react", () => ({
  useQuery: (name: unknown, args: unknown) => {
    convex.queryCalls.push({ name, args });
    return convex.result;
  },
  useMutation: () => vi.fn(),
}));

import { useSuiteFailureGroups } from "../use-suite-failure-groups";

type HookState = ReturnType<typeof useSuiteFailureGroups>;

function Harness({
  suiteId,
  enabled,
  onState,
}: {
  suiteId: string | null | undefined;
  enabled: boolean;
  onState: (state: HookState) => void;
}) {
  onState(useSuiteFailureGroups({ suiteId, enabled }));
  return null;
}

function renderHook(props: { suiteId: string | null | undefined; enabled: boolean }) {
  const states: HookState[] = [];
  render(<Harness {...props} onState={(state) => states.push(state)} />);
  return { latest: () => states[states.length - 1]! };
}

afterEach(() => {
  cleanup();
  convex.queryCalls = [];
  convex.result = undefined;
});

describe("useSuiteFailureGroups", () => {
  it("passes \"skip\" and reports not loading when the flag is off", () => {
    const { latest } = renderHook({ suiteId: "suite_1", enabled: false });
    expect(convex.queryCalls.length).toBeGreaterThan(0);
    for (const call of convex.queryCalls) {
      expect(call.name).toBe("evalFailureGroups:getSuiteFailureGroups");
      expect(call.args).toBe("skip");
    }
    expect(latest()).toMatchObject({ latest: null, inFlight: null, loading: false });
  });

  it("passes \"skip\" when there is no suite, even with the flag on", () => {
    renderHook({ suiteId: null, enabled: true });
    for (const call of convex.queryCalls) {
      expect(call.args).toBe("skip");
    }
  });

  it("asks with the suite id when enabled, and is loading until Convex answers", () => {
    const { latest } = renderHook({ suiteId: "suite_1", enabled: true });
    expect(convex.queryCalls[0]?.args).toEqual({ suiteId: "suite_1" });
    expect(latest().loading).toBe(true);
  });

  it("does not request when skipped", async () => {
    const { latest } = renderHook({ suiteId: "suite_1", enabled: false });
    await latest().request();
    expect(latest().requesting).toBe(false);
    expect(latest().error).toBeNull();
  });
});
