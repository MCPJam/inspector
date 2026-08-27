/**
 * Fulfilling a model's WebMCP page-tool call.
 *
 * The model names an opaque `page_<8hex>` alias; this resolves it back to the
 * live session and tool it stands for, runs it through the inspector store, and
 * shapes the outcome as MCP-style tool content the chat stream can carry.
 *
 * Every failure resolves rather than throws. A client-fulfilled tool call that
 * never produces a result leaves the turn paused forever waiting on a browser
 * that is not going to answer, so "the page is gone" has to come back as an
 * error RESULT, not an exception.
 */
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import { buildPageToolSnapshot } from "./page-tool-aliases";
import type { PageToolSnapshotEntry } from "@/shared/chat-v2";

/** The turn's snapshot, so an alias can be resolved when its call arrives. */
let advertised: PageToolSnapshotEntry[] = [];

export function setAdvertisedPageTools(entries: PageToolSnapshotEntry[]): void {
  advertised = entries;
}

/**
 * Snapshot the open session's tools for the turn being sent, and remember what
 * was advertised so the model's reply can be resolved back to real tools.
 *
 * Called at POST time rather than memoized: a page registers and drops tools as
 * the user moves through it, and a turn should offer what the page has now.
 */
export function snapshotPageToolsForTurn(): PageToolSnapshotEntry[] {
  const { session, tools, pageToolsLive } = useWebmcpInspectorStore.getState();
  // Gated here as well as at the caller. A "closed" status arrives as an
  // ordinary session event and leaves the last tool snapshot in place, so a
  // snapshot taken from state alone would advertise a browser that is gone —
  // and the model would then be offered tools nothing can run.
  const entries = pageToolsLive()
    ? buildPageToolSnapshot(session?.sessionId, tools)
    : [];
  setAdvertisedPageTools(entries);
  return entries;
}

export function resolvePageToolAlias(
  alias: string,
): PageToolSnapshotEntry | undefined {
  return advertised.find((entry) => entry.alias === alias);
}

interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function textResult(text: string, isError = false): McpToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function invokePageToolForChat(
  alias: string,
  input: Record<string, unknown>,
): Promise<McpToolResult> {
  const entry = resolvePageToolAlias(alias);
  if (!entry) {
    return textResult(
      "That page tool is no longer available — the WebMCP browser session was closed after this tool was offered.",
      true,
    );
  }

  const store = useWebmcpInspectorStore.getState();
  if (store.session?.sessionId !== entry.sessionId) {
    // The snapshot was taken against a session that has since been replaced,
    // so invoking would run against a different page than the model was told
    // about.
    return textResult(
      `The browser session that offered "${entry.rawName}" is gone. Reopen the page in the WebMCP tab and try again.`,
      true,
    );
  }

  const result = await store.invokeToolForResult(entry.toolKey, input);

  if (result.state === "succeeded") {
    const text =
      typeof result.output === "string"
        ? result.output
        : JSON.stringify(result.output ?? null);
    return textResult(
      result.outputTruncated
        ? `${text}\n\n[This result was truncated by the inspector.]`
        : text,
    );
  }
  if (result.state === "cancelled") {
    return textResult(
      `The invocation of "${entry.rawName}" was cancelled before it finished.`,
      true,
    );
  }
  if (result.state === "timeout") {
    return textResult(
      `"${entry.rawName}" did not respond in time and was cancelled.`,
      true,
    );
  }
  return textResult(result.errorMessage ?? `"${entry.rawName}" failed.`, true);
}
