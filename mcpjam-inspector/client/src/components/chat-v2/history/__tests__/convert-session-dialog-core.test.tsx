import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the source-agnostic promote-dialog core. The per-source adapters
 * (direct history / swarm) are covered by their own tests; here we assert the
 * core's contract: it renders the ADAPTER-provided detail states verbatim,
 * submits `importChatSessionToTestCase` with the summary's sessionId +
 * projectId and the picker selections, and pre-seeds the host attachment from
 * `defaultHostId` when it names a live project host.
 */

const importAction = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: () => [],
  useAction: () => importAction,
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({
    servers: [{ name: "Excalidraw" }],
    serversById: new Map([["srv-excalidraw", "Excalidraw"]]),
    isLoading: false,
  }),
  useProjectServerAttachments: () => ({
    serverAttachments: [{ _id: "attachment-1" }],
  }),
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [{ hostId: "host-first" }, { hostId: "host-swarm" }],
  }),
}));

// Surface the picker VALUES the core wires in, without the heavy editors.
vi.mock("@/components/evals/server-attachment-picker", () => ({
  ServerAttachmentPicker: ({ value }: { value: string | null }) => (
    <div data-testid="server-attachment-picker" data-value={value ?? ""} />
  ),
}));
vi.mock("@/components/evals/client-attachments-editor", () => ({
  ClientAttachmentsEditor: ({
    value,
  }: {
    value: Array<{ namedHostId: string }>;
  }) => (
    <div
      data-testid="client-attachments-editor"
      data-hosts={value.map((v) => v.namedHostId).join(",")}
    />
  ),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import {
  ConvertSessionDialogCore,
  type PromoteSessionDetailState,
} from "../convert-session-dialog-core";

const SUMMARY = {
  sessionId: "chat-session-id-1",
  title: "draw a dog",
  projectId: "proj-1",
};

const READY_DETAIL: PromoteSessionDetailState = {
  loading: false,
  error: null,
  usedServerIds: ["srv-excalidraw"],
  selectedServers: [],
};

function renderCore(
  overrides: Partial<{
    detail: PromoteSessionDetailState;
    defaultHostId: string | null;
  }> = {},
) {
  return render(
    <ConvertSessionDialogCore
      open
      summary={SUMMARY}
      detail={overrides.detail ?? READY_DETAIL}
      isAuthenticated
      defaultHostId={overrides.defaultHostId}
      onOpenChange={vi.fn()}
      onImported={vi.fn()}
    />,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ConvertSessionDialogCore", () => {
  it("renders the adapter's loading state", () => {
    renderCore({
      detail: { loading: true, error: null, usedServerIds: [], selectedServers: [] },
    });
    expect(screen.getByText(/Loading chat session details/)).toBeTruthy();
  });

  it("renders the adapter's error state and blocks submission", () => {
    renderCore({
      detail: {
        loading: false,
        error: "Swarm session's run attempt has not completed",
        usedServerIds: [],
        selectedServers: [],
      },
    });
    expect(screen.getByText(/has not completed/)).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Promote to test case" });
    expect(submit.hasAttribute("disabled")).toBe(true);
  });

  it("renders server chips resolved from the adapter-provided usedServerIds", () => {
    renderCore();
    expect(screen.getByText("Excalidraw")).toBeTruthy();
  });

  it("submits sessionId + projectId + picker selections on the new-suite branch", async () => {
    importAction.mockResolvedValue({
      suiteId: "suite-1",
      testCaseId: "case-1",
    });
    renderCore();

    const submit = screen.getByRole("button", { name: "Promote to test case" });
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(importAction).toHaveBeenCalledTimes(1));
    expect(importAction).toHaveBeenCalledWith({
      sessionId: "chat-session-id-1",
      projectId: "proj-1",
      testCaseTitle: "draw a dog",
      newSuiteName: expect.stringContaining("Excalidraw"),
      newSuiteServerAttachmentId: "attachment-1",
      newSuiteHostAttachments: [
        { namedHostId: "host-first", enabledOptionalServerIds: [] },
      ],
    });
  });

  it("pre-seeds the client attachment from defaultHostId when it names a project host", () => {
    renderCore({ defaultHostId: "host-swarm" });
    expect(
      screen
        .getByTestId("client-attachments-editor")
        .getAttribute("data-hosts"),
    ).toBe("host-swarm");
  });

  it("falls back to the first project host when defaultHostId is unknown", () => {
    renderCore({ defaultHostId: "host-deleted" });
    expect(
      screen
        .getByTestId("client-attachments-editor")
        .getAttribute("data-hosts"),
    ).toBe("host-first");
  });
});
