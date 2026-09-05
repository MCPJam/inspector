/**
 * The suite failure-groups hook's "skip" contract, and whose request its
 * `requesting` / `error` belong to.
 *
 * Convex's `useQuery` runs the query the moment it is given args; the only
 * way to not ask is the literal `"skip"`. A flag-off card and a suite-less
 * caller must both land there, or the flag gates the DOM and not the read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const convex = vi.hoisted(() => ({
  queryCalls: [] as Array<{ name: unknown; args: unknown }>,
  result: undefined as unknown,
  mutation: vi.fn(async (_args: unknown) => undefined),
}));

vi.mock("convex/react", () => ({
  useQuery: (name: unknown, args: unknown) => {
    convex.queryCalls.push({ name, args });
    return convex.result;
  },
  useMutation: () => convex.mutation,
}));

import { useSuiteFailureGroups } from "../use-suite-failure-groups";

type HookState = ReturnType<typeof useSuiteFailureGroups>;
type HookProps = { suiteId: string | null | undefined; enabled: boolean };

function Harness({
  suiteId,
  enabled,
  onState,
}: HookProps & { onState: (state: HookState) => void }) {
  onState(useSuiteFailureGroups({ suiteId, enabled }));
  return null;
}

function renderHook(props: HookProps) {
  const states: HookState[] = [];
  const onState = (state: HookState) => {
    states.push(state);
  };
  const utils = render(<Harness {...props} onState={onState} />);
  return {
    latest: () => states[states.length - 1]!,
    rerender: (next: HookProps) =>
      utils.rerender(<Harness {...next} onState={onState} />),
  };
}

afterEach(() => {
  cleanup();
  convex.queryCalls = [];
  convex.result = undefined;
  convex.mutation = vi.fn(async (_args: unknown) => undefined);
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
    await act(async () => {
      await latest().request();
    });
    expect(convex.mutation).not.toHaveBeenCalled();
    expect(latest().requesting).toBe(false);
    expect(latest().error).toBeNull();
  });

  it("requests for the suite and keeps the mutation's error for it", async () => {
    convex.mutation = vi.fn(async () => {
      throw new Error("judge unavailable");
    });
    const { latest } = renderHook({ suiteId: "suite_1", enabled: true });
    await act(async () => {
      await latest().request();
    });
    expect(convex.mutation).toHaveBeenCalledTimes(1);
    expect(convex.mutation).toHaveBeenCalledWith({ suiteId: "suite_1" });
    expect(latest().requesting).toBe(false);
    expect(latest().error).toBe("judge unavailable");
  });

  it("drops the old suite's requesting and error on a switch, and ignores its completion", async () => {
    let reject!: (error: Error) => void;
    convex.mutation = vi.fn(
      () =>
        new Promise<undefined>((_, rej) => {
          reject = rej;
        }),
    );
    const { latest, rerender } = renderHook({
      suiteId: "suite_a",
      enabled: true,
    });
    act(() => {
      void latest().request();
    });
    expect(latest().requesting).toBe(true);

    rerender({ suiteId: "suite_b", enabled: true });
    expect(latest().requesting).toBe(false);
    expect(latest().error).toBeNull();

    // Suite A's request settles after the switch: suite B must not wear it.
    await act(async () => {
      reject(new Error("late failure for suite_a"));
      await Promise.resolve();
    });
    expect(latest().requesting).toBe(false);
    expect(latest().error).toBeNull();

    // And switching back does not resurrect it either.
    rerender({ suiteId: "suite_a", enabled: true });
    expect(latest().requesting).toBe(false);
    expect(latest().error).toBeNull();
  });
});
