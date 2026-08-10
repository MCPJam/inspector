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

const {
  navigateMock,
  locationState,
  usagePanelMock,
  deleteChatboxMock,
  previewPaneMock,
  hostState,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  locationState: { search: "" },
  usagePanelMock: vi.fn(),
  deleteChatboxMock: vi.fn().mockResolvedValue(undefined),
  previewPaneMock: vi.fn(),
  hostState: { host: null as unknown, isLoading: false },
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

// Stubbed so jsdom never mounts the real iframe — it would try to fetch the
// share URL, and the point of these specs is WHEN the pane exists, not what
// it renders (see ChatboxPreviewPane.test.tsx for that).
vi.mock("@/components/chatboxes/ChatboxPreviewPane", () => ({
  ChatboxPreviewPane: (props: Record<string, unknown>) => {
    previewPaneMock(props);
    return <div data-testid="stub-preview" />;
  },
}));

vi.mock("@/hooks/useClients", () => ({
  useHost: () => hostState,
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

const detail = (over: Partial<ChatboxSettings> = {}) => (
  <UserTestingScenarioDetail
    chatbox={{ ...chatbox, ...over } as ChatboxSettings}
    isAuthenticated
    onBack={vi.fn()}
    onDeleted={vi.fn()}
  />
);

const renderDetail = (over: Partial<ChatboxSettings> = {}) =>
  render(detail(over));

beforeEach(() => {
  vi.clearAllMocks();
  locationState.search = "";
  hostState.host = { config: { mcpProfile: undefined } };
  hostState.isLoading = false;
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

    // Addressed by chatbox id: the host it displays is not unique per
    // scenario once environments are in play.
    expect(navigateMock).toHaveBeenCalledWith(
      "/user-testing/cb-1?tab=clusters",
      { replace: true },
    );
  });

  it("names the ENVIRONMENT on an environment-backed scenario", () => {
    renderDetail({ environmentId: "env-1", environmentName: "Checkout flow" });

    expect(screen.getByText("Checkout flow")).toBeInTheDocument();
  });

  it("warns when the environment can't resolve, and keeps the sessions", () => {
    renderDetail({
      environmentId: "env-1",
      environmentName: "Checkout flow",
      environmentError: {
        code: "ENV_ARCHIVED",
        message: "Environment “Checkout flow” is archived.",
      },
    });

    expect(
      screen.getByTestId("user-testing-detail-environment-error"),
    ).toHaveTextContent(/archived/i);
    // History is exactly what someone opens an archived scenario to read.
    expect(screen.getByTestId("stub-usage-sessions")).toBeInTheDocument();
  });

  it("shows the client, not an environment, on a host-backed scenario", () => {
    renderDetail();

    expect(
      screen.queryByTestId("user-testing-detail-environment-error"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
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

/**
 * Preview embeds the live share link, which bootstraps a real guest session.
 * When it mounts is therefore a behaviour, not an implementation detail: too
 * eager and every visit to a scenario pollutes its own Sessions list.
 */
describe("UserTestingScenarioDetail — preview", () => {
  it("does not embed anything until the Preview tab is opened", () => {
    renderDetail();

    expect(screen.queryByTestId("stub-preview")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(navigateMock).toHaveBeenCalledWith("/user-testing/cb-1?tab=preview", {
      replace: true,
    });
  });

  it("embeds this scenario's share link when opened", () => {
    locationState.search = "?tab=preview";
    renderDetail();

    expect(screen.getByTestId("stub-preview")).toBeInTheDocument();
    expect(previewPaneMock).toHaveBeenCalledWith(
      expect.objectContaining({ publishLink: "https://mcpjam.link/t/tok" }),
    );
  });

  it("hides the preview instead of unmounting it when you switch away", () => {
    locationState.search = "?tab=preview";
    const { rerender } = renderDetail();

    locationState.search = "";
    rerender(detail());

    // Still mounted — remounting would abandon the running tester session and
    // start a second one on the way back.
    expect(screen.getByTestId("stub-usage-sessions")).toBeInTheDocument();
    expect(screen.getByTestId("stub-preview").parentElement).toHaveClass(
      "hidden",
    );
    expect(previewPaneMock.mock.calls.length).toBeGreaterThan(0);
  });

  it("passes the host's mcp profile through for the iframe permissions", () => {
    const mcpProfile = { apps: { sandbox: { permissions: { mode: "deny-all" } } } };
    hostState.host = { config: { mcpProfile } };
    locationState.search = "?tab=preview";
    renderDetail();

    expect(previewPaneMock).toHaveBeenCalledWith(
      expect.objectContaining({ mcpProfile }),
    );
  });

  it("waits for the host config rather than embedding with default permissions", () => {
    hostState.isLoading = true;
    hostState.host = null;
    locationState.search = "?tab=preview";
    renderDetail();

    // `allow` only applies at mount, and its no-config default is permissive.
    expect(screen.queryByTestId("stub-preview")).not.toBeInTheDocument();
    expect(screen.getByText(/Loading preview/i)).toBeInTheDocument();
  });

  it("refuses to embed a scenario whose environment can't resolve", () => {
    locationState.search = "?tab=preview";
    renderDetail({
      environmentId: "env-1",
      environmentName: "Checkout flow",
      environmentError: {
        code: "ENV_ARCHIVED",
        message: "Environment “Checkout flow” is archived.",
      },
    });

    // The link doesn't open for testers either — framing it would show them
    // the same failure with less explanation.
    expect(previewPaneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        publishLink: null,
        emptyTitle: "This scenario can't be previewed",
      }),
    );
  });
});
