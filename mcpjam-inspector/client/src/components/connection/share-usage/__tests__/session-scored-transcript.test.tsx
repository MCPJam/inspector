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
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockScores, mockTurnRating } = vi.hoisted(() => ({
  mockScores: { rows: [] as unknown[] },
  mockTurnRating: vi.fn(),
}));

vi.mock("@/hooks/useSharedChatThreads", () => ({
  useSharedChatTurnScores: () => ({ scores: mockScores.rows }),
}));

vi.mock("@mcpjam/chat-ui", () => ({
  // Identity: the fixture messages below are already the renderable set.
  getRenderableConversationMessages: (messages: unknown[]) => messages,
  // Drive the footer callback for every message, which is what the real
  // transcript does per rendered turn.
  ReadOnlyTranscript: ({
    messages,
    renderTurnFooter,
  }: {
    messages: unknown[];
    renderTurnFooter?: (message: unknown, index: number) => unknown;
  }) => (
    <div>
      {messages.map((message, index) => (
        <div key={index}>{renderTurnFooter?.(message, index) as never}</div>
      ))}
    </div>
  ),
  TurnRating: (props: unknown) => {
    mockTurnRating(props);
    return null;
  },
}));

import { SessionScoredTranscript } from "../session-scored-transcript";

const MESSAGES = [
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
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

function renderTranscript() {
  // The remaining `ReadOnlyTranscriptProps` are the real transcript's concern;
  // the mock above ignores them.
  const props = { threadId: "t1", messages: MESSAGES } as React.ComponentProps<
    typeof SessionScoredTranscript
  >;
  render(<SessionScoredTranscript {...props} />);
}

describe("SessionScoredTranscript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScores.rows = [];
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
});
