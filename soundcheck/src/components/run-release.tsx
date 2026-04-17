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

import { useEffect, useRef, useState, useTransition } from "react";
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

  // Reset gated flags when scope changes so a stale `true` can't slip into
  // the confirmation modal or the dispatch payload. The checkbox disabling
  // is only a UI hint — state must follow.
  function changeScope(next: Scope) {
    setScope(next);
    if (next !== "full") setDeployBackend(false);
    if (next === "packages-only") setPromoteProd(false);
  }

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
    <Tile
      title="Run release"
      eyebrow="The one path to production"
      accent={impactsProd ? "warning" : "info"}
    >
      <p className="mb-5 text-xs leading-relaxed text-ink-400">
        Dispatches{" "}
        <span className="font-mono text-ink-200">release.yml</span> on{" "}
        <span className="font-mono text-ink-200">main</span>. Confirmation
        required; the server re-checks your email before touching the write
        token.
      </p>

      <div className="space-y-5">
        <fieldset className="space-y-2">
          <legend className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-500">
            Scope
          </legend>
          <div className="space-y-2">
            {(["full", "packages-only", "inspector-only"] as const).map((s) => (
              <label
                key={s}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ${scope === s ? "border-signal-wait/40 bg-signal-wait/5" : "border-ink-800 hover:border-ink-700 hover:bg-ink-800/30"}`}
              >
                <input
                  type="radio"
                  name="scope"
                  value={s}
                  checked={scope === s}
                  onChange={() => changeScope(s)}
                  className="accent-signal-wait"
                />
                <span className="font-mono text-xs text-ink-100">{s}</span>
                <span className="text-xs text-ink-400">{SCOPE_HINT[s]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="mb-2 text-[10px] font-medium uppercase tracking-[0.14em] text-ink-500">
            Production flags
          </legend>
          <div className="space-y-2">
            <label className={`flex cursor-pointer items-start gap-3 rounded-lg border border-ink-800 px-3 py-2 text-sm ${scope !== "full" ? "opacity-50" : "hover:border-ink-700"}`}>
              <input
                type="checkbox"
                checked={deployBackend}
                onChange={(e) => setDeployBackend(e.target.checked)}
                className="mt-0.5 accent-signal-wait"
                disabled={scope !== "full"}
              />
              <div className="min-w-0">
                <div className="font-mono text-xs text-ink-100">
                  deploy_backend_prod
                </div>
                <div className="mt-0.5 text-xs text-ink-400">
                  Dispatch backend production deploy (scope=full only).
                </div>
              </div>
            </label>
            <label className={`flex cursor-pointer items-start gap-3 rounded-lg border border-ink-800 px-3 py-2 text-sm ${scope === "packages-only" ? "opacity-50" : "hover:border-ink-700"}`}>
              <input
                type="checkbox"
                checked={promoteProd}
                onChange={(e) => setPromoteProd(e.target.checked)}
                className="mt-0.5 accent-signal-wait"
                disabled={scope === "packages-only"}
              />
              <div className="min-w-0">
                <div className="font-mono text-xs text-ink-100">
                  promote_production
                </div>
                <div className="mt-0.5 text-xs text-ink-400">
                  Deploy inspector to Railway prod after publish.
                </div>
              </div>
            </label>
          </div>
        </fieldset>

        {impactsProd ? (
          <div className="rounded-lg border border-signal-wait/30 bg-signal-wait/5 px-3 py-2 text-xs text-signal-wait">
            <span className="font-medium">Heads up —</span> this run will
            touch production.
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="button"
            onClick={onSubmit}
            disabled={isPending}
            className={`rounded-full px-5 py-2 text-xs font-medium tracking-wide transition-all disabled:opacity-50 ${impactsProd ? "bg-signal-wait text-ink-950 hover:bg-signal-wait/90 shadow-[0_0_20px_-5px_rgba(232,195,102,0.6)]" : "bg-ink-100 text-ink-950 hover:bg-white"}`}
          >
            Run release →
          </button>
          {feedback.kind === "ok" ? (
            <>
              <Badge tone="success">dispatched</Badge>
              <span className="text-xs text-ink-400">{feedback.message}</span>
            </>
          ) : null}
          {feedback.kind === "error" ? (
            <span className="text-xs text-signal-stop">{feedback.message}</span>
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
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // "The one path to production" deserves a real modal: name it for screen
  // readers, trap focus inside, and let Escape dismiss it (but only when
  // nothing is mid-dispatch — we don't want a stray keystroke to abandon an
  // in-flight confirm-click).
  useEffect(() => {
    cancelRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const impactsProd = deployBackend || promoteProd;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-release-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
    >
      <div
        ref={dialogRef}
        className={`panel w-full max-w-md p-7 text-ink-100 ${impactsProd ? "panel-accent-wait" : "panel-accent-info"}`}
      >
        <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-ink-500">
          Final confirmation
        </div>
        <h2
          id="confirm-release-title"
          className="display-hero mt-1 text-2xl text-ink-100"
        >
          Dispatch{" "}
          <span className="font-mono text-[0.85em]">release.yml</span>?
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-400">
          Fires on{" "}
          <span className="font-mono text-ink-200">main</span> with these
          inputs:
        </p>

        <dl className="mt-4 space-y-2 border-l border-ink-800 pl-4 text-sm">
          <div className="flex gap-3">
            <dt className="w-44 font-mono text-xs text-ink-500">scope</dt>
            <dd className="font-mono text-xs text-ink-100">{scope}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-44 font-mono text-xs text-ink-500">
              deploy_backend_prod
            </dt>
            <dd
              className={`font-mono text-xs ${deployBackend ? "text-signal-wait" : "text-ink-400"}`}
            >
              {String(deployBackend)}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-44 font-mono text-xs text-ink-500">
              promote_production
            </dt>
            <dd
              className={`font-mono text-xs ${promoteProd ? "text-signal-wait" : "text-ink-400"}`}
            >
              {String(promoteProd)}
            </dd>
          </div>
        </dl>

        {impactsProd ? (
          <p className="mt-5 rounded-lg border border-signal-wait/30 bg-signal-wait/5 px-3 py-2.5 text-xs leading-relaxed text-signal-wait">
            This is the one path to production. Release.yml will refuse to run
            unless deploy-staging.yml is green for the current main SHA.
          </p>
        ) : null}

        <div className="mt-7 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-full border border-ink-700 px-4 py-2 text-xs font-medium text-ink-200 transition-colors hover:bg-ink-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-full px-5 py-2 text-xs font-medium tracking-wide transition-all disabled:opacity-50 ${impactsProd ? "bg-signal-wait text-ink-950 hover:bg-signal-wait/90 shadow-[0_0_20px_-5px_rgba(232,195,102,0.6)]" : "bg-ink-100 text-ink-950 hover:bg-white"}`}
          >
            {busy ? "Dispatching…" : "Dispatch release →"}
          </button>
        </div>
      </div>
    </div>
  );
}
