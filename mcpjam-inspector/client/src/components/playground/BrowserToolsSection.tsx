/**
 * BrowserToolsSection
 *
 * TWO GROUPS, NOT ONE LIST. The `browser_*` tools are ours and stay put once
 * the host attaches the capability. The page's tools are the SITE'S — they
 * appear and vanish as the browser navigates, and they are a sibling origin
 * in this pane, not a caption under Browser.
 *
 * EACH PAGE TOOL LEADS WITH THE PAGE'S NAME. The transcript still says
 * `webmcp_bookSlot`; that name sits on the line beneath, with the host, so
 * a person groks "the site's topping tool" first and can still find the
 * call in chat.
 *
 * Rows select like MCP tools: the list collapses to a parameter form, and
 * Run asks the agent (every browser / page call still asks first). Firing
 * `browser_act` from this pane would skip that path.
 */
import { useMemo, type ReactNode } from "react";
import { Badge } from "@mcpjam/design-system/badge";
import type { BrowserPageToolsResponse } from "@/shared/browser-page-tools";
import type { SerializedModelRequestTool } from "@/shared/model-request-payload";
import { cn } from "@/lib/utils";
import { useAppNavigate } from "@/lib/app-navigation";
import type { BrowserLocalConsentPrompt } from "@/hooks/useBrowserTools";
import { Button } from "@mcpjam/design-system/button";
import { buildHostFocusTabPath } from "@/components/hosts/host-verify-deep-link";
import { ToolSourceHeader } from "./ToolSourceHeader";
import {
  catalogBrowserPaneTools,
  type BrowserPaneTool,
} from "./browser-pane-tools";

interface BrowserToolsSectionProps {
  tools: SerializedModelRequestTool[];
  page: BrowserPageToolsResponse | null;
  searchQuery: string;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  /**
   * Set while this device hasn't allowed local Browser. The browser verbs
   * aren't offered until it has, so WebMCP asks for it in their place.
   */
  localConsent?: BrowserLocalConsentPrompt | null;
}

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

function ToolRow({
  tool,
  selected,
  onSelect,
  children,
}: {
  tool: BrowserPaneTool;
  selected: boolean;
  onSelect?: (key: string) => void;
  children: ReactNode;
}) {
  const className = cn(
    "w-full text-left px-3 py-2 rounded-md border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1",
    onSelect
      ? selected
        ? "cursor-pointer bg-primary/10"
        : "cursor-pointer hover:bg-muted/50"
      : "",
  );
  if (!onSelect) {
    return <div className={className}>{children}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(tool.key)}
      className={className}
    >
      {children}
    </button>
  );
}

export function BrowserToolsSection({
  tools,
  page,
  searchQuery,
  selectedKey = null,
  onSelect,
  localConsent = null,
}: BrowserToolsSectionProps) {
  const navigate = useAppNavigate();
  const query = searchQuery.trim().toLowerCase();
  const catalog = useMemo(
    () => catalogBrowserPaneTools({ tools, page }),
    [tools, page],
  );
  const pageItems = catalog.filter((tool) => tool.kind === "page");
  const browserItems = catalog.filter((tool) => tool.kind === "browser");

  const filteredPageTools = useMemo(() => {
    if (!query) return pageItems;
    return pageItems.filter((tool) =>
      `${tool.title} ${tool.callName} ${tool.description ?? ""} ${
        tool.originHost ?? ""
      }`
        .toLowerCase()
        .includes(query),
    );
  }, [pageItems, query]);
  const filteredTools = useMemo(() => {
    if (!query) return browserItems;
    return browserItems.filter((tool) =>
      `${tool.title} ${tool.description ?? ""}`.toLowerCase().includes(query),
    );
  }, [browserItems, query]);

  if (tools.length === 0 && !localConsent) return null;
  if (query && filteredTools.length === 0 && filteredPageTools.length === 0) {
    return null;
  }

  const showPage = !query || filteredPageTools.length > 0;
  const showBrowser =
    browserItems.length > 0 && (!query || filteredTools.length > 0);

  return (
    <div data-testid="browser-tools-section">
      {showPage ? (
        <ToolSourceHeader title={localConsent ? "Browser" : "WebMCP"}>
          {localConsent ? (
            <p className="px-3 text-xs leading-snug text-muted-foreground">
              {localConsent.disabledForClient ? (
                "Browser tools are disabled for this client."
              ) : (
                <>
                  Enable browser access from the Browser tab on the right pane
                  or{" "}
                  <Button
                    variant="link"
                    className="h-auto p-0 text-xs"
                    onClick={() =>
                      navigate(
                        buildHostFocusTabPath(
                          localConsent.settingsHostId,
                          "browser",
                        ),
                      )
                    }
                  >
                    Browser settings
                  </Button>
                  .
                </>
              )}
            </p>
          ) : page === null ? (
            <p className="px-3 text-xs text-muted-foreground">
              Reading the page…
            </p>
          ) : !page.ok ? (
            <p className="px-3 text-xs text-muted-foreground">
              {pageNotice(page)}
            </p>
          ) : filteredPageTools.length === 0 ? (
            <p className="px-3 text-xs text-muted-foreground">
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
                <ToolRow
                  key={tool.key}
                  tool={tool}
                  selected={selectedKey === tool.key}
                  onSelect={onSelect}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <code
                      className="min-w-0 flex-1 truncate text-xs font-medium text-foreground"
                      style={{ fontFamily: "var(--font-code)" }}
                    >
                      {tool.title}
                    </code>
                    {tool.readOnlyClaim && (
                      <Badge
                        variant="outline"
                        title="The page claims this one only reads. Not trusted — every page tool still asks before it runs."
                      >
                        page says read-only
                      </Badge>
                    )}
                  </div>
                  <p
                    className="mt-0.5 truncate text-xs text-muted-foreground"
                    style={{ fontFamily: "var(--font-code)" }}
                  >
                    {tool.callName}
                    {tool.originHost ? ` · ${tool.originHost}` : ""}
                    {tool.isMainFrame === false ? " · embedded frame" : ""}
                  </p>
                  {tool.blockingMessage || tool.note ? (
                    <p className="text-xs text-warning mt-1">
                      {tool.blockingMessage
                        ? `Not offered to the model: ${tool.blockingMessage}`
                        : `Note: ${tool.note}`}
                    </p>
                  ) : null}
                </ToolRow>
              ))}
            </div>
          )}
          {page?.ok && filteredPageTools.length > 0 && (
            <p className="px-3 pt-1 text-xs leading-snug text-muted-foreground">
              Available to the model on its next step, by these names. They
              change when the browser navigates.
            </p>
          )}
        </ToolSourceHeader>
      ) : null}

      {showBrowser ? (
        <ToolSourceHeader
          className={showPage ? "mt-3" : undefined}
          title="Browser"
          defaultOpen={false}
        >
          <div className="space-y-0.5">
            {filteredTools.map((tool) => (
              <ToolRow
                key={tool.key}
                tool={tool}
                selected={selectedKey === tool.key}
                onSelect={onSelect}
              >
                <code
                  className="block truncate text-xs font-medium text-foreground"
                  style={{ fontFamily: "var(--font-code)" }}
                >
                  {tool.title}
                </code>
                {tool.description && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {tool.description}
                  </p>
                )}
              </ToolRow>
            ))}
          </div>
        </ToolSourceHeader>
      ) : null}
    </div>
  );
}
