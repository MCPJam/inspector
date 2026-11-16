"use client";

/**
 * The release card's one button. The card decides what it does (start a
 * release from pending changesets, or retry versions already on main); the
 * operator only chooses what else ships with it.
 *
 * A plain release (npm, GitHub release, desktop) is one click. Anything that
 * also deploys production services, or skips the tests, asks once more and
 * names what it will touch.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@mcpjam/design-system/button";
import { Toggle } from "@mcpjam/design-system/toggle";
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
  const [hosted, setHosted] = useState(false);
  const [backend, setBackend] = useState(false);
  const [skipTests, setSkipTests] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<DispatchResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const extras = [
    hosted ? "the hosted app" : null,
    backend ? "the backend" : null
  ].filter((x): x is string => x !== null);
  const needsConfirm = extras.length > 0 || skipTests;
  const started = result?.kind === "ok" || result?.kind === "partial";

  function send() {
    startTransition(async () => {
      const outcome = await dispatchRelease({
        action,
        deploy_backend_prod: backend,
        deploy_webapp: hosted,
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
        <span className="mx-1 text-xs text-muted-foreground">also deploy</span>
        <Toggle
          variant="outline"
          size="sm"
          pressed={hosted}
          onPressedChange={setHosted}
          disabled={started}
          className="px-3"
        >
          Hosted app
        </Toggle>
        <Toggle
          variant="outline"
          size="sm"
          pressed={backend}
          onPressedChange={setBackend}
          disabled={started}
          className="px-3"
        >
          Backend
        </Toggle>
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
              {extras.length > 0
                ? `This also deploys ${extras.join(" and ")} to production.`
                : "This publishes to npm."}
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
