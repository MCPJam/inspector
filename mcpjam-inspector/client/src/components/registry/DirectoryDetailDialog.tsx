import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, KeyRound, ShieldOff } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import type { DirectoryServer } from "@/hooks/useServerDirectory";
import type { DirectoryServerDetail } from "@/lib/claude-directory-detail";

/**
 * Everything the directory knows about one connector, behind a card click.
 *
 * The card stays a one-liner; this is where the rest of the upstream listing
 * lives — the long description, the published tool names, who publishes it,
 * what access it asks for, and where it actually connects. Sections render
 * only when the listing carries them: absence is upstream's statement, not a
 * gap to paper over.
 *
 * `detail` is the parsed `rawJson` body:
 *   undefined — still loading (skeletons)
 *   null      — body unavailable; the summary the card had is all there is
 */

/** Past this many, the tool list collapses behind "Show all". */
const TOOLS_PREVIEW_COUNT = 24;

export interface DirectoryDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: DirectoryServer;
  detail: DirectoryServerDetail | null | undefined;
  /** Chips under the title — the card's tier/endpoint badges, unchanged. */
  badges?: ReactNode;
  /** The card's connect control, so the two can never disagree. */
  action?: ReactNode;
}

/** Where a connect would go, said the way the row says it. */
function endpointSummary(server: DirectoryServer): string | undefined {
  switch (server.endpointKind) {
    case "fixed":
      return server.remoteUrl;
    case "options":
      return server.remoteUrlOptions?.join("  ·  ");
    case "tenant":
      return "Your own instance URL";
    default:
      return undefined;
  }
}

export function DirectoryDetailDialog({
  open,
  onOpenChange,
  server,
  detail,
  badges,
  action,
}: DirectoryDetailDialogProps) {
  const [iconFailed, setIconFailed] = useState(false);
  const [showAllTools, setShowAllTools] = useState(false);

  // A dialog reused across cards must not carry one row's expansion (or a
  // dead icon verdict) over to the next.
  useEffect(() => {
    setIconFailed(false);
    setShowAllTools(false);
  }, [server._id]);

  const showIcon = Boolean(server.iconUrl) && !iconFailed;
  const loading = detail === undefined;
  const description = detail?.description ?? server.description;
  const toolNames = detail?.toolNames ?? [];
  const visibleTools = showAllTools
    ? toolNames
    : toolNames.slice(0, TOOLS_PREVIEW_COUNT);
  const endpoint = endpointSummary(server);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[560px] max-h-[85vh] overflow-y-auto"
        data-testid="directory-detail-dialog"
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            {showIcon ? (
              <img
                src={server.iconUrl}
                alt=""
                referrerPolicy="no-referrer"
                onError={() => setIconFailed(true)}
                className="h-10 w-10 rounded-md object-contain flex-shrink-0"
              />
            ) : null}
            <div className="min-w-0">
              <DialogTitle className="truncate">
                {server.displayName}
              </DialogTitle>
              <DialogDescription>
                {detail?.authorName
                  ? `By ${detail.authorName} · From Claude directory`
                  : "From Claude directory"}
              </DialogDescription>
            </div>
          </div>
          {badges ? (
            <div className="flex items-center gap-1.5 flex-wrap pt-1">
              {badges}
            </div>
          ) : null}
        </DialogHeader>

        {loading ? (
          <div className="space-y-2" data-testid="directory-detail-loading">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            {description && (
              <p className="text-muted-foreground whitespace-pre-line">
                {description}
              </p>
            )}

            {detail && detail.categories.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {detail.categories.map((category) => (
                  <Badge
                    key={category}
                    variant="outline"
                    className="text-[11px] px-1.5 py-0.5 border-muted-foreground/30 text-muted-foreground"
                  >
                    {category}
                  </Badge>
                ))}
              </div>
            )}

            {detail && detail.toolNames.length > 0 && (
              <section data-testid="directory-detail-tools">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                  Tools ({detail.toolNames.length})
                </h4>
                <div className="flex gap-1.5 flex-wrap">
                  {visibleTools.map((name) => (
                    <code
                      key={name}
                      className="text-[11px] font-mono bg-muted rounded px-1.5 py-0.5"
                    >
                      {name}
                    </code>
                  ))}
                  {!showAllTools && toolNames.length > TOOLS_PREVIEW_COUNT && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-1.5 text-[11px]"
                      onClick={() => setShowAllTools(true)}
                    >
                      Show all {toolNames.length}
                    </Button>
                  )}
                </div>
              </section>
            )}

            {detail && detail.promptNames.length > 0 && (
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                  Prompts ({detail.promptNames.length})
                </h4>
                <div className="flex gap-1.5 flex-wrap">
                  {detail.promptNames.map((name) => (
                    <code
                      key={name}
                      className="text-[11px] font-mono bg-muted rounded px-1.5 py-0.5"
                    >
                      {name}
                    </code>
                  ))}
                </div>
              </section>
            )}

            {detail &&
              (detail.authPosture ||
                detail.permissions ||
                detail.sensitiveDataTypes.length > 0 ||
                detail.requiredFields.length > 0) && (
                <section className="space-y-1">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Access
                  </h4>
                  {detail.authPosture && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                      {detail.authPosture === "no_auth" ? (
                        <ShieldOff className="h-3.5 w-3.5" />
                      ) : (
                        <KeyRound className="h-3.5 w-3.5" />
                      )}
                      {detail.authPosture === "no_auth"
                        ? "Listed as connecting without authentication"
                        : "Listed as requiring sign-in"}
                    </p>
                  )}
                  {detail.permissions && (
                    <p className="text-xs text-muted-foreground">
                      Permissions: {detail.permissions}
                    </p>
                  )}
                  {detail.sensitiveDataTypes.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Sensitive data: {detail.sensitiveDataTypes.join(", ")}
                    </p>
                  )}
                  {detail.requiredFields.map((field) => (
                    <p
                      key={field.field}
                      className="text-xs text-muted-foreground"
                    >
                      Requires <code className="font-mono">{field.field}</code>
                      {field.sourceUrl && (
                        <>
                          {" — "}
                          <a
                            href={field.sourceUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="underline underline-offset-2"
                          >
                            where to get it
                          </a>
                        </>
                      )}
                    </p>
                  ))}
                </section>
              )}

            {endpoint && (
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                  Endpoint
                </h4>
                <p className="text-xs font-mono text-muted-foreground break-all">
                  {endpoint}
                </p>
              </section>
            )}

            {detail && detail.links.length > 0 && (
              <div className="flex items-center gap-3 flex-wrap">
                {detail.links.map((link) => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 inline-flex items-center gap-1"
                  >
                    {link.label}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {action}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
