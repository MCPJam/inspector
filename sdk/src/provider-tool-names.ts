/**
 * Provider-safe tool names on the wire.
 *
 * MCP allows tool names such as `cart.add` or `files/read`, but Anthropic,
 * Bedrock and OpenAI answer a 400 before the model runs for any tool name
 * with characters outside `[a-zA-Z0-9_-]`, and 64 characters is the
 * shortest of their length limits. The names are rewritten only in the
 * request a provider sees and restored in its reply, so tool execution,
 * transcripts and eval matching keep the server's own names.
 */
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

const PROVIDER_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_TOOL_NAME_LENGTH = 64;

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];
type CallOptions = Parameters<
  NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"];

export interface ToolNameAliases {
  /** The name the provider sees for `name`. */
  toWire(name: string): string;
  /** The original name for a name the provider sent back. */
  fromWire(name: string): string;
}

function isProviderSafeToolName(name: string): boolean {
  return PROVIDER_TOOL_NAME.test(name);
}

function sanitizeToolName(name: string): string {
  return (
    name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME_LENGTH) ||
    "tool"
  );
}

/**
 * Alias every unsafe name in `names` to a safe one that collides with no
 * other name in the set. Unsafe names are processed sorted, so the same set
 * yields the same aliases on every step of a turn. A name outside the set
 * (an old call in history) is sanitized without collision checks: the
 * provider only needs it well-formed.
 */
export function createToolNameAliases(
  names: Iterable<string>
): ToolNameAliases {
  const unique = [...new Set(names)];
  const taken = new Set(unique.filter(isProviderSafeToolName));
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();
  for (const name of unique.filter((n) => !isProviderSafeToolName(n)).sort()) {
    const base = sanitizeToolName(name);
    let alias = base;
    for (let n = 2; taken.has(alias); n++) {
      const suffix = `_${n}`;
      alias = base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length) + suffix;
    }
    taken.add(alias);
    toWire.set(name, alias);
    fromWire.set(alias, name);
  }
  return {
    toWire: (name) =>
      toWire.get(name) ??
      (isProviderSafeToolName(name) ? name : sanitizeToolName(name)),
    fromWire: (name) => fromWire.get(name) ?? name,
  };
}

/** Rename the `toolName` of a tool-call / tool-result / tool-input part. */
export function renameToolNamePart<T>(
  part: T,
  rename: (name: string) => string
): T {
  if (!part || typeof part !== "object" || !("toolName" in part)) return part;
  const { toolName } = part as { toolName: unknown };
  if (typeof toolName !== "string") return part;
  const renamed = rename(toolName);
  return renamed === toolName ? part : { ...part, toolName: renamed };
}

/** Rename tool names inside message content; unchanged messages keep identity. */
export function renameToolNamesInMessages<
  T extends { role: string; content: unknown },
>(messages: T[], rename: (name: string) => string): T[] {
  let changed = false;
  const next = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content = message.content.map((part) =>
      renameToolNamePart(part, rename)
    );
    if (
      content.every((part, i) => part === (message.content as unknown[])[i])
    ) {
      return message;
    }
    changed = true;
    return { ...message, content };
  });
  return changed ? next : messages;
}

const aliasesByCall = new WeakMap<CallOptions, ToolNameAliases>();

const providerSafeToolNamesMiddleware: LanguageModelMiddleware = {
  transformParams: async ({ params }) => {
    const aliases = createToolNameAliases(
      (params.tools ?? []).map((tool) => tool.name)
    );
    const tools = params.tools?.map((tool) =>
      tool.type === "function" && !isProviderSafeToolName(tool.name)
        ? { ...tool, name: aliases.toWire(tool.name) }
        : tool
    );
    const toolChoice = renameToolNamePart(params.toolChoice, aliases.toWire);
    const prompt = renameToolNamesInMessages(params.prompt, aliases.toWire);
    if (
      prompt === params.prompt &&
      toolChoice === params.toolChoice &&
      tools?.every((tool, i) => tool === params.tools?.[i]) !== false
    ) {
      return params;
    }
    const next = { ...params, tools, toolChoice, prompt };
    aliasesByCall.set(next, aliases);
    return next;
  },
  wrapGenerate: async ({ doGenerate, params }) => {
    const result = await doGenerate();
    const aliases = aliasesByCall.get(params);
    if (!aliases) return result;
    return {
      ...result,
      content: result.content.map((part) =>
        renameToolNamePart(part, aliases.fromWire)
      ),
    };
  },
  wrapStream: async ({ doStream, params }) => {
    const result = await doStream();
    const aliases = aliasesByCall.get(params);
    if (!aliases) return result;
    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            controller.enqueue(renameToolNamePart(part, aliases.fromWire));
          },
        })
      ),
    };
  },
};

/**
 * Wrap `model` so tool names a provider would reject are aliased on the way
 * out and restored on the way back. A no-op for calls whose names are all
 * already safe.
 */
export function withProviderSafeToolNames(model: WrappableModel) {
  return wrapLanguageModel({
    model,
    middleware: providerSafeToolNamesMiddleware,
  });
}
