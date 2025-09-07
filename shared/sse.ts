// Shared SSE event types between server and client

export type SSETextEvent = {
  type: "text";
  content: string;
};

export type SSEToolCallEvent = {
  type: "tool_call";
  toolCall: {
    id: number;
    name: string;
    parameters: Record<string, unknown>;
    timestamp: string; // ISO string
    status: "pending" | "executing" | "completed" | "error";
  };
};

export type SSEToolResultEvent = {
  type: "tool_result";
  toolResult: {
    id: number;
    toolCallId: number;
    result: unknown;
    error?: string;
    timestamp: string; // ISO string
  };
};

export type SSEElicitationRequestEvent = {
  type: "elicitation_request";
  requestId: string;
  message: string;
  schema: unknown;
  timestamp: string; // ISO string
};

export type SSEElicitationCompleteEvent = {
  type: "elicitation_complete";
};

export type SSETraceStepEvent = {
  type: "trace_step";
  step: number;
  text?: string;
  toolCalls?: Array<{ name: string; params: Record<string, unknown> }>;
  toolResults?: Array<{ result: unknown; error?: string }>;
  timestamp: string; // ISO string
};

export type SSEErrorEvent = {
  type: "error";
  error: string;
};

export type SSEvent =
  | SSETextEvent
  | SSEToolCallEvent
  | SSEToolResultEvent
  | SSEElicitationRequestEvent
  | SSEElicitationCompleteEvent
  | SSETraceStepEvent
  | SSEErrorEvent;
