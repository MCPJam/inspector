/**
 * The selectable catalog behind the Playground's WebMCP + Browser groups.
 *
 * Minting lives here so the list and the select → detail → Run hook cannot
 * drift: a row the pane shows is a tool the model was given, under the same
 * name.
 */
import type {
  BrowserPageTool,
  BrowserPageToolsResponse,
} from "@/shared/browser-page-tools";
import {
  WEBMCP_MAX_PAGE_TOOLS,
  WEBMCP_TOOL_NAME_PREFIX,
  declaredToolsFromWebmcp,
  mintDeclaredToolNames,
  overCapMessage,
  safeDeclaredOrigin,
  toProviderToolSchema,
  type MintedDeclaredTool,
} from "@/shared/declared-tools";
import type { SerializedModelRequestTool } from "@/shared/model-request-payload";

export type BrowserPaneToolKind = "browser" | "page";

export type BrowserPaneTool = {
  key: string;
  kind: BrowserPaneToolKind;
  /** Row / header lead — page name, or `browser_*`. */
  title: string;
  /** The name the model calls. Run's prompt uses this. */
  callName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  originHost?: string;
  /** The CDP frame that registered this page tool — needed to invoke it. */
  frameId?: string;
  readOnlyClaim?: boolean;
  isMainFrame?: boolean;
  blocking?: boolean;
  blockingMessage?: string;
  note?: string;
};

export function hostLabel(url: string | undefined): string {
  const safe = safeDeclaredOrigin(url);
  if (safe === "unknown") return "";
  return safe.replace(/^https?:\/\//, "");
}

export function browserToolKey(name: string): string {
  return `browser:${name}`;
}

export function pageToolKey(tool: Pick<MintedDeclaredTool, "name" | "frameId">): string {
  return `page:${tool.frameId ?? ""}\u0000${tool.name}`;
}

export function mintPageToolsForPane(
  pageTools: readonly BrowserPageTool[],
): Array<MintedDeclaredTool & { overCap: boolean }> {
  return mintDeclaredToolNames(
    WEBMCP_TOOL_NAME_PREFIX,
    declaredToolsFromWebmcp(pageTools),
  ).map((tool, index) => ({
    ...tool,
    overCap: index >= WEBMCP_MAX_PAGE_TOOLS,
    diagnostics: [
      ...tool.diagnostics,
      ...(index >= WEBMCP_MAX_PAGE_TOOLS
        ? [
            {
              code: "over_cap" as const,
              message: overCapMessage(WEBMCP_MAX_PAGE_TOOLS),
              blocking: true as const,
            },
          ]
        : []),
      ...toProviderToolSchema(tool.inputSchema, "generic").diagnostics,
    ],
  }));
}

export function catalogBrowserPaneTools(args: {
  tools: SerializedModelRequestTool[];
  page: BrowserPageToolsResponse | null;
}): BrowserPaneTool[] {
  const browser = args.tools.map(
    (tool): BrowserPaneTool => ({
      key: browserToolKey(tool.name),
      kind: "browser",
      title: tool.name,
      callName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }),
  );

  if (!args.page?.ok) return browser;

  const page = mintPageToolsForPane(args.page.tools).map((tool): BrowserPaneTool => {
    const blocking = tool.diagnostics.find((d) => d.blocking);
    const note = tool.diagnostics.find((d) => !d.blocking);
    return {
      key: pageToolKey(tool),
      kind: "page",
      title: tool.rawName,
      callName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      originHost: hostLabel(tool.origin),
      frameId: tool.frameId,
      readOnlyClaim: tool.annotations?.readOnly === true,
      isMainFrame: tool.isMainFrame,
      blocking: Boolean(blocking),
      blockingMessage: blocking?.message,
      note: note?.message,
    };
  });

  return [...page, ...browser];
}
