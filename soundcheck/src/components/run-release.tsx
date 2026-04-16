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
import { Badge, Tile } from "@/components/ui";

type Scope = "packages-only" | "inspector-only" | "full";

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

  function onSubmit() {
    setConfirming(true);
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
    <Tile title="Run release">
      <p className="mb-3 text-xs text-neutral-500">
        Dispatches <span className="font-mono">release.yml</span> on{" "}
        <span className="font-mono">main</span>. This is the one path to
        production.
      </p>

      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
            scope
          </legend>
          <div className="space-y-1.5">
            {(["full", "packages-only", "inspector-only"] as const).map((s) => (
              <label
                key={s}
                className="flex cursor-pointer items-center gap-2 text-sm"
              >
                <input
                  type="radio"
                  name="scope"
                  value={s}
                  checked={scope === s}
                  onChange={() => setScope(s)}
                  className="accent-neutral-800 dark:accent-neutral-200"
                />
                <span className="font-mono text-xs text-neutral-700 dark:text-neutral-200">
                  {s}
                </span>
                <span className="text-xs text-neutral-500">{SCOPE_HINT[s]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="space-y-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={deployBackend}
              onChange={(e) => setDeployBackend(e.target.checked)}
              className="accent-neutral-800 dark:accent-neutral-200"
              disabled={scope !== "full"}
            />
            <span className="font-mono text-xs text-neutral-700 dark:text-neutral-200">
              deploy_backend_prod
            </span>
            <span className="text-xs text-neutral-500">
              dispatch backend prod deploy (scope=full only)
            </span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={promoteProd}
              onChange={(e) => setPromoteProd(e.target.checked)}
              className="accent-neutral-800 dark:accent-neutral-200"
              disabled={scope === "packages-only"}
            />
            <span className="font-mono text-xs text-neutral-700 dark:text-neutral-200">
              promote_production
            </span>
            <span className="text-xs text-neutral-500">
              deploy inspector to Railway prod after publish
            </span>
          </label>
        </div>

        {impactsProd ? (
          <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
            This run will touch production.
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSubmit}
            disabled={isPending}
            className="rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            Run release…
          </button>
          {feedback.kind === "ok" ? (
            <Badge tone="success">dispatched</Badge>
          ) : null}
          {feedback.kind === "error" ? (
            <span className="text-xs text-red-500">{feedback.message}</span>
          ) : null}
          {feedback.kind === "ok" ? (
            <span className="text-xs text-neutral-500">{feedback.message}</span>
          ) : null}
        </div>
      </div>

      {confirming ? (
        <ConfirmModal
          onCancel={() => setConfirming(false)}
          onConfirm={onConfirm}
          busy={isPending}
          scope={scope}
          deployBackend={deployBackend}
          promoteProd={promoteProd}
        />
      ) : null}
    </Tile>
  );
}

const SCOPE_HINT: Record<Scope, string> = {
  "full": "publish whatever changesets are pending",
  "packages-only": "publish sdk/cli only (no inspector)",
  "inspector-only": "publish inspector only (no sdk/cli)"
};

function ConfirmModal({
  onCancel,
  onConfirm,
  busy,
  scope,
  deployBackend,
  promoteProd
}: {
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  scope: Scope;
  deployBackend: boolean;
  promoteProd: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-6 text-neutral-900 shadow-xl dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100">
        <h2 className="text-base font-semibold">Confirm release dispatch</h2>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          This will dispatch{" "}
          <span className="font-mono">release.yml</span> on{" "}
          <span className="font-mono">main</span> with:
        </p>
        <ul className="mt-3 space-y-1 text-sm">
          <li>
            <span className="font-mono text-xs text-neutral-500">scope</span>:{" "}
            <span className="font-mono font-semibold">{scope}</span>
          </li>
          <li>
            <span className="font-mono text-xs text-neutral-500">
              deploy_backend_prod
            </span>
            :{" "}
            <span className="font-mono font-semibold">
              {String(deployBackend)}
            </span>
          </li>
          <li>
            <span className="font-mono text-xs text-neutral-500">
              promote_production
            </span>
            :{" "}
            <span className="font-mono font-semibold">{String(promoteProd)}</span>
          </li>
        </ul>
        {(deployBackend || promoteProd) ? (
          <p className="mt-4 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
            This is the one path to production. Release.yml will refuse to run
            unless deploy-staging.yml is green for the current main SHA.
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            {busy ? "Dispatching…" : "Dispatch release"}
          </button>
        </div>
      </div>
    </div>
  );
}
