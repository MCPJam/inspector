import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  plan: "free",
  user: "viewer",
  fail: false,
  projectsMissing: false,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: (name: string) => {
    if (state.fail) throw new Error("Raw internal error");
    return name === "users:getCurrentUser"
      ? { _id: state.user }
      : name === "projects:getMyProjects"
      ? state.projectsMissing
        ? []
        : [{ _id: "project", organizationId: "org" }]
      : { effectivePlan: state.plan };
  },
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
import {
  SharedSettingsGate,
  sharedSettingsAccess,
} from "../SharedSettingsGate";
beforeEach(() => {
  state.fail = false;
  state.projectsMissing = false;
  state.plan = "free";
  state.user = "viewer";
});
vi.mock("@/lib/error-reporting", () => ({ reportBoundaryError: vi.fn() }));
describe("shared settings access", () => {
  it("shows a safe retry prompt on query errors", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    state.fail = true;
    render(
      <SharedSettingsGate
        projectId="project"
        creatorId="creator"
        resource="study"
      >
        <button>Save</button>
      </SharedSettingsGate>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "couldn’t check your access",
    );
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Raw internal error")).not.toBeInTheDocument();
    spy.mockRestore();
  });
  it("does not spin forever for an inaccessible project", () => {
    state.projectsMissing = true;
    render(
      <SharedSettingsGate
        projectId="project"
        creatorId="creator"
        resource="study"
      >
        <button>Save</button>
      </SharedSettingsGate>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("couldn’t verify");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("leaves local settings available without a Convex query", () => {
    state.fail = true;
    render(
      <SharedSettingsGate projectId={null} creatorId={null} resource="study">
        <button>Save</button>
      </SharedSettingsGate>,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it.each(["free", "pro"])("offers Team for non-creators on %s", (plan) => {
    state.plan = plan;
    render(
      <SharedSettingsGate
        projectId="project"
        creatorId="creator"
        resource="eval suite"
      >
        <button>Save settings</button>
      </SharedSettingsGate>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Basic RBAC");
    expect(
      screen.getByRole("link", { name: "View Team plans" }),
    ).toHaveAttribute("href", "/organizations/org/plans");
    expect(
      screen.queryByRole("button", { name: "Save settings" }),
    ).not.toBeInTheDocument();
  });
  it.each(["team", "enterprise"])(
    "retains existing editing UI on %s",
    (plan) => {
      state.plan = plan;
      render(
        <SharedSettingsGate
          projectId="project"
          creatorId="creator"
          resource="study"
        >
          <button disabled>Role-restricted save</button>
        </SharedSettingsGate>,
      );
      expect(screen.getByRole("button")).toBeDisabled();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    },
  );
  it("allows creators even on Free", () => {
    expect(
      sharedSettingsAccess("owner", "owner", { effectivePlan: "free" }),
    ).toBe("allowed");
  });
  it("does not show an upsell while access is unresolved", () => {
    expect(sharedSettingsAccess(undefined, "owner", undefined)).toBe("loading");
    expect(sharedSettingsAccess("viewer", undefined, undefined)).toBe(
      "unavailable",
    );
  });
});
