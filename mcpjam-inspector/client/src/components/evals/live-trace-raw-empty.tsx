import { TraceRawView } from "./trace-raw-view";
import { SAMPLE_CHAT_RAW_REQUEST_PAYLOAD } from "./sample-chat-raw-payload";

/**
 * Raw tab placeholder: sample model request JSON (system, tools, messages) before the
 * first outgoing chat message, mirroring {@link LiveTraceTimelineEmptyState}.
 */
export function LiveTraceRawEmptyState({ testId }: { testId: string }) {
  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-hidden px-4 py-2"
      data-testid={testId}
    >
      <p className="shrink-0 px-1 text-center text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Sample raw request</span>
        {" — "}
        Example of the JSON payload sent to the model (system prompt, tool
        definitions, and chat messages). Your live request appears after you
        send a message.
      </p>
      <div
        className="relative min-h-0 flex-1 overflow-auto rounded-xl border bg-card p-2"
        data-testid={`${testId}-sample-preview`}
      >
        <TraceRawView
          trace={null}
          requestPayloadHistory={{
            entries: [
              {
                turnId: "sample-turn-1",
                promptIndex: 0,
                stepIndex: 0,
                payload: SAMPLE_CHAT_RAW_REQUEST_PAYLOAD,
              },
            ],
            hasUiMessages: true,
          }}
          growWithContent
        />
      </div>
    </div>
  );
}
