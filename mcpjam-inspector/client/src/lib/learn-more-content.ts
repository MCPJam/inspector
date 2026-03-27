export interface LearnMoreEntry {
  title: string;
  videoUrl: string;
  videoThumbnail?: string;
  description: string;
  docsUrl: string;
}

export const learnMoreContent: Record<string, LearnMoreEntry> = {
  servers: {
    title: "Servers",
    videoUrl: "",
    description:
      "Connect and manage your MCP servers. Add servers via stdio, HTTP, or SSE transports and monitor their connection status.",
    docsUrl: "https://docs.mcpjam.com/servers",
  },
  "chat-v2": {
    title: "Chat",
    videoUrl: "",
    description:
      "Chat with your MCP servers using AI. Test tool calls, explore capabilities, and interact with your servers in natural language.",
    docsUrl: "https://docs.mcpjam.com/chat",
  },
  sandboxes: {
    title: "Sandboxes",
    videoUrl: "",
    description:
      "Run MCP servers in isolated cloud sandboxes. Test and share servers without local setup.",
    docsUrl: "https://docs.mcpjam.com/sandboxes",
  },
  "app-builder": {
    title: "App Builder",
    videoUrl: "",
    description:
      "Build interactive UI apps powered by your MCP servers. Create custom views and interfaces with the App Builder.",
    docsUrl: "https://docs.mcpjam.com/app-builder",
  },
  views: {
    title: "Views",
    videoUrl: "",
    description:
      "Browse and interact with MCP App views exposed by your connected servers. Views provide rich UI experiences on top of MCP.",
    docsUrl: "https://docs.mcpjam.com/views",
  },
  "client-config": {
    title: "Client Config",
    videoUrl: "",
    description:
      "Configure client capabilities and settings for how the inspector communicates with your MCP servers.",
    docsUrl: "https://docs.mcpjam.com/client-config",
  },
  evals: {
    title: "Generate Evals",
    videoUrl: "",
    description:
      "Generate evaluation suites for your MCP servers. Test tool reliability and response quality with automated evals.",
    docsUrl: "https://docs.mcpjam.com/evals",
  },
  "ci-evals": {
    title: "Evals CI/CD",
    videoUrl: "",
    description:
      "Run MCP evaluations in your CI/CD pipeline. Catch regressions and ensure server quality before deploying.",
    docsUrl: "https://docs.mcpjam.com/ci-evals",
  },
  skills: {
    title: "Skills",
    videoUrl: "",
    description:
      "Explore and manage skills that extend your MCP server capabilities. Skills are reusable prompt templates for common tasks.",
    docsUrl: "https://docs.mcpjam.com/skills",
  },
  learning: {
    title: "Learning",
    videoUrl: "",
    description:
      "Interactive walkthroughs and guides to help you understand MCP concepts, transports, and app development.",
    docsUrl: "https://docs.mcpjam.com/learning",
  },
  "oauth-flow": {
    title: "OAuth Debugger",
    videoUrl: "",
    description:
      "Debug and inspect OAuth flows for your MCP servers. Step through the authorization process and inspect tokens.",
    docsUrl: "https://docs.mcpjam.com/oauth",
  },
  tools: {
    title: "Tools",
    videoUrl: "/tool-vid-march.mp4",
    description:
      "Browse, call, and test the tools exposed by your connected MCP servers. Inspect input schemas and view responses.",
    docsUrl: "https://docs.mcpjam.com/inspector/tools-prompts-resources#tools",
  },
  resources: {
    title: "Resources",
    videoUrl: "",
    description:
      "Explore resources provided by your MCP servers. Resources expose data like files, database records, and API responses.",
    docsUrl: "https://docs.mcpjam.com/resources",
  },
  prompts: {
    title: "Prompts",
    videoUrl: "",
    description:
      "View and test prompt templates from your MCP servers. Prompts are reusable templates that guide AI interactions.",
    docsUrl: "https://docs.mcpjam.com/prompts",
  },
  tasks: {
    title: "Tasks",
    videoUrl: "",
    description:
      "Monitor and manage long-running tasks from your MCP servers. Track progress, view results, and cancel operations.",
    docsUrl: "https://docs.mcpjam.com/tasks",
  },
  support: {
    title: "Support",
    videoUrl: "",
    description:
      "Get help with the MCP Inspector. Find documentation, report issues, and connect with the community.",
    docsUrl: "https://docs.mcpjam.com/support",
  },
  settings: {
    title: "Settings",
    videoUrl: "",
    description:
      "Configure the MCP Inspector. Manage themes, AI providers, and application preferences.",
    docsUrl: "https://docs.mcpjam.com/settings",
  },
};
