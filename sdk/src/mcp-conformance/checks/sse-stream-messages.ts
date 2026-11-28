import {
  isJSONRPCResponse,
  parseJSONRPCMessage,
} from "@modelcontextprotocol/client";
import { stableStringifyJson } from "../../widget-runtime/json-utils.js";
import type { RawHttpResult } from "../raw-http.js";

type SseStream = {
  index: number;
  response: Pick<RawHttpResult, "sse" | "bodyError">;
};

type StreamInspection =
  | {
      unansweredStreams: number[];
      eventCounts: number[];
      readErrors: Array<string | undefined>;
    }
  | {
      violation: { message: string; streamIndexes: number[]; eventIndex: number };
    };

export function inspectSseStreamMessages(
  streams: readonly SseStream[],
  protocolVersion: string,
  firstRequestId: number,
): StreamInspection {
  const firstStreamByMessage = new Map<string, number>();
  const unansweredStreams: number[] = [];

  for (const { index, response } of streams) {
    const requestId = firstRequestId + index;
    let answered = false;
    for (const [eventIndex, event] of (response.sse ?? []).entries()) {
      // The client SDK reads data from complete, default or named message events.
      if (
        !event.terminated ||
        !event.data ||
        (event.event && event.event !== "message")
      ) {
        continue;
      }

      // March 2025 permits batches on SSE. Validate every batch member using
      // the same SDK validator as a single message.
      const payloads: readonly unknown[] =
        protocolVersion === "2025-03-26" &&
        Array.isArray(event.json) &&
        event.json.length > 0
          ? event.json
          : [event.json];
      let messages: ReturnType<typeof parseJSONRPCMessage>[];
      try {
        messages = payloads.map(parseJSONRPCMessage);
      } catch {
        return {
          violation: {
            message: "A concurrent SSE stream sent malformed JSON-RPC",
            streamIndexes: [index],
            eventIndex,
          },
        };
      }

      for (const [messageIndex, message] of messages.entries()) {
        const isResponse = isJSONRPCResponse(message);
        if (isResponse && String(message.id) === String(requestId)) {
          answered = true;
        }

        // Request and response IDs identify calls in opposite directions.
        // For messages without an RPC ID, identical payloads alone can be
        // independent notifications. Require the same SSE event ID as well.
        const key =
          "id" in message && message.id != null
            ? JSON.stringify([isResponse ? "response" : "request", message.id])
            : event.id &&
              stableStringifyJson(["event", event.id, payloads[messageIndex]]);
        if (!key) continue;
        const firstIndex = firstStreamByMessage.get(key);
        if (firstIndex !== undefined && firstIndex !== index) {
          return {
            violation: {
              message: "The server sent the same JSON-RPC message on multiple SSE streams",
              streamIndexes: [firstIndex, index],
              eventIndex,
            },
          };
        }
        firstStreamByMessage.set(key, index);
      }
    }
    if (!answered) unansweredStreams.push(index);
  }

  return {
    unansweredStreams,
    // A truncated tail is never a delivered event.
    eventCounts: streams.map(
      ({ response }) =>
        response.sse?.filter((event) => event.terminated).length ?? 0,
    ),
    readErrors: streams.map(({ response }) => response.bodyError),
  };
}
