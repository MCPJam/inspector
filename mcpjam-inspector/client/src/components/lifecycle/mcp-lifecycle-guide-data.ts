import type { McpLifecycleStep20250326 } from "./mcp-lifecycle-data";

export interface McpLifecycleStepGuide {
  title: string;
  summary: string;
  phase: "initialization" | "operation" | "shutdown";
  teachableMoments: string[];
  tips: string[];
  /** JSON code example rendered in a <pre> block */
  codeExample?: string;
  /** Optional table (e.g. capability negotiation) */
  table?: {
    caption: string;
    headers: string[];
    rows: string[][];
  };
}

export const HTTP_STEP_ORDER: McpLifecycleStep20250326[] = [
  "initialize_request",
  "initialize_result",
  "initialized_notification",
  "operation_request",
  "operation_response",
];

export const LIFECYCLE_GUIDE_METADATA: Partial<
  Record<McpLifecycleStep20250326, McpLifecycleStepGuide>
> = {
  initialize_request: {
    title: "Initialize Request",
    summary:
      "The client kicks off the MCP session by sending an initialize request. This is always the very first message — it carries the protocol version the client supports, the capabilities it can provide, and metadata about itself.",
    phase: "initialization",
    teachableMoments: [
      "The client MUST send the latest protocol version it supports. The server will either agree or propose a different version.",
      "Capabilities declare what optional features the client offers (e.g. roots, sampling, elicitation). The server uses this to decide what it can request later.",
      "The client SHOULD NOT send any requests (other than pings) until it receives the initialize response.",
    ],
    tips: [
      "For HTTP transports, the client MUST include the MCP-Protocol-Version header on all subsequent requests after initialization.",
      "clientInfo fields like name, version, and icons help servers identify and display the connected client.",
    ],
    codeExample: JSON.stringify(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {
            roots: { listChanged: true },
            sampling: {},
            elicitation: { form: {}, url: {} },
          },
          clientInfo: {
            name: "ExampleClient",
            version: "1.0.0",
          },
        },
      },
      null,
      2,
    ),
    table: {
      caption: "Client Capabilities",
      headers: ["Capability", "Description"],
      rows: [
        ["roots", "Provides filesystem roots to the server"],
        ["sampling", "Supports LLM sampling requests from the server"],
        ["elicitation", "Supports server elicitation requests (forms, URLs)"],
        ["tasks", "Supports task-augmented client requests"],
        ["experimental", "Non-standard experimental features"],
      ],
    },
  },

  initialize_result: {
    title: "Initialize Response",
    summary:
      "The server responds with its own protocol version, capabilities, and metadata. This is where version negotiation resolves — the server either agrees to the client's version or proposes its own.",
    phase: "initialization",
    teachableMoments: [
      "If the server supports the requested protocol version, it responds with the same version. Otherwise it responds with the latest version it supports.",
      "If the client cannot support the server's proposed version, it SHOULD disconnect.",
      "Server capabilities tell the client which features are available: tools, resources, prompts, logging, etc.",
      "The optional instructions field provides human-readable guidance for the client.",
    ],
    tips: [
      "Check whether listChanged is true for prompts, resources, or tools — this means the server will notify you when these lists update.",
      "The subscribe capability under resources means you can subscribe to individual resource changes.",
    ],
    codeExample: JSON.stringify(
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {
            logging: {},
            prompts: { listChanged: true },
            resources: { subscribe: true, listChanged: true },
            tools: { listChanged: true },
          },
          serverInfo: {
            name: "ExampleServer",
            version: "1.0.0",
          },
          instructions: "Optional instructions for the client",
        },
      },
      null,
      2,
    ),
    table: {
      caption: "Server Capabilities",
      headers: ["Capability", "Description"],
      rows: [
        ["prompts", "Offers prompt templates"],
        ["resources", "Provides readable resources"],
        ["tools", "Exposes callable tools"],
        ["logging", "Emits structured log messages"],
        ["completions", "Supports argument autocompletion"],
        ["tasks", "Supports task-augmented server requests"],
        ["experimental", "Non-standard experimental features"],
      ],
    },
  },

  initialized_notification: {
    title: "Initialized Notification",
    summary:
      "The client confirms that initialization is complete by sending a notification. This is a one-way message — the server does not respond. After this, both sides enter normal operation.",
    phase: "initialization",
    teachableMoments: [
      "This is a notification, not a request — there is no id field and no response is expected.",
      "The server SHOULD NOT send requests (other than pings and logging) before receiving this notification.",
      "After this notification, the session is fully established and both sides can use their negotiated capabilities.",
    ],
    tips: [
      "If the server starts sending requests before this notification arrives, it may be a spec violation worth investigating.",
      "This is the last message in the initialization phase. Everything after this is the operation phase.",
    ],
    codeExample: JSON.stringify(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      null,
      2,
    ),
  },

  operation_request: {
    title: "Operation Phase — Request",
    summary:
      "With initialization complete, the client sends operational requests to the server. These follow the JSON-RPC 2.0 format and can invoke tools, read resources, list prompts, and more — but only capabilities that were negotiated during initialization.",
    phase: "operation",
    teachableMoments: [
      "Both sides MUST respect the negotiated protocol version for all messages.",
      "Only use capabilities that were successfully negotiated. For example, don't call tools/call if the server didn't declare the tools capability.",
      "Each request has a unique id that the server uses to correlate its response.",
    ],
    tips: [
      "Common operations: tools/call, resources/read, resources/list, prompts/get, prompts/list, logging/setLevel.",
      "Implementations SHOULD set timeouts on all requests to prevent hung connections.",
    ],
    codeExample: JSON.stringify(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "get_weather",
          arguments: {
            location: "San Francisco",
          },
        },
      },
      null,
      2,
    ),
  },

  operation_response: {
    title: "Operation Phase — Response & Shutdown",
    summary:
      "The server processes the request and returns a JSON-RPC result. For HTTP transports, shutdown is signaled by simply closing the HTTP connection — there are no explicit shutdown messages in the protocol.",
    phase: "shutdown",
    teachableMoments: [
      "For HTTP, shutdown is signaled by closing the HTTP connection(s). There is no dedicated shutdown message.",
      "Implementations SHOULD establish timeouts for all sent requests to prevent hung connections and resource exhaustion.",
      "When a request times out, the sender SHOULD issue a cancellation notification for that request and stop waiting.",
    ],
    tips: [
      "Progress notifications from the server can reset the timeout clock, but implementations SHOULD still enforce a maximum timeout.",
      "SDKs and middleware SHOULD allow timeouts to be configured on a per-request basis.",
    ],
    codeExample: JSON.stringify(
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          content: [
            {
              type: "text",
              text: "Current weather in San Francisco: 62°F, partly cloudy",
            },
          ],
        },
      },
      null,
      2,
    ),
  },
};

export function getLifecycleStepGuide(
  step: McpLifecycleStep20250326,
): McpLifecycleStepGuide | undefined {
  return LIFECYCLE_GUIDE_METADATA[step];
}

export function getLifecycleStepIndex(step: McpLifecycleStep20250326): number {
  const index = HTTP_STEP_ORDER.indexOf(step);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

// ---------------------------------------------------------------------------
// Slim data model — minimalist content for the animated guide wizard
// ---------------------------------------------------------------------------

export interface McpLifecycleStepSlim {
  title: string;
  subtitle: string;
  phase: "initialization" | "operation" | "shutdown";
  keyInsight: string;
  codeSnippet?: string;
  direction: "client-to-server" | "server-to-client";
}

export const PHASE_ACCENT = {
  initialization: "#3b82f6",
  operation: "#10b981",
  shutdown: "#f59e0b",
} as const;

export const LIFECYCLE_GUIDE_SLIM: Record<
  (typeof HTTP_STEP_ORDER)[number],
  McpLifecycleStepSlim
> = {
  initialize_request: {
    title: "Initialize Request",
    subtitle: "Client sends its version and capabilities",
    phase: "initialization",
    direction: "client-to-server",
    keyInsight:
      "The client must send the latest protocol version it supports. The server will negotiate from there.",
    codeSnippet: `{
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: { roots: {}, sampling: {} },
    clientInfo: { name: "MyClient", version: "1.0" }
  }
}`,
  },

  initialize_result: {
    title: "Initialize Response",
    subtitle: "Server responds with its own capabilities",
    phase: "initialization",
    direction: "server-to-client",
    keyInsight:
      "If the client can't work with the server's proposed version, it should disconnect gracefully.",
    codeSnippet: `{
  result: {
    protocolVersion: "2025-11-25",
    capabilities: { tools: {}, resources: {} },
    serverInfo: { name: "MyServer" }
  }
}`,
  },

  initialized_notification: {
    title: "Initialized",
    subtitle: "Client confirms — the handshake is complete",
    phase: "initialization",
    direction: "client-to-server",
    keyInsight:
      "This is a notification, not a request. No id field, no response expected. After this, normal operations can begin.",
    codeSnippet: `{
  method: "notifications/initialized"
}`,
  },

  operation_request: {
    title: "Operation Request",
    subtitle: "Client invokes tools, reads resources, or lists prompts",
    phase: "operation",
    direction: "client-to-server",
    keyInsight:
      "Only use capabilities that were negotiated during initialization. Each request gets a unique id for correlation.",
    codeSnippet: `{
  method: "tools/call",
  params: {
    name: "get_weather",
    arguments: { location: "San Francisco" }
  }
}`,
  },

  operation_response: {
    title: "Response & Shutdown",
    subtitle: "Server returns results. Close connection to shut down.",
    phase: "shutdown",
    direction: "server-to-client",
    keyInsight:
      "For HTTP, there's no special shutdown message — just close the connection. Set timeouts to prevent hung requests.",
    codeSnippet: `{
  result: {
    content: [{
      type: "text",
      text: "62°F, partly cloudy"
    }]
  }
}`,
  },
};
