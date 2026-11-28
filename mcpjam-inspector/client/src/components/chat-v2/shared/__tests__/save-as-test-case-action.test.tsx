import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The per-turn promote surface. Covered here because it is the one promote
 * affordance that used to stop at a toast: the session-level dialog surfaces
 * navigate through `onImported` (see ShareUsageThreadDetail's tests), so
 * without this the "land on the created case" contract held on some surfaces
 * and not on this one.
 */

const saveAction = vi.fn();
const { mockNavigateApp, mockToast } = vi.hoisted(() => ({
  mockNavigateApp: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: () => [
    { suite: { _id: "suite-1", name: "Excalidraw suite", source: "chat" } },
  ],
  useAction: () => saveAction,
}));

// A settled, fully bootstrapped session: the attachment pickers are live, so
// the new-suite requirement applies rather than being waived as pending.
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [{ _id: "attachment-1" }],
  }),
}));

const mockTrack = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track: mockTrack }));

const projectHosts = vi.hoisted(() => ({
  value: [{ hostId: "host-first" }] as Array<{ hostId: string }>,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: projectHosts.value, isLoading: false }),
}));

vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: () => <div data-testid="server-picker" />,
}));
vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: ({
    isOpen,
    onCreated,
  }: {
    isOpen: boolean;
    onCreated: (hostId: string) => void;
  }) =>
    isOpen ? (
      <button type="button" onClick={() => onCreated("host-new")}>
        Finish creating client
      </button>
    ) : null,
}));
vi.mock("@/components/hosts/client-multi-select", () => ({
  ClientMultiSelect: ({
    value,
    onChange,
  }: {
    value: string[];
    onChange: (ids: string[]) => void;
  }) => (
    <button
      type="button"
      data-testid="client-multi-select"
      data-host={value.join(",")}
      onClick={() => onChange([])}
    >
      Clear clients
    </button>
  ),
}));

vi.mock("@/lib/toast", () => ({ toast: mockToast }));

// Stubs, not reimplementations of the real builders (those are covered in
// lib/__tests__/eval-route-url.test.ts). The route TYPE is in the stub path
// on purpose: without it a promote that asked for the wrong kind of eval
// route would produce the same URL and pass unnoticed.
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: (...args: unknown[]) => mockNavigateApp(...args),
  buildEvalsPath: (route: Record<string, unknown>) =>
    `/evals/${route.type}/${route.suiteId}/${route.testId}`,
  buildEvaluatePath: (route: Record<string, unknown>) =>
    `/evaluate/${route.type}/${route.suiteId}/${route.testId}`,
}));

// Radix Select needs a pointer dance jsdom can't do faithfully; the items
// become plain buttons so the test can pick a destination suite directly.
vi.mock("@mcpjam/design-system/select", async () => {
  const React = await import("react");
  const SelectContext = React.createContext<(value: string) => void>(() => {});
  return {
    Select: ({
      onValueChange,
      children,
    }: {
      onValueChange: (value: string) => void;
      children: React.ReactNode;
    }) => (
      <SelectContext.Provider value={onValueChange}>
        <div>{children}</div>
      </SelectContext.Provider>
    ),
    SelectTrigger: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children: React.ReactNode;
    }) => {
      const onValueChange = React.useContext(SelectContext);
      return (
        <button type="button" onClick={() => onValueChange(value)}>
          {children}
        </button>
      );
    },
  };
});

import { SaveAsTestCaseAction } from "../save-as-test-case-action";

async function promoteToExistingSuite({
  toolCalls = false,
  location,
}: { toolCalls?: boolean; location?: "playground" | "chat" } = {}) {
  const user = userEvent.setup();
  render(
    <SaveAsTestCaseAction
      chatSessionId="chat-session-1"
      promptIndex={2}
      promptPreview="draw a dog"
      projectId="proj-1"
      location={location}
    />,
  );

  await user.click(
    screen.getByRole("button", { name: "Save this prompt as a test case" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Excalidraw suite" }),
  );
  if (toolCalls) await user.click(screen.getByRole("switch"));
  await user.click(screen.getByRole("button", { name: "Save as test case" }));
}

describe("SaveAsTestCaseAction", () => {
  it("counts saves from the Chat tab under its own location", async () => {
    await promoteToExistingSuite({ location: "chat" });
    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith(
        "playground_test_case_saved",
        expect.objectContaining({ location: "chat" }),
      ),
    );
  });

  it("asks the backend to keep tool calls only when the switch is on", async () => {
    await promoteToExistingSuite({ toolCalls: true });
    await waitFor(() =>
      expect(saveAction).toHaveBeenCalledWith(
        expect.objectContaining({ assertToolCalls: true }),
      ),
    );
  });

  beforeEach(() => {
    projectHosts.value = [{ hostId: "host-first" }];
  });

  it("keeps a cleared client selection empty and disables saving", async () => {
    const user = userEvent.setup();
    render(
      <SaveAsTestCaseAction
        chatSessionId="chat-session-1"
        promptIndex={2}
        promptPreview="draw a dog"
        projectId="proj-1"
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Save this prompt as a test case" }),
    );
    await user.click(screen.getByRole("radio", { name: "New suite" }));
    expect(screen.getByTestId("client-multi-select")).toHaveAttribute(
      "data-host",
      "host-first",
    );
    await user.click(screen.getByRole("button", { name: "Clear clients" }));
    expect(screen.getByTestId("client-multi-select")).toHaveAttribute(
      "data-host",
      "",
    );
    expect(
      screen.getByRole("button", { name: "Save as test case" }),
    ).toBeDisabled();
  });

  it("names a new suite after the prompt's server", async () => {
    const user = userEvent.setup();
    render(
      <SaveAsTestCaseAction
        chatSessionId="chat-session-1"
        promptIndex={2}
        promptPreview="draw a dog"
        projectId="proj-1"
        serverNames={["Linear"]}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Save this prompt as a test case" }),
    );
    await user.click(screen.getByRole("radio", { name: "New suite" }));
    expect(screen.getByDisplayValue("Linear")).toBeInTheDocument();
  });

  it("names a Chat tab suite with no server after the tab", async () => {
    const user = userEvent.setup();
    render(
      <SaveAsTestCaseAction
        chatSessionId="chat-session-1"
        promptIndex={2}
        promptPreview="draw a dog"
        projectId="proj-1"
        location="chat"
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Save this prompt as a test case" }),
    );
    await user.click(screen.getByRole("radio", { name: "New suite" }));
    expect(screen.getByDisplayValue("Chat suite")).toBeInTheDocument();
  });

  it("creates and attaches a client when the project has none", async () => {
    projectHosts.value = [];
    const user = userEvent.setup();
    render(
      <SaveAsTestCaseAction
        chatSessionId="chat-session-1"
        promptIndex={2}
        promptPreview="draw a dog"
        projectId="proj-1"
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Save this prompt as a test case" }),
    );
    await user.click(screen.getByRole("radio", { name: "New suite" }));
    await user.click(screen.getByRole("button", { name: "Create a client" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Finish creating client",
        hidden: true,
      }),
    );
    expect(screen.getByTestId("client-multi-select")).toHaveAttribute(
      "data-host",
      "host-new",
    );
  });

  it("navigates to the case it just created", async () => {
    saveAction.mockResolvedValue({
      suiteId: "suite-1",
      testCaseId: "case-1",
      createdSuite: false,
      updatedSuiteEnvironment: false,
      addedServers: [],
    });

    await promoteToExistingSuite();

    await waitFor(() =>
      expect(saveAction).toHaveBeenCalledWith(
        expect.objectContaining({
          chatSessionId: "chat-session-1",
          promptIndex: 2,
          destinationSuiteId: "suite-1",
        }),
      ),
    );
    expect(saveAction.mock.calls[0][0]).not.toHaveProperty("assertToolCalls");
    expect(mockTrack).toHaveBeenCalledWith("playground_test_case_saved", {
      location: "playground",
      source: "message_menu",
      new_suite: false,
      assert_tool_calls: false,
    });
    await waitFor(() =>
      expect(mockNavigateApp).toHaveBeenCalledWith("/evaluate/test-edit/suite-1/case-1"),
    );
    // The toast was the old dead end; navigation replaces it.
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it("falls back to the toast when the created case can't be resolved", async () => {
    saveAction.mockResolvedValue({ addedServers: [] });

    await promoteToExistingSuite();

    await waitFor(() =>
      expect(mockToast.success).toHaveBeenCalledWith("Saved as test case"),
    );
    expect(mockNavigateApp).not.toHaveBeenCalled();
  });

  it("keeps the added-servers toast, which the destination doesn't show", async () => {
    saveAction.mockResolvedValue({
      suiteId: "suite-1",
      testCaseId: "case-1",
      updatedSuiteEnvironment: true,
      addedServers: ["Excalidraw"],
    });

    await promoteToExistingSuite();

    await waitFor(() =>
      expect(mockToast.success).toHaveBeenCalledWith(
        "Saved as test case. Added Excalidraw to the suite.",
      ),
    );
    expect(mockNavigateApp).toHaveBeenCalledWith("/evaluate/test-edit/suite-1/case-1");
  });
});
