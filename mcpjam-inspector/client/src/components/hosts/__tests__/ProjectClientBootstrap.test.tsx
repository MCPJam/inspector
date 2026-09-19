import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ProjectClientBootstrap } from "../ProjectClientBootstrap";

vi.mock("../ClientSelectionSync", () => ({
  ClientSelectionSync: () => <div data-testid="selection-sync" />,
}));
vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [null, vi.fn()],
}));

describe("ProjectClientBootstrap", () => {
  beforeEach(() => window.history.replaceState({}, "", "/servers"));
  it("initializes without a router", () => {
    render(<ProjectClientBootstrap projectId="p1" />);
    expect(screen.getByTestId("selection-sync")).toBeInTheDocument();
  });
  it("defers to the client canvas on the no-router path", () => {
    window.history.replaceState({}, "", "/p/tn7dxppdq9nyz9ty8vt403n7sh8d7qx8/hosts/client-a");
    render(<ProjectClientBootstrap projectId="p1" />);
    expect(screen.queryByTestId("selection-sync")).not.toBeInTheDocument();
  });
  it("uses the router pathname instead of the window pathname", () => {
    render(
      <MemoryRouter initialEntries={["/p/tn7dxppdq9nyz9ty8vt403n7sh8d7qx8/hosts/client-a"]}>
        <ProjectClientBootstrap projectId="p1" />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("selection-sync")).not.toBeInTheDocument();
  });
});
