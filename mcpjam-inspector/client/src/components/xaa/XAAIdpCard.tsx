import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, Info, KeyRound } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@mcpjam/design-system/dialog";
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

function SetupGuidance() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="h-3.5 w-3.5 text-muted-foreground" />
          Before you run this test
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Before you run this test</DialogTitle>
          <DialogDescription>
            Configure your authorization server to accept MCPJam&apos;s ID-JAG
            and exchange it for an access token.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <p>
            MCPJam acts as both the identity provider and the client/agent in
            this test. Your authorization server must turn MCPJam&apos;s ID-JAG
            into an access token.
          </p>
          <ol className="list-decimal space-y-2 pl-5 marker:font-medium marker:text-foreground">
            <li>
              <strong className="font-medium text-foreground">
                Trust MCPJam&apos;s identity provider.
              </strong>{" "}
              Add either the Issuer URL or JWKS URL to your authorization
              server so it can verify MCPJam&apos;s ID-JAGs.
            </li>
            <li>
              <strong className="font-medium text-foreground">
                Choose how MCPJam identifies the client.
              </strong>{" "}
              Use the option your authorization server supports:
              <ul className="mt-1 list-[circle] space-y-1 pl-5 marker:text-muted-foreground">
                <li>
                  <strong>Pre-registration:</strong> Create a client for MCPJam
                  in your authorization server, then enter the returned client
                  ID in MCPJam.
                </li>
                <li>
                  <strong>DCR:</strong> Let MCPJam create a client during the
                  test through your registration endpoint.
                </li>
                <li>
                  <strong>CIMD:</strong> Let MCPJam identify itself with its
                  client metadata URL. Your authorization server must support
                  CIMD.
                </li>
              </ul>
            </li>
            <li>
              <strong className="font-medium text-foreground">
                Check the exchange support.
              </strong>{" "}
              Your authorization server must accept an ID-JAG from an external
              issuer and exchange it with the{" "}
              <code className="font-mono">jwt-bearer</code> grant.
            </li>
          </ol>
          <div className="flex items-start gap-2 border-l-2 border-amber-500 pl-3 pt-1">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span>
              Some authorization servers do not support this cross-app flow
              yet.
            </span>
          </div>
          <div className="space-y-1.5 pt-1">
            <div className="font-medium text-foreground">
              What your authorization server receives
            </div>
            <p>
              MCPJam puts these values in the ID-JAG. Your authorization server
              should verify that they match the expected authorization server,
              MCP server, and client.
            </p>
            <ul className="list-disc space-y-1 pl-5 marker:text-muted-foreground">
              <li>
                <code className="font-mono">aud</code> → your authorization
                server&apos;s issuer
              </li>
              <li>
                <code className="font-mono">resource</code> → the MCP server&apos;s
                resource identifier
              </li>
              <li>
                <code className="font-mono">client_id</code> → MCPJam&apos;s
                client identity
              </li>
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Persistent "MCPJam is your identity provider" bar. The XAA debugger always
 * mints assertions with MCPJam as the IdP, so this surfaces the issuer + JWKS
 * URLs a developer registers with their own authorization server, inline with
 * copy buttons and visible setup guidance.
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
  hostedIssuerDisabledReason,
}: {
  organizationId?: string | null;
  /** LOCAL builds only: which issuer mints this run's assertions. */
  issuerMode?: XaaIssuerMode;
  onIssuerModeChange?: (mode: XaaIssuerMode) => void;
  /** Signed-in + active-org gate: a local guest bearer is signed with a local
   * key the hosted issuer rejects, and the mint targets the org-scoped issuer. */
  canUseHostedIssuer?: boolean;
  /** Why the toggle is disabled (signed out vs no active org), for the hint. */
  hostedIssuerDisabledReason?: string;
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
    // Clear the first-render flag up front, regardless of mode. Otherwise a
    // mount in hosted mode (which takes the early return below) would leave it
    // set, and a later hosted→local toggle would skip the synchronous reset —
    // leaving the copy fields showing the hosted issuer/JWKS while the run
    // mints locally. The useState initializer already produced the correct
    // value for the first render, so only the reset on *changes* is needed.
    const wasFirstRender = isFirstResolve.current;
    isFirstResolve.current = false;

    if (hostedIssuerOn) {
      if (!wasFirstRender) {
        setUrls(getHostedXaaIdpUrls(organizationId));
      }
      return;
    }
    const controller = new AbortController();
    // Reset synchronously on any change (org switch or a hosted→local toggle)
    // so a stale hosted/prior-org URL never lingers before discovery resolves.
    if (!wasFirstRender) {
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
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex shrink-0 items-center gap-1.5">
              <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-sm font-semibold">
                MCPJam is your identity provider
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <CopyField label="Issuer URL" value={issuerBaseUrl} />
              <CopyField label="OpenID Config" value={openidConfigUrl} />
              <CopyField label="JWKS URL" value={jwksUrl} />
            </div>
          </div>
        </div>
        <SetupGuidance />
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
              {!canUseHostedIssuer && hostedIssuerDisabledReason && (
                <span>({hostedIssuerDisabledReason})</span>
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
                JWKS. No tunnel is needed. Token requests and MCP calls still run
                from this machine; your authorization server must be reachable
                over https.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <span>
                These are local URLs. Your authorization server can only fetch
                them if it can reach this machine. A cloud-hosted Okta or
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
          This issuer is scoped to your organization. Only its members can
          mint assertions under it.
        </div>
      )}
    </div>
  );
}
