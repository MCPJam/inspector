import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { HomeTab } from "../HomeTab";
vi.mock("convex/react", () => ({ useQuery: () => undefined }));
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/app-navigation", () => ({ useAppNavigate: () => vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../home/OrgStatsStrip", () => ({ OrgStatsStrip: () => null }));
vi.mock("../home/RecommendedServers", () => ({ RecommendedServers: () => null }));
vi.mock("../home/RecommendedHosts", () => ({ RecommendedHosts: () => null }));
vi.mock("../home/ProductUpdatesRow", () => ({ ProductUpdatesRow: () => null }));
vi.mock("../home/SharedSlackChannelCard", () => ({ SharedSlackChannelCard: () => null }));
vi.mock("../mcpjam-agent/McpjamAgentHero", () => ({ McpjamAgentHero: () => <div>Home composer</div> }));
vi.mock("../mcpjam-agent/McpjamAgentThread", () => ({ McpjamAgentThread: () => <div>Home conversation</div> }));
it.each(["/home", "/home?compose=1"])("shows the composer on %s", (url) => {
  render(<MemoryRouter initialEntries={[url]}><HomeTab projectId="p" organizationId="org" /></MemoryRouter>);
  expect(screen.getByText("Home composer")).toBeVisible();
});
it("resumes a Home conversation", () => {
  render(<MemoryRouter initialEntries={["/home?session=general-1"]}><HomeTab projectId="p" organizationId="org" /></MemoryRouter>);
  expect(screen.getByText("Home conversation")).toBeVisible();
  expect(screen.getByRole("button", { name: "Back to home" })).toBeVisible();
});
