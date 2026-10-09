import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SwarmSessionPromoteDetail } from "@/lib/swarm-api";

/**
 * The swarm adapter's contract with the shared dialog core: it resolves the
 * detail through `chatSessionPromote:getChatSessionPromoteDetail` with the
 * row's `id` (the chatSessions _id), forwards the ACTION's hostId as
 * `defaultHostId` (authoritative attribution — not the list row's copy), and
 * surfaces action failures (auth, completion gate, transcript parse) as the
 * core's detail error instead of crashing.
 */

const getDetailAction = vi.fn();

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useAction: () => getDetailAction,
}));

// Stub the shared core and surface the props the adapter wires in.
vi.mock("@/components/chat-v2/history/convert-session-dialog-core", () => ({
  ConvertSessionDialogCore: (props: {
    summary: {
      sessionId: string;
      title: string;
      projectId: string | null;
    } | null;
    detail: { loading: boolean; error: string | null; usedServerIds: string[] };
    defaultHostId?: string | null;
    hostDefaultResolved?: boolean;
  }) => (
    <div
      data-testid="core"
      data-session-id={props.summary?.sessionId ?? ""}
      data-title={props.summary?.title ?? ""}
      data-project-id={props.summary?.projectId ?? ""}
      data-loading={String(props.detail.loading)}
      data-error={props.detail.error ?? ""}
      data-used-servers={props.detail.usedServerIds.join(",")}
      data-default-host={props.defaultHostId ?? ""}
      data-host-default-resolved={String(props.hostDefaultResolved ?? true)}
    />
  ),
}));

import { ConvertPromotableSessionDialog } from "../convert-promotable-session-dialog";

const SESSION = {
  id: "chat-session-id-9",
  chatSessionId: "synth_run-1_host-1_0",
  projectId: "proj-1",
  hostId: "host-from-row",
  startedAt: 1,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("ConvertPromotableSessionDialog", () => {
  it("fetches promote detail with the row's id and forwards the action's hostId", async () => {
    getDetailAction.mockResolvedValue({
      sessionId: "chat-session-id-9",
      chatSessionId: "synth_run-1_host-1_0",
      sourceType: "swarm",
      projectId: "proj-1",
      title: null,
      firstMessagePreview: "draw a dog for me please",
      messageCount: 2,
      usedServerIds: ["srv-excalidraw"],
      selectedServers: [],
      hostId: "host-authoritative",
    });

    render(
      <ConvertPromotableSessionDialog
        open
        sessionId={SESSION.id}
        seedProjectId={SESSION.projectId}
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(getDetailAction).toHaveBeenCalledWith({
        sessionId: "chat-session-id-9",
      })
    );

    const core = screen.getByTestId("core");
    await waitFor(() =>
      expect(core.getAttribute("data-loading")).toBe("false")
    );
    expect(core.getAttribute("data-session-id")).toBe("chat-session-id-9");
    expect(core.getAttribute("data-project-id")).toBe("proj-1");
    // Title seeded from the transcript preview when no custom title exists.
    expect(core.getAttribute("data-title")).toBe("draw a dog for me please");
    expect(core.getAttribute("data-used-servers")).toBe("srv-excalidraw");
    // The ACTION's hostId wins over the list row's copy.
    expect(core.getAttribute("data-default-host")).toBe("host-authoritative");
  });

  it("marks the host default unresolved on the initial render", async () => {
    let resolveDetail!: (value: SwarmSessionPromoteDetail) => void;
    getDetailAction.mockImplementationOnce(
      () =>
        new Promise<SwarmSessionPromoteDetail>((resolve) => {
          resolveDetail = resolve;
        })
    );

    render(
      <ConvertPromotableSessionDialog
        open
        sessionId={SESSION.id}
        seedProjectId={SESSION.projectId}
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />
    );

    const core = screen.getByTestId("core");
    expect(core.getAttribute("data-host-default-resolved")).toBe("false");
    expect(core.getAttribute("data-default-host")).toBe("");

    resolveDetail({
      sessionId: "chat-session-id-9",
      chatSessionId: "synth_run-1_host-1_0",
      sourceType: "swarm",
      projectId: "proj-1",
      title: null,
      firstMessagePreview: "draw a dog for me please",
      messageCount: 2,
      usedServerIds: [],
      selectedServers: [],
      hostId: "host-authoritative",
    });

    await waitFor(() =>
      expect(core.getAttribute("data-host-default-resolved")).toBe("true")
    );
    expect(core.getAttribute("data-default-host")).toBe("host-authoritative");
  });

  it("surfaces an action failure as the core's detail error", async () => {
    // A refusal the client has no code for: the payload's own message is
    // author-written, so it is shown. `Error.message` never is — see the
    // envelope cases below.
    getDetailAction.mockRejectedValue(
      Object.assign(new Error("[CONVEX A(...)] Server Error"), {
        data: {
          message:
            "Swarm session's run attempt has not completed; only sessions from succeeded attempts can be promoted.",
        },
      })
    );

    render(
      <ConvertPromotableSessionDialog
        open
        sessionId={SESSION.id}
        seedProjectId={SESSION.projectId}
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />
    );

    const core = screen.getByTestId("core");
    await waitFor(() =>
      expect(core.getAttribute("data-error")).toMatch(/has not completed/)
    );
    expect(core.getAttribute("data-loading")).toBe("false");
  });

  /**
   * The refusal the user actually hits. Convex wraps a rejection in its own
   * envelope, and the adapter used to render `error.message` verbatim — so the
   * dialog showed a request id, an "Uncaught Error" and four stack frames of
   * backend file paths (BB-247). Copy now comes from the payload's CODE.
   */
  it("renders a coded refusal as human copy, never the server envelope", async () => {
    const convexError = Object.assign(
      new Error(
        "[CONVEX A(chatSessionPromote:getChatSessionPromoteDetail)] " +
          "[Request ID: 01840e30525f321f] Server Error Uncaught Error: " +
          "Swarm session's run attempt has not completed; only sessions " +
          "from succeeded attempts can be promoted. at " +
          "assertSwarmAttemptSucceeded (../convex/chatSessionPromote.ts:462:6)"
      ),
      {
        data: {
          code: "SWARM_ATTEMPT_NOT_SUCCEEDED",
          message:
            "Swarm session's run attempt has not completed; only sessions from succeeded attempts can be promoted.",
          attemptStatus: "failed",
        },
      }
    );
    getDetailAction.mockRejectedValue(convexError);

    render(
      <ConvertPromotableSessionDialog
        open
        sessionId={SESSION.id}
        seedProjectId={SESSION.projectId}
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />
    );

    const core = screen.getByTestId("core");
    await waitFor(() =>
      expect(core.getAttribute("data-error")).toMatch(/did not finish/i)
    );
    const shown = core.getAttribute("data-error") ?? "";
    expect(shown).not.toMatch(/Uncaught Error/);
    expect(shown).not.toMatch(/convex\/chatSessionPromote\.ts/);
    expect(shown).not.toMatch(/Request ID/);
  });

  /**
   * An unexpected server fault carries no `ConvexError` payload, so its
   * message IS the envelope — request id, stack frames, backend paths. There
   * is nothing in it a user can act on and plenty they should not see
   * (CWE-209), so the generic fallback stands in.
   */
  it("shows the fallback for a fault with no ConvexError payload", async () => {
    getDetailAction.mockRejectedValue(
      new Error(
        "[CONVEX A(chatSessionPromote:getChatSessionPromoteDetail)] " +
          "[Request ID: 0184] Server Error Uncaught TypeError: x is not a " +
          "function at handler (../convex/chatSessionPromote.ts:534:15)"
      )
    );

    render(
      <ConvertPromotableSessionDialog
        open
        sessionId={SESSION.id}
        seedProjectId={SESSION.projectId}
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />
    );

    const core = screen.getByTestId("core");
    await waitFor(() =>
      expect(core.getAttribute("data-error")).toBe("Failed to load session")
    );
  });
});
