import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  /** What the backend answers, by the args of the subscription asking. */
  answer: vi.fn((_args: Record<string, string[]>): unknown => undefined),
  subscriptions: [] as Array<Record<string, string[]> | null>,
}));

vi.mock("convex/react", () => ({
  useQueries: (queries: Record<string, { args: Record<string, string[]> }>) => {
    const policy = queries.policy;
    server.subscriptions.push(policy ? policy.args : null);
    return policy ? { policy: server.answer(policy.args) } : {};
  },
}));

import {
  telemetryMembershipKey,
  useTelemetryPrivacyContext,
  type TelemetryPrivacyContextInput,
} from "../useTelemetryPrivacyContext";

const FULL = { recording: "full", identity: "full" };
const MASKED = { recording: "masked", identity: "id_only" };

function input(
  overrides: Partial<TelemetryPrivacyContextInput> = {},
): TelemetryPrivacyContextInput {
  return {
    enabled: true,
    actor: "user_A",
    membershipKey: "org_1:member:0",
    projectIds: ["proj_1"],
    organizationIds: ["org_1", null, "org_1"],
    ...overrides,
  };
}

function render(initial: TelemetryPrivacyContextInput) {
  return renderHook(
    (props: TelemetryPrivacyContextInput) => useTelemetryPrivacyContext(props),
    { initialProps: initial },
  );
}

describe("useTelemetryPrivacyContext", () => {
  beforeEach(() => {
    server.answer.mockReset();
    server.answer.mockReturnValue(FULL);
    server.subscriptions.length = 0;
  });

  it("asks for the contexts in view and returns the answer for this actor", () => {
    const { result } = render(input());
    expect(result.current).toEqual({
      policy: FULL,
      identity: "full",
      actor: "user_A",
    });
    expect(server.subscriptions.at(-1)).toEqual({
      projectIds: ["proj_1"],
      organizationIds: ["org_1"],
    });
  });

  it("does not ask while the actor is still resolving", () => {
    const { result } = render(input({ actor: undefined }));
    expect(result.current.policy).toBeUndefined();
    expect(server.subscriptions.every((s) => s === null)).toBe(true);
  });

  it("asks for an anonymous visitor too, as no one", () => {
    server.answer.mockReturnValue(MASKED);
    const { result } = render(input({ actor: null }));
    expect(result.current).toEqual({
      policy: MASKED,
      identity: "id_only",
      actor: null,
    });
  });

  it("reads a query error or a malformed answer as conservative", () => {
    server.answer.mockReturnValue(new Error("boom"));
    expect(render(input()).result.current.policy).toEqual(MASKED);
    server.answer.mockReturnValue({ recording: "full" });
    expect(render(input()).result.current.policy).toEqual(MASKED);
  });

  it("never reads the previous actor's answer as the next actor's", () => {
    const { result, rerender } = render(input());
    expect(result.current.actor).toBe("user_A");
    // The local cache still holds user_A's answer when the actor changes.
    const seen: unknown[] = [];
    server.answer.mockImplementation(() => FULL);
    rerender(input({ actor: "user_B" }));
    seen.push(result.current);
    // The switch rendered with the query skipped, then subscribed afresh.
    expect(server.subscriptions).toContain(null);
    expect(seen[0]).not.toEqual(
      expect.objectContaining({ actor: "user_A", policy: FULL }),
    );
    expect(result.current.actor).toBe("user_B");
  });

  it("drops identity on a membership reload until the new answer arrives", () => {
    const { result, rerender } = render(input());
    server.answer.mockReturnValue(undefined);
    rerender(input({ membershipKey: "org_1:member:1" }));
    expect(result.current).toEqual({
      policy: undefined,
      identity: undefined,
      actor: "user_A",
    });
  });

  it("carries identity, not the recording policy, across a change of contexts", () => {
    const { result, rerender } = render(input());
    server.answer.mockReturnValue(undefined);
    rerender(input({ organizationIds: ["org_2"] }));
    expect(result.current).toEqual({
      policy: undefined,
      identity: "full",
      actor: "user_A",
    });
  });

  it("asks nothing when disabled", () => {
    const { result } = render(input({ enabled: false }));
    expect(result.current.policy).toBeUndefined();
    expect(server.answer).not.toHaveBeenCalled();
  });
});

describe("telemetryMembershipKey", () => {
  it("changes with membership, role and privacy, and reads loading as loading", () => {
    expect(telemetryMembershipKey(undefined)).toBe("loading");
    const base = [{ _id: "b" }, { _id: "a", myRole: "admin" }];
    expect(telemetryMembershipKey(base)).toBe(
      telemetryMembershipKey([...base].reverse()),
    );
    expect(telemetryMembershipKey(base)).not.toBe(
      telemetryMembershipKey([...base, { _id: "c" }]),
    );
    expect(telemetryMembershipKey(base)).not.toBe(
      telemetryMembershipKey([
        { _id: "b", enterprisePrivacy: true },
        { _id: "a", myRole: "admin" },
      ]),
    );
  });
});
