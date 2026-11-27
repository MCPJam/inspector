import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { HomeChecklist } from "../HomeChecklist";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => vi.fn(),
  routePaths: { playground: "/playground", conformance: "/conformance" },
  buildConformanceRunPath: (id: string) => `/conformance/runs/${id}`,
  buildConformanceSetupPath: () => "/conformance?setup=1",
  buildEvaluatePath: () => "/evaluate",
}));
vi.mock("@/hooks/use-soft-query", () => ({ useSoftQuery: () => ({ data: [] }) }));
vi.mock("@/components/ui/error-card", () => ({ ErrorCard: () => null }));
vi.mock("@/lib/app-route-context", () => ({
  useAppRouteContext: () => ({
    projectServers: {},
    appState: { servers: {} },
    convexProjectId: "p",
    currentUser: { _id: "me" },
    activeProject: { name: "Default" },
  }),
}));

const panelTitle = () => screen.getByRole("heading", { level: 3 });

it("shows the first unfinished step, then the step the user picks", () => {
  render(<HomeChecklist onFinished={vi.fn()} />);
  expect(screen.getByText("Finish setting up your project")).toBeVisible();
  expect(panelTitle()).toHaveTextContent("Connect your server");
  const agent = screen.getByRole("button", { name: /Add MCPJam to your coding agent/ });
  fireEvent.click(agent);
  expect(panelTitle()).toHaveTextContent("Add MCPJam to your coding agent");
  expect(agent).toHaveAttribute("aria-current", "step");
  fireEvent.click(agent);
  expect(panelTitle()).toHaveTextContent("Add MCPJam to your coding agent");
  expect(screen.getByText("Step 3 of 5")).toBeVisible();
});
