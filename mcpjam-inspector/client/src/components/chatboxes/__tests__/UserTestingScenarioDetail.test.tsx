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
  updateChatboxMock,
  environmentState,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  locationState: { search: "" },
  usagePanelMock: vi.fn(),
  deleteChatboxMock: vi.fn().mockResolvedValue(undefined),
  updateChatboxMock: vi.fn().mockResolvedValue(undefined),
  // What `useProjectEnvironment` answers with: `undefined` = loading,
  // `null` = not visible, a row = loaded. Mutable per test.
  environmentState: { row: undefined as unknown },
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
  useChatboxMutations: () => ({
    deleteChatbox: deleteChatboxMock,
    updateChatbox: updateChatboxMock,
  }),
}));

// Mandatory: the real hook calls `useConvexAuth`, which has no provider here.
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironment: (projectId: string | null, envId: string | null) =>
    projectId && envId ? environmentState.row : null,
}));

vi.mock("@/components/project-environments/NameEnvironmentDialog", () => ({
  NameEnvironmentDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="stub-name-environment-dialog" /> : null,
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

const renderDetail = (over: Partial<ChatboxSettings> = {}) =>
  render(
    <UserTestingScenarioDetail
      chatbox={{ ...chatbox, ...over } as ChatboxSettings}
      onBack={vi.fn()}
      onDeleted={vi.fn()}
    />,
  );

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears calls but NOT implementations — reinstate the
  // resolved defaults so a per-test rejection can't leak into later cases.
  deleteChatboxMock.mockResolvedValue(undefined);
  updateChatboxMock.mockResolvedValue(undefined);
  locationState.search = "";
  environmentState.row = undefined;
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

  describe("naming the backing ad-hoc environment", () => {
    const adhocRow = {
      environmentId: "env-1",
      projectId: "p1",
      origin: "adhoc",
      hostId: "host-1",
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
    };

    it("offers it for an ad-hoc row, and opens the dialog", () => {
      environmentState.row = adhocRow;
      // The label is synthesized from the client for ad-hoc rows — its
      // presence must NOT read as "named".
      renderDetail({ environmentId: "env-1", environmentName: "ChatGPT" });

      const button = screen.getByTestId("user-testing-name-environment");
      fireEvent.click(button);

      expect(
        screen.getByTestId("stub-name-environment-dialog"),
      ).toBeInTheDocument();
    });

    it("hides it while the environment row is still loading (fail closed)", () => {
      environmentState.row = undefined;
      renderDetail({ environmentId: "env-1", environmentName: "ChatGPT" });

      expect(
        screen.queryByTestId("user-testing-name-environment"),
      ).not.toBeInTheDocument();
    });

    it("hides it for a named environment", () => {
      environmentState.row = {
        ...adhocRow,
        origin: "named",
        name: "Checkout flow",
      };
      renderDetail({
        environmentId: "env-1",
        environmentName: "Checkout flow",
      });

      expect(
        screen.queryByTestId("user-testing-name-environment"),
      ).not.toBeInTheDocument();
    });

    it("hides it for a host-backed scenario (no environment at all)", () => {
      renderDetail();

      expect(
        screen.queryByTestId("user-testing-name-environment"),
      ).not.toBeInTheDocument();
    });
  });

  describe("editing the scenario itself", () => {
    it("renames via updateChatbox from the header title", async () => {
      renderDetail();

      fireEvent.click(screen.getByText("Payments beta"));
      const input = screen.getByDisplayValue("Payments beta");
      fireEvent.change(input, { target: { value: "Payments GA" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(updateChatboxMock).toHaveBeenCalledWith({
        chatboxId: "cb-1",
        name: "Payments GA",
      });
    });

    it("persists the description on blur, only when it changed", () => {
      renderDetail({ description: "Old copy" });

      const textarea = screen.getByTestId("user-testing-description");
      // Blur with no edit: no write.
      fireEvent.blur(textarea);
      expect(updateChatboxMock).not.toHaveBeenCalled();

      fireEvent.change(textarea, { target: { value: "New copy" } });
      fireEvent.blur(textarea);
      expect(updateChatboxMock).toHaveBeenCalledWith({
        chatboxId: "cb-1",
        description: "New copy",
      });
    });
  });
});
