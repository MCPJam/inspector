"use client";

/**
 * Promotes the MCP staging worker to mcp.mcpjam.com. It ships on its own
 * schedule, not with a release, so it lives on the MCP tile rather than the
 * release card. deploy-mcp-prod.yml refuses unless staging is green for the
 * current MCP build.
 */

import { useState, useTransition } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@mcpjam/design-system/dialog";
import { dispatchRelease, type DispatchResult } from "@/lib/dispatch-client";

export function McpPromoteButton() {
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<DispatchResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function send() {
    startTransition(async () => {
      setResult(
        await dispatchRelease({
          action: "none",
          deploy_backend_prod: false,
          deploy_webapp: false,
          deploy_mcp_production: true,
          skip_verify: false
        })
      );
      setConfirming(false);
    });
  }

  return (
    <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setConfirming(true)}
        disabled={isPending || result?.kind === "ok"}
      >
        {result?.kind === "ok" ? "Promoting" : "Promote to production"}
      </Button>
      {result ? (
        <span
          role="status"
          className={
            "text-xs " +
            (result.kind === "error" ? "text-destructive" : "text-muted-foreground")
          }
        >
          {result.message}
        </span>
      ) : null}

      <Dialog open={confirming} onOpenChange={(v) => !isPending && setConfirming(v)}>
        <DialogContent showCloseButton={!isPending} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Promote MCP to production?</DialogTitle>
            <DialogDescription>
              Deploys the staging worker to mcp.mcpjam.com. It refuses unless staging is
              green for the current MCP build.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={send} disabled={isPending}>
              {isPending ? "Starting…" : "Promote"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
