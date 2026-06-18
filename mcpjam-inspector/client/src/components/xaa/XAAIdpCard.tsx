import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, Info, KeyRound } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@mcpjam/design-system/hover-card";
import { HOSTED_MODE } from "@/lib/config";
import { copyToClipboard } from "@/lib/clipboard";
import { fetchXaaIdpUrls, getXaaIdpUrls } from "@/lib/xaa/idp-endpoints";

// Inline label + value + copy button, sized to share one horizontal bar with
// the sibling field. The URL is truncated (the copy button carries the full
// value); the native title surfaces it on hover for a quick read.
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  const handleCopy = async () => {
    const success = await copyToClipboard(value);
    if (!success) {
      return;
    }
    setCopied(true);
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, 1500);
  };

  // Clear the pending reset timer on unmount to avoid a stale state update.
  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="shrink-0 text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div
        className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/30 px-2.5 py-1.5 font-mono text-xs"
        title={value}
      >
        {value}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={handleCopy}
        aria-label={`Copy ${label}`}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}

// Long-form explanation, behind an info icon so the bar stays compact. Hover
// (or focus) to read how MCPJam plays the IdP and what it stamps into each
// ID-JAG.
function IdpInfo() {
  return (
    <HoverCard openDelay={150} closeDelay={150}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="How MCPJam acts as your identity provider"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="w-[26rem] space-y-3 text-xs text-muted-foreground"
      >
        <p>
          Use this to test whether your authorization server correctly validates
          ID-JAGs from an external issuer. MCPJam acts as the test IdP and the
          requesting client; your authorization server plays the resource
          app&apos;s authorization server.
        </p>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-foreground">
            In your authorization server
          </div>
          <ul className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground">
            <li>
              Trust MCPJam as an ID-JAG issuer so it can verify assertion
              signatures. Give it <em>either</em> the Issuer URL (if your server
              auto-discovers keys from OAuth/OIDC metadata) <em>or</em> the JWKS
              URL directly — both resolve to the same signing keys, so you
              don&apos;t need both.
            </li>
            <li>
              Register the client ID MCPJam will present, so the token exchange
              is recognized.
            </li>
          </ul>
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-foreground">
            MCPJam stamps these into each ID-JAG
          </div>
          <p>
            You set these in the debugger run config, not in your authorization
            server — make sure your server expects them.
          </p>
          <ul className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground">
            <li>
              <code className="font-mono">aud</code> → your authorization
              server&apos;s issuer
            </li>
            <li>
              <code className="font-mono">resource</code> → the MCP server&apos;s
              resource identifier
            </li>
            <li>
              <code className="font-mono">client_id</code> → the Client ID you
              set in Configure Server to Test
            </li>
          </ul>
        </div>

        <p>
          Cross-app access is new — some authorization servers don&apos;t yet
          expose a way to trust an external ID-JAG issuer and redeem it via the{" "}
          <code className="font-mono">jwt-bearer</code> grant. Check that yours
          supports it before wiring up the steps above.
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * Persistent "MCPJam is your identity provider" bar. The XAA debugger always
 * mints assertions with MCPJam as the IdP, so this surfaces the issuer + JWKS
 * URLs a developer registers with their own authorization server, inline with
 * copy buttons. The how-and-why detail lives behind the info icon.
 */
export function XAAIdpCard() {
  // Start from the browser-origin guess, then swap in the server-advertised
  // issuer once resolved — see fetchXaaIdpUrls for why the guess can be wrong.
  const [urls, setUrls] = useState(() => getXaaIdpUrls());
  const { issuerBaseUrl, jwksUrl } = urls;

  // Resolve the real issuer from the server's discovery doc once on mount —
  // the URLs are always visible now, so there's no expand to defer it to.
  useEffect(() => {
    const controller = new AbortController();
    void fetchXaaIdpUrls(controller.signal).then((serverUrls) => {
      if (controller.signal.aborted || !serverUrls) {
        return;
      }
      setUrls(serverUrls);
    });
    return () => controller.abort();
  }, []);

  return (
    <div className="border-b border-border bg-background px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex shrink-0 items-center gap-1.5">
          <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-semibold">
            MCPJam is your identity provider
          </span>
          <IdpInfo />
        </div>
        <div className="flex min-w-[20rem] flex-[1_1_24rem] flex-wrap items-center gap-x-4 gap-y-2">
          <CopyField label="Issuer URL" value={issuerBaseUrl} />
          <CopyField label="JWKS URL" value={jwksUrl} />
        </div>
      </div>

      {!HOSTED_MODE && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span>
            These are local URLs. Your authorization server can only fetch them
            if it can reach this machine — a cloud-hosted Okta or Auth0 tenant
            cannot reach <code className="font-mono">localhost</code>. Expose the
            inspector with a public tunnel (e.g. ngrok) first.
          </span>
        </div>
      )}
    </div>
  );
}
