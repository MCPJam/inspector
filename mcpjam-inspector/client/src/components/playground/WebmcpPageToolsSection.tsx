import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
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
 *
 * Hidden until a page is actually open. An empty "open WebMCP" caption at the
 * bottom of the tool list is not an offer — it is noise on every chat that
 * never uses the Inspector.
 *
 * Rendered in BOTH modes. It was local-only while `/api/web/chat-v2` ignored
 * `pageTools` — listing tools that would then be dropped mid-conversation is
 * worse than not offering them — and the hosted route now validates, advertises
 * and approval-classifies them exactly as the local one does. Fulfilment was
 * never the obstacle: the client invokes through the session it already owns,
 * and that session's transport is hosted or local without this component
 * knowing which.
 */
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import { useWebmcpInspectorEnabled } from "@/hooks/useWebmcpInspectorEnabled";

export function WebmcpPageToolsSection() {
  const flagOn = useWebmcpInspectorEnabled();
  const approval = useActiveChatSessionStore((state) =>
    state.sessionId ? state.approvalSettings[state.sessionId] : undefined,
  );
  const session = useWebmcpInspectorStore((state) => state.session);
  const tools = useWebmcpInspectorStore((state) => state.tools);
  const chatEnabled = useWebmcpInspectorStore((state) => state.chatEnabled);
  const setChatEnabled = useWebmcpInspectorStore(
    (state) => state.setChatEnabled,
  );

  if (!flagOn) return null;

  const live = Boolean(session) && session?.status !== "closed";
  if (!live) return null;

  return (
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
        <span className="block text-xs text-muted-foreground">
          {tools.length === 0
            ? "No tools registered yet"
            : `${tools.length} tool${tools.length === 1 ? "" : "s"} — Tool Approval ${approval === undefined ? "uses chat setting" : approval ? "on" : "off"}`}
        </span>
        <span className="block text-xs text-muted-foreground">
          Chat and you share control of this signed-in page. Tool results go to
          your model provider.
        </span>
      </span>
    </label>
  );
}
