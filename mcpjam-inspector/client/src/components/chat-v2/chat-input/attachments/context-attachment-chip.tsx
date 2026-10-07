import { useEffect, useState } from "react";
import { FileText, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { PluginServerIcon } from "../plugin-server-icon";
import type { PluginIcons } from "@/lib/plugins/plugin-api-types";

/** How one App context block reads in its App's Context popover. */
export interface ContextAttachmentBlock {
  kind: "text" | "resource_link" | "resource" | "image" | "structured";
  /** Text excerpt, or the URI of a resource link / embedded resource. */
  detail?: string;
  /** Image format label, e.g. "PNG". */
  format?: string;
  /** Inline image or text thumbnail (HTTPS or data URI only). */
  thumbnail?: string;
}

export interface ContextAttachment {
  id: string;
  title: string;
  description?: string;
  remove?: () => void;
  removing?: boolean;
  /** App context groups into one "Context" chip per App instance. */
  group?: {
    id: string;
    title: string;
    serverName?: string;
    /** The imported plugin's icons, when the App's server belongs to one. */
    icons?: PluginIcons;
    /** The server's icons (`server/discover`, else `initialize`). */
    serverIcons?: readonly unknown[];
    /** Removes every block this App supplied. */
    removeAll?: () => void;
  };
  block?: ContextAttachmentBlock;
}

/** Mentions keep one chip per pick. */
export function ContextAttachmentChip({
  title,
  description,
  remove,
  removing,
}: ContextAttachment) {
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-muted/50 px-2 py-1.5 text-xs">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="max-w-48 truncate font-medium" title={title}>
          {title}
        </div>
        {description && (
          <div className="max-w-48 truncate text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {remove && (
        <Button
          variant="ghost"
          size="icon"
          className="size-5 shrink-0"
          disabled={removing}
          aria-label={`Remove ${title}`}
          onClick={remove}
          type="button"
        >
          <X className="size-3" />
        </Button>
      )}
    </div>
  );
}

function Thumbnail({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return null;
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className="size-9 shrink-0 rounded-md border border-border object-cover"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * One chip per App: its plugin icon and "Context". Opening it lists each
 * block by type (text: title and text; resource link and embedded resource:
 * title and URI; image: title, format and thumbnail). Each row is removable,
 * and × on the chip removes all of that App's context.
 */
export function ContextGroupChip({
  group,
  items,
}: {
  group: NonNullable<ContextAttachment["group"]>;
  items: ContextAttachment[];
}) {
  const removing = items.some((item) => item.removing);
  return (
    <Popover>
      <div
        data-testid="context-group-chip"
        className="inline-flex max-w-full items-center gap-0.5 rounded-md border border-border bg-muted/50 py-0.5 pl-0.5 pr-1 text-xs"
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-1.5 text-xs font-medium"
            title={group.title}
            aria-label={`${group.title} context, ${items.length} item${
              items.length === 1 ? "" : "s"
            }`}
          >
            <PluginServerIcon
              serverName={group.serverName}
              pluginIcons={group.icons}
              serverIcons={group.serverIcons}
            />
            Context
          </Button>
        </PopoverTrigger>
        {group.removeAll && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-5 shrink-0"
            disabled={removing}
            aria-label={`Remove all ${group.title} context`}
            onClick={group.removeAll}
          >
            <X className="size-3" />
          </Button>
        )}
      </div>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <p className="truncate px-2 pb-1 pt-1.5 text-xs text-muted-foreground">
          {group.title}
        </p>
        <ul aria-label={`${group.title} context`} className="space-y-0.5">
          {items.map((item) => {
            const block = item.block;
            const secondary =
              block?.kind === "image" ? block.format : block?.detail;
            return (
              <li
                key={item.id}
                data-context-kind={block?.kind}
                className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm" title={item.title}>
                    {item.title}
                  </p>
                  {secondary && (
                    <p className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {secondary}
                    </p>
                  )}
                </div>
                {block?.thumbnail && <Thumbnail src={block.thumbnail} />}
                {item.remove && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-5 shrink-0"
                    disabled={item.removing}
                    aria-label={`Remove ${item.title}`}
                    onClick={item.remove}
                  >
                    <X className="size-3" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** Group App context per App, keeping first-seen order; others stay single. */
export function groupContextAttachments(attachments: ContextAttachment[]) {
  const order: (
    | { kind: "single"; attachment: ContextAttachment }
    | {
        kind: "group";
        group: NonNullable<ContextAttachment["group"]>;
        items: ContextAttachment[];
      }
  )[] = [];
  const groups = new Map<string, ContextAttachment[]>();
  for (const attachment of attachments) {
    if (!attachment.group) {
      order.push({ kind: "single", attachment });
      continue;
    }
    const existing = groups.get(attachment.group.id);
    if (existing) {
      existing.push(attachment);
      continue;
    }
    const items = [attachment];
    groups.set(attachment.group.id, items);
    order.push({ kind: "group", group: attachment.group, items });
  }
  return order;
}
