import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    summary: { sessionId: string; title: string; projectId: string | null } | null;
    detail: { loading: boolean; error: string | null; usedServerIds: string[] };
    defaultHostId?: string | null;
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
    />
  ),
}));

import { ConvertSwarmSessionDialog } from "../convert-swarm-session-dialog";

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

describe("ConvertSwarmSessionDialog", () => {
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
      <ConvertSwarmSessionDialog
        open
        session={SESSION}
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(getDetailAction).toHaveBeenCalledWith({
        sessionId: "chat-session-id-9",
      }),
    );

    const core = screen.getByTestId("core");
    await waitFor(() => expect(core.getAttribute("data-loading")).toBe("false"));
    expect(core.getAttribute("data-session-id")).toBe("chat-session-id-9");
    expect(core.getAttribute("data-project-id")).toBe("proj-1");
    // Title seeded from the transcript preview when no custom title exists.
    expect(core.getAttribute("data-title")).toBe("draw a dog for me please");
    expect(core.getAttribute("data-used-servers")).toBe("srv-excalidraw");
    // The ACTION's hostId wins over the list row's copy.
    expect(core.getAttribute("data-default-host")).toBe("host-authoritative");
  });

  it("surfaces an action failure as the core's detail error", async () => {
    getDetailAction.mockRejectedValue(
      new Error(
        "Swarm session's run attempt has not completed; only sessions from succeeded attempts can be promoted.",
      ),
    );

    render(
      <ConvertSwarmSessionDialog
        open
        session={SESSION}
        onOpenChange={vi.fn()}
        onImported={vi.fn()}
      />,
    );

    const core = screen.getByTestId("core");
    await waitFor(() =>
      expect(core.getAttribute("data-error")).toMatch(/has not completed/),
    );
    expect(core.getAttribute("data-loading")).toBe("false");
  });
});
