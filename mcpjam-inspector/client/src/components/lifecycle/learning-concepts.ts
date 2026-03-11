import { GitBranch, type LucideIcon } from "lucide-react";

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
    id: "mcp-lifecycle",
    title: "MCP Lifecycle",
    description:
      "Learn how MCP connections are established, used, and shut down — from initialization through operation to graceful shutdown.",
    icon: GitBranch,
    totalSteps: 7,
    category: "Protocol",
  },
];
