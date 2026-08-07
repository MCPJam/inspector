/**
 * Scenario detail. Two behaviours are load-bearing beyond layout:
 *
 *  - Clusters are per-scenario. The usage panel is chatbox-scoped, so the
 *    Clusters tab must be rendering against THIS scenario's chatboxId and not
 *    some project-wide aggregate — that was the defect in the design PR this
 *    surface replaced.
 *  - The sub-tab lives in the URL and switches with `replace`, so the browser
 *    back button goes from a scenario to the list rather than walking back
 *    through every tab the user tried.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatboxSettings } from "@/hooks/useChatboxes";

const { navigateMock, locationState, usagePanelMock, deleteChatboxMock } =
  vi.hoisted(() => ({
    navigateMock: vi.fn(),
    locationState: { search: "" },
    usagePanelMock: vi.fn(),
    deleteChatboxMock: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("react-router", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ search: locationState.search, pathname: "/x" }),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));

vi.mock("@/lib/chatbox-client-style", () => ({
  getChatboxHostLabel: (style: string) => `Label:${style}`,
  getChatboxHostLogo: () => "logo.png",
}));

vi.mock("@/lib/chatbox-session", () => ({
  buildChatboxLink: (token: string) => `https://mcpjam.link/t/${token}`,
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/useChatboxes", () => ({
  useChatboxMutations: () => ({ deleteChatbox: deleteChatboxMock }),
}));

vi.mock("@/components/chatboxes/ChatboxShareSection", () => ({
  ChatboxShareSection: () => <div data-testid="stub-share" />,
}));

vi.mock("@/components/chatboxes/ChatboxDeleteConfirmDialog", () => ({
  ChatboxDeleteConfirmDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="stub-delete-dialog" /> : null,
}));

vi.mock("@/components/chatboxes/ChatboxUsagePanel", () => ({
  ChatboxUsagePanel: (props: Record<string, unknown>) => {
    usagePanelMock(props);
    return <div data-testid={`stub-usage-${props.section}`} />;
  },
}));

import { UserTestingScenarioDetail } from "../UserTestingScenarioDetail";

const chatbox = {
  chatboxId: "cb-1",
  projectId: "p1",
  name: "Payments beta",
  hostStyle: "cursor",
  systemPrompt: "",
  modelId: "m",
  temperature: 0.5,
  requireToolApproval: false,
  allowGuestAccess: true,
  mode: "anyone_with_link",
  servers: [],
  namedHostId: "host-1",
  namedHostName: "Cursor",
  members: [],
  link: { token: "tok", path: "/t/tok", url: "u", rotatedAt: 0, updatedAt: 0 },
} as unknown as ChatboxSettings;

const renderDetail = () =>
  render(
    <UserTestingScenarioDetail
      chatbox={chatbox}
      hostName="Cursor"
      onBack={vi.fn()}
      onDeleted={vi.fn()}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  locationState.search = "";
});

describe("UserTestingScenarioDetail", () => {
  it("lands on Sessions and shows the scenario's share link", () => {
    renderDetail();

    expect(screen.getByTestId("stub-usage-sessions")).toBeInTheDocument();
    expect(screen.getByText("mcpjam.link/t/tok")).toBeInTheDocument();
  });

  it("scopes Clusters to this scenario's chatbox", () => {
    locationState.search = "?tab=clusters";
    renderDetail();

    expect(screen.getByTestId("stub-usage-insights")).toBeInTheDocument();
    expect(usagePanelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        section: "insights",
        chatbox: expect.objectContaining({ chatboxId: "cb-1" }),
      }),
    );
  });

  it("switches tabs by replacing the URL, not pushing onto history", () => {
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: "Clusters" }));

    expect(navigateMock).toHaveBeenCalledWith(
      "/user-testing/host-1?tab=clusters",
      { replace: true },
    );
  });

  it("seeds the session pane from a deep-linked session", () => {
    locationState.search = "?session=thread-9";
    renderDetail();

    expect(usagePanelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        section: "sessions",
        initialThreadId: "thread-9",
      }),
    );
  });

  it("asks for confirmation before deleting rather than deleting outright", () => {
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: /Delete/i }));

    expect(screen.getByTestId("stub-delete-dialog")).toBeInTheDocument();
    expect(deleteChatboxMock).not.toHaveBeenCalled();
  });
});
