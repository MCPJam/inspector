import { useMemo, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { AlertTriangle, ExternalLink, Copy, X } from "lucide-react";
import {
  URL_WARNING_COPY,
  analyzeElicitationUrl,
  splitUrlForDisplay,
} from "./url-analysis";

/**
 * URL-mode elicitation consent (MCP 2025-11-25).
 *
 * The server wants the user to complete something out of band — an OAuth
 * connect, a payment, entering a credential — at a URL the SERVER chose. The
 * client's whole job here is informed consent, so this dialog:
 *
 *   - shows the FULL url, always, before any consent (never truncated behind a
 *     "details" toggle, and never rendered as an anchor the user could click by
 *     reflex before reading it)
 *   - emphasizes the host, warns on punycode / http / embedded credentials, and
 *     refuses non-http(s) schemes outright
 *   - performs ZERO network activity (no favicon, no preview, no prefetch)
 *   - opens in a new tab the client cannot inspect, only on an explicit click
 *
 * `accept` means "the user consented and we sent them there" — NOT that the
 * out-of-band interaction succeeded. The server learns that separately.
 */

export interface UrlElicitationConsentProps {
  request: {
    rendezvousId: string;
    serverId: string;
    serverName?: string;
    message: string;
    url?: string;
  } | null;
  onResponse: (action: "accept" | "decline" | "cancel") => void | Promise<void>;
  loading?: boolean;
  /**
   * Advisory mode: no server call is blocked on the answer (the -32042 path,
   * where the tool already failed). Opening still works; there's just nothing
   * to accept, so the footer reads as "open / close".
   */
  advisory?: boolean;
}

export function UrlElicitationConsent({
  request,
  onResponse,
  loading,
  advisory,
}: UrlElicitationConsentProps) {
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [copied, setCopied] = useState(false);

  const analysis = useMemo(
    () => (request?.url ? analyzeElicitationUrl(request.url) : null),
    [request?.url],
  );

  if (!request) return null;

  const open = () => {
    if (!analysis?.parsed || analysis.blocked) return;

    // Two-step open, deliberately.
    //
    // `window.open(url, "_blank", "noopener")` returns null even on SUCCESS, so
    // it cannot distinguish "blocked" from "opened" — we'd either swallow a
    // real failure or withhold consent from a user who did open the page.
    // Opening about:blank first gives a real handle (null ⇒ genuinely blocked),
    // and nulling `opener` before navigating preserves the isolation `noopener`
    // was there for.
    const win = window.open("about:blank", "_blank");
    if (!win) {
      setPopupBlocked(true);
      return;
    }
    win.opener = null;
    win.location.replace(analysis.parsed.href);
    setPopupBlocked(false);
    if (!advisory) void onResponse("accept");
  };

  const copy = async () => {
    if (!request.url) return;
    try {
      await navigator.clipboard.writeText(request.url);
      setCopied(true);
    } catch {
      // Clipboard can be denied; the URL is on screen and selectable anyway.
    }
  };

  const display = analysis?.parsed ? splitUrlForDisplay(analysis.parsed) : null;
  const serverLabel = request.serverName ?? request.serverId;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Dismissing without choosing is `cancel`, not `decline` — the spec
        // distinguishes "no explicit choice" from an explicit refusal.
        if (!next && !advisory) void onResponse("cancel");
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ExternalLink className="h-4 w-4" />
            Open a link to continue?
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-1">
              <div>
                <span className="font-medium text-foreground">
                  {serverLabel}
                </span>{" "}
                is asking you to open a page to finish this step.
              </div>
              {/* serverId is the trusted anchor; serverName is server-supplied. */}
              <div className="font-mono text-[11px] text-muted-foreground">
                {request.serverId}
              </div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-foreground">{request.message}</p>

          {analysis?.blocked ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="text-xs text-destructive">
                This server sent a link MCPJam won't open — it isn't a valid
                web address. Nothing has been sent to it.
                <div className="mt-1 break-all font-mono text-[11px] opacity-80">
                  {request.url}
                </div>
              </div>
            </div>
          ) : (
            display && (
              <div className="rounded-md border bg-muted/40 p-3">
                <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Destination
                </div>
                {/* Plain text, never an <a>: the user must read before they go. */}
                <div className="max-h-24 overflow-auto break-all font-mono text-xs">
                  <span className="text-muted-foreground">{display.origin}</span>
                  <span className="font-semibold text-foreground">
                    {display.host}
                  </span>
                  <span className="text-muted-foreground">{display.rest}</span>
                </div>
              </div>
            )
          )}

          {analysis?.warnings.map((warning) => (
            <div
              key={warning}
              className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              <span className="text-xs text-amber-700 dark:text-amber-500">
                {URL_WARNING_COPY[warning]}
              </span>
            </div>
          ))}

          {popupBlocked && (
            <div className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
              Your browser blocked the new tab. Allow pop-ups for this site, or
              copy the link and open it yourself.
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" size="sm" onClick={copy} disabled={!request.url}>
            <Copy className="mr-1.5 h-3.5 w-3.5" />
            {copied ? "Copied" : "Copy link"}
          </Button>
          <div className="flex gap-2">
            {!advisory && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onResponse("decline")}
                disabled={loading}
              >
                <X className="mr-1.5 h-3.5 w-3.5" />
                Decline
              </Button>
            )}
            <Button
              size="sm"
              onClick={open}
              disabled={loading || !analysis || analysis.blocked}
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Open in new tab
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
