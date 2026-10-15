import { useEffect, useRef, useState } from "react";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@mcpjam/design-system/popover";
import { Button } from "@mcpjam/design-system/button";
import { FileText } from "lucide-react";
import {
  pluginMentionLink,
  type PluginMentionSelection,
} from "@/shared/plugin-mentions";
import { PluginServerIcon } from "../plugin-server-icon";
import type { PluginIcons } from "@/lib/plugins/plugin-api-types";

/** A connected plugin/server that declares a mention search tool. */
export type MentionPlugin = {
  serverId: string;
  name: string;
  /** The installed plugin that owns the server, when one does. */
  pluginId?: string;
  /** The imported plugin's icons, when the server belongs to one. */
  icons?: PluginIcons;
  /** The server's icons from discovery (`server/discover`, else `initialize`). */
  serverIcons?: readonly unknown[];
};
/** The text range a mention replaces, and the query typed into it. */
export type MentionToken = { start: number; end: number; query: string };

export type MentionComposer = {
  scope: string;
  /**
   * The chat's plugin workspace. Composer-owned extension surfaces (the form
   * card) key on it, so a pending form stays with its own chat.
   */
  workspaceId?: string;
  /** Step one: plugins whose mention search tool is declared. */
  plugins: (signal: AbortSignal) => Promise<MentionPlugin[]>;
  /** Step two: search one picked plugin; never every server at once. */
  search: (
    serverId: string,
    query: string,
    signal: AbortSignal,
  ) => Promise<PluginMentionSelection[]>;
  select: (selection: PluginMentionSelection, range: MentionToken) => void;
};

/**
 * The composer's two-step "@" picker. Without a scope it lists plugins; once
 * a plugin is picked it reads "<Plugin> · Type to search" and shows only that
 * plugin's results, each with its icon and title.
 */
export function MentionsPopover({
  anchor,
  token,
  scopedTo,
  actionTrigger,
  setActionTrigger,
  mentions,
  onPickPlugin,
  onDismiss,
}: {
  anchor: { x: number; y: number };
  token: MentionToken;
  scopedTo?: MentionPlugin | null;
  actionTrigger: string | null;
  setActionTrigger: (key: string | null) => void;
  mentions: MentionComposer;
  onPickPlugin: (plugin: MentionPlugin, token: MentionToken) => void;
  onDismiss: () => void;
}) {
  const query = token.query;
  const [plugins, setPlugins] = useState<MentionPlugin[]>([]);
  const [items, setItems] = useState<PluginMentionSelection[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [selected, setSelected] = useState(0);
  const current = useRef(mentions);
  current.current = mentions;
  const scopedServer = scopedTo?.serverId;

  // Step one: the plugin list (the composer caches its probes per session).
  useEffect(() => {
    if (scopedServer) return;
    const abort = new AbortController();
    setStatus("loading");
    void current.current
      .plugins(abort.signal)
      .then((rows) => {
        if (abort.signal.aborted) return;
        setPlugins(rows);
        setStatus("ready");
      })
      .catch(() => {
        if (!abort.signal.aborted) setStatus("error");
      });
    return () => abort.abort();
  }, [scopedServer, mentions.scope]);

  // Step two: debounced search of the picked plugin only.
  useEffect(() => {
    if (!scopedServer) return;
    const abort = new AbortController();
    setItems([]);
    setStatus("loading");
    const timer = setTimeout(() => {
      void current.current
        .search(scopedServer, query, abort.signal)
        .then((rows) => {
          if (abort.signal.aborted) return;
          setItems(rows);
          setStatus("ready");
        })
        .catch(() => {
          if (!abort.signal.aborted) setStatus("error");
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [scopedServer, query, mentions.scope]);

  useEffect(() => setSelected(0), [query, scopedServer]);

  const visiblePlugins = scopedServer
    ? []
    : plugins.filter((plugin) =>
        plugin.name.toLowerCase().includes(query.toLowerCase()),
      );
  const count = scopedServer ? items.length : visiblePlugins.length;

  function choose(index: number) {
    if (scopedServer) {
      const item = items[index];
      if (item) current.current.select(item, token);
    } else {
      const plugin = visiblePlugins[index];
      if (plugin) onPickPlugin(plugin, token);
    }
  }

  useEffect(() => {
    if (!actionTrigger) return;
    if (actionTrigger === "ArrowDown")
      setSelected((i) => Math.max(0, Math.min(i + 1, count - 1)));
    if (actionTrigger === "ArrowUp") setSelected((i) => Math.max(i - 1, 0));
    if (actionTrigger === "Enter") choose(selected);
    if (actionTrigger === "Escape") onDismiss();
    setActionTrigger(null);
    // Key presses are one-shot triggers from the composer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionTrigger]);

  const message = (text: string) => (
    <p role="status" className="p-2 text-sm text-muted-foreground">
      {text}
    </p>
  );
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <PopoverAnchor asChild>
        <span
          style={{
            position: "absolute",
            left: anchor.x,
            top: anchor.y,
            width: 0,
            height: 0,
            pointerEvents: "none",
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 p-1"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <p className="truncate px-2 pb-1 pt-1.5 text-xs text-muted-foreground">
          {scopedTo ? `${scopedTo.name} · Type to search` : "Mention a plugin"}
        </p>
        <div
          role="listbox"
          aria-label={scopedTo ? `${scopedTo.name} results` : "Plugins"}
        >
          {status === "loading"
            ? message(scopedTo ? "Searching…" : "Loading plugins…")
            : status === "error"
              ? message(
                  scopedTo
                    ? `Couldn’t search ${scopedTo.name}. Try again.`
                    : "Couldn’t load plugins. Try again.",
                )
              : count === 0
                ? message(
                    scopedTo
                      ? "No results."
                      : plugins.length
                        ? "No matching plugins."
                        : "No connected plugin offers mentions.",
                  )
                : scopedTo
                  ? items.map((item, index) => {
                      const link = pluginMentionLink(item);
                      return (
                        <Button
                          key={`${item.serverId}:${link.uri}:${index}`}
                          type="button"
                          variant="ghost"
                          role="option"
                          aria-selected={selected === index}
                          className="h-auto w-full justify-start gap-2 p-2 text-left aria-selected:bg-accent"
                          onMouseEnter={() => setSelected(index)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => choose(index)}
                        >
                          {link.icons?.length ? (
                            <PluginServerIcon icons={link.icons} />
                          ) : (
                            <FileText
                              aria-hidden="true"
                              className="size-4 shrink-0 text-muted-foreground"
                            />
                          )}
                          <span className="truncate">
                            {link.title ?? link.name}
                          </span>
                        </Button>
                      );
                    })
                  : visiblePlugins.map((plugin, index) => (
                      <Button
                        key={plugin.serverId}
                        type="button"
                        variant="ghost"
                        role="option"
                        aria-selected={selected === index}
                        className="h-auto w-full justify-start gap-2 p-2 text-left aria-selected:bg-accent"
                        onMouseEnter={() => setSelected(index)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => choose(index)}
                      >
                        <PluginServerIcon
                          serverName={plugin.name}
                          pluginIcons={plugin.icons}
                          serverIcons={plugin.serverIcons}
                        />
                        <span className="truncate">{plugin.name}</span>
                      </Button>
                    ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The query after a picked plugin's "@", spaces allowed, on one line. */
export function scopedMentionToken(
  text: string,
  caret: number,
  anchor: number,
): MentionToken | undefined {
  if (
    !Number.isSafeInteger(caret) ||
    caret <= anchor ||
    caret > text.length ||
    text[anchor] !== "@"
  )
    return;
  const query = text.slice(anchor + 1, caret);
  if (query.includes("\n") || query.length > 1024) return;
  return { start: anchor, end: caret, query };
}
