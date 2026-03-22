// ---------------------------------------------------------------------------
// MCP 101 — Guide content data
// ---------------------------------------------------------------------------

export type Mcp101Step =
  | "what_is_mcp"
  | "why_standards"
  | "architecture"
  | "capabilities"
  | "security";

export const MCP101_STEP_ORDER: Mcp101Step[] = [
  "what_is_mcp",
  "why_standards",
  "architecture",
  "capabilities",
  "security",
];

export interface Mcp101StepGuide {
  title: string;
  summary: string;
  phase: "fundamentals" | "architecture" | "capabilities" | "security";
  teachableMoments: string[];
  tips: string[];
  /** JSON code example rendered in a <pre> block */
  codeExample?: string;
  /** Optional table */
  table?: {
    caption: string;
    headers: string[];
    rows: string[][];
  };
}

export const MCP101_PHASE_ACCENT = {
  fundamentals: "#8b5cf6",
  architecture: "#3b82f6",
  capabilities: "#10b981",
  security: "#f59e0b",
} as const;

export const MCP101_GUIDE_METADATA: Record<Mcp101Step, Mcp101StepGuide> = {
  what_is_mcp: {
    title: "What is MCP?",
    summary:
      "The Model Context Protocol (MCP) is an open protocol that standardizes how AI applications connect to external tools and data sources. Think of it like HTTP — just as HTTP standardized how browsers talk to web servers, MCP standardizes how AI agents talk to the tools they need. It has a formal specification, uses JSON-RPC 2.0 as its message format, and is maintained as an open standard.",
    phase: "fundamentals",
    teachableMoments: [
      "MCP is a protocol with a specification — not a library, not a framework. Anyone can implement it.",
      "It uses JSON-RPC 2.0 as its wire format — a lightweight, well-established standard for remote procedure calls.",
      "MCP supports multiple transports: HTTP with Server-Sent Events (Streamable HTTP) and stdio for local processes.",
      "The protocol is stateful — connections go through initialization, operation, and shutdown phases.",
    ],
    tips: [
      "MCP draws inspiration from the Language Server Protocol (LSP), which successfully standardized programming language support across IDEs.",
      "The specification is versioned by date (e.g., \"2025-11-25\") and maintained at modelcontextprotocol.io.",
    ],
    codeExample: JSON.stringify(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "MyApp", version: "1.0" },
        },
      },
      null,
      2,
    ),
  },

  why_standards: {
    title: "Why Standards Matter",
    summary:
      "Without a standard protocol, every AI app needs custom code for every tool — an N×M integration problem. With MCP, tool providers build one server that works with every MCP-compatible app, and app developers add MCP support once to access every server. This is the same pattern that made HTTP, USB, and LSP successful: agree on the interface, and the ecosystem builds itself.",
    phase: "fundamentals",
    teachableMoments: [
      "Without MCP: 10 AI apps × 10 tools = 100 custom integrations to build and maintain.",
      "With MCP: 10 apps + 10 servers = 20 implementations. Each side builds once.",
      "Standards enable an ecosystem — independent teams build MCP servers and clients that work together out of the box.",
      "For enterprises: standardized security, auditing, and governance across all AI-tool integrations.",
    ],
    tips: [
      "LSP proved this model: before it, every editor needed custom language support. After LSP, language teams build one server and every editor benefits.",
      "MCP servers already exist for databases, APIs, file systems, cloud services, and more — your app gets all of them by supporting the protocol.",
    ],
  },

  architecture: {
    title: "The Architecture",
    summary:
      "MCP defines three roles. Hosts are the AI applications users interact with — like an IDE, chat app, or agentic workflow. Inside each host, Clients manage individual connections to MCP servers. Servers expose tools, data, and capabilities. A single host can connect to many servers simultaneously through multiple clients.",
    phase: "architecture",
    teachableMoments: [
      "Hosts are user-facing LLM applications (IDEs, chat interfaces, AI workflows).",
      "Clients live inside hosts — each client maintains a 1:1 stateful session with a single server.",
      "Servers provide the actual capabilities: tools, resources, and prompts.",
      "A single host can run many clients at once, each connected to a different server.",
    ],
    tips: [
      "Servers stay simple and focused — a weather server just does weather, a database server just does queries.",
      "The client handles all protocol complexity (initialization, capability negotiation, transport) so servers can focus on their domain.",
    ],
    table: {
      caption: "MCP Roles",
      headers: ["Role", "Examples", "Responsibility"],
      rows: [
        [
          "Host",
          "IDE, Chat app, AI workflow",
          "User-facing application that embeds AI",
        ],
        [
          "Client",
          "Protocol connector",
          "Manages 1:1 session with a server",
        ],
        [
          "Server",
          "Tool provider, data source",
          "Exposes capabilities via MCP",
        ],
      ],
    },
  },

  capabilities: {
    title: "Giving Agents Hands",
    summary:
      "In the age of AI agents, models need to do more than generate text — they need to take action. MCP servers expose three core primitives that give agents the ability to interact with the real world. Tools are functions the model can call. Resources are data the model can read. Prompts are templates that guide the model for specific tasks.",
    phase: "capabilities",
    teachableMoments: [
      "Tools are model-controlled — the AI decides when to call them based on the user's request.",
      "Resources are application-controlled — the host app decides which resources to include in context.",
      "Prompts are user-controlled — users choose which prompt templates to invoke.",
      "Capabilities are negotiated during initialization — servers declare what they offer, clients declare what they support.",
    ],
    tips: [
      "Think of tools as the agent's \"hands\" — they let it take action: run code, query APIs, send emails, modify files.",
      "Resources are the agent's \"eyes\" — they let it see relevant data without being told everything upfront.",
    ],
    table: {
      caption: "MCP Primitives",
      headers: ["Primitive", "Controlled By", "Purpose"],
      rows: [
        [
          "Tools",
          "AI Model",
          "Functions the model can execute (e.g., query_db, send_email)",
        ],
        [
          "Resources",
          "Application",
          "Data and context to include (e.g., file contents, API data)",
        ],
        [
          "Prompts",
          "User",
          "Reusable templates for specific tasks (e.g., code_review)",
        ],
      ],
    },
  },

  security: {
    title: "Security by Design",
    summary:
      "Giving AI agents real-world capabilities demands serious security. MCP builds safety into the protocol: users must explicitly consent to all operations, data access requires authorization, and every tool invocation needs approval. The goal is to give agents powerful hands without compromising safety — especially critical for enterprise deployments where governance and auditability are non-negotiable.",
    phase: "security",
    teachableMoments: [
      "User Consent & Control: Users must explicitly approve all data access and tool invocations. No silent actions.",
      "Data Privacy: Hosts must not share user data with servers or transmit it elsewhere without explicit consent.",
      "Tool Safety: Tools represent arbitrary code execution — hosts must get user approval before calling any tool.",
      "LLM Sampling Controls: When servers request LLM sampling, users control whether it happens, what prompt is sent, and what the server sees.",
    ],
    tips: [
      "MCP's consent model maps naturally to enterprise access control and audit frameworks.",
      "Tool annotations (readOnlyHint, destructiveHint) help hosts decide which tools need extra scrutiny — but always treat annotations as untrusted unless from a verified server.",
    ],
  },
};
