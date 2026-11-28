import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { posthog, captureMock } = vi.hoisted(() => {
  const captureMock = vi.fn();
  return {
    captureMock,
    posthog: { register: vi.fn(), unregister: vi.fn(), capture: captureMock },
  };
});
vi.mock("posthog-js", () => ({ default: posthog }));
vi.mock("posthog-js/react", () => ({ usePostHog: () => posthog }));
vi.mock("@/lib/PosthogUtils", () => ({
  standardEventProps: (location: string) => ({ location, platform: "web" }),
}));

import { usePostHogOrgContext } from "../usePostHogOrgContext";
import { track } from "@/lib/analytics";

beforeEach(() => vi.clearAllMocks());

function captured() {
  return captureMock.mock.calls.at(-1)?.[1];
}

it("groups a signed-in member's connect outcomes and tool events by organization", () => {
  renderHook(() => usePostHogOrgContext("org_1", true));
  track("server_connect_outcome", { outcome: "success" });
  expect(captured()).toMatchObject({ $groups: { organization: "org_1" } });
  track("execute_tool", { location: "tools_sidebar" });
  expect(captured()).toMatchObject({ $groups: { organization: "org_1" } });
});

it("never groups a guest's events", () => {
  renderHook(() => usePostHogOrgContext("org_guest", false));
  track("server_connect_outcome", { outcome: "failure" });
  expect(captured()).not.toHaveProperty("$groups");
});

it("stops grouping when the member signs out or leaves the organization", () => {
  const { rerender } = renderHook(
    ({ member, org }) => usePostHogOrgContext(org, member),
    { initialProps: { member: true, org: "org_1" as string | null } },
  );
  rerender({ member: false, org: "org_1" });
  track("server_connect_outcome", { outcome: "success" });
  expect(captured()).not.toHaveProperty("$groups");
  rerender({ member: true, org: null });
  track("server_connect_outcome", { outcome: "success" });
  expect(captured()).not.toHaveProperty("$groups");
});

it("stops grouping once the hook's owner unmounts", () => {
  // AuthRecoveryBoundary replaces App with a sign-in banner whose tracking
  // must not carry the organization App last had.
  const { unmount } = renderHook(() => usePostHogOrgContext("org_1", true));
  unmount();
  track("signin_started", { location: "session-refresh" });
  expect(captured()).not.toHaveProperty("$groups");
});

it("lets a billing event keep the organization it names", () => {
  renderHook(() => usePostHogOrgContext("org_in_view", true));
  track("billing_flow_started", { organization_id: "org_billed" });
  expect(captured()).toMatchObject({ $groups: { organization: "org_billed" } });
  track("billing_flow_started", {});
  expect(captured()).not.toHaveProperty("$groups");
});
