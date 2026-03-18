import type {
  SequenceDiagramActorConfig,
  SequenceDiagramAction,
} from "@/components/sequence-diagram";

/**
 * MCP Lifecycle steps for the 2025-03-26 spec.
 * stdio has 7 steps (shared 5 + 2 shutdown), http has 5 steps (shared only).
 */
export type McpLifecycleStep20250326 =
  // Shared (both transports)
  | "initialize_request"
  | "initialize_result"
  | "initialized_notification"
  | "operation_request"
  | "operation_response"
  // stdio shutdown
  | "close_stdin"
  | "process_exit";

export type McpTransport = "stdio" | "http";

interface BuildOptions {
  transport: McpTransport;
  labels?: Partial<Record<McpLifecycleStep20250326, string>>;
}

export interface McpLifecycleScenario {
  actors: SequenceDiagramActorConfig[];
  actions: SequenceDiagramAction[];
}

// --- Actor definitions ---

const CLIENT_ACTOR: SequenceDiagramActorConfig = {
  id: "client",
  label: "Client (Host)",
  color: "#10b981", // green
};

const SERVER_ACTOR: SequenceDiagramActorConfig = {
  id: "server",
  label: "MCP Server",
  color: "#f59e0b", // amber
};

const PROCESS_ACTOR: SequenceDiagramActorConfig = {
  id: "process",
  label: "Server Process",
  color: "#8b5cf6", // purple
};

// --- Action builders ---

function buildSharedActions(
  labels: Partial<Record<McpLifecycleStep20250326, string>>,
): SequenceDiagramAction[] {
  return [
    {
      id: "initialize_request",
      label: labels.initialize_request ?? "initialize",
      description: "Client sends initialize request with capabilities",
      from: "client",
      to: "server",
      details: [
        { label: "Method", value: "initialize" },
        { label: "Note", value: "Version negotiation occurs here" },
      ],
    },
    {
      id: "initialize_result",
      label: labels.initialize_result ?? "initialize (result)",
      description: "Server responds with its capabilities and version",
      from: "server",
      to: "client",
      details: [
        { label: "Contains", value: "Server capabilities + protocol version" },
      ],
    },
    {
      id: "initialized_notification",
      label: labels.initialized_notification ?? "notifications/initialized",
      description: "Client confirms initialization is complete",
      from: "client",
      to: "server",
      details: [
        { label: "Type", value: "Notification (no response)" },
        {
          label: "Note",
          value: "No requests allowed before this notification",
        },
      ],
    },
    {
      id: "operation_request",
      label: labels.operation_request ?? "request (e.g. tools/call)",
      description: "Client sends operational requests to the server",
      from: "client",
      to: "server",
      details: [
        { label: "Examples", value: "tools/call, resources/read, prompts/get" },
      ],
    },
    {
      id: "operation_response",
      label: labels.operation_response ?? "response (result)",
      description: "Server processes the request and returns a result",
      from: "server",
      to: "client",
    },
  ];
}

function buildStdioShutdownActions(
  labels: Partial<Record<McpLifecycleStep20250326, string>>,
): SequenceDiagramAction[] {
  return [
    {
      id: "close_stdin",
      label: labels.close_stdin ?? "Close stdin",
      description:
        "Client closes the stdin stream to signal shutdown to the server process",
      from: "client",
      to: "process",
      details: [
        { label: "Transport", value: "stdio" },
        {
          label: "Fallback",
          value: "SIGTERM, then SIGKILL if process does not exit",
        },
      ],
    },
    {
      id: "process_exit",
      label: labels.process_exit ?? "Process exit",
      description: "Server process exits cleanly after stdin is closed",
      from: "process",
      to: "client",
      details: [{ label: "Expected", value: "Clean exit code 0" }],
    },
  ];
}

/**
 * Build the MCP lifecycle scenario for spec version 2025-03-26.
 *
 * - stdio: client + server + process (7 actions including shutdown)
 * - http: client + server (5 actions, shutdown is just closing the connection)
 */
export function buildMcpLifecycleScenario20250326(
  options: BuildOptions,
): McpLifecycleScenario {
  const { transport, labels = {} } = options;

  const actors: SequenceDiagramActorConfig[] =
    transport === "stdio"
      ? [CLIENT_ACTOR, SERVER_ACTOR, PROCESS_ACTOR]
      : [CLIENT_ACTOR, SERVER_ACTOR];

  const sharedActions = buildSharedActions(labels);

  if (transport === "http") {
    // HTTP: annotate operation_response with shutdown info
    const operationResponse = sharedActions.find(
      (a) => a.id === "operation_response",
    );
    if (operationResponse) {
      operationResponse.details = [
        ...(operationResponse.details ?? []),
        {
          label: "Shutdown",
          value: "Close HTTP connection (transport-level)",
        },
      ];
    }
    return { actors, actions: sharedActions };
  }

  // stdio: add shutdown actions
  const stdioShutdown = buildStdioShutdownActions(labels);
  return { actors, actions: [...sharedActions, ...stdioShutdown] };
}
