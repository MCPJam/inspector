"use client";

/**
 * Run Release tile — the single dispatch form for every production deploy
 * Soundcheck can trigger:
 *
 *   - release.yml (scope + promote_production + deploy_backend_prod)
 *   - deploy-mcp-prod.yml (deploy_mcp_production)
 *
 * MCP lives here rather than in its own tile because it's another flavor
 * of "promote something to production" — the operator's mental model is
 * one control plane, not two. The server route decides which workflow(s)
 * to dispatch based on the selection.
 *
 * The scope radio has four options. `none` exists so MCP can be promoted
 * without running release.yml at all; the other three map 1:1 to
 * release.yml's scope input.
 *
 * The confirmation modal quotes the final inputs back verbatim because
 * production-touching dispatches deserve a deliberate extra click.
 *
 * The client never sees the GitHub PAT. The server route
 * /api/release/dispatch holds it; this component only POSTs JSON to it.
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

type Scope = "none" | "packages-only" | "inspector-only" | "full";

const SCOPE_HINT: Record<Scope, string> = {
  "full": "publish whatever changesets are pending",
  "packages-only": "publish sdk/cli only (no inspector)",
  "inspector-only": "publish inspector only (no sdk/cli)",
  "none": "skip npm publish (use for MCP-only promotions)"
};

export function RunRelease() {
  const router = useRouter();
  const [scope, setScope] = useState<Scope>("full");
  const [deployBackend, setDeployBackend] = useState(false);
  const [promoteProd, setPromoteProd] = useState(false);
  const [deployMcp, setDeployMcp] = useState(false);
  const [skipVerify, setSkipVerify] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<
    | { kind: "idle" }
    | { kind: "ok"; message: string }
    | { kind: "partial"; message: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [isPending, startTransition] = useTransition();

  const runsRelease = scope !== "none";
  const impactsProd = deployBackend || promoteProd || deployMcp;
  const hasAnyTarget = runsRelease || deployMcp;
  const effectiveSkipVerify = runsRelease && skipVerify;

  // Reset gated flags when scope changes so a stale `true` can't slip into
  // the confirmation modal or the dispatch payload. The checkbox disabling
  // is only a UI hint — state must follow.
  function changeScope(next: Scope) {
    setScope(next);
    if (next !== "full") setDeployBackend(false);
    if (next === "packages-only" || next === "none") setPromoteProd(false);
    if (next === "none") setSkipVerify(false);
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
  function changeDeployMcp(v: boolean) {
    setDeployMcp(v);
    setFeedback({ kind: "idle" });
  }
  function changeSkipVerify(v: boolean) {
    setSkipVerify(v);
    setFeedback({ kind: "idle" });
  }

  function onConfirm() {
    setFeedback({ kind: "idle" });
    startTransition(async () => {
      try {
        const res = await fetch("/api/release/dispatch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Same-origin sentinel — the route rejects POSTs missing this
            // header to close a CSRF vector. See route.ts for rationale.
            "x-soundcheck-action": "release-dispatch"
          },
          body: JSON.stringify({
            scope,
            deploy_backend_prod: deployBackend,
            promote_production: promoteProd,
            deploy_mcp_production: deployMcp,
            skip_verify: effectiveSkipVerify
          })
        });
        const json = (await res.json()) as {
          error?: string;
          message?: string;
          partial?: boolean;
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
          kind: json.partial ? "partial" : "ok",
          message:
            json.message ??
            "Dispatched. The progress tile should pick it up shortly."
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

  const buttonLabel = runsRelease
    ? "Run release →"
    : deployMcp
      ? "Deploy MCP →"
      : "Run release →";

  return (
    <Tile
      title="Run release"
      eyebrow="The one path to production"
      accent={impactsProd ? "warning" : "info"}
    >
      <p className="mb-5 text-xs leading-relaxed text-muted-foreground">
        Dispatches{" "}
        <span className="font-mono text-foreground">release.yml</span> and/or{" "}
        <span className="font-mono text-foreground">deploy-mcp-prod.yml</span>{" "}
        on <span className="font-mono text-foreground">main</span>.
        Confirmation required; the server re-checks your email before
        touching the write token.
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
            {(
              ["full", "packages-only", "inspector-only", "none"] as const
            ).map((s) => (
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
            Preflight
          </legend>
          <FlagRow
            id="skip-verify"
            name="skip_verify"
            checked={skipVerify}
            onChange={changeSkipVerify}
            disabled={!runsRelease}
            description="Recovery-only: skip npm run verify; staging and Changesets gates still run."
          />
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
              disabled={scope === "packages-only" || scope === "none"}
              description="Deploy inspector to Railway prod after publish."
            />
            <FlagRow
              id="deploy-mcp"
              name="deploy_mcp_production"
              checked={deployMcp}
              onChange={changeDeployMcp}
              disabled={false}
              description="Deploy MCP worker to mcp.mcpjam.com (independent of release scope)."
            />
          </div>
        </fieldset>

        {impactsProd ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <span className="font-medium">Heads up —</span> this run will touch
            production.
          </div>
        ) : null}

        {effectiveSkipVerify ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <span className="font-medium">Recovery mode:</span>{" "}
            <span className="font-mono">npm run verify</span> will be skipped.
          </div>
        ) : null}

        {!hasAnyTarget ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Pick a scope or check <span className="font-mono">deploy_mcp_production</span>{" "}
            to enable dispatch.
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={isPending || !hasAnyTarget}
            variant={impactsProd ? "destructive" : "default"}
          >
            {buttonLabel}
          </Button>
          {feedback.kind === "ok" ? (
            <>
              <Badge tone="success">dispatched</Badge>
              <span className="text-xs text-muted-foreground">
                {feedback.message}
              </span>
            </>
          ) : null}
          {feedback.kind === "partial" ? (
            <>
              <Badge tone="warning">partial</Badge>
              <span className="text-xs text-warning">{feedback.message}</span>
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
        deployMcp={deployMcp}
        skipVerify={effectiveSkipVerify}
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
  promoteProd,
  deployMcp,
  skipVerify
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
  scope: Scope;
  deployBackend: boolean;
  promoteProd: boolean;
  deployMcp: boolean;
  skipVerify: boolean;
}) {
  const impactsProd = deployBackend || promoteProd || deployMcp;
  const runsRelease = scope !== "none";
  const dispatchedWorkflows = [
    runsRelease ? "release.yml" : null,
    deployMcp ? "deploy-mcp-prod.yml" : null
  ].filter(Boolean) as string[];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={!busy} className="sm:max-w-md">
        <DialogHeader>
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Final confirmation
          </div>
          <DialogTitle className="text-xl">
            {dispatchedWorkflows.length === 2
              ? "Dispatch release.yml + deploy-mcp-prod.yml?"
              : runsRelease
                ? "Dispatch release.yml?"
                : "Dispatch deploy-mcp-prod.yml?"}
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
              skip_verify
            </dt>
            <dd
              className={
                "font-mono text-xs " +
                (skipVerify ? "text-warning" : "text-muted-foreground")
              }
            >
              {String(runsRelease && skipVerify)}
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
          <div className="flex gap-3">
            <dt className="w-44 font-mono text-xs text-muted-foreground">
              deploy_mcp_production
            </dt>
            <dd
              className={
                "font-mono text-xs " +
                (deployMcp ? "text-warning" : "text-muted-foreground")
              }
            >
              {String(deployMcp)}
            </dd>
          </div>
        </dl>

        {impactsProd ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning">
            This is the one path to production. Release.yml refuses unless
            deploy-staging.yml is green for the current main SHA;
            deploy-mcp-prod.yml refuses unless deploy-mcp-staging.yml is green
            for the current MCP build inputs.
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
            {busy
              ? "Dispatching…"
              : dispatchedWorkflows.length === 2
                ? "Dispatch both →"
                : runsRelease
                  ? "Dispatch release →"
                  : "Deploy MCP →"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
