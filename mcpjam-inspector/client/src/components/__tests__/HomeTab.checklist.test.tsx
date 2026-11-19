import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { HomeTab } from "../HomeTab";

const variant = vi.hoisted(() => ({ value: "control" }));
vi.mock("convex/react", () => ({ useQuery: () => undefined }));
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/app-navigation", () => ({ useAppNavigate: () => vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../home/OrgStatsStrip", () => ({ OrgStatsStrip: () => null }));
vi.mock("../home/RecommendedServers", () => ({ RecommendedServers: () => <div>Recommended servers</div> }));
vi.mock("../home/RecommendedHosts", () => ({ RecommendedHosts: () => null }));
vi.mock("../home/ProductUpdatesRow", () => ({ ProductUpdatesRow: () => null }));
vi.mock("../home/SharedSlackChannelCard", () => ({ SharedSlackChannelCard: () => null }));
vi.mock("../mcpjam-agent/McpjamAgentHero", () => ({ McpjamAgentHero: () => null }));
vi.mock("../mcpjam-agent/McpjamAgentThread", () => ({ McpjamAgentThread: () => null }));
vi.mock("../home/checklist/use-home-checklist-variant", () => ({
  useHomeChecklistVariant: () => variant.value,
}));
vi.mock("../home/checklist/HomeChecklist", () => ({
  HomeChecklist: ({ onFinished }: { onFinished: () => void }) => (
    <button type="button" onClick={onFinished}>
      Setup checklist
    </button>
  ),
}));

const renderHome = () =>
  render(
    <MemoryRouter initialEntries={["/home"]}>
      <HomeTab projectId="p" organizationId="org" />
    </MemoryRouter>,
  );

it("shows today's Home to control", () => {
  variant.value = "control";
  renderHome();
  expect(screen.getByText("Recommended servers")).toBeVisible();
  expect(screen.queryByText("Setup checklist")).toBeNull();
});

it("shows the checklist to treatment, then today's Home once it finishes", () => {
  variant.value = "treatment";
  renderHome();
  expect(screen.queryByText("Recommended servers")).toBeNull();
  screen.getByText("Setup checklist").click();
  expect(screen.findByText("Recommended servers")).resolves.toBeVisible();
});
