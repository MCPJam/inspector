import {
  AppWindow,
  Blocks,
  BookOpen,
  Database,
  GitBranch,
  Globe,
  Lightbulb,
  MessageSquare,
  Network,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface LearningConcept {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  totalSteps: number;
  category: string;
  estimatedMinutes: number;
}

export interface LearningGroup {
  title: string;
  subtitle: string;
  modules: LearningConcept[];
}

export const LEARNING_GROUPS: LearningGroup[] = [
  {
    title: "Getting Started",
    subtitle: "Learn what MCP is and why people use it",
    modules: [
      {
        id: "why-mcp",
        title: "Why MCP?",
        description:
          "See why AI needs a standard way to reach tools and data.",
        icon: Lightbulb,
        totalSteps: 7,
        category: "Concepts",
        estimatedMinutes: 2,
      },
      {
        id: "what-is-mcp",
        title: "What is MCP?",
        description:
          "Learn the basic parts of MCP and how they work together.",
        icon: Network,
        totalSteps: 8,
        category: "Fundamentals",
        estimatedMinutes: 4,
      },
    ],
  },
  {
    title: "The Protocol",
    subtitle: "Learn the main pieces MCP servers expose",
    modules: [
      {
        id: "mcp-lifecycle",
        title: "MCP Lifecycle",
        description:
          "Walk through how an MCP connection starts, runs, and ends.",
        icon: GitBranch,
        totalSteps: 5,
        category: "Protocol",
        estimatedMinutes: 3,
      },
      {
        id: "mcp-tools",
        title: "MCP Tools",
        description:
          "Learn how AI uses MCP tools to do real work.",
        icon: Wrench,
        totalSteps: 5,
        category: "Protocol",
        estimatedMinutes: 2,
      },
      {
        id: "mcp-resources",
        title: "MCP Resources",
        description:
          "Learn how MCP shares files, docs, and other read-only data.",
        icon: Database,
        totalSteps: 5,
        category: "Protocol",
        estimatedMinutes: 2,
      },
      {
        id: "mcp-prompts",
        title: "MCP Prompts",
        description:
          "Learn how reusable prompt templates fit into MCP.",
        icon: MessageSquare,
        totalSteps: 5,
        category: "Protocol",
        estimatedMinutes: 2,
      },
    ],
  },
  {
    title: "Building with MCP",
    subtitle: "See how MCP can power UI-based apps",
    modules: [
      {
        id: "mcp-apps",
        title: "MCP Apps",
        description:
          "See how an MCP server can open a real UI, not just return text.",
        icon: AppWindow,
        totalSteps: 7,
        category: "Extensions",
        estimatedMinutes: 4,
      },
      {
        id: "apps-sdk",
        title: "OpenAI Apps SDK",
        description:
          "Learn what ChatGPT adds on top of standard MCP Apps.",
        icon: Blocks,
        totalSteps: 7,
        category: "Extensions",
        estimatedMinutes: 4,
      },
    ],
  },
  {
    title: "MCP in Context",
    subtitle: "Compare MCP with tools you already use",
    modules: [
      {
        id: "mcp-vs-cli",
        title: "MCP vs CLI",
        description:
          "When should you use shell commands, and when should you use MCP?",
        icon: Terminal,
        totalSteps: 4,
        category: "Comparisons",
        estimatedMinutes: 2,
      },
      {
        id: "mcp-vs-api",
        title: "MCP vs REST APIs",
        description:
          "See how MCP works with APIs instead of replacing them.",
        icon: Globe,
        totalSteps: 4,
        category: "Comparisons",
        estimatedMinutes: 2,
      },
      {
        id: "mcp-vs-skills",
        title: "MCP vs Skills",
        description:
          "Learn the difference between instructions for an agent and access for an agent.",
        icon: BookOpen,
        totalSteps: 3,
        category: "Comparisons",
        estimatedMinutes: 1,
      },
    ],
  },
];

// Flat list for backward compatibility
export const LEARNING_CONCEPTS: LearningConcept[] = LEARNING_GROUPS.flatMap(
  (g) => g.modules,
);
