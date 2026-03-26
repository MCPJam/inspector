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
      "The client starts the MCP connection by saying which version and features it supports.",
    phase: "initialization",
    teachableMoments: [
      "This is always the first real MCP message.",
      "The client should wait for the server's reply before sending normal requests.",
    ],
    tips: [
      "For HTTP, later requests should include the negotiated MCP protocol version header.",
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
      "The server replies with the version and features it can support.",
    phase: "initialization",
    teachableMoments: [
      "This is where version negotiation is settled.",
      "The server lists things like tools, resources, prompts, and logging support.",
    ],
    tips: [
      "If the server proposes a version the client cannot use, the client should disconnect cleanly.",
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
      "The client sends one last message to say the handshake is done.",
    phase: "initialization",
    teachableMoments: [
      "It is a notification, so there is no id and no reply.",
      "After this, both sides can use the features they agreed on.",
    ],
    tips: [
      "This is the last step before normal MCP traffic starts.",
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
      "Now the client can do real work, like call tools, read resources, or list prompts.",
    phase: "operation",
    teachableMoments: [
      "The client should only use features the server said it supports.",
      "Each request gets an id so the reply can match it.",
    ],
    tips: [
      "Set timeouts so one slow request does not hang the whole connection.",
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
      "The server sends back the result. In HTTP, closing the connection is how shutdown usually happens.",
    phase: "shutdown",
    teachableMoments: [
      "HTTP does not use a special shutdown message.",
      "If a request takes too long, the sender should stop waiting and cancel it.",
    ],
    tips: [
      "Good clients still enforce a maximum timeout even if progress updates arrive.",
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

/**
 * Next HTTP lifecycle step for the walkthrough Continue control.
 * Unknown or missing `current` → first step; last step → wraps to first.
 */
export function nextHttpLifecycleStepId(
  current: string | undefined,
): McpLifecycleStep20250326 {
  if (!current) {
    return HTTP_STEP_ORDER[0];
  }
  const idx = HTTP_STEP_ORDER.indexOf(current as McpLifecycleStep20250326);
  if (idx < 0) {
    return HTTP_STEP_ORDER[0];
  }
  if (idx >= HTTP_STEP_ORDER.length - 1) {
    return HTTP_STEP_ORDER[0];
  }
  return HTTP_STEP_ORDER[idx + 1];
}

export function isLastHttpLifecycleStep(current: string | undefined): boolean {
  if (!current) return false;
  const idx = HTTP_STEP_ORDER.indexOf(current as McpLifecycleStep20250326);
  return idx === HTTP_STEP_ORDER.length - 1;
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

export const LIFECYCLE_GUIDE_SLIM: Record<
  (typeof HTTP_STEP_ORDER)[number],
  McpLifecycleStepSlim
> = {
  initialize_request: {
    title: "Initialize Request",
    subtitle: "Client says what version and features it supports",
    phase: "initialization",
    direction: "client-to-server",
    keyInsight:
      "This starts the handshake. The server will answer with the version and features it can use.",
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
    subtitle: "Server replies with its version and features",
    phase: "initialization",
    direction: "server-to-client",
    keyInsight:
      "If the client cannot use the server's version, it should disconnect cleanly.",
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
    subtitle: "Client confirms the handshake is done",
    phase: "initialization",
    direction: "client-to-server",
    keyInsight:
      "This is a one-way message. No id, no reply. After this, normal MCP work can begin.",
    codeSnippet: `{
  method: "notifications/initialized"
}`,
  },

  operation_request: {
    title: "Operation Request",
    subtitle: "Client asks to use tools or read data",
    phase: "operation",
    direction: "client-to-server",
    keyInsight:
      "Only use features the server agreed to during setup, and give each request an id.",
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
    subtitle: "Server returns the result; HTTP ends by closing",
    phase: "shutdown",
    direction: "server-to-client",
    keyInsight:
      "HTTP has no special shutdown message. Clients should use timeouts so requests do not hang forever.",
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
