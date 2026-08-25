import type { CallToolResult } from "@modelcontextprotocol/client";

/**
 * Which halves of a tool result a host relays to a widget that called a tool.
 *
 * A tool result has two halves — the `content` block array and
 * `structuredContent` (MCP spec, "Tool Result" under server/tools) — and real
 * hosts differ in what they forward. Cursor 3.4 strips `structuredContent`, so
 * a widget reading it breaks silently there while working everywhere else.
 *
 * This is the WIDGET axis, deliberately distinct from the two mcpjam already
 * models: `modelVisibleMcpToolResults` (what the model sees) and
 * `mcpToolResultImageRendering` (what mcpjam's own chat UI draws). Same tool
 * result, three different pipes.
 *
 * Absent or `true` means forwarded, matching the omit-when-absent discipline
 * every probe knob uses: only an explicit `false` drops anything.
 */
export interface ToolResultPolicy {
  structuredContent?: boolean;
  content?: {
    text?: boolean;
    image?: boolean;
    audio?: boolean;
    resource?: boolean;
    resourceLink?: boolean;
  };
}

/**
 * Spec `ContentBlock.type` values mapped to their policy key. `resource_link`
 * is the only one whose wire name differs from its camelCase config key.
 */
const CONTENT_TYPE_TO_POLICY_KEY: Record<
  string,
  keyof NonNullable<ToolResultPolicy["content"]>
> = {
  text: "text",
  image: "image",
  audio: "audio",
  resource: "resource",
  resource_link: "resourceLink",
};

/**
 * Drop the halves of `result` this host does not forward to widgets.
 *
 * Returns the ORIGINAL object when nothing is dropped, so the common case
 * costs no allocation and referential equality is preserved for consumers
 * that memoize on it.
 *
 * A block whose `type` is not in the spec's five kinds is always kept: the
 * policy cannot describe it, and silently swallowing an unknown block would
 * make a future spec addition look like host breakage.
 */
export function applyToolResultPolicy<T extends Partial<CallToolResult>>(
  result: T,
  policy: ToolResultPolicy | null | undefined,
): T {
  if (!policy || !result || typeof result !== "object") return result;

  const dropStructured =
    policy.structuredContent === false && "structuredContent" in result;

  const contentPolicy = policy.content;
  const blocks = Array.isArray(result.content) ? result.content : null;
  const filteredBlocks =
    contentPolicy && blocks
      ? blocks.filter((block) => {
          const type = (block as { type?: unknown } | null)?.type;
          if (typeof type !== "string") return true;
          const key = CONTENT_TYPE_TO_POLICY_KEY[type];
          if (key === undefined) return true;
          return contentPolicy[key] !== false;
        })
      : null;

  const dropsBlocks =
    filteredBlocks !== null && blocks !== null &&
    filteredBlocks.length !== blocks.length;

  if (!dropStructured && !dropsBlocks) return result;

  const next = { ...result } as T;
  if (dropStructured) {
    delete (next as { structuredContent?: unknown }).structuredContent;
  }
  if (dropsBlocks) {
    (next as { content?: unknown }).content = filteredBlocks;
  }
  return next;
}

/**
 * Which browser storage APIs a widget can reach inside the host's sandbox.
 *
 * NOT an MCP concept — the MCP Apps spec's `sandbox` defines only
 * `permissions` and `csp`. This is an observed consequence of the sandboxed
 * iframe the spec does mandate, measured because widgets that persist state
 * break silently on a host that blocks it.
 *
 * Named and exported because the same shape crosses five seams (profile
 * type, widget-host projection, renderer, sandboxed-iframe prop, modal
 * prop). Adding a fourth API — cookies, OPFS — must be a one-line change,
 * not five edits in lockstep where a missed copy drops the field silently.
 *
 * Absent or `true` means available; only an explicit `false` blocks.
 */
export interface BrowserStoragePolicy {
  localStorage?: boolean;
  sessionStorage?: boolean;
  indexedDB?: boolean;
}
