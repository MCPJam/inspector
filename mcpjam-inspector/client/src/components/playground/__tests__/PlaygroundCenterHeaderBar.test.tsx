import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaygroundCenterHeaderBar } from "@/components/playground/PlaygroundCenterHeaderBar";

vi.mock("@/components/shared/ClientContextHeader", () => ({
  ClientContextHeader: () => <div data-testid="mock-host-header" />,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

describe("PlaygroundCenterHeaderBar", () => {
  const defaultProps = {
    mode: "chat" as const,
    onModeChange: vi.fn(),
    headerView: "host" as const,
    onHeaderViewChange: vi.fn(),
    activeProjectId: null,
    protocol: null,
    isMultiModelLayoutMode: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows an in-flow Back control in host view so it is not absolutely positioned", () => {
    const { container } = render(
      <PlaygroundCenterHeaderBar
        {...defaultProps}
        showTraceTabs
        headerView="host"
      />,
    );

    const header = container.querySelector('[data-testid="playground-main-header"]');
    expect(header).toBeTruthy();
    expect(header).not.toHaveClass("relative");

    const back = screen.getByTestId("playground-header-host-back");
    expect(back).toBeVisible();
    expect(back.closest(".absolute")).toBeNull();
  });

  it("returns to tabs when Back is pressed", async () => {
    const user = userEvent.setup();
    const onHeaderViewChange = vi.fn();

    render(
      <PlaygroundCenterHeaderBar
        {...defaultProps}
        showTraceTabs
        headerView="host"
        onHeaderViewChange={onHeaderViewChange}
      />,
    );

    await user.click(screen.getByTestId("playground-header-host-back"));
    expect(onHeaderViewChange).toHaveBeenCalledWith("tabs");
  });

  it("omits Back when trace tabs are hidden (multi-model)", () => {
    render(
      <PlaygroundCenterHeaderBar
        {...defaultProps}
        showTraceTabs={false}
        headerView="host"
      />,
    );

    expect(screen.queryByTestId("playground-header-host-back")).toBeNull();
  });
});
