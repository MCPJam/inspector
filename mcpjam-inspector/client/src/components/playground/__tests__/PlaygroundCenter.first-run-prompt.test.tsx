import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeOnboarding, mockPlaygroundMain, playgroundState } = vi.hoisted(
  () => ({
    completeOnboarding: vi.fn(),
    mockPlaygroundMain: vi.fn(),
    playgroundState: {
      loadingState: { kind: "ready" },
      onboarding: {
        isGuidedPostConnect: false,
        isFirstRunUnfinished: false,
        completeOnboarding: vi.fn(),
      },
      firstRunComposerSeed: false,
      firstRunSubmitBlocked: false,
      isExecuting: false,
      selectedTool: null,
      invokingMessage: null,
      pendingExecution: null,
      handleExecutionInjected: vi.fn(),
      setWidgetState: vi.fn(),
      deviceType: "desktop",
      setDeviceType: vi.fn(),
      savedRequestsHook: {
        saveDialogState: {
          isOpen: false,
          defaults: { title: "", description: "" },
        },
        closeSaveDialog: vi.fn(),
        handleSaveDialogSubmit: vi.fn(),
      },
    },
  }),
);

vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  PLAYGROUND_FIRST_RUN_PROMPT: "What can this server do?",
  usePlaygroundStateContext: () => playgroundState,
}));

vi.mock("@/components/ui-playground/PlaygroundMain", () => ({
  PlaygroundMain: (props: { onFirstMessageSent?: () => void }) => {
    mockPlaygroundMain(props);
    return (
      <button type="button" onClick={props.onFirstMessageSent}>
        Send first message
      </button>
    );
  },
}));

vi.mock("@/components/tools/SaveRequestDialog", () => ({
  default: () => null,
}));

import { PlaygroundCenter } from "../PlaygroundCenter";

describe("PlaygroundCenter first-run prompt handoff", () => {
  beforeEach(() => {
    mockPlaygroundMain.mockClear();
    completeOnboarding.mockClear();
    playgroundState.onboarding.completeOnboarding = completeOnboarding;
  });

  it("prefills and highlights the general prompt without auto-sending it", () => {
    const onFirstRunPromptConsumed = vi.fn();

    render(
      <PlaygroundCenter
        enableMultiModelChat
        firstRunPrompt="What can this server do?"
        onFirstRunPromptConsumed={onFirstRunPromptConsumed}
      />,
    );

    expect(mockPlaygroundMain).toHaveBeenCalledWith(
      expect.objectContaining({
        initialInput: "What can this server do?",
        initialInputTypewriter: true,
        pulseSubmit: true,
      }),
    );
    expect(onFirstRunPromptConsumed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send first message" }));

    expect(onFirstRunPromptConsumed).toHaveBeenCalledOnce();
    expect(completeOnboarding).not.toHaveBeenCalled();
  });
});
