import { generateId, type UIMessage, type DynamicToolUIPart } from "ai";
import type { MCPPromptResult } from "../chat-input/prompts/mcp-prompts-popover";
import type { SkillResult } from "../chat-input/skills/skill-types";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant with access to MCP tools.";

/** Match ChatTabV2 non-minimal composer placeholder (hosted / full chat UI). */
export const DEFAULT_CHAT_COMPOSER_PLACEHOLDER = `Ask something… Use Slash "/" commands for Skills & MCP prompts`;

/** Match ChatTabV2 minimalMode / compact composer (e.g. overlays, narrow NUX). */
export const MINIMAL_CHAT_COMPOSER_PLACEHOLDER = "Message…";

// Starter prompts must be answerable from the model's own tool list — the
// playground/chat model only sees the selected servers' model-visible tools,
// so prompts that need meta-data (server inventory, activity logs) always
// dead-end in "I don't have access to that".
export const STARTER_PROMPTS: Array<{ label: string; text: string }> = [
  {
    label: "What can this server do?",
    text: "What can this server do?",
  },
  {
    label: "What tools can I use?",
    text: "What tools can I use?",
  },
  {
    label: "Give me example prompts to try",
    text: "Give me example prompts to try",
  },
];

export interface FormattedError {
  message: string;
  details?: string;
  code?: string;
  statusCode?: number;
  isRetryable?: boolean;
  isMCPJamPlatformError?: boolean;
  canTopUp?: boolean;
  /**
   * `true` when the server has paused this account from spending credits or
   * starting a new top-up. The user cannot self-serve out of this state —
   * the UI should render a contact-support message rather than any retry or
   * top-up affordance.
   */
  walletLocked?: boolean;
  /**
   * Sub-classification of a rate-limit error.
   *  - `"total"`: the user's daily credit budget is exhausted (the existing
   *    happy-path rate-limit error; pairs with `canTopUp` to drive the CTA).
   *  - `"concurrency"`: another credit-funded chat is still in flight; the
   *    user just needs to wait a few seconds and retry. No top-up CTA.
   */
  limitKind?: "total" | "concurrency";
  /**
   * Raw `retryAfter` in milliseconds, surfaced for UIs that need
   * second-level granularity (the existing `formatRetryAfter` rounds up to
   * minutes). Used by the concurrency-throttle banner.
   */
  retryAfterMs?: number;
}

const USER_RATE_LIMIT_CODE = "user_rate_limit";
const MCPJAM_RATE_LIMIT_CODE = "mcpjam_rate_limit";
const RATE_LIMIT_CODES = new Set<string>([
  USER_RATE_LIMIT_CODE,
  MCPJAM_RATE_LIMIT_CODE,
]);

const MCPJAM_PLATFORM_CODES = [
  USER_RATE_LIMIT_CODE,
  MCPJAM_RATE_LIMIT_CODE,
  "mcpjam_api_error",
  "mcpjam_config_error",
];
const MCPJAM_MODEL_LIMIT_PATTERN = /mcpjam[\w\s-]*model limit/i;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/**
 * Plain-English copy for the connection failures a chat turn can hit.
 *
 * The server already sends an accurate `code` (`WebRouteError` → `webError`),
 * but the raw `message` beside it is written for us, not for the person in the
 * playground: a failed OAuth refresh renders as "Authorization failed" and an
 * unreachable server as "fetch failed". Both leave the user with no idea what
 * to do next. Translate the codes we understand and leave everything else on
 * the existing verbatim path.
 *
 * The raw message is preserved as `details`, so the "More details" collapsible
 * still shows exactly what the server said.
 */
const describeServer = (serverName: string | undefined) =>
  serverName ? `“${serverName}”` : "the MCP server";

const humanizeConnectionError = (
  code: unknown,
  rawDetails: unknown,
): string | null => {
  if (typeof code !== "string") return null;

  const detailBag =
    rawDetails && typeof rawDetails === "object"
      ? (rawDetails as Record<string, unknown>)
      : undefined;
  const serverName =
    typeof detailBag?.serverName === "string" && detailBag.serverName.length > 0
      ? detailBag.serverName
      : undefined;
  const server = describeServer(serverName);

  // An expired/revoked OAuth grant is flagged by the backend regardless of the
  // code it rides in on (see hosted-oauth-refresh.ts), so check it first.
  if (
    detailBag?.refreshTokenInvalid === true ||
    detailBag?.oauthRequired === true
  ) {
    return `Your connection to ${server} has expired. Reconnect it to keep chatting.`;
  }

  switch (code) {
    case "SERVER_UNREACHABLE":
      return `Couldn't reach ${server}. It may be offline or blocking the connection.`;
    case "TIMEOUT":
      return `${serverName ? `“${serverName}”` : "The MCP server"} took too long to respond.`;
    // UNAUTHORIZED / FORBIDDEN are NOT unambiguous: the same codes carry
    // MCPJam's own auth failures (expired session, missing bearer via
    // `assertBearerToken`) and project-permission denials, neither of which is
    // the user's MCP server misbehaving. Sending someone to reconnect a server
    // that is working fine is worse than the jargon this replaces, so only
    // rewrite when the payload actually names a server. Everything else falls
    // through to the verbatim path.
    case "UNAUTHORIZED":
      if (!serverName) return null;
      return `${server} rejected the connection. Reconnect it to refresh your access.`;
    case "FORBIDDEN":
      if (!serverName) return null;
      return `${server} refused this request. Your access may not cover the tools this chat needs.`;
    default:
      return null;
  }
};

/**
 * Build the "More details" payload for a humanized banner.
 *
 * The banner no longer leads with the server's own wording, so that wording has
 * to survive here or it is lost outright. Fold it into the structured details
 * rather than replacing them (a bare `details ?? message` drops one or the
 * other), and keep the result JSON-shaped when the server sent an object so
 * `ErrorBox` still renders it through `JsonEditor` instead of a flat `<pre>`.
 */
const preserveServerMessageInDetails = (
  message: string,
  rawDetails: unknown,
): string | undefined => {
  if (rawDetails == null) return message;

  if (
    typeof rawDetails === "object" &&
    !Array.isArray(rawDetails) &&
    // `serverMessage` (not `message`) so a details bag that already carries its
    // own `message` key can't silently swallow the server's wording.
    !("serverMessage" in (rawDetails as Record<string, unknown>))
  ) {
    return normalizeDetails({
      ...(rawDetails as Record<string, unknown>),
      serverMessage: message,
    });
  }

  const normalized = normalizeDetails(rawDetails);
  if (!normalized) return message;
  return normalized.includes(message)
    ? normalized
    : `${message}\n\n${normalized}`;
};

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

/** `1 server`, `0 servers`. Exported so other count strips reuse this instead
 *  of re-deriving the same `s` suffix. */
export const pluralize = (value: number, unit: string) =>
  `${value} ${unit}${value === 1 ? "" : "s"}`;

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

const formatRetryMinutes = (minutes: number): string | null => {
  if (!Number.isFinite(minutes) || minutes < 1) return null;

  if (minutes < MINUTES_PER_HOUR) {
    return `try again in ${pluralize(minutes, "minute")}`;
  }

  if (minutes >= 20 * MINUTES_PER_HOUR && minutes < 36 * MINUTES_PER_HOUR) {
    return "try again tomorrow";
  }

  if (minutes < MINUTES_PER_DAY) {
    const hours = Math.floor(minutes / MINUTES_PER_HOUR);
    const remainingMinutes = minutes % MINUTES_PER_HOUR;
    const hourText = pluralize(hours, "hour");

    if (remainingMinutes < 5) {
      return `try again in ${hourText}`;
    }

    return `try again in ${hourText} ${pluralize(remainingMinutes, "minute")}`;
  }

  const days = Math.max(2, Math.round(minutes / MINUTES_PER_DAY));
  return `try again in about ${pluralize(days, "day")}`;
};

const formatRetryAfter = (retryAfter: unknown): string | null => {
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter)) {
    return null;
  }

  return formatRetryMinutes(Math.ceil(retryAfter / 60000));
};

const normalizeRetryPhrase = (phrase: string): string => {
  const normalized = lowercaseFirst(phrase.trim().replace(/[.。]+$/, ""));
  const durationMatch = normalized.match(
    /\btry again\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i,
  );

  if (!durationMatch) {
    return normalized;
  }

  const value = Number(durationMatch[1]);
  const unit = durationMatch[2]?.toLowerCase();
  if (!Number.isFinite(value) || !unit) {
    return normalized;
  }

  let minutes: number;
  if (
    unit.startsWith("ms") ||
    unit.startsWith("msec") ||
    unit.startsWith("millisecond")
  ) {
    minutes = Math.ceil(value / 60000);
  } else if (unit === "s" || unit.startsWith("sec")) {
    minutes = Math.ceil(value / 60);
  } else if (unit === "m" || unit.startsWith("min")) {
    minutes = Math.ceil(value);
  } else if (unit === "h" || unit.startsWith("hr") || unit.startsWith("hour")) {
    minutes = Math.ceil(value * MINUTES_PER_HOUR);
  } else {
    minutes = Math.ceil(value * MINUTES_PER_DAY);
  }

  return formatRetryMinutes(minutes) ?? normalized;
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

    return normalizeRetryPhrase(match[0]);
  }

  return null;
};

const isMCPJamModelLimit = (
  code: unknown,
  message: unknown,
  details?: unknown,
) => {
  if (typeof code === "string" && RATE_LIMIT_CODES.has(code)) return true;
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
  extras?: {
    code?: string;
    canTopUp?: boolean;
    limitKind?: "total" | "concurrency";
    retryAfterMs?: number;
  },
): FormattedError => ({
  code: extras?.code ?? MCPJAM_RATE_LIMIT_CODE,
  message: retryPhrase
    ? `Add your own API key in Settings > LLM Providers to keep chatting now, or ${retryPhrase}.`
    : "Add your own API key in Settings > LLM Providers to keep chatting now, or add credits from Billing.",
  isRetryable: false,
  isMCPJamPlatformError: true,
  ...(extras?.canTopUp !== undefined ? { canTopUp: extras.canTopUp } : {}),
  ...(extras?.limitKind !== undefined ? { limitKind: extras.limitKind } : {}),
  ...(extras?.retryAfterMs !== undefined
    ? { retryAfterMs: extras.retryAfterMs }
    : {}),
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
      const canTopUp =
        typeof parsed.canTopUp === "boolean" ? parsed.canTopUp : undefined;
      const walletLocked =
        typeof parsed.walletLocked === "boolean"
          ? parsed.walletLocked
          : undefined;
      const limitKind =
        parsed.limitKind === "total" || parsed.limitKind === "concurrency"
          ? parsed.limitKind
          : undefined;
      // `retryAfterMs` is only meaningful for the concurrency banner (which
      // needs second-level granularity). The existing rate-limit copy
      // already embeds a humanized retry phrase in `message`, so emitting
      // raw ms there would duplicate information AND retroactively widen
      // the FormattedError shape that legacy callers / tests assert via
      // `toEqual`. Gate strictly on `limitKind === "concurrency"`.
      const retryAfterMs =
        limitKind === "concurrency" &&
        typeof parsed.retryAfter === "number" &&
        Number.isFinite(parsed.retryAfter)
          ? parsed.retryAfter
          : undefined;

      if (isMCPJamModelLimit(code, message, details)) {
        return formatMCPJamModelLimit(
          formatRetryAfter(parsed.retryAfter) ??
            extractRetryPhrase(parsed.details, message),
          {
            code: typeof code === "string" ? code : undefined,
            canTopUp,
            limitKind,
            retryAfterMs,
          },
        );
      }

      // Connection failures get human copy; the server's own wording stays
      // reachable under "More details" rather than leading the banner. Copy
      // only — `isRetryable` and every other field keep whatever the server
      // sent, so the banner's affordances are unchanged.
      const humanized = humanizeConnectionError(code, parsed.details);
      if (humanized) {
        return {
          message: humanized,
          details: preserveServerMessageInDetails(message, parsed.details),
          code,
          statusCode: parsed.statusCode,
          isRetryable: parsed.isRetryable,
          isMCPJamPlatformError: code
            ? MCPJAM_PLATFORM_CODES.includes(code)
            : false,
        };
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
        ...(canTopUp !== undefined ? { canTopUp } : {}),
        ...(walletLocked !== undefined ? { walletLocked } : {}),
        ...(limitKind !== undefined ? { limitKind } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
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

    // Format output to match server-side loadSkill response.
    //
    // `toolOutput` is the escape hatch for a SERVER-SERVED skill (SEP-2640):
    // its `loadSkill` result is the shared origin banner plus the body, and the
    // banner already carries the `# Skill: <ref>` heading. Re-prefixing here
    // would produce a message the tool could never have returned, breaking the
    // "injection is indistinguishable from a real tool result" invariant this
    // whole function exists to maintain.
    const skillOutput =
      skill.toolOutput ?? `# Skill: ${skill.name}\n\n${skill.content}`;

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

/** First text part of a user message, used to seed prompt previews. */
export function extractUserMessageText(message: UIMessage): string {
  const parts = (message.parts ?? []) as Array<{
    type?: string;
    text?: unknown;
  }>;
  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string") {
      return part.text;
    }
  }
  return "";
}
