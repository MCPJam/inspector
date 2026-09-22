/**
 * The read-only transcript's score join.
 *
 * What these pin:
 *   - BOTH per-turn keys render. Dropping `user_thumb` (the pre-thumbs filter)
 *     would silently show a thumbs-rated session as unrated.
 *   - The widget MATCHES the row. A stored `0` rendered as stars reads as
 *     "unrated"; a `4` rendered as thumbs cannot be shown at all.
 *   - A turn carrying rows under BOTH keys shows the latest revision — what
 *     the tester currently means.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockScores, mockTurnRating } = vi.hoisted(() => ({
  mockScores: { rows: [] as unknown[] },
  mockTurnRating: vi.fn(),
}));

vi.mock("@/hooks/useSharedChatThreads", () => ({
  useSharedChatTurnScores: () => ({ scores: mockScores.rows }),
}));

vi.mock("@mcpjam/chat-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcpjam/chat-ui")>()),
  TurnRating: (props: unknown) => {
    mockTurnRating(props);
    return <span>rating</span>;
  },
}));

vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: ({ adaptedTrace, renderAssistantTurnFooter }: any) => (
    <div>{adaptedTrace.messages.map((message: any) => (
      <div key={message.id} data-testid={message.id}>
        {message.role === "assistant" && renderAssistantTurnFooter?.(message)}
      </div>
    ))}</div>
  ),
}));

import { SessionScoredTranscript } from "../session-scored-transcript";

const MESSAGES = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
] as never;

function score(overrides: Record<string, unknown>) {
  return {
    key: "user_rating",
    promptIndex: 0,
    dataType: "numeric",
    source: "end_user",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function renderTranscript(messages = MESSAGES) {
  // The remaining `ReadOnlyTranscriptProps` are the real transcript's concern;
  // the mock above ignores them.
  const props = { threadId: "t1", adaptedTrace: { messages, toolRenderOverrides: {} } } as React.ComponentProps<
    typeof SessionScoredTranscript
  >;
  render(<SessionScoredTranscript {...props} />);
}

describe("SessionScoredTranscript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScores.rows = [];
  });

  it("anchors ratings to adapted IDs across hidden rows and multiple assistant messages", () => {
    mockScores.rows = [score({ value: 4 }), score({ value: 0, key: "user_thumb", promptIndex: 1 })];
    renderTranscript([
      { id: "u1", role: "user", parts: [] },
      { id: "model-context-1", role: "user", parts: [] },
      { id: "a1", role: "assistant", parts: [] },
      { id: "a1-more", role: "assistant", parts: [] },
      { id: "widget-state-1", role: "user", parts: [] },
      { id: "u2", role: "user", parts: [] },
      { id: "a2", role: "assistant", parts: [] },
    ] as never);
    expect(screen.getByTestId("a1")).toHaveTextContent("rating");
    expect(screen.getByTestId("a1-more")).toBeEmptyDOMElement();
    expect(screen.getByTestId("a2")).toHaveTextContent("rating");
    expect(mockTurnRating).toHaveBeenCalledTimes(2);
  });

  it("renders a star row as stars", () => {
    mockScores.rows = [score({ value: 4, comment: "good" })];
    renderTranscript();
    expect(mockTurnRating).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "stars",
        value: 4,
        comment: "good",
        readOnly: true,
      })
    );
  });

  it("renders a thumb row as thumbs", () => {
    mockScores.rows = [
      score({ key: "user_thumb", dataType: "boolean", value: 1 }),
    ];
    renderTranscript();
    expect(mockTurnRating).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "thumbs", value: 1 })
    );
  });

  it("shows a thumbs-down rather than treating 0 as unrated", () => {
    mockScores.rows = [
      score({
        key: "user_thumb",
        dataType: "boolean",
        value: 0,
        comment: "wrong order",
      }),
    ];
    renderTranscript();
    expect(mockTurnRating).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "thumbs",
        value: 0,
        comment: "wrong order",
      })
    );
  });

  it("prefers the latest revision when a turn carries both keys", () => {
    // The shape a mid-session style switch plus a re-rate produces.
    mockScores.rows = [
      score({ value: 4, updatedAt: 10 }),
      score({
        key: "user_thumb",
        dataType: "boolean",
        value: 0,
        updatedAt: 20,
      }),
    ];
    renderTranscript();
    expect(mockTurnRating).toHaveBeenCalledTimes(1);
    expect(mockTurnRating).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "thumbs", value: 0 })
    );
  });

  it("ignores rows under keys that are not per-turn ratings", () => {
    mockScores.rows = [score({ key: "eval_grade", value: 1 })];
    renderTranscript();
    expect(mockTurnRating).not.toHaveBeenCalled();
  });

  it("renders nothing when the session has no score rows", () => {
    mockScores.rows = [];
    renderTranscript();
    expect(mockTurnRating).not.toHaveBeenCalled();
  });

  it("renders nothing while the scores query is still loading", () => {
    // `useQuery` returns undefined before the first round-trip, and the
    // transcript is the point of the page — it must render regardless.
    mockScores.rows = undefined as never;
    renderTranscript();
    expect(mockTurnRating).not.toHaveBeenCalled();
  });

  it("skips a row with no promptIndex — there is no turn to anchor it to", () => {
    mockScores.rows = [score({ value: 4, promptIndex: undefined })];
    renderTranscript();
    expect(mockTurnRating).not.toHaveBeenCalled();
  });
});
