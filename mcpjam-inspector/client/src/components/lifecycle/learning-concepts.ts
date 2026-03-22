import { BookOpen, GitBranch, type LucideIcon } from "lucide-react";

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
    id: "mcp-101",
    title: "MCP 101",
    description:
      "What is MCP and why does it matter? Learn how this open protocol standardizes the way AI agents connect to tools and data — securely.",
    icon: BookOpen,
    totalSteps: 5,
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
