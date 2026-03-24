import { GitBranch, Network, type LucideIcon } from "lucide-react";

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
];
