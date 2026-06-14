import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Card } from "@mcpjam/design-system/card";
import { HOSTED_MODE } from "@/lib/config";
import { copyToClipboard } from "@/lib/clipboard";
import { fetchXaaIdpUrls, getXaaIdpUrls } from "@/lib/xaa/idp-endpoints";

function CopyRow({ label, value }: { label: string; value: string }) {
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
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-stretch gap-2">
        <div className="min-w-0 flex-1 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs break-all">
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
    </div>
  );
}

/**
 * Persistent "Use MCPJam as your test IdP" card. Surfaces the issuer,
 * OpenID configuration, and JWKS URLs the user registers with their own
 * authorization server so the JWT-bearer token exchange can succeed —
 * previously only reachable through a transient bootstrap dialog.
 */
export function XAAIdpCard() {
  const [expanded, setExpanded] = useState(false);
  // Start from the browser-origin guess, then swap in the server-advertised
  // issuer once resolved — see fetchXaaIdpUrls for why the guess can be wrong.
  const [urls, setUrls] = useState(() => getXaaIdpUrls());
  const resolved = useRef(false);

  const { issuerBaseUrl, jwksUrl } = urls;

  // Resolve the real issuer from the server's discovery doc once, the first
  // time the card is expanded.
  useEffect(() => {
    if (!expanded || resolved.current) {
      return;
    }
    const controller = new AbortController();
    void fetchXaaIdpUrls(controller.signal).then((serverUrls) => {
      if (controller.signal.aborted) {
        return;
      }
      // Mark done only after a non-aborted resolution — setting it up front
      // would lock out future expansions if the first attempt is aborted.
      resolved.current = true;
      if (serverUrls) {
        setUrls(serverUrls);
      }
    });
    return () => controller.abort();
  }, [expanded]);

  return (
    <Card className="mx-3 mt-3 mb-1 gap-0 p-0">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">
              Use MCPJam as your test IdP
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            Only when you target your own authorization server — register these
            endpoints so it trusts MCPJam-issued assertions.
          </p>
        </div>
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="space-y-4 px-4 pb-4">
          <CopyRow label="Issuer URL" value={issuerBaseUrl} />
          <CopyRow label="JWKS URL" value={jwksUrl} />

          <p className="text-xs text-muted-foreground">
            Use this to test whether your authorization server correctly
            validates ID-JAGs from an external issuer. MCPJam acts as the test
            IdP and the requesting client; your authorization server plays the
            resource app&apos;s authorization server.
          </p>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-foreground">
              In your authorization server
            </div>
            <ul className="list-disc space-y-1.5 pl-5 text-xs text-muted-foreground marker:text-muted-foreground">
              <li>
                Trust MCPJam as an ID-JAG issuer so it can verify assertion
                signatures. Give it <em>either</em> the Issuer URL (if your
                server auto-discovers keys from OAuth/OIDC metadata) <em>or</em>{" "}
                the JWKS URL directly — both resolve to the same signing keys,
                so you don&apos;t need both.
              </li>
              <li>
                Register the client ID MCPJam will present, so the token
                exchange is recognized.
              </li>
            </ul>
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-foreground">
              MCPJam stamps these into each ID-JAG
            </div>
            <p className="text-xs text-muted-foreground">
              You set these in the debugger run config, not in your
              authorization server — make sure your server expects them.
            </p>
            <ul className="list-disc space-y-1.5 pl-5 text-xs text-muted-foreground marker:text-muted-foreground">
              <li>
                <code className="font-mono">aud</code> → your authorization
                server&apos;s issuer
              </li>
              <li>
                <code className="font-mono">resource</code> → the MCP
                server&apos;s resource identifier
              </li>
              <li>
                <code className="font-mono">client_id</code> → the Client ID you
                set in Configure Target
              </li>
            </ul>
          </div>

          <p className="text-xs text-muted-foreground">
            Cross-app access is new — some authorization servers don&apos;t yet
            expose a way to trust an external ID-JAG issuer and redeem it via
            the <code className="font-mono">jwt-bearer</code> grant. Check that
            yours supports it before wiring up the steps above.
          </p>

          {!HOSTED_MODE && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>
                These are local URLs. Your authorization server can only fetch
                them if it can reach this machine — a cloud-hosted Okta or Auth0
                tenant cannot reach <code className="font-mono">localhost</code>.
                Expose the inspector with a public tunnel (e.g. ngrok) first.
              </span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
