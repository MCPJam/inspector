import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RunVenueHints } from "../RunVenueHints";
const state = vi.hoisted(() => ({
  host: vi.fn(),
  environment: vi.fn(),
  venue: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/hooks/useClients", () => ({ useHost: state.host }));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironment: state.environment,
}));
vi.mock("@/hooks/useUnattendedHarnessVenue", () => ({
  useUnattendedHarnessVenue: state.venue,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("resolves ad-hoc environments before the inactive host axis", () => {
  state.environment.mockReturnValue({ hostId: "environment-client" });
  state.host.mockReturnValue({
    host: { name: "Codex", config: { harness: "codex" } },
    isLoading: false,
  });
  state.venue.mockReturnValue("local");
  render(
    <RunVenueHints
      projectId="project"
      environmentIds={["adhoc"]}
      hostIds={["ignored"]}
    />,
  );
  expect(state.environment).toHaveBeenCalledWith("project", "adhoc");
  expect(state.host).toHaveBeenCalledWith({
    isAuthenticated: true,
    hostId: "environment-client",
  });
  expect(screen.getByRole("status")).toHaveTextContent("This machine");
});
it.each([null, { hostId: "client", archivedAt: 0 }])(
  "does not claim cloud when the environment cannot run",
  (environment) => {
    state.environment.mockReturnValue(environment);
    render(<RunVenueHints projectId="project" environmentIds={["gone"]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Unavailable");
    expect(state.venue).not.toHaveBeenCalled();
  },
);
