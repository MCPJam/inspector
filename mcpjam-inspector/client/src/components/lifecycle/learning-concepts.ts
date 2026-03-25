import { AppWindow, GitBranch, Lightbulb, Network, type LucideIcon } from "lucide-react";

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
    id: "mcp-apps",
    title: "MCP Apps",
    description:
      "Learn how MCP servers deliver rich, interactive HTML user interfaces into host apps — ui:// resources, tool linkage, and postMessage.",
    icon: AppWindow,
    totalSteps: 7,
    category: "Extensions",
  },
];
