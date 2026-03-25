import {
  AppWindow,
  Blocks,
  BookOpen,
  Database,
  FlaskConical,
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
    subtitle: "Understand why MCP exists and how it works",
    modules: [
      {
        id: "why-mcp",
        title: "Why MCP?",
        description:
          "Understand why AI needs a universal protocol — from isolated LLMs through tool calling and agents to the N×M problem MCP solves.",
        icon: Lightbulb,
        totalSteps: 7,
        category: "Concepts",
        estimatedMinutes: 4,
      },
      {
        id: "what-is-mcp",
        title: "What is MCP?",
        description:
          "Understand the Model Context Protocol architecture — how host applications, clients, servers, and resources connect to give AI access to the world.",
        icon: Network,
        totalSteps: 8,
        category: "Fundamentals",
        estimatedMinutes: 6,
      },
    ],
  },
  {
    title: "The Protocol",
    subtitle: "Learn the building blocks of MCP",
    modules: [
      {
        id: "mcp-lifecycle",
        title: "MCP Lifecycle",
        description:
          "Learn how MCP connections are established, used, and shut down — from initialization through operation to graceful shutdown.",
        icon: GitBranch,
        totalSteps: 5,
        category: "Protocol",
        estimatedMinutes: 4,
      },
      {
        id: "mcp-tools",
        title: "MCP Tools",
        description:
          "Learn how MCP Tools let AI models invoke actions on external systems — discovery, invocation, result types, error handling, and security.",
        icon: Wrench,
        totalSteps: 5,
        category: "Protocol",
        estimatedMinutes: 3,
      },
      {
        id: "mcp-resources",
        title: "MCP Resources",
        description:
          "Understand MCP Resources — application-controlled data that gives AI context. URIs, templates, subscriptions, and content types.",
        icon: Database,
        totalSteps: 5,
        category: "Protocol",
        estimatedMinutes: 3,
      },
      {
        id: "mcp-prompts",
        title: "MCP Prompts",
        description:
          "Discover MCP Prompts — user-controlled templates that guide AI interactions. Arguments, messages, and slash commands.",
        icon: MessageSquare,
        totalSteps: 5,
        category: "Protocol",
        estimatedMinutes: 3,
      },
    ],
  },
  {
    title: "Building with MCP",
    subtitle: "See how MCP powers interactive apps",
    modules: [
      {
        id: "mcp-apps",
        title: "MCP Apps",
        description:
          "Learn how MCP servers deliver rich, interactive HTML user interfaces into host apps — ui:// resources, tool linkage, and postMessage.",
        icon: AppWindow,
        totalSteps: 7,
        category: "Extensions",
        estimatedMinutes: 5,
      },
      {
        id: "apps-sdk",
        title: "OpenAI Apps SDK",
        description:
          "Learn how the Apps SDK layers ChatGPT-specific features (window.openai) on top of standard MCP Apps — dual-protocol support, tool metadata, and deployment.",
        icon: Blocks,
        totalSteps: 7,
        category: "Extensions",
        estimatedMinutes: 5,
      },
    ],
  },
  {
    title: "Try MCP",
    subtitle: "Connect to a live server and explore interactively",
    modules: [
      {
        id: "learning-tools",
        title: "Explore Tools",
        description:
          "Connect to a learning server and browse, invoke, and inspect MCP tools in real time.",
        icon: Wrench,
        totalSteps: 1,
        category: "Interactive",
        estimatedMinutes: 5,
      },
      {
        id: "learning-resources",
        title: "Explore Resources",
        description:
          "Browse and read MCP resources from a live learning server — URIs, templates, and content types.",
        icon: Database,
        totalSteps: 1,
        category: "Interactive",
        estimatedMinutes: 5,
      },
      {
        id: "learning-prompts",
        title: "Explore Prompts",
        description:
          "List and execute MCP prompts on a live learning server — arguments, messages, and slash commands.",
        icon: FlaskConical,
        totalSteps: 1,
        category: "Interactive",
        estimatedMinutes: 5,
      },
    ],
  },
  {
    title: "MCP in Context",
    subtitle: "Compare MCP to tools you already know",
    modules: [
      {
        id: "mcp-vs-cli",
        title: "MCP vs CLI",
        description:
          "Compare MCP with CLI tools — when speed matters vs. when governance matters. Understand the tradeoffs for single-user vs. multi-user scenarios.",
        icon: Terminal,
        totalSteps: 4,
        category: "Comparisons",
        estimatedMinutes: 3,
      },
      {
        id: "mcp-vs-api",
        title: "MCP vs REST APIs",
        description:
          "Understand how MCP relates to REST APIs — stateless vs. stateful, static vs. dynamic discovery, and why MCP wraps APIs rather than replacing them.",
        icon: Globe,
        totalSteps: 4,
        category: "Comparisons",
        estimatedMinutes: 3,
      },
      {
        id: "mcp-vs-skills",
        title: "MCP vs Skills",
        description:
          "Learn why Skills and MCP are complementary — Skills teach agents how to think, MCP gives them access to act.",
        icon: BookOpen,
        totalSteps: 3,
        category: "Comparisons",
        estimatedMinutes: 2,
      },
    ],
  },
];

// Flat list for backward compatibility
export const LEARNING_CONCEPTS: LearningConcept[] = LEARNING_GROUPS.flatMap(
  (g) => g.modules,
);
