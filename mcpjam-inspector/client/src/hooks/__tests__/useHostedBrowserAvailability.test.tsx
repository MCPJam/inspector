import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  hosted: true,
  isMember: true as boolean | undefined,
  userReady: true,
  result: undefined as unknown,
  asked: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));
vi.mock("../use-is-member-actor", () => ({
  useIsMemberActor: () => state.isMember,
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => state.userReady,
}));
vi.mock("convex/react", () => ({
  useQueries: (queries: Record<string, { args: Record<string, unknown> }>) => {
    if (!queries.availability) return {};
    state.asked.push(queries.availability.args);
    return { availability: state.result };
  },
}));

const ANSWER = {
  inspector: { available: true, reason: null },
  tools: { available: false, reason: "catalog_disabled" },
};

async function render(
  surface: "inspector" | "tools",
  scope: { organizationId?: string | null; projectId?: string | null } = {
    organizationId: "org_1",
  },
) {
  // `HOSTED_MODE` picks the implementation at load, so load it fresh.
  vi.resetModules();
  const { HostedBrowserScopeProvider, useHostedBrowserAvailable } =
    await import("../useHostedBrowserAvailability");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <HostedBrowserScopeProvider {...scope}>
      {children}
    </HostedBrowserScopeProvider>
  );
  return renderHook(() => useHostedBrowserAvailable(surface), { wrapper })
    .result.current;
}

beforeEach(() => {
  state.hosted = true;
  state.isMember = true;
  state.userReady = true;
  state.result = ANSWER;
  state.asked = [];
});

describe("useHostedBrowserAvailable", () => {
  it("answers each surface from the backend", async () => {
    expect(await render("inspector")).toBe(true);
    expect(await render("tools")).toBe(false);
    expect(state.asked[0]).toEqual({ organizationId: "org_1" });
  });

  it("asks by project when one is active, the scope a launch is gated on", async () => {
    await render("inspector", { organizationId: "org_1", projectId: "proj_1" });
    expect(state.asked[0]).toEqual({ projectId: "proj_1" });
  });

  it("is undefined while the answer is not in, so a route guard waits", async () => {
    state.result = undefined;
    expect(await render("inspector")).toBeUndefined();
  });

  it("offers nothing when the backend cannot answer", async () => {
    // An older backend without the query, or any server error.
    state.result = new Error("Could not find public function");
    expect(await render("inspector")).toBe(false);
  });

  it("offers nothing, without throwing, on an answer it cannot read", async () => {
    for (const answer of [null, {}, { inspector: null }]) {
      state.result = answer;
      expect(await render("inspector")).toBe(false);
    }
  });

  it("refuses a guest without asking", async () => {
    state.isMember = false;
    expect(await render("inspector")).toBe(false);
    expect(state.asked).toEqual([]);
  });

  it("waits while the member or the scope is still resolving", async () => {
    state.isMember = undefined;
    expect(await render("inspector")).toBeUndefined();
    state.isMember = true;
    expect(await render("inspector", {})).toBeUndefined();
    expect(state.asked).toEqual([]);
  });

  it("asks nothing outside hosted mode", async () => {
    state.hosted = false;
    expect(await render("inspector")).toBeUndefined();
    expect(state.asked).toEqual([]);
  });
});
