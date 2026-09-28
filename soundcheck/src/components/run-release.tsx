"use client";

/**
 * Run Release tile — the single dispatch form for every production deploy
 * Soundcheck can trigger:
 *
 *   - start: prepare-release.yml opens the version PR, with the deploy
 *     flags as checkboxes in it. Merging the PR is the release;
 *     release-trigger.yml runs release.yml once main is green.
 *   - publish: release.yml directly, for versions already merged whose
 *     automatic run failed or never started.
 *   - deploy-mcp-prod.yml (deploy_mcp_production), with either or alone.
 *
 * MCP lives here rather than in its own tile because it's another flavor
 * of "promote something to production" — the operator's mental model is
 * one control plane, not two. The server route decides which workflow(s)
 * to dispatch based on the selection.
 *
 * `none` exists so MCP can be promoted without touching a release at all.
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

type Action = "start" | "publish" | "none";

const ACTION_HINT: Record<Action, string> = {
  start: "open the version PR; merging it releases",
  publish: "release versions already merged (retry)",
  none: "no release (use for MCP-only promotions)"
};

export function RunRelease() {
  const router = useRouter();
  const [action, setAction] = useState<Action>("start");
  const [deployBackend, setDeployBackend] = useState(false);
  const [deployWebapp, setDeployWebapp] = useState(false);
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

  const runsRelease = action !== "none";
  // "start" only writes the deploy flags into the version PR; production
  // changes when that PR merges, not on this click.
  const impactsProd =
    deployMcp || (action === "publish" && (deployBackend || deployWebapp));
  const hasAnyTarget = runsRelease || deployMcp;
  const effectiveSkipVerify = action === "publish" && skipVerify;

  // Reset gated flags when the action changes so a stale `true` can't slip
  // into the confirmation modal or the dispatch payload. The checkbox
  // disabling is only a UI hint — state must follow.
  function changeAction(next: Action) {
    setAction(next);
    if (next === "none") {
      setDeployBackend(false);
      setDeployWebapp(false);
    }
    if (next !== "publish") setSkipVerify(false);
    setFeedback({ kind: "idle" });
  }

  function changeDeployBackend(v: boolean) {
    setDeployBackend(v);
    setFeedback({ kind: "idle" });
  }
  function changeDeployWebapp(v: boolean) {
    setDeployWebapp(v);
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
            action,
            deploy_backend_prod: deployBackend,
            deploy_webapp: deployWebapp,
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

  const buttonLabel =
    action === "start"
      ? "Start release →"
      : action === "publish"
        ? "Run release now →"
        : deployMcp
          ? "Deploy MCP →"
          : "Start release →";

  return (
    <Tile
      title="Run release"
      eyebrow="The one path to production"
      accent={impactsProd ? "warning" : "info"}
    >
      <p className="mb-5 text-xs leading-relaxed text-muted-foreground">
        Start release opens the version PR; merging it ships to npm and
        production once <span className="font-mono text-foreground">main</span>{" "}
        is green. MCP promotes through{" "}
        <span className="font-mono text-foreground">deploy-mcp-prod.yml</span>.
        Confirmation required; the server re-checks your email before
        touching the write token.
      </p>

      <div className="space-y-5">
        <fieldset>
          <legend className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            Release
          </legend>
          <RadioGroup
            value={action}
            onValueChange={(v) => changeAction(v as Action)}
            className="gap-2"
          >
            {(["start", "publish", "none"] as const).map((a) => (
              <Label
                key={a}
                htmlFor={`action-${a}`}
                className={
                  "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm font-normal transition-colors " +
                  (action === a
                    ? "border-primary/50 bg-primary/5"
                    : "border-border hover:bg-accent")
                }
              >
                <RadioGroupItem value={a} id={`action-${a}`} />
                <span className="font-mono text-xs text-foreground">{a}</span>
                <span className="text-xs text-muted-foreground">
                  {ACTION_HINT[a]}
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
            disabled={action !== "publish"}
            description="Recovery-only, publish only: skips the green-CI and green-staging gates on main's SHA."
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
              disabled={!runsRelease}
              description="Dispatch backend production deploy with the release. For start, ticked in the version PR."
            />
            <FlagRow
              id="deploy-webapp"
              name="deploy_webapp"
              checked={deployWebapp}
              onChange={changeDeployWebapp}
              disabled={!runsRelease}
              description="Deploy inspector to Railway prod after publish (needs an inspector version). For start, ticked in the version PR."
            />
            <FlagRow
              id="deploy-mcp"
              name="deploy_mcp_production"
              checked={deployMcp}
              onChange={changeDeployMcp}
              disabled={false}
              description="Deploy MCP worker to mcp.mcpjam.com (independent of the release)."
            />
          </div>
        </fieldset>

        {impactsProd ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            <span className="font-medium">Heads up —</span> this run will touch
            production.
          </div>
        ) : null}

        {action === "start" && (deployBackend || deployWebapp) ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            These deploys are ticked in the version PR and happen when it
            merges. Untick them there to change your mind.
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
            Pick a release action or check{" "}
            <span className="font-mono">deploy_mcp_production</span> to enable
            dispatch.
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
        action={action}
        deployBackend={deployBackend}
        deployWebapp={deployWebapp}
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
  action,
  deployBackend,
  deployWebapp,
  deployMcp,
  skipVerify
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
  action: Action;
  deployBackend: boolean;
  deployWebapp: boolean;
  deployMcp: boolean;
  skipVerify: boolean;
}) {
  const impactsProd =
    deployMcp || (action === "publish" && (deployBackend || deployWebapp));
  const releaseWorkflow =
    action === "start"
      ? "prepare-release.yml"
      : action === "publish"
        ? "release.yml"
        : null;
  const dispatchedWorkflows = [
    releaseWorkflow,
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
            {`Dispatch ${dispatchedWorkflows.join(" + ")}?`}
          </DialogTitle>
          <DialogDescription>
            Fires on <span className="font-mono text-foreground">main</span>{" "}
            with these inputs:
          </DialogDescription>
        </DialogHeader>

        <dl className="space-y-2 border-l border-border pl-4 text-sm">
          <div className="flex gap-3">
            <dt className="w-44 font-mono text-xs text-muted-foreground">
              action
            </dt>
            <dd className="font-mono text-xs text-foreground">{action}</dd>
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
              {String(action === "publish" && skipVerify)}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-44 font-mono text-xs text-muted-foreground">
              deploy_webapp
            </dt>
            <dd
              className={
                "font-mono text-xs " +
                (deployWebapp ? "text-warning" : "text-muted-foreground")
              }
            >
              {String(deployWebapp)}
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
            deploy-staging.yml is green for the current main SHA (unless
            skip_verify); deploy-mcp-prod.yml refuses unless
            deploy-mcp-staging.yml is green for the current MCP build inputs.
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
                : action === "start"
                  ? "Open version PR →"
                  : action === "publish"
                    ? "Dispatch release →"
                    : "Deploy MCP →"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
