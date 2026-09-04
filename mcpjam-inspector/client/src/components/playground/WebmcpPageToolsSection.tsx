/**
 * WebmcpPageToolsSection
 *
 * Opt-in for the tools of the page the WebMCP Inspector currently has open, in
 * the Playground Tools panel.
 *
 * A sibling of the server list rather than an entry in it: the tool source here
 * is a live web page, not an MCP server, and `ActiveServerSelector` is keyed on
 * server records. Folding a page in as a pseudo-server would misrepresent what
 * it is everywhere selection is read.
 *
 * The opt-in lives in the inspector store rather than in props, because two
 * distant places need it — this toggle and the chat transport — and threading a
 * boolean between them through the tools pane would couple every layer in
 * between to a feature none of them care about.
 *
 * The toggle is deliberate. A chat that silently gained tools because a browser
 * session was left open in another tab would be a surprise, and these tools run
 * code on somebody else's site.
 */
import { Globe } from "lucide-react";
import {
  scopeNavigationTarget,
  routePaths,
  useAppNavigate,
  useCurrentPathname,
} from "@/lib/app-navigation";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import { useWebmcpInspectorEnabled } from "@/hooks/useWebmcpInspectorEnabled";
import { HOSTED_MODE } from "@/lib/config";

export function WebmcpPageToolsSection() {
  const flagOn = useWebmcpInspectorEnabled();
  const session = useWebmcpInspectorStore((state) => state.session);
  const tools = useWebmcpInspectorStore((state) => state.tools);
  const chatEnabled = useWebmcpInspectorStore((state) => state.chatEnabled);
  const setChatEnabled = useWebmcpInspectorStore(
    (state) => state.setChatEnabled,
  );
  const pathname = useCurrentPathname();
  const navigate = useAppNavigate();

  if (!flagOn) return null;
  // HOSTED HAS NO SERVER PATH FOR PAGE TOOLS, yet. The local chat route reads
  // `pageTools` and classifies their approvals (`routes/mcp/chat-v2.ts`); the
  // hosted one at `/api/web/chat-v2` never looks at the field, so a turn that
  // advertised them would silently drop every call. Rendering the section
  // would offer a capability that does nothing — worse than not offering it,
  // because the tools would be listed and then ignored mid-conversation.
  //
  // The WebMCP tab itself works hosted; this is only the Playground bridge.
  // Threading page tools through the hosted chat path is its own change.
  if (HOSTED_MODE) return null;

  const live = Boolean(session) && session?.status !== "closed";

  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5 px-3 pb-1">
        <Globe className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Page tools
        </span>
      </div>

      {!live ? (
        <p className="px-3 text-xs text-muted-foreground">
          No page open.{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() =>
              navigate(scopeNavigationTarget(routePaths.webmcp, pathname))
            }
          >
            Open one in WebMCP
          </button>{" "}
          to let the model use its tools.
        </p>
      ) : (
        <label className="flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-accent/40">
          <input
            type="checkbox"
            checked={chatEnabled}
            onChange={(event) => setChatEnabled(event.target.checked)}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium">
              {session?.url}
            </span>
            <span className="block text-[11px] text-muted-foreground">
              {tools.length === 0
                ? "No tools registered yet"
                : `${tools.length} tool${tools.length === 1 ? "" : "s"} — every call asks first`}
            </span>
          </span>
        </label>
      )}
    </div>
  );
}
