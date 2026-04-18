"use client";

/**
 * Run Release tile — form + confirmation modal.
 *
 * The three inputs map 1:1 to release.yml's workflow_dispatch inputs. The
 * confirmation modal quotes them back verbatim because "the one path to
 * production" is load-bearing; we want a deliberate extra click before any
 * prod-facing outcome.
 *
 * The client never sees `GITHUB_DISPATCH_PAT`. The server route
 * /api/release/dispatch holds the write token; this component only POSTs
 * JSON to it.
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
import {
  RadioGroup,
  RadioGroupItem
} from "@mcpjam/design-system/radio-group";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import { Badge, Tile } from "@/components/ui";

type Scope = "packages-only" | "inspector-only" | "full";

const SCOPE_HINT: Record<Scope, string> = {
  "full": "publish whatever changesets are pending",
  "packages-only": "publish sdk/cli only (no inspector)",
  "inspector-only": "publish inspector only (no sdk/cli)"
};

export function RunRelease() {
  const router = useRouter();
  const [scope, setScope] = useState<Scope>("full");
  const [deployBackend, setDeployBackend] = useState(false);
  const [promoteProd, setPromoteProd] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<
    | { kind: "idle" }
    | { kind: "ok"; message: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [isPending, startTransition] = useTransition();

  const impactsProd = deployBackend || promoteProd;

  // Reset gated flags when scope changes so a stale `true` can't slip into
  // the confirmation modal or the dispatch payload. The checkbox disabling
  // is only a UI hint — state must follow.
  function changeScope(next: Scope) {
    setScope(next);
    if (next !== "full") setDeployBackend(false);
    if (next === "packages-only") setPromoteProd(false);
    // Any edit to the form is implicitly "I'm preparing the next dispatch" —
    // clear stale success/error feedback from an earlier run so the chip
    // next to the button always reflects the current form state.
    setFeedback({ kind: "idle" });
  }

  function changeDeployBackend(v: boolean) {
    setDeployBackend(v);
    setFeedback({ kind: "idle" });
  }
  function changePromoteProd(v: boolean) {
    setPromoteProd(v);
    setFeedback({ kind: "idle" });
  }

  function onConfirm() {
    setFeedback({ kind: "idle" });
    startTransition(async () => {
      try {
        const res = await fetch("/api/release/dispatch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope,
            deploy_backend_prod: deployBackend,
            promote_production: promoteProd
          })
        });
        const json = (await res.json()) as { error?: string; message?: string };
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
            json.message ??
            "release.yml dispatched. The progress tile should pick it up shortly."
        });
        setConfirming(false);
        // Give GitHub a beat to record the new run, then refresh so the
        // progress tile re-fetches and picks up the in-flight run.
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
      title="Run release"
      eyebrow="The one path to production"
      accent={impactsProd ? "warning" : "info"}
    >
      <p className="mb-5 text-xs leading-relaxed text-muted-foreground">
        Dispatches{" "}
        <span className="font-mono text-foreground">release.yml</span> on{" "}
        <span className="font-mono text-foreground">main</span>. Confirmation
        required; the server re-checks your email before touching the write
        token.
      </p>

      <div className="space-y-5">
        <fieldset>
          <legend className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Scope
          </legend>
          <RadioGroup
            value={scope}
            onValueChange={(v) => changeScope(v as Scope)}
            className="gap-2"
          >
            {(["full", "packages-only", "inspector-only"] as const).map((s) => (
              <Label
                key={s}
                htmlFor={`scope-${s}`}
                className={
                  "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm font-normal transition-colors " +
                  (scope === s
                    ? "border-primary/50 bg-primary/5"
                    : "border-border hover:bg-accent")
                }
              >
                <RadioGroupItem value={s} id={`scope-${s}`} />
                <span className="font-mono text-xs text-foreground">{s}</span>
                <span className="text-xs text-muted-foreground">
                  {SCOPE_HINT[s]}
                </span>
              </Label>
            ))}
          </RadioGroup>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Production flags
          </legend>
          <div className="space-y-2">
            <FlagRow
              id="deploy-backend"
              name="deploy_backend_prod"
              checked={deployBackend}
              onChange={changeDeployBackend}
              disabled={scope !== "full"}
              description="Dispatch backend production deploy (scope=full only)."
            />
            <FlagRow
              id="promote-prod"
              name="promote_production"
              checked={promoteProd}
              onChange={changePromoteProd}
              disabled={scope === "packages-only"}
              description="Deploy inspector to Railway prod after publish."
            />
          </div>
        </fieldset>

        {impactsProd ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <span className="font-medium">Heads up —</span> this run will touch
            production.
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={isPending}
            variant={impactsProd ? "destructive" : "default"}
          >
            Run release →
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
      </div>

      <ConfirmModal
        open={confirming}
        onOpenChange={(v) => !isPending && setConfirming(v)}
        onConfirm={onConfirm}
        busy={isPending}
        scope={scope}
        deployBackend={deployBackend}
        promoteProd={promoteProd}
      />
    </Tile>
  );
}

function FlagRow({
  id,
  name,
  checked,
  onChange,
  disabled,
  description
}: {
  id: string;
  name: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
  description: string;
}) {
  return (
    <Label
      htmlFor={id}
      className={
        "flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 text-sm font-normal transition-colors " +
        (disabled ? "opacity-50" : "hover:bg-accent")
      }
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <div className="min-w-0">
        <div className="font-mono text-xs text-foreground">{name}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {description}
        </div>
      </div>
    </Label>
  );
}

function ConfirmModal({
  open,
  onOpenChange,
  onConfirm,
  busy,
  scope,
  deployBackend,
  promoteProd
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
  scope: Scope;
  deployBackend: boolean;
  promoteProd: boolean;
}) {
  const impactsProd = deployBackend || promoteProd;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!busy} className="sm:max-w-md">
        <DialogHeader>
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Final confirmation
          </div>
          <DialogTitle className="text-xl">
            Dispatch{" "}
            <span className="font-mono text-[0.85em]">release.yml</span>?
          </DialogTitle>
          <DialogDescription>
            Fires on <span className="font-mono text-foreground">main</span>{" "}
            with these inputs:
          </DialogDescription>
        </DialogHeader>

        <dl className="space-y-2 border-l border-border pl-4 text-sm">
          <div className="flex gap-3">
            <dt className="w-44 font-mono text-xs text-muted-foreground">
              scope
            </dt>
            <dd className="font-mono text-xs text-foreground">{scope}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-44 font-mono text-xs text-muted-foreground">
              deploy_backend_prod
            </dt>
            <dd
              className={
                "font-mono text-xs " +
                (deployBackend ? "text-warning" : "text-muted-foreground")
              }
            >
              {String(deployBackend)}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-44 font-mono text-xs text-muted-foreground">
              promote_production
            </dt>
            <dd
              className={
                "font-mono text-xs " +
                (promoteProd ? "text-warning" : "text-muted-foreground")
              }
            >
              {String(promoteProd)}
            </dd>
          </div>
        </dl>

        {impactsProd ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning">
            This is the one path to production. Release.yml will refuse to run
            unless deploy-staging.yml is green for the current main SHA.
          </p>
        ) : null}

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
            variant={impactsProd ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Dispatching…" : "Dispatch release →"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
