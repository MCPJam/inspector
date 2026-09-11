import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import type { WebMcpToolDescriptor } from "@/shared/webmcp-inspector-protocol";

/**
 * Annotation badges.
 *
 * Shown as CLAIMS, never as guarantees. They are written by the inspected page,
 * which is third-party content, and a page that wants its tool run without a
 * prompt has every incentive to describe it favourably. Nothing in the product
 * derives a permission decision from them, and the tooltips say so to whoever
 * is reading the panel.
 *
 * The values themselves are reported faithfully — the browser carries a page's
 * `readOnlyHint` and `untrustedContentHint` through unchanged — so nothing here
 * hedges about the TRANSPORT. The one exception is `consequential`, which the
 * pinned Chromium does not report at all; its tooltip says that rather than
 * letting an absent badge read as "the page did not claim it".
 */
function AnnotationBadges({ tool }: { tool: WebMcpToolDescriptor }) {
  const badges: { label: string; title: string }[] = [];
  if (tool.annotations?.readOnly) {
    badges.push({
      label: "read-only",
      title:
        "The page claims this tool changes nothing. A claim, not a guarantee — model-driven calls still ask before running.",
    });
  }
  if (tool.annotations?.untrustedContent) {
    badges.push({
      label: "untrusted output",
      title:
        "The page warns its output may contain third-party or user-generated content.",
    });
  }
  if (tool.annotations?.consequential) {
    badges.push({
      label: "consequential",
      title:
        "The page claims this tool may have a consequential side effect. A claim, not a guarantee — model-driven calls still ask before running. The browser build this inspector pins does not report this annotation at all, so a tool that declares it may show no badge here.",
    });
  }
  if (tool.annotations?.autosubmit) {
    badges.push({
      label: "autosubmit",
      title:
        "Declared with the toolautosubmit attribute, so invoking it submits the form rather than only filling it in.",
    });
  }
  if (tool.fromSubframe) {
    badges.push({
      label: "subframe",
      // The origin heading above each group already says WHICH publisher this
      // is; what the badge adds is that it is not the page you typed in.
      title:
        "Registered by a frame inside the page rather than the page itself. When its origin differs from the page's, it is a cross-origin frame running in its own process — a third-party widget, inspected through a CDP session of its own.",
    });
  }
  if (tool.registrationKind === "declarative") {
    badges.push({
      label: "declarative",
      title:
        "Declared in markup (a <form toolname>) rather than registered from script. Its input schema was derived by the browser from the form's own controls.",
    });
  }
  if (badges.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((badge) => (
        <Badge
          key={badge.label}
          variant="secondary"
          className="text-[10px] font-normal"
          title={badge.title}
        >
          {badge.label}
        </Badge>
      ))}
    </div>
  );
}

export interface ToolsPanelProps {
  tools: WebMcpToolDescriptor[];
  selectedToolKey: string | undefined;
  onSelect: (toolKey: string) => void;
  /** True once a session is live, so "none yet" can be distinguished from "no session". */
  hasSession: boolean;
}

export function ToolsPanel({
  tools,
  selectedToolKey,
  onSelect,
  hasSession,
}: ToolsPanelProps) {
  if (!hasSession) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Open a page to see the tools it registers.
      </p>
    );
  }

  if (tools.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground space-y-2">
        <p>This page has not registered any WebMCP tools yet.</p>
        <p className="text-xs">
          Tools appear the moment the page registers them, including after a
          navigation or a user action — nothing needs reloading here.
        </p>
      </div>
    );
  }

  // Grouped by origin because a page and its frames are different publishers,
  // and "which origin offered this" is the first thing worth knowing about a
  // tool an agent might call.
  const byOrigin = new Map<string, WebMcpToolDescriptor[]>();
  for (const tool of tools) {
    const list = byOrigin.get(tool.origin) ?? [];
    list.push(tool);
    byOrigin.set(tool.origin, list);
  }

  return (
    <div className="divide-y">
      {[...byOrigin.entries()].map(([origin, originTools]) => (
        <section key={origin}>
          <header className="px-3 py-2 text-xs font-medium text-muted-foreground truncate">
            {origin}
          </header>
          <ul>
            {originTools.map((tool) => (
              <li key={tool.toolKey}>
                <button
                  type="button"
                  onClick={() => onSelect(tool.toolKey)}
                  className={cn(
                    "w-full px-3 py-2 text-left hover:bg-accent/50 transition-colors",
                    selectedToolKey === tool.toolKey && "bg-accent",
                  )}
                >
                  <div className="font-mono text-sm truncate">{tool.name}</div>
                  {tool.description ? (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {tool.description}
                    </p>
                  ) : null}
                  <div className="mt-1">
                    <AnnotationBadges tool={tool} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
