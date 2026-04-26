import { ModelDefinition } from "@/shared/types.js";
import { generateId, type UIMessage, type DynamicToolUIPart } from "ai";
import type { MCPPromptResult } from "../chat-input/prompts/mcp-prompts-popover";
import type { SkillResult } from "../chat-input/skills/skill-types";
import azureLogo from "/azure_logo.png";
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
import openrouterLogo from "/openrouter_logo.png";
import moonshotLightLogo from "/moonshot_light.png";
import moonshotDarkLogo from "/moonshot_dark.png";
import zAiLogo from "/z-ai.png";
import minimaxLogo from "/minimax_logo.svg";
import qwenLogo from "/qwen_logo.png";

export const getProviderLogoFromProvider = (
  provider: string,
  themeMode?: "light" | "dark" | "system",
): string | null => {
  switch (provider) {
    case "anthropic":
      return claudeLogo;
    case "azure":
      return azureLogo;
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
    case "custom":
      return null;
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
    case "minimax":
      return minimaxLogo;
    case "qwen":
      return qwenLogo;
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
  return getProviderColorForTheme(provider);
};

export const getProviderColorForTheme = (
  provider: string,
  themeMode?: "light" | "dark" | "system",
) => {
  const resolveThemeClasses = (lightClasses: string, darkClasses: string) => {
    if (themeMode === "light") return lightClasses;
    if (themeMode === "dark") return darkClasses;
    return `${lightClasses} dark:${darkClasses}`;
  };

  switch (provider) {
    case "anthropic":
      return resolveThemeClasses("text-orange-600", "text-orange-400");
    case "openai":
      return resolveThemeClasses("text-green-600", "text-green-400");
    case "deepseek":
      return resolveThemeClasses("text-blue-600", "text-blue-400");
    case "google":
      return resolveThemeClasses("text-red-600", "text-red-400");
    case "mistral":
      return resolveThemeClasses("text-orange-500", "text-orange-400");
    case "ollama":
      return resolveThemeClasses("text-gray-600", "text-gray-400");
    case "xai":
      return resolveThemeClasses("text-purple-600", "text-purple-400");
    case "azure":
      return resolveThemeClasses("text-purple-600", "text-purple-400");
    case "custom":
      return "bg-gradient-to-br from-teal-500 to-cyan-600";
    case "moonshotai":
      return resolveThemeClasses("text-cyan-600", "text-cyan-400");
    case "z-ai":
      return resolveThemeClasses("text-indigo-600", "text-indigo-400");
    case "minimax":
      return resolveThemeClasses("text-pink-600", "text-pink-400");
    case "qwen":
      return resolveThemeClasses("text-yellow-600", "text-yellow-400");
    case "meta":
      return resolveThemeClasses("text-blue-500", "text-blue-400");
    default:
      return resolveThemeClasses("text-blue-600", "text-blue-400");
  }
};

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant with access to MCP tools.";

/** Match ChatTabV2 non-minimal composer placeholder (hosted / full chat UI). */
export const DEFAULT_CHAT_COMPOSER_PLACEHOLDER = `Ask something… Use Slash "/" commands for Skills & MCP prompts`;

/** Match ChatTabV2 minimalMode / compact composer (e.g. overlays, narrow NUX). */
export const MINIMAL_CHAT_COMPOSER_PLACEHOLDER = "Message…";

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

export interface FormattedError {
  message: string;
  details?: string;
  code?: string;
  statusCode?: number;
  isRetryable?: boolean;
  isMCPJamPlatformError?: boolean;
}

const MCPJAM_PLATFORM_CODES = [
  "mcpjam_rate_limit",
  "mcpjam_api_error",
  "mcpjam_config_error",
];

const MCPJAM_RATE_LIMIT_CODE = "mcpjam_rate_limit";
const MCPJAM_MODEL_LIMIT_PATTERN = /mcpjam[\w\s-]*model limit/i;

const normalizeDetails = (details: unknown): string | undefined => {
  if (details == null) return undefined;
  if (typeof details === "string") return details;

  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
};

const lowercaseFirst = (value: string) =>
  value.length > 0 ? value[0].toLowerCase() + value.slice(1) : value;

const collectStringValues = (
  value: unknown,
  strings: string[] = [],
  seen = new WeakSet<object>(),
): string[] => {
  if (typeof value === "string") {
    strings.push(value);
    return strings;
  }

  if (!value || typeof value !== "object") {
    return strings;
  }

  if (seen.has(value)) {
    return strings;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, strings, seen);
    }
    return strings;
  }

  for (const item of Object.values(value)) {
    collectStringValues(item, strings, seen);
  }

  return strings;
};

const formatRetryAfter = (retryAfter: unknown): string | null => {
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter)) {
    return null;
  }

  const minutes = Math.ceil(retryAfter / 60000);
  if (minutes < 1) {
    return null;
  }

  return `try again in ${minutes} minute${minutes === 1 ? "" : "s"}`;
};

const extractRetryPhrase = (...values: Array<unknown>): string | null => {
  for (const value of values.flatMap((item) => collectStringValues(item))) {
    const sentence = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /try again/i.test(line));

    if (!sentence) continue;

    const match = sentence.match(
      /\btry again(?:\s+(?:in|after)\s+[^.。,;}\]"'\n]+|\s+(?:tomorrow|later))?/i,
    );

    if (!match?.[0]) continue;

    return lowercaseFirst(match[0].trim().replace(/[.。]+$/, ""));
  }

  return null;
};

const isMCPJamModelLimit = (
  code: unknown,
  message: unknown,
  details?: unknown,
) => {
  if (code === MCPJAM_RATE_LIMIT_CODE) return true;
  if (typeof message === "string" && MCPJAM_MODEL_LIMIT_PATTERN.test(message)) {
    return true;
  }
  if (typeof details === "string" && MCPJAM_MODEL_LIMIT_PATTERN.test(details)) {
    return true;
  }

  return false;
};

const formatMCPJamModelLimit = (
  retryPhrase: string | null,
): FormattedError => ({
  code: MCPJAM_RATE_LIMIT_CODE,
  message: retryPhrase
    ? `Add your own API key under LLM Providers in Settings to continue now, or ${retryPhrase}.`
    : "Add your own API key under LLM Providers in Settings to continue now, or wait until your daily limit resets.",
  isRetryable: false,
  isMCPJamPlatformError: true,
});

export function formatErrorMessage(error: unknown): FormattedError | null {
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

  // Try to parse as JSON to extract structured error
  try {
    const parsed = JSON.parse(errorString);
    if (parsed && typeof parsed === "object") {
      // Handle structured error with code
      const code = parsed.code;
      const message = parsed.error || parsed.message || "An error occurred";
      const details = normalizeDetails(parsed.details);

      if (isMCPJamModelLimit(code, message, details)) {
        return formatMCPJamModelLimit(
          formatRetryAfter(parsed.retryAfter) ??
            extractRetryPhrase(parsed.details, message),
        );
      }

      return {
        message,
        details,
        code,
        statusCode: parsed.statusCode,
        isRetryable: parsed.isRetryable,
        isMCPJamPlatformError: code
          ? MCPJAM_PLATFORM_CODES.includes(code)
          : false,
      };
    }
  } catch {
    // Return as-is
  }

  if (isMCPJamModelLimit(undefined, errorString)) {
    return formatMCPJamModelLimit(extractRetryPhrase(errorString));
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

/**
 * Builds UIMessages that simulate the LLM calling loadSkill tool.
 * Creates assistant messages with tool invocations instead of user messages.
 */
export function buildSkillToolMessages(
  skillResults: SkillResult[],
): UIMessage[] {
  const messages: UIMessage[] = [];

  for (const skill of skillResults) {
    if (!skill.content) continue;

    const toolCallId = `skill-load-${skill.name}-${generateId()}`;

    // Format output to match server-side loadSkill response
    const skillOutput = `# Skill: ${skill.name}\n\n${skill.content}`;

    // Build parts array
    const parts: UIMessage["parts"] = [];

    // Add loadSkill tool part
    const loadSkillPart: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolCallId,
      toolName: "loadSkill",
      state: "output-available",
      input: { name: skill.name },
      output: skillOutput,
    };
    parts.push(loadSkillPart);

    // Add readSkillFile parts for selected files
    if (skill.selectedFiles && skill.selectedFiles.length > 0) {
      for (const file of skill.selectedFiles) {
        const fileToolCallId = `skill-file-${generateId()}`;

        const readFilePart: DynamicToolUIPart = {
          type: "dynamic-tool",
          toolCallId: fileToolCallId,
          toolName: "readSkillFile",
          state: "output-available",
          input: { name: skill.name, path: file.path },
          output: `# File: ${file.path}\n\n\`\`\`\n${file.content}\n\`\`\``,
        };
        parts.push(readFilePart);
      }
    }

    // Create assistant message with tool invocations
    messages.push({
      id: `assistant-skill-${skill.name}-${generateId()}`,
      role: "assistant",
      parts,
    });
  }

  return messages;
}

/** Deep-clone UI messages for seeding compare columns or restoring threads. */
export function cloneUiMessages(messages: UIMessage[]): UIMessage[] {
  return structuredClone(messages);
}
