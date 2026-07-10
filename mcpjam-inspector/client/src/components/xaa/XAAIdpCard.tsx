import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, Info, KeyRound } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@mcpjam/design-system/hover-card";
import { Switch } from "@mcpjam/design-system/switch";
import { HOSTED_MODE } from "@/lib/config";
import { copyToClipboard } from "@/lib/clipboard";
import {
  fetchXaaIdpUrls,
  getHostedXaaIdpUrls,
  getXaaIdpUrls,
} from "@/lib/xaa/idp-endpoints";
import type { XaaIssuerMode } from "@/hooks/useXaaRunSettings";

// A compact click-to-copy chip: shows only the label to keep the bar minimal —
// the long URL stays hidden (revealed on hover via the native title) and the
// whole chip copies the full value. The icon flips to a check on copy.
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
    <button
      type="button"
      onClick={handleCopy}
      title={value}
      aria-label={`Copy ${label}`}
      className="group inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span>{copied ? "Copied" : label}</span>
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Copy className="h-3.5 w-3.5 opacity-60 transition-opacity group-hover:opacity-100" />
      )}
    </button>
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
 *
 * Hosted signed-in users get the org-scoped issuer (/o/<orgId>): minting under
 * it requires org membership, so it is the issuer to register with a real
 * authorization server. The legacy unscoped issuer is mintable by anyone and
 * should be treated as test-only.
 */
export function XAAIdpCard({
  organizationId,
  issuerMode = "local",
  onIssuerModeChange,
  canUseHostedIssuer = false,
}: {
  organizationId?: string | null;
  /** LOCAL builds only: which issuer mints this run's assertions. */
  issuerMode?: XaaIssuerMode;
  onIssuerModeChange?: (mode: XaaIssuerMode) => void;
  /** Signed-in gate: a local guest bearer is signed with a local key and the
   * hosted issuer would reject it, so the toggle needs a real session. */
  canUseHostedIssuer?: boolean;
}) {
  const hostedIssuerOn =
    !HOSTED_MODE && issuerMode === "hosted" && canUseHostedIssuer;

  // Start from the browser-origin guess, then swap in the server-advertised
  // issuer once resolved — see fetchXaaIdpUrls for why the guess can be wrong.
  // With the hosted-issuer opt-in on, the URLs are constructed instead:
  // hosted CORS blocks a local browser from fetching the hosted discovery doc.
  const [urls, setUrls] = useState(() =>
    hostedIssuerOn ? getHostedXaaIdpUrls(organizationId) : getXaaIdpUrls(organizationId),
  );
  const { issuerBaseUrl, openidConfigUrl, jwksUrl } = urls;

  // Resolve the real issuer from the server's discovery doc once on mount —
  // the URLs are always visible now, so there's no expand to defer it to.
  const isFirstResolve = useRef(true);
  useEffect(() => {
    if (hostedIssuerOn) {
      setUrls(getHostedXaaIdpUrls(organizationId));
      return;
    }
    const controller = new AbortController();
    // The useState initializer already produced this value on first render;
    // only reset synchronously when the org actually changes (so a stale
    // prior-org URL never flashes) to avoid a wasted render on mount.
    if (isFirstResolve.current) {
      isFirstResolve.current = false;
    } else {
      setUrls(getXaaIdpUrls(organizationId));
    }
    void fetchXaaIdpUrls(controller.signal, organizationId).then(
      (serverUrls) => {
        if (controller.signal.aborted || !serverUrls) {
          return;
        }
        setUrls(serverUrls);
      },
    );
    return () => controller.abort();
  }, [organizationId, hostedIssuerOn]);

  const isOrgScoped = HOSTED_MODE && Boolean(organizationId);

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
        <div className="flex flex-wrap items-center gap-2">
          <CopyField label="Issuer URL" value={issuerBaseUrl} />
          <CopyField label="OpenID Config" value={openidConfigUrl} />
          <CopyField label="JWKS URL" value={jwksUrl} />
        </div>
      </div>

      {!HOSTED_MODE && (
        <div className="mt-3 space-y-2 text-xs text-muted-foreground">
          {onIssuerModeChange && (
            <label className="flex items-center gap-2">
              <Switch
                checked={hostedIssuerOn}
                disabled={!canUseHostedIssuer}
                onCheckedChange={(checked) =>
                  onIssuerModeChange(checked ? "hosted" : "local")
                }
                aria-label="Use hosted issuer"
              />
              <span className="font-medium text-foreground">
                Use hosted issuer (app.mcpjam.com)
              </span>
              {!canUseHostedIssuer && (
                <span>— sign in to mint through the hosted issuer</span>
              )}
            </label>
          )}
          {hostedIssuerOn ? (
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                ID tokens and ID-JAGs are minted by{" "}
                <code className="font-mono">app.mcpjam.com</code>, so a cloud
                authorization server can discover this issuer and fetch its
                JWKS — no tunnel needed. Token requests and MCP calls still run
                from this machine; your authorization server must be reachable
                over https.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>
                These are local URLs. Your authorization server can only fetch
                them if it can reach this machine — a cloud-hosted Okta or
                Auth0 tenant cannot reach{" "}
                <code className="font-mono">localhost</code>.
                {onIssuerModeChange
                  ? " Flip on the hosted issuer above, or expose MCPJam with a public tunnel (e.g. ngrok)."
                  : " Expose MCPJam with a public tunnel (e.g. ngrok) first."}
              </span>
            </div>
          )}
        </div>
      )}

      {isOrgScoped && (
        <div className="mt-3 text-xs text-muted-foreground">
          This issuer is scoped to your organization — only its members can
          mint assertions under it.
        </div>
      )}
    </div>
  );
}
