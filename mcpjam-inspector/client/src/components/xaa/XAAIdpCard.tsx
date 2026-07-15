import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Info, KeyRound } from "lucide-react";
import { Switch } from "@mcpjam/design-system/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { useLearnMore } from "@/hooks/use-learn-more";
import { LearnMoreExpandedPanel } from "@/components/learn-more/LearnMoreExpandedPanel";
import { SegmentedControl } from "@/components/ui/json-editor/segmented-control";
import { HOSTED_MODE } from "@/lib/config";
import { copyToClipboard } from "@/lib/clipboard";
import {
  fetchXaaIdpUrls,
  getHostedXaaIdpUrls,
  getXaaIdpUrls,
} from "@/lib/xaa/idp-endpoints";
import type { XaaIssuerMode } from "@/hooks/useXaaRunSettings";
import type { IdentityAssertionFormat } from "@/shared/xaa.js";
import { IDENTITY_ASSERTION_FORMAT_HINTS } from "./xaa-server-form";

function IssuerModeHint({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex shrink-0 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        variant="muted"
        className="max-w-sm text-left text-balance"
      >
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

// A compact click-to-copy chip: shows only the label to keep the bar minimal —
// the long URL stays hidden (revealed on hover via the native title) and the
// whole chip copies the full value. The icon flips to a check on copy.
// Exported for the setup center's MCPJam Agent card.
export function CopyField({ label, value }: { label: string; value: string }) {
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
  const { expandedTabId, sourceRect, openExpandedModal, closeExpandedModal } =
    useLearnMore();

  return (
    <>
      <button
        type="button"
        onClick={(e) =>
          openExpandedModal("xaa-idp", e.currentTarget.getBoundingClientRect())
        }
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Info className="h-3.5 w-3.5" />
        How it works
      </button>
      <LearnMoreExpandedPanel
        tabId={expandedTabId}
        sourceRect={sourceRect}
        onClose={closeExpandedModal}
      />
    </>
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
  issuerKind = "org",
  identityAssertionFormat,
  onIdentityAssertionFormatChange,
  identityAssertionFormatDisabledReason = null,
}: {
  organizationId?: string | null;
  /** LOCAL builds only: which issuer mints this run's assertions. */
  issuerMode?: XaaIssuerMode;
  onIssuerModeChange?: (mode: XaaIssuerMode) => void;
  /** Active-org gate for the hosted-issuer toggle. */
  canUseHostedIssuer?: boolean;
  /** Why the toggle is disabled (no active org yet), for the hint. */
  hostedIssuerDisabledReason?: string;
  /** Which scoped issuer flavor this session mints under: "org"
   * (/o/<orgId>, signed-in members) or "anonymous" (/g/<personalOrgId>,
   * guest sessions — the visibly separate anonymous test issuer a RAS must
   * explicitly allowlist; NOT enterprise-managed-authorization
   * conformance). */
  issuerKind?: "org" | "anonymous";
  /**
   * The active target's identity-assertion preset (per-server, persisted).
   * The OIDC/SAML control renders only when the change handler is provided —
   * surfaces without a persistence path (e.g. the setup center) omit it.
   */
  identityAssertionFormat?: IdentityAssertionFormat;
  onIdentityAssertionFormatChange?: (format: IdentityAssertionFormat) => void;
  /** Non-null disables the format control and explains why (native title). */
  identityAssertionFormatDisabledReason?: string | null;
}) {
  const hostedIssuerOn =
    !HOSTED_MODE && issuerMode === "hosted" && canUseHostedIssuer;

  // Start from the browser-origin guess, then swap in the server-advertised
  // issuer once resolved — see fetchXaaIdpUrls for why the guess can be wrong.
  // With the hosted-issuer opt-in on, the URLs are constructed instead:
  // hosted CORS blocks a local browser from fetching the hosted discovery doc.
  const [urls, setUrls] = useState(() =>
    hostedIssuerOn
      ? getHostedXaaIdpUrls(organizationId, issuerKind)
      : getXaaIdpUrls(organizationId, issuerKind)
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
        setUrls(getHostedXaaIdpUrls(organizationId, issuerKind));
      }
      return;
    }
    const controller = new AbortController();
    // Reset synchronously on any change (org switch or a hosted→local toggle)
    // so a stale hosted/prior-org URL never lingers before discovery resolves.
    if (!wasFirstRender) {
      setUrls(getXaaIdpUrls(organizationId, issuerKind));
    }
    void fetchXaaIdpUrls(controller.signal, organizationId, issuerKind).then(
      (serverUrls) => {
        if (controller.signal.aborted || !serverUrls) {
          return;
        }
        setUrls(serverUrls);
      }
    );
    return () => controller.abort();
  }, [organizationId, hostedIssuerOn, issuerKind]);

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
            {identityAssertionFormat && onIdentityAssertionFormatChange && (
              <div
                className="flex shrink-0 items-center gap-1.5"
                title={identityAssertionFormatDisabledReason ?? undefined}
                data-testid="identity-assertion-toggle"
              >
                <span className="text-xs text-muted-foreground">
                  Identity assertion
                </span>
                <SegmentedControl
                  options={[
                    {
                      value: "oidc",
                      label: "OIDC",
                      title: IDENTITY_ASSERTION_FORMAT_HINTS.oidc,
                    },
                    {
                      value: "saml",
                      label: "SAML",
                      title: IDENTITY_ASSERTION_FORMAT_HINTS.saml,
                    },
                  ]}
                  value={identityAssertionFormat}
                  onChange={onIdentityAssertionFormatChange}
                  disabled={Boolean(identityAssertionFormatDisabledReason)}
                />
              </div>
            )}
            {!HOSTED_MODE && (
              <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
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
                  </label>
                )}
                {hostedIssuerOn ? (
                  <IssuerModeHint label="About the hosted issuer">
                    ID tokens and ID-JAGs are minted by{" "}
                    <code className="font-mono">app.mcpjam.com</code>, so a
                    cloud authorization server can discover this issuer and
                    fetch its JWKS. No tunnel is needed. Token requests and MCP
                    calls still run from this machine; your authorization server
                    must be reachable over https.
                    {issuerKind === "anonymous" && (
                      <>
                        {" "}
                        This session mints under the{" "}
                        <b>anonymous test issuer</b> (
                        <code className="font-mono">/g/…</code>): its discovery
                        document is marked{" "}
                        <code className="font-mono">
                          mcpjam:issuer_kind: anonymous-test
                        </code>{" "}
                        and an authorization server must explicitly allowlist
                        it. Assertions prove control of an anonymous session —
                        this is a testing convenience, not enterprise-managed
                        authorization. Sign in to mint under a membership-gated
                        organization issuer.
                      </>
                    )}
                  </IssuerModeHint>
                ) : (
                  <IssuerModeHint label="About local issuer URLs">
                    These are local URLs. Your authorization server can only
                    fetch them if it can reach this machine. A cloud-hosted Okta
                    or Auth0 tenant cannot reach{" "}
                    <code className="font-mono">localhost</code>.
                    {onIssuerModeChange
                      ? " Flip on the hosted issuer, or expose MCPJam with a public tunnel (e.g. ngrok)."
                      : " Expose MCPJam with a public tunnel (e.g. ngrok) first."}
                  </IssuerModeHint>
                )}
                {onIssuerModeChange &&
                  !canUseHostedIssuer &&
                  hostedIssuerDisabledReason && (
                    <span>({hostedIssuerDisabledReason})</span>
                  )}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SetupGuidance />
        </div>
      </div>

      {/* The chips above stay valid in SAML mode — the ID-JAG is a JWT under
          this issuer either way; only the identity assertion changes shape.
          Say so, or the "OpenID Config" labels next to a SAML selection read
          as a contradiction. */}
      {identityAssertionFormat === "saml" &&
        onIdentityAssertionFormatChange && (
          <div
            className="mt-2 text-xs text-muted-foreground"
            data-testid="saml-format-note"
          >
            This server's identity assertions are SAML 2.0 (the ID-JAG carries
            a saml-nameid subject identifier). The ID-JAG itself is still a
            JWT minted under this issuer, so the discovery and JWKS URLs above
            are unchanged.
          </div>
        )}

      {isOrgScoped &&
        (issuerKind === "anonymous" ? (
          <div
            className="mt-3 text-xs text-muted-foreground"
            data-testid="anonymous-issuer-note"
          >
            <span className="mr-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400">
              Anonymous test issuer
            </span>
            This guest session mints under the anonymous test issuer (
            <code className="font-mono">/g/…</code>). Its discovery document is
            marked{" "}
            <code className="font-mono">mcpjam:issuer_kind: anonymous-test</code>{" "}
            and an authorization server must explicitly allowlist it —
            assertions prove control of an anonymous session, not
            enterprise-managed authorization. Sign in to mint under a
            membership-gated organization issuer.
          </div>
        ) : (
          <div className="mt-3 text-xs text-muted-foreground">
            This issuer is scoped to your organization. Only its members can
            mint assertions under it.
          </div>
        ))}
    </div>
  );
}
