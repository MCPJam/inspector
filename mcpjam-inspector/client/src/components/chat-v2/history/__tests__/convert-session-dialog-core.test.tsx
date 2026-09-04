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
const mocks = vi.hoisted(() => ({
  isUserReady: true,
  useQuery: vi.fn(() => []),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useAction: () => importAction,
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mocks.isUserReady,
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
vi.mock("@/components/hosts/server-picker", () => ({
  ServerPicker: ({ value }: { value: string | null }) => (
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

import userEvent from "@testing-library/user-event";
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
    hostDefaultResolved: boolean;
  }> = {}
) {
  return render(
    <ConvertSessionDialogCore
      open
      summary={SUMMARY}
      detail={overrides.detail ?? READY_DETAIL}
      isAuthenticated
      defaultHostId={overrides.defaultHostId}
      hostDefaultResolved={overrides.hostDefaultResolved}
      onOpenChange={vi.fn()}
      onImported={vi.fn()}
    />
  );
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.isUserReady = true;
  mocks.useQuery.mockReturnValue([]);
});

describe("ConvertSessionDialogCore", () => {
  it("renders the adapter's loading state", () => {
    renderCore({
      detail: {
        loading: true,
        error: null,
        usedServerIds: [],
        selectedServers: [],
      },
    });
    expect(screen.getByText(/Loading session details/)).toBeTruthy();
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
      screen.getByTestId("client-attachments-editor").getAttribute("data-hosts")
    ).toBe("host-swarm");
  });

  it("falls back to the first project host when defaultHostId is unknown", () => {
    renderCore({ defaultHostId: "host-deleted" });
    expect(
      screen.getByTestId("client-attachments-editor").getAttribute("data-hosts")
    ).toBe("host-first");
  });

  it("does not seed hosts while detail is loading, so a late defaultHostId still wins", () => {
    // Project hosts are typically cached before the promote detail resolves;
    // seeding during load would grab projectHosts[0] and the non-empty
    // attachment would then block the authoritative reseed.
    const loading: PromoteSessionDetailState = {
      loading: true,
      error: null,
      usedServerIds: [],
      selectedServers: [],
    };
    const { rerender } = render(
      <ConvertSessionDialogCore
        open
        summary={SUMMARY}
        detail={loading}
        isAuthenticated
        defaultHostId={null}
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />
    );
    expect(
      screen.getByTestId("client-attachments-editor").getAttribute("data-hosts")
    ).toBe("");

    rerender(
      <ConvertSessionDialogCore
        open
        summary={SUMMARY}
        detail={READY_DETAIL}
        isAuthenticated
        defaultHostId="host-swarm"
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />
    );
    expect(
      screen.getByTestId("client-attachments-editor").getAttribute("data-hosts")
    ).toBe("host-swarm");
  });

  it("does not seed a cached project host before the adapter resolves its host default", () => {
    const { rerender } = render(
      <ConvertSessionDialogCore
        open
        summary={SUMMARY}
        detail={READY_DETAIL}
        isAuthenticated
        defaultHostId={null}
        hostDefaultResolved={false}
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />
    );
    expect(
      screen.getByTestId("client-attachments-editor").getAttribute("data-hosts")
    ).toBe("");

    rerender(
      <ConvertSessionDialogCore
        open
        summary={SUMMARY}
        detail={READY_DETAIL}
        isAuthenticated
        defaultHostId="host-swarm"
        hostDefaultResolved
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />
    );
    expect(
      screen.getByTestId("client-attachments-editor").getAttribute("data-hosts")
    ).toBe("host-swarm");
  });

  it("skips the suite subscription while the database user is not ready", () => {
    mocks.isUserReady = false;

    renderCore();

    expect(mocks.useQuery).toHaveBeenCalledWith(
      "testSuites:getTestSuitesOverview",
      "skip"
    );
  });
});

/**
 * D8f2 — the content-transfer acknowledgement.
 *
 * Three things worth pinning: it is asked ONLY when the server says so, it is
 * REQUIRED rather than advisory, and an unticked box sends nothing. That last
 * one matters most: a client that sent `true` regardless would stamp an audit
 * record saying a person decided something they were never shown.
 */
describe("ConvertSessionDialogCore — content-transfer acknowledgement", () => {
  const ACK_DETAIL: PromoteSessionDetailState = {
    ...READY_DETAIL,
    requiresContentTransferAcknowledgement: true,
  };

  const ackCheckbox = () =>
    screen.getByRole("checkbox", {
      name: /copies a tester's content into a durable test case/i,
    });

  it("does not ask when the server did not say to", () => {
    renderCore();
    expect(
      screen.queryByText(/Someone else wrote this transcript/i)
    ).toBeNull();
  });

  it("asks when the server says this is someone else's transcript", () => {
    renderCore({ detail: ACK_DETAIL });
    expect(
      screen.getByText(/Someone else wrote this transcript/i)
    ).toBeTruthy();
    expect(
      screen.getByText(/copies a tester's own words into a test case/i)
    ).toBeTruthy();
  });

  it("is never pre-ticked", () => {
    renderCore({ detail: ACK_DETAIL });
    expect(ackCheckbox().getAttribute("data-state")).toBe("unchecked");
  });

  it("BLOCKS submit until it is ticked, rather than warning", () => {
    renderCore({ detail: ACK_DETAIL });
    const submit = screen.getByRole("button", {
      name: "Promote to test case",
    });
    expect(submit.hasAttribute("disabled")).toBe(true);

    fireEvent.click(ackCheckbox());
    expect(submit.hasAttribute("disabled")).toBe(false);
  });

  it("is a real focusable control, not a div with a click handler", () => {
    renderCore({ detail: ACK_DETAIL });
    const checkbox = ackCheckbox();
    // A native <button role="checkbox"> is what makes Space activate it and
    // Tab reach it. The accessible name comes from a <label htmlFor> bound to
    // this id, and the consequence is what a screen reader reads with it.
    expect(checkbox.tagName).toBe("BUTTON");
    expect(checkbox.getAttribute("id")).toBe("content-transfer-ack");
    expect(checkbox.getAttribute("aria-describedby")).toBe(
      "content-transfer-consequence"
    );
    expect(checkbox.hasAttribute("disabled")).toBe(false);
  });

  it("is reachable and tickable by keyboard ALONE", async () => {
    // `userEvent` models real keyboard semantics — Space on a focused button
    // activates it — where a bare `fireEvent.keyDown` does not, because jsdom
    // never synthesizes the click a browser would. No pointer event is fired
    // anywhere in this test.
    const user = userEvent.setup();
    renderCore({ detail: ACK_DETAIL });
    const checkbox = ackCheckbox();
    const submit = screen.getByRole("button", {
      name: "Promote to test case",
    });
    expect(submit.hasAttribute("disabled")).toBe(true);

    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);

    await user.keyboard("[Space]");
    expect(checkbox.getAttribute("data-state")).toBe("checked");
    expect(submit.hasAttribute("disabled")).toBe(false);

    // ...and back off again, so the box is genuinely operable rather than a
    // one-way latch that happens to have been set.
    await user.keyboard("[Space]");
    expect(checkbox.getAttribute("data-state")).toBe("unchecked");
    expect(submit.hasAttribute("disabled")).toBe(true);
  });

  it("the sentence is the hit target, not just the box", () => {
    renderCore({ detail: ACK_DETAIL });
    const checkbox = ackCheckbox();
    // Clicking the LABEL toggles the control, which is what a `<label
    // htmlFor>` bound to the checkbox's own id buys — a bigger target and an
    // accessible name a screen reader reads out with the control.
    fireEvent.click(
      screen.getByText(/copies a tester's content into a durable test case/i)
    );
    expect(checkbox.getAttribute("data-state")).toBe("checked");
  });

  it("sends the acknowledgement once it is ticked", async () => {
    importAction.mockResolvedValue({ suiteId: "s", testCaseId: "c" });
    renderCore({ detail: ACK_DETAIL });
    fireEvent.click(ackCheckbox());
    fireEvent.click(
      screen.getByRole("button", { name: "Promote to test case" })
    );
    await waitFor(() => expect(importAction).toHaveBeenCalled());
    expect(importAction.mock.calls[0][0]).toMatchObject({
      contentTransferAcknowledged: true,
    });
  });

  it("sends NOTHING when it was never asked for", async () => {
    importAction.mockResolvedValue({ suiteId: "s", testCaseId: "c" });
    renderCore();
    fireEvent.click(
      screen.getByRole("button", { name: "Promote to test case" })
    );
    await waitFor(() => expect(importAction).toHaveBeenCalled());
    expect(importAction.mock.calls[0][0]).not.toHaveProperty(
      "contentTransferAcknowledged"
    );
  });
});
