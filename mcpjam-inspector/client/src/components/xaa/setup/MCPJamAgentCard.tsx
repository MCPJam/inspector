import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { XAA_DEBUG_IDP_CLIENT_ID } from "@mcpjam/sdk/browser";
import { Badge } from "@mcpjam/design-system/badge";
import { Card } from "@mcpjam/design-system/card";
import { CopyField } from "@/components/xaa/XAAIdpCard";
import { fetchXaaIdpUrls, getXaaIdpUrls } from "@/lib/xaa/idp-endpoints";

/**
 * The single fixed agent identity the managed test IdP issues ID-JAGs for.
 * There is nothing to create or configure — this card only surfaces the
 * identity (issuer/JWKS to trust, the fixed client_id to expect) so admins
 * can register it with their own authorization servers.
 */
export function MCPJamAgentCard({
  organizationId,
}: {
  organizationId: string | null;
}) {
  // Browser-origin guess first, then swap in the server-advertised issuer
  // once discovery resolves (mirrors XAAIdpCard).
  const [urls, setUrls] = useState(() => getXaaIdpUrls(organizationId));

  useEffect(() => {
    const controller = new AbortController();
    // Reset synchronously on org change so a stale prior-org URL never
    // lingers before discovery resolves.
    setUrls(getXaaIdpUrls(organizationId));
    void fetchXaaIdpUrls(controller.signal, organizationId).then(
      (serverUrls) => {
        if (controller.signal.aborted || !serverUrls) return;
        setUrls(serverUrls);
      },
    );
    return () => controller.abort();
  }, [organizationId]);

  return (
    <Card className="mx-4 mt-3 gap-0 p-0">
      <div className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">MCPJam Agent</h3>
              <Badge variant="secondary" className="text-[10px]">
                Fixed
              </Badge>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              The one agent this test IdP mints ID-JAGs for. Connections below
              decide which apps it may reach, and as whom.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyField label="Issuer URL" value={urls.issuerBaseUrl} />
          <CopyField label="JWKS URL" value={urls.jwksUrl} />
          <CopyField label="Client ID" value={XAA_DEBUG_IDP_CLIENT_ID} />
        </div>
      </div>
    </Card>
  );
}
