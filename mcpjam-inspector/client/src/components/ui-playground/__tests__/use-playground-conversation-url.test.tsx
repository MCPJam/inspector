/**
 * Playground conversation ↔ URL round-trip.
 *
 * The behaviours pinned here are the ones a refresh or an OAuth return depends
 * on: the id reaches the URL while the transcript is alive, the restore fires
 * once on load, it survives the chat hook re-minting its session id, and a
 * conversation that is gone leaves no stale param behind.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";

import {
  usePlaygroundConversationUrl,
  type ConversationRestoreOutcome,
} from "../use-playground-conversation-url";

type Props = Parameters<typeof usePlaygroundConversationUrl>[0];

const baseProps = (overrides: Partial<Props> = {}): Props => ({
  enabled: true,
  chatSessionId: "fresh-session",
  hasMessages: false,
  isSessionBootstrapComplete: true,
  isStreaming: false,
  projectId: "proj-1",
  isMultiModelLayoutMode: false,
  isEvalHandoffPending: false,
  activeHistorySessionId: null,
  restoreConversation: async () => "restored",
  ...overrides,
});

function renderConversationUrl(props: Props, initialEntry = "/playground") {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
  );
  return renderHook(
    (hookProps: Props) => ({
      url: usePlaygroundConversationUrl(hookProps),
      search: useLocation().search,
      // Stands in for navigation the hook doesn't perform: Back/Forward, or
      // another part of the app changing the route.
      navigate: useNavigate(),
    }),
    { wrapper, initialProps: props },
  );
}

/**
 * Settle effects and the microtasks they queue.
 *
 * Negative assertions ("never fetched") cannot use `waitFor` — it succeeds on
 * the first pass and would pass even if the call arrived a tick later. They
 * need a deterministic flush instead.
 */
const settle = () => act(async () => {});

beforeEach(() => {
  localStorage.clear();
});

describe("usePlaygroundConversationUrl", () => {
  it("writes the session id once the transcript has content", async () => {
    const { result, rerender } = renderConversationUrl(baseProps());
    expect(result.current.search).toBe("");

    rerender(baseProps({ chatSessionId: "chat-1", hasMessages: true }));

    await waitFor(() =>
      expect(result.current.search).toBe("?conversation=chat-1"),
    );
  });

  it("leaves other query params alone", async () => {
    const { result, rerender } = renderConversationUrl(
      baseProps(),
      "/playground?tab=raw",
    );

    rerender(baseProps({ chatSessionId: "chat-1", hasMessages: true }));

    await waitFor(() =>
      expect(result.current.search).toBe("?tab=raw&conversation=chat-1"),
    );
  });

  it("restores the conversation named in the URL", async () => {
    const restoreConversation = vi.fn(
      async (): Promise<ConversationRestoreOutcome> => "restored",
    );
    renderConversationUrl(
      baseProps({ restoreConversation }),
      "/playground?conversation=chat-1",
    );

    await waitFor(() =>
      expect(restoreConversation).toHaveBeenCalledWith("chat-1"),
    );
    expect(restoreConversation).toHaveBeenCalledTimes(1);
  });

  it("waits for auth before fetching", async () => {
    const restoreConversation = vi.fn(
      async (): Promise<ConversationRestoreOutcome> => "restored",
    );
    const { rerender } = renderConversationUrl(
      baseProps({ isSessionBootstrapComplete: false, restoreConversation }),
      "/playground?conversation=chat-1",
    );

    expect(restoreConversation).not.toHaveBeenCalled();

    rerender(
      baseProps({ isSessionBootstrapComplete: true, restoreConversation }),
    );
    await waitFor(() => expect(restoreConversation).toHaveBeenCalledTimes(1));
  });

  it("reports the restore so the caller can show a loading state", async () => {
    let finish: ((outcome: ConversationRestoreOutcome) => void) | undefined;
    const restoreConversation = vi.fn(
      () =>
        new Promise<ConversationRestoreOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderConversationUrl(
      baseProps({ restoreConversation }),
      "/playground?conversation=chat-1",
    );

    await waitFor(() =>
      expect(result.current.url.isRestoringConversation).toBe(true),
    );

    await act(async () => {
      finish?.("restored");
    });
    expect(result.current.url.isRestoringConversation).toBe(false);
  });

  it("does not restore over an existing transcript", async () => {
    const restoreConversation = vi.fn(
      async (): Promise<ConversationRestoreOutcome> => "restored",
    );
    renderConversationUrl(
      baseProps({ hasMessages: true, restoreConversation }),
      "/playground?conversation=chat-1",
    );

    await settle();
    expect(restoreConversation).not.toHaveBeenCalled();
  });

  it("does not race a thread picked from the rail", async () => {
    const restoreConversation = vi.fn(
      async (): Promise<ConversationRestoreOutcome> => "restored",
    );
    renderConversationUrl(
      baseProps({ activeHistorySessionId: "row-1", restoreConversation }),
      "/playground?conversation=chat-1",
    );

    await settle();
    expect(restoreConversation).not.toHaveBeenCalled();
  });

  it("defers to a pending eval handoff", async () => {
    const restoreConversation = vi.fn(
      async (): Promise<ConversationRestoreOutcome> => "restored",
    );
    renderConversationUrl(
      baseProps({ isEvalHandoffPending: true, restoreConversation }),
      "/playground?conversation=chat-1",
    );

    await settle();
    expect(restoreConversation).not.toHaveBeenCalled();
  });

  it("re-arms when the chat hook re-mints its session id", async () => {
    // auth-bootstrap wipes the transcript and mints a new id once auth or the
    // project scope resolves late. The param must survive that and re-fire.
    const restoreConversation = vi.fn(
      async (): Promise<ConversationRestoreOutcome> => "restored",
    );
    const { result, rerender } = renderConversationUrl(
      baseProps({ chatSessionId: "chat-1", hasMessages: true, restoreConversation }),
      "/playground?conversation=chat-1",
    );
    expect(restoreConversation).not.toHaveBeenCalled();

    rerender(
      baseProps({
        chatSessionId: "re-minted",
        hasMessages: false,
        restoreConversation,
      }),
    );

    await waitFor(() =>
      expect(restoreConversation).toHaveBeenCalledWith("chat-1"),
    );
    // ...and the param it needs is still there.
    expect(result.current.search).toBe("?conversation=chat-1");
  });

  it("drops a conversation that is gone, and does not retry it", async () => {
    const restoreConversation = vi.fn(
      async (): Promise<ConversationRestoreOutcome> => "unavailable",
    );
    const { result, rerender } = renderConversationUrl(
      baseProps({ restoreConversation }),
      "/playground?conversation=chat-1",
    );

    await waitFor(() => expect(result.current.search).toBe(""));

    rerender(baseProps({ chatSessionId: "another", restoreConversation }));
    await settle();
    expect(restoreConversation).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale restore erase a newer conversation", async () => {
    // The user navigates (Back/Forward) while the first fetch is still in
    // flight, and that fetch then comes back "gone". It must not take the URL
    // the user is now on down with it.
    let finish: ((outcome: ConversationRestoreOutcome) => void) | undefined;
    const restoreConversation = vi.fn(
      () =>
        new Promise<ConversationRestoreOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderConversationUrl(
      baseProps({ restoreConversation }),
      "/playground?conversation=chat-1",
    );
    await waitFor(() =>
      expect(restoreConversation).toHaveBeenCalledWith("chat-1"),
    );

    const staleFinish = finish;
    act(() => result.current.navigate("/playground?conversation=chat-2"));
    expect(result.current.search).toBe("?conversation=chat-2");

    await act(async () => {
      staleFinish?.("unavailable");
    });

    expect(result.current.search).toBe("?conversation=chat-2");
  });

  it("keeps the param after a transient failure", async () => {
    const restoreConversation = vi.fn(
      async (): Promise<ConversationRestoreOutcome> => "failed",
    );
    const { result } = renderConversationUrl(
      baseProps({ restoreConversation }),
      "/playground?conversation=chat-1",
    );

    await waitFor(() => expect(restoreConversation).toHaveBeenCalledTimes(1));
    expect(result.current.search).toBe("?conversation=chat-1");
  });

  it("falls back to storage when the URL arrives bare", async () => {
    // Electron rebuilds the renderer at the OAuth callback URL, so the param
    // is gone and localStorage is all that is left.
    localStorage.setItem(
      "mcpjam:playground-active-conversation:v1",
      JSON.stringify({
        chatSessionId: "chat-1",
        projectId: "proj-1",
        updatedAt: Date.now(),
      }),
    );
    const restoreConversation = vi.fn(
      async (): Promise<ConversationRestoreOutcome> => "restored",
    );
    const { result } = renderConversationUrl(baseProps({ restoreConversation }));

    await waitFor(() =>
      expect(restoreConversation).toHaveBeenCalledWith("chat-1"),
    );
    // Adopted into the URL so a second refresh takes the param path.
    await waitFor(() =>
      expect(result.current.search).toBe("?conversation=chat-1"),
    );
  });

  it("never adopts a conversation from another project", async () => {
    localStorage.setItem(
      "mcpjam:playground-active-conversation:v1",
      JSON.stringify({
        chatSessionId: "chat-1",
        projectId: "proj-1",
        updatedAt: Date.now(),
      }),
    );
    const restoreConversation = vi.fn(
      async (): Promise<ConversationRestoreOutcome> => "restored",
    );
    renderConversationUrl(baseProps({ projectId: "proj-2", restoreConversation }));

    await settle();
    expect(restoreConversation).not.toHaveBeenCalled();
  });

  it("clears the URL and storage on an explicit reset", async () => {
    const { result, rerender } = renderConversationUrl(baseProps());
    rerender(baseProps({ chatSessionId: "chat-1", hasMessages: true }));
    await waitFor(() =>
      expect(result.current.search).toBe("?conversation=chat-1"),
    );

    // `resetChat` clears the URL and empties the transcript in one commit.
    await act(async () => {
      result.current.url.clearConversation();
      rerender(baseProps({ chatSessionId: "new-session", hasMessages: false }));
    });

    await waitFor(() => expect(result.current.search).toBe(""));
    expect(
      localStorage.getItem("mcpjam:playground-active-conversation:v1"),
    ).toBeNull();
    // And the cleared id must not come back on the next render pass.
    rerender(baseProps({ chatSessionId: "new-session", hasMessages: false }));
    expect(result.current.search).toBe("");
  });

  it("is completely inert when disabled", async () => {
    // The eval preview embeds this surface in a docked panel; it must not
    // touch the page's query string or reopen anything.
    const restoreConversation = vi.fn(
      async (): Promise<ConversationRestoreOutcome> => "restored",
    );
    const { result } = renderConversationUrl(
      baseProps({
        enabled: false,
        hasMessages: true,
        chatSessionId: "chat-1",
        restoreConversation,
      }),
      "/playground?conversation=chat-9",
    );

    await settle();
    expect(restoreConversation).not.toHaveBeenCalled();
    expect(result.current.search).toBe("?conversation=chat-9");
  });

  it("leaves the URL alone in compare mode but still opens an explicit id", async () => {
    // Compare lanes hold their own sessions, so the URL stops tracking the
    // pane — but an id the user arrived with still opens, exactly as it would
    // from the history rail.
    const restoreConversation = vi.fn(
      async (): Promise<ConversationRestoreOutcome> => "restored",
    );
    const { result } = renderConversationUrl(
      baseProps({ isMultiModelLayoutMode: true, restoreConversation }),
      "/playground?conversation=chat-9",
    );

    await waitFor(() =>
      expect(restoreConversation).toHaveBeenCalledWith("chat-9"),
    );
    expect(result.current.search).toBe("?conversation=chat-9");
  });

  it("does not write the pane's session id while compare is live", async () => {
    const { result, rerender } = renderConversationUrl(
      baseProps({ isMultiModelLayoutMode: true }),
    );

    rerender(
      baseProps({
        isMultiModelLayoutMode: true,
        chatSessionId: "chat-1",
        hasMessages: true,
      }),
    );

    await settle();
    expect(result.current.search).toBe("");
  });
});
