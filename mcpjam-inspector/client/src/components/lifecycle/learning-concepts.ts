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
}

export const LEARNING_CONCEPTS: LearningConcept[] = [
  {
    id: "why-mcp",
    title: "Why MCP?",
    description:
      "Understand why AI needs a universal protocol — from isolated LLMs through tool calling and agents to the N×M problem MCP solves.",
    icon: Lightbulb,
    totalSteps: 7,
    category: "Concepts",
  },
  {
    id: "what-is-mcp",
    title: "What is MCP?",
    description:
      "Understand the Model Context Protocol architecture — how host applications, clients, servers, and resources connect to give AI access to the world.",
    icon: Network,
    totalSteps: 8,
    category: "Fundamentals",
  },
  {
    id: "mcp-lifecycle",
    title: "MCP Lifecycle",
    description:
      "Learn how MCP connections are established, used, and shut down — from initialization through operation to graceful shutdown.",
    icon: GitBranch,
    totalSteps: 5,
    category: "Protocol",
  },
  {
    id: "mcp-tools",
    title: "MCP Tools",
    description:
      "Learn how MCP Tools let AI models invoke actions on external systems — discovery, invocation, result types, error handling, and security.",
    icon: Wrench,
    totalSteps: 5,
    category: "Protocol",
  },
  {
    id: "mcp-resources",
    title: "MCP Resources",
    description:
      "Understand MCP Resources — application-controlled data that gives AI context. URIs, templates, subscriptions, and content types.",
    icon: Database,
    totalSteps: 5,
    category: "Protocol",
  },
  {
    id: "mcp-prompts",
    title: "MCP Prompts",
    description:
      "Discover MCP Prompts — user-controlled templates that guide AI interactions. Arguments, messages, and slash commands.",
    icon: MessageSquare,
    totalSteps: 5,
    category: "Protocol",
  },
  {
    id: "mcp-apps",
    title: "MCP Apps",
    description:
      "Learn how MCP servers deliver rich, interactive HTML user interfaces into host apps — ui:// resources, tool linkage, and postMessage.",
    icon: AppWindow,
    totalSteps: 7,
    category: "Extensions",
  },
  {
    id: "apps-sdk",
    title: "OpenAI Apps SDK",
    description:
      "Learn how the Apps SDK layers ChatGPT-specific features (window.openai) on top of standard MCP Apps — dual-protocol support, tool metadata, and deployment.",
    icon: Blocks,
    totalSteps: 7,
    category: "Extensions",
  },
  {
    id: "mcp-vs-cli",
    title: "MCP vs CLI",
    description:
      "Compare MCP with CLI tools — when speed matters vs. when governance matters. Understand the tradeoffs for single-user vs. multi-user scenarios.",
    icon: Terminal,
    totalSteps: 4,
    category: "Comparisons",
  },
  {
    id: "mcp-vs-api",
    title: "MCP vs REST APIs",
    description:
      "Understand how MCP relates to REST APIs — stateless vs. stateful, static vs. dynamic discovery, and why MCP wraps APIs rather than replacing them.",
    icon: Globe,
    totalSteps: 4,
    category: "Comparisons",
  },
  {
    id: "mcp-vs-skills",
    title: "MCP vs Skills",
    description:
      "Learn why Skills and MCP are complementary — Skills teach agents how to think, MCP gives them access to act.",
    icon: BookOpen,
    totalSteps: 3,
    category: "Comparisons",
  },
];
