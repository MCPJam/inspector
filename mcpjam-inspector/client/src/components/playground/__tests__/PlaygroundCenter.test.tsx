import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlaygroundCenter } from "@/components/playground/PlaygroundCenter";

const mockUsePlaygroundStateContext = vi.fn();

vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  PLAYGROUND_FIRST_RUN_PROMPT: "mock-first-run-prompt",
  usePlaygroundStateContext: () => mockUsePlaygroundStateContext(),
}));

vi.mock("@/components/ui-playground/PlaygroundMain", () => ({
  PlaygroundMain: (props: { showPostConnectGuide?: boolean }) => (
    <div
      data-testid="playground-main"
      data-show-post-connect-guide={String(!!props.showPostConnectGuide)}
    />
  ),
}));

vi.mock("@/components/tools/SaveRequestDialog", () => ({
  default: () => <div data-testid="mock-save-request-dialog" />,
}));

function buildState(isGuidedPostConnect: boolean) {
  return {
    loadingState: { kind: "ready" as const },
    isExecuting: false,
    selectedTool: undefined,
    invokingMessage: undefined,
    pendingExecution: undefined,
    handleExecutionInjected: vi.fn(),
    setWidgetState: vi.fn(),
    deviceType: "desktop" as const,
    setDeviceType: vi.fn(),
    firstRunComposerSeed: false,
    onboarding: {
      isGuidedPostConnect,
      completeOnboarding: vi.fn(),
    },
    savedRequestsHook: {
      saveDialogState: {
        isOpen: false,
        defaults: { title: "", description: "" },
      },
      closeSaveDialog: vi.fn(),
      handleSaveDialogSubmit: vi.fn(),
    },
  };
}

describe("PlaygroundCenter", () => {
  it("shows the post-connect Excalidraw guide once onboarding reaches the guided phase", () => {
    mockUsePlaygroundStateContext.mockReturnValue(buildState(true));

    render(<PlaygroundCenter enableMultiModelChat={false} />);

    expect(screen.getByTestId("playground-main")).toHaveAttribute(
      "data-show-post-connect-guide",
      "true",
    );
  });

  it("does not show the guide before onboarding reaches the guided phase", () => {
    mockUsePlaygroundStateContext.mockReturnValue(buildState(false));

    render(<PlaygroundCenter enableMultiModelChat={false} />);

    expect(screen.getByTestId("playground-main")).toHaveAttribute(
      "data-show-post-connect-guide",
      "false",
    );
  });
});
