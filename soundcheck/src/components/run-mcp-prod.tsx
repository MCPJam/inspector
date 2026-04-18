"use client";

/**
 * Deploy MCP production tile — button + confirmation modal.
 *
 * The MCP Cloudflare Worker isn't part of release.yml's scope (Changesets
 * ignores @mcpjam/mcp; it deploys via its own Cloudflare pipeline). This
 * tile is the single user-facing path to promote whatever's currently on
 * mcp-staging.mcpjam.com to mcp.mcpjam.com.
 *
 * The workflow itself (`deploy-mcp-prod.yml`) re-checks that the current
 * main SHA has a green `deploy-mcp-staging.yml` run — clicking here
 * without one fails at the workflow's preflight step rather than
 * shipping a SHA that hasn't been verified on staging.
 *
 * No form inputs: unlike release.yml, this workflow has no scope/flags.
 * Main head + green staging = the only valid dispatch shape, so the
 * button carries all the state and the modal just surfaces the warning.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@mcpjam/design-system/dialog";
import { Badge, Tile } from "@/components/ui";

export function RunMcpProd() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<
    | { kind: "idle" }
    | { kind: "ok"; message: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [isPending, startTransition] = useTransition();

  function onConfirm() {
    setFeedback({ kind: "idle" });
    startTransition(async () => {
      try {
        const res = await fetch("/api/mcp/dispatch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Same-origin sentinel — the route rejects POSTs missing this
            // header to close a CSRF vector. See route.ts for rationale.
            "x-soundcheck-action": "mcp-prod-dispatch"
          }
        });
        const json = (await res.json()) as {
          error?: string;
          message?: string;
        };
        if (!res.ok) {
          setFeedback({
            kind: "error",
            message: json.error ?? `Dispatch failed: ${res.status}`
          });
          setConfirming(false);
          return;
        }
        setFeedback({
          kind: "ok",
          message:
            json.message ?? "deploy-mcp-prod.yml dispatched."
        });
        setConfirming(false);
        // Mirrors the release button: give GitHub a beat to register the
        // new run, then refresh so any downstream tile that reads
        // workflow-run state (future MCP progress tile, etc.) picks it up.
        setTimeout(() => router.refresh(), 4000);
      } catch (err) {
        setFeedback({
          kind: "error",
          message: (err as Error).message
        });
        setConfirming(false);
      }
    });
  }

  return (
    <Tile
      title="Deploy MCP production"
      eyebrow="mcp.mcpjam.com"
      accent="warning"
    >
      <p className="mb-5 text-xs leading-relaxed text-muted-foreground">
        Dispatches{" "}
        <span className="font-mono text-foreground">deploy-mcp-prod.yml</span>{" "}
        on <span className="font-mono text-foreground">main</span>. The
        workflow refuses unless{" "}
        <span className="font-mono text-foreground">
          deploy-mcp-staging.yml
        </span>{" "}
        is green for the current main SHA — check the MCP tile in
        section&nbsp;I first.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="destructive"
          onClick={() => setConfirming(true)}
          disabled={isPending}
        >
          Deploy MCP to production →
        </Button>
        {feedback.kind === "ok" ? (
          <>
            <Badge tone="success">dispatched</Badge>
            <span className="text-xs text-muted-foreground">
              {feedback.message}
            </span>
          </>
        ) : null}
        {feedback.kind === "error" ? (
          <span className="text-xs text-destructive">{feedback.message}</span>
        ) : null}
      </div>

      <ConfirmModal
        open={confirming}
        onOpenChange={(v) => !isPending && setConfirming(v)}
        onConfirm={onConfirm}
        busy={isPending}
      />
    </Tile>
  );
}

function ConfirmModal({
  open,
  onOpenChange,
  onConfirm,
  busy
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!busy} className="sm:max-w-md">
        <DialogHeader>
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Final confirmation
          </div>
          <DialogTitle className="text-xl">
            Promote MCP to{" "}
            <span className="font-mono text-[0.85em]">mcp.mcpjam.com</span>?
          </DialogTitle>
          <DialogDescription>
            Fires{" "}
            <span className="font-mono text-foreground">
              deploy-mcp-prod.yml
            </span>{" "}
            on <span className="font-mono text-foreground">main</span>.
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning">
          The Cloudflare Worker behind{" "}
          <span className="font-mono">mcp.mcpjam.com</span> will be
          overwritten with the current main SHA. Any client connected to the
          prod MCP endpoint sees the new build within seconds of the deploy
          completing.
        </p>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Dispatching…" : "Deploy to production →"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
