export interface LearningExampleBase {
  id: string;
  title: string;
  description: string;
  objective: string;
}

export interface LearningToolExample extends LearningExampleBase {
  targetName: string;
  defaultParameters?: Record<string, unknown>;
  rawParameters?: string;
}

export interface LearningResourceExample extends LearningExampleBase {
  uri: string;
}

export interface LearningPromptExample extends LearningExampleBase {
  targetName: string;
  defaultArguments?: Record<string, string>;
  rawArguments?: string;
}

export interface LearningExampleManifest {
  tools: LearningToolExample[];
  resources: LearningResourceExample[];
  prompts: LearningPromptExample[];
}

export const learningExampleManifest: LearningExampleManifest = {
  tools: [
    {
      id: "tool-greet",
      title: "Greeting tool",
      description:
        "A minimal tool call for learning request parameters, result payloads, and the corresponding JSON-RPC traffic.",
      objective:
        "Use a simple, side-effect-free tool to understand how tool input turns into a response.",
      targetName: "greet",
      defaultParameters: {
        name: "MCPJam learner",
      },
      rawParameters: JSON.stringify(
        {
          name: "MCPJam learner",
        },
        null,
        2,
      ),
    },
    {
      id: "tool-display-mcp-app",
      title: "Inline MCP App",
      description:
        "Invoke a tool that advertises a UI resource so the shared MCP Apps renderer can show the resulting experience inline.",
      objective:
        "See how tool metadata, UI resources, and RPC traffic work together for interactive apps.",
      targetName: "display-mcp-app",
      defaultParameters: {},
      rawParameters: "{}",
    },
  ],
  resources: [
    {
      id: "resource-server-info",
      title: "Server info resource",
      description:
        "Read a plain resource to inspect how resources/list and resources/read behave over the same sandbox connection.",
      objective:
        "Compare resource discovery with resource reads and inspect the payload shape returned by the server.",
      uri: "info://mcp-demo/server-info",
    },
    {
      id: "resource-ui-app",
      title: "UI resource",
      description:
        "Open a ui:// resource directly and render it with the shared MCP Apps runtime.",
      objective:
        "Understand how ui:// resources differ from tool results and how hosts resolve them.",
      uri: "ui://mcp-demo/mcp-app.html",
    },
  ],
  prompts: [
    {
      id: "prompt-explain-concept",
      title: "Concept prompt",
      description:
        "Fetch a prompt with arguments and inspect the prompt content that comes back from the server.",
      objective:
        "Learn how prompts expose templated, reusable instructions separately from tools and resources.",
      targetName: "explain-concept",
      defaultArguments: {
        concept: "MCP tools",
      },
      rawArguments: JSON.stringify(
        {
          concept: "MCP tools",
        },
        null,
        2,
      ),
    },
  ],
};
