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
vi.mock("@/components/evals/server-attachment-picker", () => ({
  ServerAttachmentPicker: ({ value }: { value: string | null }) => (
    <div data-testid="server-attachment-picker" data-value={value ?? ""} />
  ),
}));
// BB-163: the new-suite branch attaches ONE client through a single field,
// so what's worth surfacing is the host id the core wires in.
vi.mock("@/components/hosts/HostPicker", () => ({
  HostPicker: ({ value }: { value: string | null }) => (
    <div data-testid="client-picker" data-host={value ?? ""} />
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

  /**
   * BB-163 removed the always-on "Session servers" chip row. The session's
   * servers still drive the generated suite name, which is where a reader
   * now sees them — and it is the only place, because showing them twice was
   * BB-93's "why do I see server selection twice?".
   */
  it("seeds the suite name from the adapter-provided usedServerIds, without a chip row", () => {
    renderCore();
    expect(
      (screen.getByLabelText("Suite name") as HTMLInputElement).value
    ).toContain("Excalidraw");
    expect(screen.queryByText("Session servers")).toBeNull();
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
      screen.getByTestId("client-picker").getAttribute("data-host")
    ).toBe("host-swarm");
  });

  it("falls back to the first project host when defaultHostId is unknown", () => {
    renderCore({ defaultHostId: "host-deleted" });
    expect(
      screen.getByTestId("client-picker").getAttribute("data-host")
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
    // BB-163: while the detail is in flight the destination area is a
    // spinner, so there is no client field to have seeded yet.
    expect(screen.queryByTestId("client-picker")).toBeNull();
    expect(screen.getByText(/Loading session details/)).toBeTruthy();

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
      screen.getByTestId("client-picker").getAttribute("data-host")
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
      screen.getByTestId("client-picker").getAttribute("data-host")
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
      screen.getByTestId("client-picker").getAttribute("data-host")
    ).toBe("host-swarm");
  });

  it("shows only the new-suite fields when the project has no suites", () => {
    // Spec: no radio nobody can answer, and explicitly no nested
    // create-suite modal.
    renderCore();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByLabelText("Suite name")).toBeTruthy();
    expect(screen.getByTestId("client-picker")).toBeTruthy();
    expect(screen.getByTestId("server-attachment-picker")).toBeTruthy();
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
 * BB-163 — the two "Add to" states.
 *
 * The load-bearing claim of the redesign is that client and server belong to
 * the SUITE, not the case: the existing-suite branch reports the destination's
 * pair read-only and never asks for it, and only a brand-new suite gets
 * pickers. These pin both halves, plus the default the spec calls for.
 */
describe("ConvertSessionDialogCore — Add to", () => {
  const SUITE_ENTRIES = [
    {
      suite: {
        _id: "suite-billing",
        name: "Billing evals",
        environment: { servers: ["Excalidraw"] },
        hostAttachments: [{ hostName: "Claude" }],
      },
    },
    {
      suite: {
        _id: "suite-other",
        name: "Checkout evals",
        environment: { servers: ["Excalidraw"] },
        hostAttachments: [{ hostName: "Cursor" }],
      },
    },
  ];

  function renderWithSuites() {
    mocks.useQuery.mockReturnValue(SUITE_ENTRIES);
    return renderCore();
  }

  it("defaults to Existing suite and pre-selects the first one", () => {
    renderWithSuites();
    expect(
      screen
        .getByTestId("promote-destination-existing")
        .getAttribute("data-selected")
    ).toBe("true");
    expect(screen.getByText("Billing evals")).toBeTruthy();
  });

  it("reports the selected suite's client and server read-only", () => {
    renderWithSuites();
    expect(
      screen.getByTestId("promote-existing-suite-summary").textContent
    ).toBe("Claude · Excalidraw");
  });

  it("does NOT ask for client or server on the existing-suite branch", () => {
    renderWithSuites();
    expect(screen.queryByTestId("client-picker")).toBeNull();
    expect(screen.queryByTestId("server-attachment-picker")).toBeNull();
    expect(screen.queryByLabelText("Suite name")).toBeNull();
  });

  it("reveals suite name, client and server once New suite is picked", () => {
    renderWithSuites();
    fireEvent.click(screen.getByRole("radio", { name: "New suite" }));

    expect(screen.getByLabelText("Suite name")).toBeTruthy();
    expect(screen.getByTestId("client-picker")).toBeTruthy();
    expect(screen.getByTestId("server-attachment-picker")).toBeTruthy();
    // ...and the existing branch's picker folds away with it.
    expect(screen.queryByTestId("promote-existing-suite-summary")).toBeNull();
  });

  it("submits into the pre-selected suite without re-asking for a destination", async () => {
    importAction.mockResolvedValue({ suiteId: "suite-billing", testCaseId: "c" });
    renderWithSuites();

    const submit = screen.getByRole("button", { name: "Promote to test case" });
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submit);

    await waitFor(() => expect(importAction).toHaveBeenCalledTimes(1));
    expect(importAction.mock.calls[0][0]).toMatchObject({
      destinationSuiteId: "suite-billing",
      testCaseTitle: "draw a dog",
    });
    // Suite-owned inputs are never sent from this branch.
    expect(importAction.mock.calls[0][0]).not.toHaveProperty("newSuiteName");
    expect(importAction.mock.calls[0][0]).not.toHaveProperty(
      "newSuiteHostAttachments"
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
