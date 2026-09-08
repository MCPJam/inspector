/**
 * BrowserToolsSection
 *
 * The agent browser, in the Playground Tools panel: the six `browser_*` tools
 * MCPJam gives the model, and under them the WebMCP tools the page it has open
 * offers right now.
 *
 * TWO GROUPS, NOT ONE LIST, because they are two different kinds of thing and
 * a person debugging needs to tell them apart. The `browser_*` tools are ours
 * and are always there once the host attaches the capability; the page tools
 * are the SITE'S, and appear and vanish as the browser navigates.
 *
 * EACH PAGE TOOL IS SHOWN UNDER THE NAME THE MODEL CALLS, with the page's own
 * name and origin beneath it. That pairing is the point of the row: the
 * transcript says `webmcp_bookSlot` while the page says `bookSlot`, and a pane
 * that showed only one of them leaves the other unreadable.
 *
 * The names are minted with the SAME shared functions the server mints with, so
 * this pane can never show a name the model was not given. A second
 * implementation here would drift on the first collision rule anybody changed.
 *
 * DISPLAY-ONLY, deliberately. Every other section here offers a Run; this one
 * does not, because running `browser_act` from a form would drive a real
 * browser — a signed-in one, on the local engine — outside the approval path
 * that exists precisely to put a person in front of that. The Browser pane in
 * the right rail is where a person drives it by hand.
 *
 * A sibling of the server list rather than an entry in it, for the same reason
 * `WebmcpPageToolsSection` is: the tool source is a browser, not an MCP server,
 * and selection everywhere else is keyed on server records.
 */
import { useMemo } from "react";
import { Globe, RefreshCw } from "lucide-react";
import type { BrowserPageToolsResponse } from "@/shared/browser-page-tools";
import {
  WEBMCP_TOOL_NAME_PREFIX,
  declaredToolsFromWebmcp,
  mintDeclaredToolNames,
  overCapMessage,
  safeDeclaredOrigin,
  toProviderToolSchema,
  WEBMCP_MAX_PAGE_TOOLS,
} from "@/shared/declared-tools";
import type { SerializedModelRequestTool } from "@/shared/model-request-payload";

/** ` · host` for the row's subtitle, or nothing when the origin is not one. */
function displayOrigin(origin: string | undefined): string {
  const safe = safeDeclaredOrigin(origin);
  return safe === "unknown" ? "" : ` · ${safe.replace(/^https?:\/\//, "")}`;
}

interface BrowserToolsSectionProps {
  /** The `browser_*` definitions, as the model is shown them. */
  tools: SerializedModelRequestTool[];
  /** The page read, or `null` while the first one is in flight. */
  page: BrowserPageToolsResponse | null;
  /**
   * The daemon's own change signal, when a browser stream is open.
   *
   * Used only to say the list is LIVE — that it follows the page rather than
   * waiting for somebody to press refresh. Absent means "no news" (no stream
   * open, or a daemon too old to send it), never "no tools".
   */
  live?: { revision: number; hash: string; count: number; url?: string };
  /** Which browser this is — the one claim about containment to get right. */
  engine: "hosted" | "local";
  /** Shared with the panel's search box so these rows filter together. */
  searchQuery: string;
  onRefreshPage: () => void;
}

/**
 * What the pane SAYS when a page read produced no list. One sentence each,
 * because each is a different thing for the person to do (or not do).
 */
function pageNotice(response: BrowserPageToolsResponse): string {
  if (response.ok) return "";
  switch (response.error) {
    case "no_browser_session":
      return "No browser running yet. It starts on the first browser tool call.";
    case "no_page":
      return "The browser is open but hasn't loaded a page yet.";
    case "lease_held":
      return "Someone has taken control of the browser, so its page isn't being read.";
    case "busy":
      return "The browser is busy. This list refreshes on the next read.";
    default:
      return "Couldn't read the page's tools.";
  }
}

export function BrowserToolsSection({
  tools,
  page,
  live,
  engine,
  searchQuery,
  onRefreshPage,
}: BrowserToolsSectionProps) {
  const query = searchQuery.trim().toLowerCase();
  const filteredTools = useMemo(() => {
    if (!query) return tools;
    return tools.filter((tool) =>
      `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(query),
    );
  }, [tools, query]);

  const pageTools = page?.ok ? page.tools : [];
  const minted = useMemo(
    () =>
      mintDeclaredToolNames(
        WEBMCP_TOOL_NAME_PREFIX,
        declaredToolsFromWebmcp(pageTools),
      ).map((tool, index) => ({
        ...tool,
        // PAST THE SERVER'S CAP. `buildWebmcpPageTools` advertises at most
        // `WEBMCP_MAX_PAGE_TOOLS`, so a page declaring more gets a pane that
        // lists names the model was never given — under a footer saying it can
        // call them. Marked rather than hidden: "this page declares more than
        // we advertise" is the fact a person debugging a large or hostile
        // registry actually needs.
        overCap: index >= WEBMCP_MAX_PAGE_TOOLS,
        // `generic`, because the pane does not know which provider this turn
        // will run against — and must not guess. That still catches the one
        // diagnostic that is true of EVERY provider (a schema whose root is
        // not an object cannot be expressed as tool arguments at all), which
        // is the one worth telling a person about before they wonder why the
        // model never called it. Provider-specific notes stay on the server,
        // where the provider is known.
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
      })),
    [pageTools],
  );
  const filteredPageTools = useMemo(() => {
    if (!query) return minted;
    return minted.filter((tool) =>
      `${tool.name} ${tool.rawName} ${tool.description}`
        .toLowerCase()
        .includes(query),
    );
  }, [minted, query]);

  if (tools.length === 0) return null;
  // A search that matches nothing here hides the whole section rather than
  // leaving a header over an empty space — the same rule the built-in section
  // follows.
  if (query && filteredTools.length === 0 && filteredPageTools.length === 0) {
    return null;
  }

  return (
    <div className="mt-3" data-testid="browser-tools-section">
      <div className="flex items-center gap-1.5 px-3 pb-1">
        <Globe className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Browser
        </span>
        <span
          className="font-mono text-[9px] rounded bg-muted px-1 py-[1px] text-muted-foreground"
          title={
            engine === "local"
              ? "These drive the Chromium on THIS machine, with your logins. Every call asks first."
              : "These drive the browser on your MCPJam computer. Every call asks first."
          }
        >
          {engine === "local" ? "this machine" : "your computer"}
        </span>
      </div>

      <div className="space-y-0.5">
        {filteredTools.map((tool) => (
          <div
            key={tool.name}
            className="w-full px-3 py-2 rounded-md border border-transparent"
          >
            <code className="block text-xs font-mono font-medium truncate">
              {tool.name}
            </code>
            {tool.description && (
              <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">
                {tool.description}
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-1.5 px-3 pb-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Declared by the page
        </span>
        {live && (
          <span
            className="font-mono text-[9px] rounded bg-accent px-1 py-[1px] text-accent-foreground"
            title="This list follows the page: the browser reports when its tools change, and the pane re-reads then."
          >
            live
          </span>
        )}
        <button
          type="button"
          onClick={onRefreshPage}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Refresh page tools"
          title="Re-read the page"
        >
          <RefreshCw className="h-2.5 w-2.5" />
        </button>
      </div>

      {page === null ? (
        <p className="px-3 text-[11px] text-muted-foreground">
          Reading the page…
        </p>
      ) : !page.ok ? (
        <p className="px-3 text-[11px] text-muted-foreground">
          {pageNotice(page)}
        </p>
      ) : filteredPageTools.length === 0 ? (
        <p className="px-3 text-[11px] text-muted-foreground">
          {query
            ? "No page tools match your search."
            : page.webmcpSupported
              ? `This page offers no WebMCP tools${
                  page.url ? ` (${page.url})` : ""
                }.`
              : "This page doesn't use WebMCP."}
        </p>
      ) : (
        <div className="space-y-0.5">
          {filteredPageTools.map((tool) => (
            <div
              key={`${tool.frameId ?? ""}\u0000${tool.name}`}
              className="w-full px-3 py-2 rounded-md border border-transparent"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                {/* THE NAME THE MODEL CALLS. The page's own name is below it:
                    the transcript says `webmcp_bookSlot` while the page says
                    `bookSlot`, and a person debugging needs both. */}
                <code className="text-xs font-mono font-medium truncate flex-1">
                  {tool.name}
                </code>
                {/* The page said this one only reads. Shown, never trusted:
                    the approval classifier ignores page annotations because an
                    imperative registration cannot carry them at all, so a
                    missing badge is an absent signal rather than a claim. */}
                {tool.annotations?.readOnly === true && (
                  <span
                    className="font-mono text-[9px] rounded bg-accent px-1 py-[1px] text-accent-foreground shrink-0"
                    title="The page claims this one only reads. Not trusted — every page tool still asks before it runs."
                  >
                    page says read-only
                  </span>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground/80 mt-0.5 truncate font-mono">
                {tool.rawName}
                {/* REDUCED, not echoed: the origin is page-reported, and this
                    label sits outside any fence. `safeDeclaredOrigin` keeps
                    scheme + host and nothing a page could write. */}
                {displayOrigin(tool.origin)}
                {tool.isMainFrame ? "" : " \u00b7 embedded frame"}
              </p>
              {tool.diagnostics.length > 0 && (
                <p className="text-[10px] text-warning mt-1">
                  {tool.diagnostics[0].blocking
                    ? "Not offered to the model: "
                    : "Note: "}
                  {tool.diagnostics[0].message}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {page?.ok && filteredPageTools.length > 0 && (
        <p className="px-3 pt-1 text-[10px] leading-snug text-muted-foreground">
          Available to the model on its next step, by these names. They change
          when the browser navigates.
        </p>
      )}
    </div>
  );
}
