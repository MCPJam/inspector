"use client";

/**
 * The release card's one button. The card decides what it does (start a
 * release from pending changesets, or retry versions already on main); the
 * operator chooses nothing else.
 *
 * One click ships everything: npm, GitHub release, desktop, the hosted app and
 * the backend. Only skipping the tests asks once more.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@mcpjam/design-system/dialog";
import { dispatchRelease, type DispatchResult } from "@/lib/dispatch-client";
import type { ReleaseAction } from "@/lib/release-status";

const BUTTON_LABEL: Record<ReleaseAction, string> = {
  start: "Start release",
  publish: "Retry release"
};

export function ReleaseButton({
  action,
  version
}: {
  action: ReleaseAction;
  version: string;
}) {
  const router = useRouter();
  const [skipTests, setSkipTests] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<DispatchResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const needsConfirm = skipTests;
  const started = result?.kind === "ok" || result?.kind === "partial";

  function send() {
    startTransition(async () => {
      const outcome = await dispatchRelease({
        action,
        deploy_backend_prod: true,
        deploy_webapp: true,
        deploy_mcp_production: false,
        skip_verify: skipTests
      });
      setResult(outcome);
      setConfirming(false);
      // GitHub needs a moment to list the new run before the card can show it.
      if (outcome.kind !== "error") setTimeout(() => router.refresh(), 4000);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="lg"
          disabled={isPending || started}
          onClick={() => (needsConfirm ? setConfirming(true) : send())}
        >
          {isPending ? "Starting…" : started ? "Started" : BUTTON_LABEL[action]}
        </Button>
      </div>

      <details className="group text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">
          Urgent fix?
        </summary>
        <label className="mt-2 flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={skipTests}
            onCheckedChange={(v) => setSkipTests(v === true)}
            disabled={started}
          />
          Ship without waiting for the full tests and staging
        </label>
      </details>

      {result ? (
        <p
          role="status"
          className={
            "text-xs " +
            (result.kind === "error"
              ? "text-destructive"
              : result.kind === "partial"
                ? "text-warning"
                : "text-muted-foreground")
          }
        >
          {result.message}
        </p>
      ) : null}

      <Dialog open={confirming} onOpenChange={(v) => !isPending && setConfirming(v)}>
        <DialogContent showCloseButton={!isPending} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {BUTTON_LABEL[action]} {version}?
            </DialogTitle>
            <DialogDescription>
              This publishes to npm and deploys the hosted app and backend to production.
              {skipTests
                ? " It ships without waiting for the full tests or a green staging deploy."
                : " Nothing ships until the full tests and staging pass."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={send} disabled={isPending}>
              {isPending ? "Starting…" : BUTTON_LABEL[action]}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
