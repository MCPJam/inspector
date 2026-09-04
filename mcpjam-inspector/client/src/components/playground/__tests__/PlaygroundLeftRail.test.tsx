import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { track } from "@/lib/analytics";
import type { ServerFormData } from "@/shared/types";
import { PlaygroundLeftRail } from "../PlaygroundLeftRail";

/**
 * Zero-server Tools rail: connecting a server must happen in place. The empty
 * state's "Connect a server" button used to navigate to Servers, which dropped
 * the user out of the Playground mid-flow (BB-134).
 */

const playgroundState = vi.hoisted(() => ({
  onConnect: undefined as ((formData: ServerFormData) => void) | undefined,
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

vi.mock("@/components/chat-v2/history/ChatHistoryRail", () => ({
  ChatHistoryRail: () => <div data-testid="chat-history-rail" />,
}));

vi.mock("../panes/EnvironmentToolsPane", () => ({
  EnvironmentToolsPane: () => <div data-testid="environment-tools-pane" />,
}));

vi.mock("../panes/MultiServerToolsPane", () => ({
  MultiServerToolsPaneInner: () => <div data-testid="multi-server-pane" />,
}));

vi.mock("../playground-chat-history-bridge", () => ({
  usePlaygroundChatHistoryBridge: () => null,
}));

vi.mock("@/hooks/useHarnessBuiltinTools", () => ({
  useHarnessBuiltinTools: () => ({ tools: [] }),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

vi.mock("@/hooks/use-previewed-environment-id", () => ({
  usePreviewedEnvironmentId: () => [null, vi.fn()],
}));

vi.mock("@/components/ui-playground/hooks/use-playground-state", () => ({
  usePlaygroundStateContext: () => ({
    tools: {},
    selectedTool: null,
    fetchingTools: false,
    fetchTools: vi.fn(),
    setSelectedTool: vi.fn(),
    formFields: {},
    updateFormField: vi.fn(),
    updateFormFieldIsSet: vi.fn(),
    isExecuting: false,
    executeTool: vi.fn(),
    activeServerNames: [],
    savedRequestsHook: {
      openSaveDialog: vi.fn(),
      savedRequests: [],
      highlightedRequestId: null,
      handleLoadRequest: vi.fn(),
      handleRenameRequest: vi.fn(),
      handleDuplicateRequest: vi.fn(),
      handleDeleteRequest: vi.fn(),
    },
    onConnect: playgroundState.onConnect,
  }),
}));

// Stands in for the empty state's "Connect a server" button, which lives three
// components down (PlaygroundLeft → ToolList) and is covered by ToolList's own
// suite. What matters here is the handler the rail hands it.
vi.mock("@/components/ui-playground/PlaygroundLeft", () => ({
  PlaygroundLeft: ({
    onAddServerRequested,
  }: {
    onAddServerRequested?: () => void;
  }) => (
    <button
      type="button"
      disabled={!onAddServerRequested}
      onClick={onAddServerRequested}
    >
      Connect a server
    </button>
  ),
}));

vi.mock("@/components/connection/AddServerModal", () => ({
  AddServerModal: ({
    isOpen,
    onSubmit,
  }: {
    isOpen: boolean;
    onSubmit: (formData: ServerFormData) => void;
  }) =>
    isOpen ? (
      <div role="dialog">
        <button
          type="button"
          onClick={() => onSubmit({ name: "local" } as ServerFormData)}
        >
          Save server
        </button>
      </div>
    ) : null,
}));

describe("PlaygroundLeftRail — zero-server Tools body", () => {
  beforeEach(() => {
    playgroundState.onConnect = undefined;
    vi.mocked(track).mockClear();
  });

  it("connects from the empty state without leaving the Playground", () => {
    const onConnect = vi.fn();
    playgroundState.onConnect = onConnect;

    render(<PlaygroundLeftRail />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /connect a server/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save server/i }));

    expect(onConnect).toHaveBeenCalledWith({ name: "local" });
    expect(track).toHaveBeenCalledWith("connecting_server", {
      location: "playground_tools_rail",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // Names the handler, not the fallback: the mock button is disabled purely
  // because it received no `onAddServerRequested`. That the real button then
  // routes to /servers is ToolList's test, not this one.
  it("hands PlaygroundLeft no connect handler when the state has none", () => {
    render(<PlaygroundLeftRail />);

    expect(
      screen.getByRole("button", { name: /connect a server/i }),
    ).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
