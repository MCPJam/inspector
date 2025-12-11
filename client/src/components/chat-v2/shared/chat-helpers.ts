import { ModelDefinition } from "@/shared/types.js";
import { generateId, type UIMessage } from "ai";
import type { MCPPromptResult } from "../chat-input/prompts/mcp-prompts-popover";
import claudeLogo from "/claude_logo.png";
import openaiLogo from "/openai_logo.png";
import deepseekLogo from "/deepseek_logo.svg";
import googleLogo from "/google_logo.png";
import metaLogo from "/meta_logo.svg";
import mistralLogo from "/mistral_logo.png";
import ollamaLogo from "/ollama_logo.svg";
import ollamaDarkLogo from "/ollama_dark.png";
import grokLightLogo from "/grok_light.svg";
import grokDarkLogo from "/grok_dark.png";
import litellmLogo from "/litellm_logo.png";
import openrouterLogo from "/openrouter_logo.png";
import moonshotLightLogo from "/moonshot_light.png";
import moonshotDarkLogo from "/moonshot_dark.png";
import zAiLogo from "/z-ai.png";

export const getProviderLogoFromProvider = (
  provider: string,
  themeMode?: "light" | "dark" | "system",
): string | null => {
  switch (provider) {
    case "anthropic":
      return claudeLogo;
    case "openai":
      return openaiLogo;
    case "deepseek":
      return deepseekLogo;
    case "google":
      return googleLogo;
    case "mistral":
      return mistralLogo;
    case "ollama":
      // Return dark logo when in dark mode
      if (themeMode === "dark") {
        return ollamaDarkLogo;
      }
      // For system theme, check if document has dark class
      if (themeMode === "system" && typeof document !== "undefined") {
        const isDark = document.documentElement.classList.contains("dark");
        return isDark ? ollamaDarkLogo : ollamaLogo;
      }
      // Default to light logo for light mode or when themeMode is not provided
      return ollamaLogo;
    case "meta":
      return metaLogo;
    case "xai":
      if (themeMode === "dark") {
        return grokDarkLogo;
      }
      if (themeMode === "system" && typeof document !== "undefined") {
        const isDark = document.documentElement.classList.contains("dark");
        return isDark ? grokDarkLogo : grokLightLogo;
      }
      return grokLightLogo;
    case "litellm":
      return litellmLogo;
    case "openrouter":
      return openrouterLogo;
    case "moonshotai":
      if (themeMode === "dark") {
        return moonshotDarkLogo;
      }
      if (themeMode === "system" && typeof document !== "undefined") {
        const isDark = document.documentElement.classList.contains("dark");
        return isDark ? moonshotDarkLogo : moonshotLightLogo;
      }
      return moonshotLightLogo;
    case "z-ai":
      return zAiLogo;
    default:
      return null;
  }
};

export const getProviderLogoFromModel = (
  model: ModelDefinition,
  themeMode?: "light" | "dark" | "system",
): string | null => {
  return getProviderLogoFromProvider(model.provider, themeMode);
};

export const getProviderColor = (provider: string) => {
  switch (provider) {
    case "anthropic":
      return "text-orange-600 dark:text-orange-400";
    case "openai":
      return "text-green-600 dark:text-green-400";
    case "deepseek":
      return "text-blue-600 dark:text-blue-400";
    case "google":
      return "text-red-600 dark:text-red-400";
    case "mistral":
      return "text-orange-500 dark:text-orange-400";
    case "ollama":
      return "text-gray-600 dark:text-gray-400";
    case "xai":
      return "text-purple-600 dark:text-purple-400";
    case "litellm":
      return "bg-gradient-to-br from-blue-500 to-purple-600";
    case "moonshotai":
      return "text-cyan-600 dark:text-cyan-400";
    case "z-ai":
      return "text-indigo-600 dark:text-indigo-400";
    case "meta":
      return "text-blue-500 dark:text-blue-400";
    default:
      return "text-blue-600 dark:text-blue-400";
  }
};

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant with access to MCP tools.";

export const STARTER_PROMPTS: Array<{ label: string; text: string }> = [
  {
    label: "Show me connected tools",
    text: "List my connected MCP servers and their available tools.",
  },
  {
    label: "Suggest an automation",
    text: "Suggest an automation I can build with my current MCP setup.",
  },
  {
    label: "Summarize recent activity",
    text: "Summarize the most recent activity across my MCP servers.",
  },
];

export function formatErrorMessage(
  error: unknown,
): { message: string; details?: string } | null {
  if (!error) return null;

  let errorString: string;
  if (typeof error === "string") {
    errorString = error;
  } else if (error instanceof Error) {
    errorString = error.message;
  } else {
    try {
      errorString = JSON.stringify(error);
    } catch {
      errorString = String(error);
    }
  }

  // Try to parse as JSON to extract message and details
  try {
    const parsed = JSON.parse(errorString);
    if (parsed && typeof parsed === "object" && parsed.message) {
      return {
        message: parsed.message,
        details: parsed.details,
      };
    }
  } catch {
    // Return as-is
  }

  return { message: errorString };
}

export const VALID_MESSAGE_ROLES: UIMessage["role"][] = [
  "system",
  "user",
  "assistant",
];

export function extractPromptMessageText(content: any): string | null {
  if (!content) return null;
  if (Array.isArray(content)) {
    const combined = content
      .map((block) =>
        block?.text && typeof block.text === "string" ? block.text : "",
      )
      .filter(Boolean)
      .join("\n")
      .trim();
    return combined || null;
  }
  if (typeof content === "object" && typeof content.text === "string") {
    const text = content.text.trim();
    return text ? text : null;
  }
  if (typeof content === "string") {
    const text = content.trim();
    return text ? text : null;
  }
  return null;
}

export function buildMcpPromptMessages(
  promptResults: MCPPromptResult[],
): UIMessage[] {
  const messages: UIMessage[] = [];

  for (const result of promptResults) {
    const promptMessages = result.result?.content?.messages;
    if (!Array.isArray(promptMessages)) continue;

    promptMessages.forEach((promptMessage: any, index: number) => {
      const text = extractPromptMessageText(promptMessage?.content);
      if (!text) return;

      const role = VALID_MESSAGE_ROLES.includes(promptMessage?.role)
        ? (promptMessage.role as UIMessage["role"])
        : ("user" as UIMessage["role"]);

      messages.push({
        id: `mcp-prompt-${result.namespacedName}-${index}-${generateId()}`,
        role,
        parts: [
          {
            type: "text",
            text: `[${result.namespacedName}] ${text}`,
          },
        ],
      });
    });
  }

  return messages;
}
