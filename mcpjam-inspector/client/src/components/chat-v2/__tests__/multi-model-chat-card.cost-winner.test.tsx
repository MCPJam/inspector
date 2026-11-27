import { useState } from "react";
import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveChatTraceEnvelope } from "@/shared/live-chat-trace";
import {
  MultiModelChatCard,
  type BroadcastChatTurnRequest,
} from "../multi-model-chat-card";
import type { MultiModelCardSummary } from "../model-compare-card-header";

// Two real cards under the real compare header, each on its own stubbed
// session, so the winner label is decided the way the Chat tab decides it.

vi.mock("@/hooks/useTraceCostEnabled", () => ({
  useTraceCostEnabled: () => true,
}));

vi.mock("use-stick-to-bottom", () => {
  const StickToBottom = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );
  StickToBottom.Content = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    StickToBottom,
    useStickToBottomContext: () => ({
      isAtBottom: true,
      scrollToBottom: vi.fn(),
    }),
  };
});

// Each card's thread hands its follow-up sender to the test, as a widget's
// `ui/message` reaches it.
const followUps = vi.hoisted(
  () => ({}) as Record<string, (text: string) => void>,
);
vi.mock("@/components/chat-v2/thread", () => ({
  Thread: (props: {
    model: { id: string };
    sendFollowUpMessage: (text: string) => void;
  }) => {
    followUps[props.model.id] = props.sendFollowUpMessage;
    return null;
  },
}));
vi.mock("@/components/evals/trace-viewer", () => ({ TraceViewer: () => null }));
vi.mock("@/components/chat-v2/error", () => ({ ErrorBox: () => null }));
vi.mock("@/components/chat-v2/shared/chat-helpers", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/chat-v2/shared/chat-helpers")
  >()),
  formatErrorMessage: () => null,
}));

const refreshHarness = vi.hoisted(() => ({ current: () => {} }));

/**
 * The parts of `useChatSession` a card reads, with Stop behaving as the AI
 * SDK's does: the stream ends as `ready`, and only the session's abort flag
 * says it was stopped.
 */
function stubSession(trace: LiveChatTraceEnvelope, isStreaming: boolean) {
  const session = {
    pendingElicitations: [],
    respondToElicitation: vi.fn(),
    elicitationResponding: false,
    urlElicitationRequired: [],
    dismissUrlElicitationRequired: vi.fn(),
    messages: [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Plan a trip" }],
      },
    ],
    setMessages: vi.fn(),
    // A send starts streaming, unless a test holds it as a hosted send that
    // is still resolving server ids.
    holdSends: false,
    sendMessage: vi.fn(() => {
      if (session.holdSends) return;
      Object.assign(session, { isStreaming: true, status: "streaming" });
      refreshHarness.current();
    }),
    status: isStreaming ? "streaming" : "ready",
    error: undefined,
    chatSessionId: "chat-session",
    toolsMetadata: {},
    toolServerMap: {},
    liveTraceEnvelope: trace,
    requestPayloadHistory: [],
    hasTraceSnapshot: true,
    hasLiveTimelineContent: true,
    traceViewsSupported: true,
    isStreaming,
    addToolApprovalResponse: vi.fn(),
    systemPrompt: "",
    startChatWithMessages: vi.fn(),
    aborted: false,
    stop: () => {
      if (!session.isStreaming) return;
      Object.assign(session, {
        isStreaming: false,
        status: "ready",
        aborted: true,
      });
      refreshHarness.current();
    },
    consumeTurnAborted: () => {
      const aborted = session.aborted;
      session.aborted = false;
      return aborted;
    },
  };
  return session;
}

const sessions: Record<string, ReturnType<typeof stubSession>> = {};

vi.mock("@/hooks/use-chat-session", () => ({
  useChatSession: (options: { executionConfig: { modelId: string } }) =>
    sessions[options.executionConfig.modelId],
}));

const models = [
  { id: "openai/gpt-5-mini", name: "GPT-5 Mini", provider: "openai" as const },
  { id: "openai/gpt-5", name: "GPT-5", provider: "openai" as const },
];
const [cheap, dear] = models.map((model) => model.id);

/** A thread whose turns each made one provider-reported call. */
function pricedTrace(amounts: number[]): LiveChatTraceEnvelope {
  return {
    traceVersion: 1,
    messages: [],
    spans: amounts.map((amountUsd, promptIndex) => ({
      id: `p${promptIndex}-llm`,
      name: "LLM",
      category: "llm",
      startMs: 0,
      endMs: 10,
      promptIndex,
      stepIndex: 0,
      cost: {
        calculationVersion: 1,
        currency: "USD",
        completeness: "complete",
        amountUsd,
        source: "provider_reported",
      },
    })),
    turns: amounts.map((_amount, promptIndex) => ({
      turnId: `turn-${promptIndex}`,
      promptIndex,
      durationMs: 10,
    })),
  };
}

const broadcast = (id: number): BroadcastChatTurnRequest => ({
  id,
  text: `Prompt ${id}`,
  prependMessages: [],
});
const firstBroadcast = broadcast(1);

function Harness({
  broadcastRequest = firstBroadcast,
  stopRequestId = 0,
}: {
  broadcastRequest?: BroadcastChatTurnRequest;
  stopRequestId?: number;
}) {
  const [summaries, setSummaries] = useState<
    Record<string, MultiModelCardSummary>
  >({});
  const [, setRefresh] = useState(0);
  refreshHarness.current = () => setRefresh((value) => value + 1);
  return (
    <>
      <div data-testid="statuses">
        {models.map((model) => summaries[model.id]?.status).join(",")}
      </div>
      {models.map((model) => (
        <div key={model.id} data-testid={`card-${model.id}`}>
          <MultiModelChatCard
            model={model}
            comparisonSummaries={Object.values(summaries)}
            selectedServers={[]}
            selectedServerInstructions={{}}
            broadcastRequest={broadcastRequest}
            stopRequestId={stopRequestId}
            placeholder="Message"
            reasoningDisplayMode="inline"
            executionConfig={{
              systemPrompt: "",
              temperature: 0.7,
              requireToolApproval: false,
            }}
            onSummaryChange={(summary) =>
              setSummaries((previous) => ({
                ...previous,
                [summary.modelId]: summary,
              }))
            }
          />
        </div>
      ))}
    </>
  );
}

const winnerLabels = () => screen.queryAllByText(/^Lowest/);

function startStreaming(modelId: string) {
  Object.assign(sessions[modelId], { isStreaming: true, status: "streaming" });
  act(() => refreshHarness.current());
}

function finish(modelId: string) {
  Object.assign(sessions[modelId], { isStreaming: false, status: "ready" });
  act(() => refreshHarness.current());
}

/** One card sends a follow-up from its thread, and only that card answers. */
function followUp(modelId: string, text: string, amounts: number[]) {
  act(() => followUps[modelId](text));
  expect(sessions[modelId].sendMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ text }),
  );
  sessions[modelId].liveTraceEnvelope = pricedTrace(amounts);
  finish(modelId);
}

describe("MultiModelChatCard cost winner", () => {
  beforeEach(() => {
    sessions[cheap] = stubSession(pricedTrace([0.001]), true);
    sessions[dear] = stubSession(pricedTrace([0.004]), false);
  });

  it("names the cheaper card once both finish the same broadcast", () => {
    render(<Harness />);
    finish(dear);
    expect(winnerLabels()).toHaveLength(0);

    finish(cheap);

    expect(screen.getByTestId("statuses")).toHaveTextContent("ready,ready");
    expect(
      within(screen.getByTestId(`card-${cheap}`)).getByText("Lowest cost"),
    ).toBeInTheDocument();
    expect(winnerLabels()).toHaveLength(1);
  });

  it("names no winner when the cheaper card's stream is stopped", () => {
    const { rerender } = render(<Harness />);
    finish(dear);

    act(() => rerender(<Harness stopRequestId={1} />));

    expect(screen.getByTestId("statuses")).toHaveTextContent("cancelled,ready");
    expect(
      within(screen.getByTestId(`card-${cheap}`)).getByTestId(
        "compare-cost-row",
      ),
    ).toHaveTextContent("$0.0010");
    expect(winnerLabels()).toHaveLength(0);
  });

  it("names no winner while only one card has answered a follow-up", () => {
    const { rerender } = render(<Harness />);
    finish(dear);
    finish(cheap);
    expect(winnerLabels()).toHaveLength(1);

    followUp(cheap, "And hotels?", [0.001, 0.0002]);
    expect(winnerLabels()).toHaveLength(0);

    // The next broadcast reaches both cards, so they rank again. A hosted
    // send resolves server ids before it streams; until then each card
    // still holds the previous turn's cost and must not rank it.
    sessions[cheap].holdSends = true;
    sessions[dear].holdSends = true;
    act(() => rerender(<Harness broadcastRequest={broadcast(2)} />));
    expect(screen.getByTestId("statuses")).toHaveTextContent("running,running");
    expect(winnerLabels()).toHaveLength(0);

    startStreaming(cheap);
    startStreaming(dear);
    sessions[cheap].liveTraceEnvelope = pricedTrace([0.001, 0.0002, 0.0005]);
    sessions[dear].liveTraceEnvelope = pricedTrace([0.004, 0.0004]);
    finish(cheap);
    finish(dear);
    expect(
      within(screen.getByTestId(`card-${dear}`)).getByText("Lowest cost"),
    ).toBeInTheDocument();
    expect(winnerLabels()).toHaveLength(1);
  });

  it("names no winner when each card answered a different follow-up", () => {
    render(<Harness />);
    finish(dear);
    finish(cheap);
    expect(winnerLabels()).toHaveLength(1);

    // Both are each thread's second prompt, but not the same prompt.
    followUp(cheap, "And hotels?", [0.001, 0.0002]);
    followUp(dear, "And trains?", [0.004, 0.003]);

    expect(screen.getByTestId("statuses")).toHaveTextContent("ready,ready");
    expect(winnerLabels()).toHaveLength(0);
  });
});
