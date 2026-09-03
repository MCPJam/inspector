import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: [{ hostId: "host-first" }] }),
}));

vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: () => <div data-testid="server-attachment-picker" />,
}));
vi.mock("@/components/evals/client-attachments-editor", () => ({
  ClientAttachmentsEditor: () => (
    <div data-testid="client-attachments-editor" />
  ),
}));

vi.mock("@/lib/toast", () => ({ toast: mockToast }));

vi.mock("@/lib/app-navigation", () => ({
  navigateApp: (...args: unknown[]) => mockNavigateApp(...args),
  buildEvalsPath: (route: Record<string, unknown>) =>
    `/evals/${route.suiteId}/${route.testId}`,
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

async function promoteToExistingSuite() {
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
  await user.click(
    await screen.findByRole("button", { name: "Excalidraw suite" }),
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
}

describe("SaveAsTestCaseAction", () => {
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
    await waitFor(() =>
      expect(mockNavigateApp).toHaveBeenCalledWith("/evals/suite-1/case-1"),
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
    expect(mockNavigateApp).toHaveBeenCalledWith("/evals/suite-1/case-1");
  });
});
