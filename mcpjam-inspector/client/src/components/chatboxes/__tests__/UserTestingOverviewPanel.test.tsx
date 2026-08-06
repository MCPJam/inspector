/**
 * The scenario list is the landing screen for User Testing, so two things
 * matter more than layout: it must not claim numbers it doesn't have, and it
 * must not white-screen when the backend is older than the client.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatboxListItem } from "@/hooks/useChatboxes";

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));

vi.mock("@/lib/chatbox-client-style", () => ({
  getChatboxHostLabel: (style: string) => `Label:${style}`,
  getChatboxHostLogo: () => "logo.png",
}));

import { UserTestingOverviewPanel } from "../UserTestingOverviewPanel";

const row = (over: Partial<ChatboxListItem> = {}): ChatboxListItem => ({
  chatboxId: "cb1",
  projectId: "p1",
  name: "Payments beta",
  hostStyle: "cursor",
  mode: "anyone_with_link",
  allowGuestAccess: true,
  serverCount: 1,
  serverNames: ["acme-payments"],
  namedHostId: "host-1",
  namedHostName: "Cursor",
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

const defaults = {
  isLoading: false,
  onOpenScenario: vi.fn(),
  onCreateScenario: vi.fn(),
  createLabel: "New client",
};

describe("UserTestingOverviewPanel", () => {
  it("renders a scenario's client, server and tester count", () => {
    render(
      <UserTestingOverviewPanel
        {...defaults}
        chatboxes={[row({ uniqueTesterCount: 24, lastSessionAt: Date.now() })]}
      />,
    );

    expect(screen.getByText("Payments beta")).toBeInTheDocument();
    expect(screen.getByText("Label:cursor")).toBeInTheDocument();
    expect(screen.getByText("acme-payments")).toBeInTheDocument();
    expect(
      screen.getByTestId("user-testing-overview-testers"),
    ).toHaveTextContent("24");
  });

  // A backend that predates the counters sends nothing. "0 testers" and "we
  // don't know yet" are different claims, and only one of them should send
  // someone looking for a bug.
  it("shows an em dash, not zero, when the counters are absent", () => {
    render(<UserTestingOverviewPanel {...defaults} chatboxes={[row()]} />);

    expect(
      screen.getByTestId("user-testing-overview-testers"),
    ).toHaveTextContent("—");
  });

  it("counts a genuinely untested scenario as zero", () => {
    render(
      <UserTestingOverviewPanel
        {...defaults}
        chatboxes={[row({ uniqueTesterCount: 0 })]}
      />,
    );

    expect(
      screen.getByTestId("user-testing-overview-testers"),
    ).toHaveTextContent("0");
  });

  it("opens a scenario by its host id", () => {
    const onOpenScenario = vi.fn();
    render(
      <UserTestingOverviewPanel
        {...defaults}
        onOpenScenario={onOpenScenario}
        chatboxes={[row({ namedHostId: "host-42" })]}
      />,
    );

    fireEvent.click(screen.getByTestId("user-testing-overview-row"));

    expect(onOpenScenario).toHaveBeenCalledWith("host-42");
  });

  it("renders the empty state, with the create action, when there are none", () => {
    const onCreateScenario = vi.fn();
    render(
      <UserTestingOverviewPanel
        {...defaults}
        onCreateScenario={onCreateScenario}
        chatboxes={[]}
      />,
    );

    expect(
      screen.getByTestId("user-testing-overview-empty"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New client/i }));
    expect(onCreateScenario).toHaveBeenCalled();
  });

  it("shows a skeleton while the list is loading, not an empty state", () => {
    render(
      <UserTestingOverviewPanel
        {...defaults}
        isLoading
        chatboxes={undefined}
      />,
    );

    expect(
      screen.getByTestId("user-testing-overview-loading"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("user-testing-overview-empty"),
    ).not.toBeInTheDocument();
  });

  // This is the landing screen. A row shaped differently than expected — an
  // older or newer backend — must cost the list, not the whole page, and must
  // leave the create action reachable.
  it("falls back to the empty state when a row blows up the render", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const malformed = { ...row(), serverNames: undefined } as ChatboxListItem;

    render(<UserTestingOverviewPanel {...defaults} chatboxes={[malformed]} />);

    expect(
      screen.getByTestId("user-testing-overview-empty"),
    ).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
