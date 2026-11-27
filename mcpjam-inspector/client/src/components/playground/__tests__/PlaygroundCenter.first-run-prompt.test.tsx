import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeOnboarding, mockPlaygroundMain, navigateApp, playgroundState } =
  vi.hoisted(() => ({
    completeOnboarding: vi.fn(),
    mockPlaygroundMain: vi.fn(),
    navigateApp: vi.fn(),
    playgroundState: {
      tools: {} as Record<string, unknown>,
      toolsListed: true,
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
  }));

vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  usePlaygroundStateContext: () => playgroundState,
}));

vi.mock("@/lib/app-navigation", () => ({
  navigateApp,
  routePaths: { tools: "/tools" },
}));

vi.mock("@/components/ui-playground/PlaygroundMain", () => ({
  PlaygroundMain: (props: {
    onFirstMessageSent?: () => void;
    onRunTool?: () => void;
    onAutoRunStarted?: () => void;
  }) => {
    mockPlaygroundMain(props);
    return (
      <>
        <button type="button" onClick={props.onFirstMessageSent}>
          Send first message
        </button>
        {props.onRunTool ? (
          <button type="button" onClick={props.onRunTool}>
            Run a tool
          </button>
        ) : null}
      </>
    );
  },
}));

vi.mock("@/components/tools/SaveRequestDialog", () => ({
  default: () => null,
}));

import { PlaygroundCenter } from "../PlaygroundCenter";
import {
  readHomeChecklistAutorun,
  writeHomeChecklistAutorun,
} from "@/components/home/checklist/playground-autorun";

function tool(name: string, destructive = false) {
  return {
    name,
    inputSchema: { type: "object" },
    ...(destructive ? { annotations: { destructiveHint: true } } : {}),
  };
}

describe("PlaygroundCenter first-run prompt handoff", () => {
  beforeEach(() => {
    mockPlaygroundMain.mockClear();
    completeOnboarding.mockClear();
    navigateApp.mockClear();
    playgroundState.tools = {
      search: tool("search"),
      get_issue: tool("get_issue"),
    };
    playgroundState.toolsListed = true;
    playgroundState.onboarding.completeOnboarding = completeOnboarding;
  });

  it("prefills and highlights the tool-calling prompt without auto-sending it", () => {
    const onFirstRunPromptConsumed = vi.fn();

    render(
      <PlaygroundCenter
        enableMultiModelChat
        firstRunPrompt
        onFirstRunPromptConsumed={onFirstRunPromptConsumed}
      />,
    );

    expect(mockPlaygroundMain).toHaveBeenCalledWith(
      expect.objectContaining({
        initialInput:
          "Call each of your tools once and summarize what they returned.",
        initialInputTypewriter: true,
        pulseSubmit: true,
      }),
    );
    expect(onFirstRunPromptConsumed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send first message" }));

    expect(onFirstRunPromptConsumed).toHaveBeenCalledOnce();
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it("waits for the tool list before prefilling", () => {
    playgroundState.toolsListed = false;
    render(<PlaygroundCenter enableMultiModelChat firstRunPrompt />);
    expect(mockPlaygroundMain).toHaveBeenLastCalledWith(
      expect.objectContaining({ initialInput: undefined, pulseSubmit: false }),
    );
  });

  it("asks about resources and prompts when every tool is destructive", () => {
    playgroundState.tools = { wipe: tool("wipe", true) };
    render(<PlaygroundCenter enableMultiModelChat firstRunPrompt />);
    expect(mockPlaygroundMain).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialInput: "List the resources and prompts this server exposes.",
      }),
    );
  });

  it("opens the first tool's form in the Tools tab from the chip", () => {
    render(<PlaygroundCenter enableMultiModelChat />);
    fireEvent.click(screen.getByRole("button", { name: "Run a tool" }));
    expect(navigateApp).toHaveBeenCalledWith("/tools", {
      state: { preselectTool: "search" },
    });
  });

  it("offers no chip when the server has no tools", () => {
    playgroundState.tools = {};
    render(<PlaygroundCenter enableMultiModelChat />);
    expect(
      screen.queryByRole("button", { name: "Run a tool" }),
    ).not.toBeInTheDocument();
  });

  it("drops Home's prompt once a mount tries it, and keeps it for a mount that didn't", () => {
    writeHomeChecklistAutorun({
      prompt: "What can this server do?",
      progressKey: "k",
    });
    const first = render(<PlaygroundCenter enableMultiModelChat />);
    expect(mockPlaygroundMain).toHaveBeenLastCalledWith(
      expect.objectContaining({ autoRunInput: "What can this server do?" }),
    );
    first.unmount();
    expect(readHomeChecklistAutorun()).not.toBeNull();

    render(<PlaygroundCenter enableMultiModelChat />);
    mockPlaygroundMain.mock.lastCall?.[0].onAutoRunStarted();
    expect(readHomeChecklistAutorun()).toBeNull();
  });

  it("drops Home's prompt when the user sends before the auto-run commits", () => {
    writeHomeChecklistAutorun({
      prompt: "What can this server do?",
      progressKey: "k",
    });
    render(<PlaygroundCenter enableMultiModelChat />);
    fireEvent.click(screen.getByRole("button", { name: "Send first message" }));
    expect(readHomeChecklistAutorun()).toBeNull();
  });
});
